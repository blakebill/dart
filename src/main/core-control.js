'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');

const { state, runtimeDir, resourcesBinDir, sendLog, sendStatus, refreshTray } = require('./state');
const { isWindowsAdmin, ensureAdminForTun } = require('./admin');
const { startTrafficStream, stopTrafficStream } = require('./traffic');
const { buildSingboxConfig, buildMihomoConfig, buildRoute, ruleListToSingboxRule, extractRuleGroups, extractGeoCategories, extractRuleSetRefs, parseRuleList } = require('./converter');
const { geoDataUrls } = require('./singbox');
const crypto = require('crypto');
const subscription = require('./subscription');
const proxy = require('./proxy');
const fetch = require('./fetch');

/**
 * Core control: everything that drives the sing-box core — building the
 * config from the active profile + settings, start/stop/restart, the system
 * proxy guard, the Clash API client, proxy-mode switching, and the
 * subscription auto-update timer.
 */

// Reuse sockets for the frequent Clash API calls (connection polling, latency
// tests) instead of opening a fresh TCP connection each time.
const clashAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

// Locally served control panel: the active core hosts zashboard at
// http://127.0.0.1:<api-port>/ui/ — the same origin as the Clash API. That
// sidesteps every remote-panel failure mode at once: mixed content, CORS,
// and Chrome blocking public-site requests to 127.0.0.1 ("failed to fetch").
// Both core configs use Zashboard's latest-release URL for the first download.
const PANEL_UI_URL = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';

/** The control panel served at /ui: { dir, downloadUrl }. */
function panelUiInfo() {
  return {
    dir: path.join(runtimeDir, 'ui', 'zashboard'),
    downloadUrl: PANEL_UI_URL,
  };
}

/** The local proxy port to tunnel rule-set downloads through (0 = direct). */
function currentProxyPort() {
  return state.singbox && state.singbox.isRunning() ? state.store.getSettings().mixedPort || 0 : 0;
}

function detectCustomRuleSetFormat(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.srs')) return 'sing-box';
  } catch (_) {
    /* invalid URLs are reported by the IPC validation layer */
  }
  return 'clash';
}

function normalizeCustomRuleSetFormat(format, url) {
  if (format === 'sing-box') return 'sing-box';
  if (format === 'clash') return 'clash';
  // Legacy records used to allow Surge/Loon/QuantumultX; process them as Clash-compatible text.
  return url ? detectCustomRuleSetFormat(url) : 'clash';
}

/** The id of the subscription (profile) currently in use; falls back to the first. */
function getActiveSubId() {
  const subs = state.store.get('subscriptions') || [];
  if (!subs.length) return null;
  const active = state.store.get('activeSub');
  if (active && subs.some((s) => s.id === active)) return active;
  // Legacy stores (pre-profiles) or a stale pointer: pin the fallback choice.
  // Left unpinned, `activeSub` stays null while the core runs subs[0] — and
  // the next sub:add would silently make the NEW subscription active without
  // a restart (UI shows its nodes, the Clash API doesn't know them: delay
  // tests "time out" and selecting a node fails with 400).
  state.store.set('activeSub', subs[0].id);
  return subs[0].id;
}

/** Nodes + Clash rules (+ rule-providers) of the active subscription only. */
function activeSubData() {
  const subs = state.store.get('subscriptions') || [];
  const sub = subs.find((s) => s.id === getActiveSubId());
  return {
    nodes: (sub && sub.nodes) || [],
    rules: (sub && sub.clashRules) || [],
    providers: (sub && sub.clashRuleProviders) || {},
  };
}

/** Point a route rule at a target ('direct' | 'reject' | proxy), in place. */
function applyRuleTarget(rule, target) {
  if (target === 'direct') rule.outbound = 'direct';
  else if (target === 'reject') rule.action = 'reject';
  else rule.outbound = '🚀 Proxy';
  return rule;
}

/** Turn a stored local rule into a sing-box route rule object. */
function buildLocalRuleObject(lr) {
  const vals = (lr.values || []).map((v) => String(v).trim()).filter(Boolean);
  if (!vals.length || !lr.matchType) return null;
  return applyRuleTarget({ [lr.matchType]: vals }, lr.target);
}

const MATCH_FIELDS = ['domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'process_name'];

/**
 * Older inline custom rule-sets were persisted as one rule containing every
 * matcher field. sing-box AND-combines fields inside a rule, so split them into
 * adjacent single-field rules at load time. New records store `rules` already.
 */
function splitInlineRule(rule) {
  if (!rule || typeof rule !== 'object') return [];
  const fields = MATCH_FIELDS.filter((f) => Array.isArray(rule[f]) && rule[f].length);
  if (fields.length <= 1) return [rule];
  const target = rule.action === 'reject' ? { action: 'reject' } : { outbound: rule.outbound || '🚀 Proxy' };
  return fields.map((f) => ({ [f]: rule[f].slice(), ...target }));
}

/** Stable, traversal-safe file name for a stored custom rule-set id. */
function customRuleSetFileName(id) {
  const raw = String(id || '');
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(raw)
    ? raw
    : crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `custom-${safe}.srs`;
}

/**
 * Build extraRules/extraRuleSets from the user's local rules + pre-processed
 * custom rule-sets. Local rules come first (most specific user intent).
 */
function collectCustomRules() {
  const extraRules = [];
  const extraRuleSets = [];
  for (const lr of state.store.get('localRules') || []) {
    if (lr.enabled === false) continue;
    const rule = buildLocalRuleObject(lr);
    if (rule) extraRules.push(rule);
  }
  for (const c of state.store.get('customRuleSets') || []) {
    if (c.enabled === false) continue;
    if (c.kind === 'inline') {
      if (Array.isArray(c.rules) && c.rules.length) extraRules.push(...c.rules);
      else if (c.rule) extraRules.push(...splitInlineRule(c.rule));
    } else if (c.kind === 'ruleset') {
      const p = path.join(state.singbox.coreDir('sing-box'), customRuleSetFileName(c.id));
      if (state.singbox._validSrs(p)) {
        const tag = 'custom-' + c.id;
        extraRuleSets.push({ type: 'local', tag, format: 'binary', path: p.replace(/\\/g, '/') });
        extraRules.push(applyRuleTarget({ rule_set: [tag] }, c.target));
      }
    }
  }
  return { extraRules, extraRuleSets };
}

/** Download + convert one custom rule-set, returning the processed record. */
async function processCustomRuleSet(c) {
  const proxyPort = currentProxyPort();
  const format = normalizeCustomRuleSetFormat(c.format, c.url);
  if (format === 'sing-box') {
    const dest = path.join(state.singbox.ensureCoreDir('sing-box'), customRuleSetFileName(c.id));
    const tmp = dest + `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await fetch.downloadWithFallback(c.url, tmp, { proxyPort });
      if (!state.singbox._validSrs(tmp)) {
        throw new Error('downloaded .srs is invalid (blocked or not a sing-box rule-set)');
      }
      fs.renameSync(tmp, dest);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return { ...c, format, kind: 'ruleset', count: null, error: null, updatedAt: Date.now() };
  }
  const { body } = await fetch.getBufferWithFallback(c.url, {
    proxyPort,
    headers: { 'User-Agent': 'clash-verge/v2.0.2' },
  });
  const { rule, rules, count } = ruleListToSingboxRule(body.toString('utf-8'), c.target);
  if (!rules.length) throw new Error('no rules parsed from the list (unsupported format?)');
  return { ...c, format, kind: 'inline', rule, rules, count, error: null, updatedAt: Date.now() };
}

function buildCurrentConfig() {
  const settings = state.store.getSettings();
  // Use only the active subscription's nodes (profiles are not merged).
  const { nodes: allNodes, rules: allRules, providers } = activeSubData();
  if (allNodes.length === 0) {
    throw new Error('No nodes available. Add a config first.');
  }
  // Built-in rules mode: ignore the subscription's own Clash rules (which often
  // route nearly everything through the proxy) and fall back to the app's clean
  // default — CN/private direct, everything else proxied — so the user's local
  // rules and custom rule-sets are what actually steer routing.
  const clashRules = settings.useBuiltinRules ? [] : allRules;
  const { extraRules, extraRuleSets } = collectCustomRules();
  const mihomoGeoReady = settings.coreType === 'mihomo' ? state.singbox.mihomoGeoDataReady() : false;
  const ui = panelUiInfo();
  try { fs.mkdirSync(ui.dir, { recursive: true }); } catch (_) { /* sing-box will report */ }
  const commonOpts = {
    ruleOverrides: settings.ruleOverrides,
    mixedPort: settings.mixedPort,
    clashApiPort: settings.clashApiPort,
    clashApiSecret: state.clashApiSecret,
    enableTun: settings.enableTun,
    enableClashApi: settings.enableClashApi,
    logLevel: settings.logLevel,
    selected: state.store.get('selected'),
    clashMode: settings.clashMode,
    clashRules,
    ruleProviders: providers,
    enableIpv6: settings.enableIpv6,
    dnsRemote: settings.dnsRemote,
    dnsLocal: settings.dnsLocal,
    dnsStrategy: settings.dnsStrategy,
    extraRules,
    extraRuleSets,
  };
  const config = settings.coreType === 'mihomo'
    ? buildMihomoConfig(allNodes, {
        ...commonOpts,
        hasGeoData: mihomoGeoReady,
        externalUiDir: ui.dir.replace(/\\/g, '/'),
        externalUiDownloadUrl: ui.downloadUrl,
      })
    : buildSingboxConfig(allNodes, {
        ...commonOpts,
        externalUiDir: ui.dir.replace(/\\/g, '/'),
        externalUiDownloadUrl: ui.downloadUrl,
        ruleSetDir: state.singbox.resolveRuleSetDir(),
        geoAvailable: availableGeoSet(clashRules),
        ruleSetData: loadRuleSetData(clashRules, providers),
      });
  return { config, settings };
}

/** Build the route info (rules + rule-sets) from the current config, without running. */
function currentRouteInfo() {
  const { rules, providers } = activeSubData();
  // Mirror buildCurrentConfig: in built-in rules mode the subscription's own
  // rules are dropped so the Rules view shows what actually runs.
  const settings = state.store.getSettings();
  const clashRules = settings.useBuiltinRules ? [] : rules;
  const { extraRules, extraRuleSets } = collectCustomRules();
  // Only the route is needed here, so skip converting every node to an outbound.
  const route = buildRoute({
    ruleSetDir: state.singbox.resolveRuleSetDir(),
    clashRules,
    extraRules,
    extraRuleSets,
    ruleOverrides: settings.ruleOverrides,
    geoAvailable: availableGeoSet(clashRules),
    ruleSetData: loadRuleSetData(clashRules, providers),
  });
  return { rules: route.rules, ruleSets: route.rule_set };
}

/**
 * The active subscription's policy groups + the user's current outbound
 * overrides, for the rules UI. Empty when built-in rules mode drops them.
 */
function ruleGroupInfo() {
  const settings = state.store.getSettings();
  const groups = settings.useBuiltinRules ? [] : extractRuleGroups(activeSubData().rules);
  return { groups, overrides: settings.ruleOverrides || {} };
}

async function startCore() {
  const { config, settings } = buildCurrentConfig();
  if (settings.enableTun && !(await isWindowsAdmin())) {
    if (await ensureAdminForTun()) return; // relaunching elevated
  }
  await state.singbox.start(config);
  if (settings.autoSetSystemProxy && !settings.enableTun) {
    try {
      await proxy.enableSystemProxy('127.0.0.1', settings.mixedPort);
      state.systemProxyOn = true;
      startProxyGuard(settings.mixedPort);
    } catch (e) {
      sendLog('[gui] failed to set system proxy: ' + e.message);
    }
  }
  state.store.set('lastRunning', true);
  sendStatus();
  startTrafficStream();
  maybeFetchGeodata();
  // Pull anything the subscription's rules reference but that isn't on disk yet
  // — GEOSITE/GEOIP categories and RULE-SET providers — now that the proxy can
  // carry the download. Best-effort, non-blocking; applies on the next start.
  const { rules, providers } = effectiveSub();
  maybeFetchGeoCategories(rules);
  maybeFetchRuleProviders(rules, providers);
}

// Self-heal for installs that booted without geodata (e.g. dev runs, or a
// build whose bundling didn't land): the config above already degrades
// gracefully (no geoip-cn/geosite-cn rules), so the core is up. Fetch the
// rule-sets in the background — now that the proxy is available — so the next
// start gets the full CN-direct routing. Best-effort and non-blocking; it
// does not restart the running core.
const geodataFetchTried = {};
function maybeFetchGeodata() {
  const key = state.singbox.getCoreType();
  if (geodataFetchTried[key] || geoDataReady()) return;
  geodataFetchTried[key] = true;
  const proxyPort = currentProxyPort();
  state.singbox
    .updateGeoData(() => {}, proxyPort)
    .then(() => sendLog('[gui] geodata fetched; restart to enable CN direct routing'))
    .catch((e) => {
      geodataFetchTried[key] = false; // let a later start retry
      sendLog('[gui] background geodata fetch failed (non-fatal): ' + e.message);
    });
}

function geoDataReady() {
  if (state.singbox.getCoreType() !== 'mihomo') return state.singbox.ensureSingBoxGeoData();
  return state.singbox.mihomoGeoDataReady();
}

/** Writable dir holding all geo rule-sets (base + downloaded categories). */
function geoBinDir() {
  return state.singbox.ensureCoreDir('sing-box');
}

// The bundled CN rule-sets only need copying into the writable runtime bin once
// per process (so every geo .srs sits in the one dir resolveRuleSetDir returns).
// Gate the fs work behind a flag so it doesn't repeat on every config build.
let geoBaseEnsured = false;
function ensureGeoBaseWritable() {
  if (geoBaseEnsured) return;
  state.singbox.ensureSingBoxGeoData();
  geoBaseEnsured = true;
}

/** The active subscription's rules + providers, honoring built-in-rules mode. */
function effectiveSub() {
  const { rules, providers } = activeSubData();
  return { rules: state.store.getSettings().useBuiltinRules ? [] : rules, providers };
}

/**
 * Geo rule-set tags backed by a real local .srs right now: the CN pair plus any
 * GEOSITE/GEOIP category the rules reference that has been downloaded. Passed to
 * the converter so it only references rule-sets that actually exist on disk.
 */
function availableGeoSet(clashRules) {
  ensureGeoBaseWritable();
  const dir = state.singbox.resolveRuleSetDir();
  const avail = new Set();
  if (!dir) return avail;
  const tags = new Set(['geoip-cn', 'geosite-cn', ...extractGeoCategories(clashRules).map((c) => c.tag)]);
  for (const tag of tags) {
    if (state.singbox._validSrs(path.join(dir, tag + '.srs'))) avail.add(tag);
  }
  return avail;
}

/**
 * Shared scaffold for the post-start, best-effort background downloads (geo
 * categories + rule-providers): bail when nothing is missing, run each item
 * (isolating per-item failures), count successes, log a summary, and never
 * reject into the caller. `perItem` returns true when it fetched something.
 */
function runBackgroundFetch(label, items, perItem) {
  if (!items.length) return;
  (async () => {
    let got = 0;
    for (const item of items) {
      try { if (await perItem(item)) got += 1; } catch (_) { /* skip a failed item */ }
    }
    if (got) sendLog(`[gui] fetched ${got} ${label}; restart to apply`);
  })().catch((e) => sendLog(`[gui] ${label} fetch failed (non-fatal): ` + e.message));
}

/**
 * Download one rule-set .srs (trying each mirror in turn), validating before
 * swapping it into place so a blocked/HTML response never replaces a good file.
 * Returns true when a valid .srs landed at dest.
 */
async function fetchSrs(repo, file, dest, proxyPort) {
  const tmp = dest + '.tmp';
  for (const url of geoDataUrls(repo, file)) {
    try {
      await fetch.downloadWithFallback(url, tmp, { proxyPort });
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      continue;
    }
    if (state.singbox._validSrs(tmp)) {
      try { fs.renameSync(tmp, dest); return true; } catch (_) { return false; }
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return false;
}

/**
 * After the core is up (so downloads can use the proxy), fetch any GEOSITE/GEOIP
 * .srs the subscription references but that aren't on disk yet. Best-effort and
 * non-blocking; newly fetched sets apply on the next start (like base geodata).
 */
function maybeFetchGeoCategories(clashRules) {
  const dir = geoBinDir();
  const missing = extractGeoCategories(clashRules).filter(
    (c) => !state.singbox._validSrs(path.join(dir, c.file))
  );
  const proxyPort = currentProxyPort();
  runBackgroundFetch('subscription rule-set(s)', missing, (c) =>
    fetchSrs(c.repo, c.file, path.join(dir, c.file), proxyPort)
  );
}

/** Cache path for a rule-provider's parsed matchers (keyed by its URL). */
function ruleProviderCacheFile(url) {
  const h = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  return path.join(geoBinDir(), `rp-${h}.json`);
}

/**
 * Load the parsed matcher arrays for every RULE-SET provider the rules
 * reference and that has already been downloaded + cached. Returns a map
 * name -> { domain, domain_suffix, ip_cidr, ... } for the converter; providers
 * not yet cached are simply absent (their RULE-SET rule is then skipped).
 */
function loadRuleSetData(clashRules, providers) {
  const data = {};
  for (const name of extractRuleSetRefs(clashRules)) {
    const p = providers && providers[name];
    if (!p || !p.url) continue;
    try {
      const f = ruleProviderCacheFile(p.url);
      if (fs.existsSync(f)) {
        const m = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (m && typeof m === 'object' && !Array.isArray(m)) data[name] = m;
      }
    } catch (_) {
      // A corrupt cache must not permanently suppress its re-download.
      try { fs.unlinkSync(ruleProviderCacheFile(p.url)); } catch (_) {}
    }
  }
  return data;
}

/**
 * After the core is up, download any referenced rule-providers not cached yet,
 * parse them into matcher arrays, and cache them. Best-effort and non-blocking;
 * applies on the next start. `file`/`inline` providers (no URL) and binary
 * `mrs` rule-sets are skipped (nothing fetchable / not parseable here).
 */
function maybeFetchRuleProviders(clashRules, providers) {
  const proxyPort = currentProxyPort();
  const todo = [];
  for (const name of extractRuleSetRefs(clashRules)) {
    const p = providers && providers[name];
    if (!p || !/^https?:\/\//i.test(p.url || '')) continue;
    if ((p.format || '').toLowerCase() === 'mrs') continue;
    const f = ruleProviderCacheFile(p.url);
    let cached = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
      cached = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch (_) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    if (!cached) todo.push({ p, f });
  }
  runBackgroundFetch('rule-provider(s)', todo, async ({ p, f }) => {
    const { body } = await fetch.getBufferWithFallback(p.url, {
      proxyPort,
      headers: { 'User-Agent': 'clash-verge/v2.0.2' },
    });
    const m = parseRuleList(body.toString('utf-8'));
    const total = Object.values(m).reduce((n, a) => n + a.length, 0);
    if (total === 0) return false;
    const tmp = f + `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(m), 'utf-8');
      fs.renameSync(tmp, f);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return true;
  });
}

/**
 * Stop the core. When `remember` is true (an explicit user stop) we also clear
 * the auto-resume flag, so the app does not start itself on the next launch.
 */
async function stopCore(remember) {
  // Mark the stop as intentional so the exit handler doesn't fire a "core
  // crashed" notification for a stop/restart we initiated.
  state.coreStopping = true;
  stopTrafficStream();
  stopProxyGuard();
  if (state.systemProxyOn) {
    try {
      await proxy.disableSystemProxy();
    } catch (e) {
      sendLog('[gui] failed to disable system proxy: ' + e.message);
    }
    state.systemProxyOn = false;
  }
  try {
    await state.singbox.stop();
    if (remember) state.store.set('lastRunning', false);
  } finally {
    state.coreStopping = false;
    sendStatus();
  }
}

/**
 * Guard the system proxy: some software (or a network change) can overwrite the
 * Windows proxy registry. While we own it, re-assert it if it gets changed.
 */
let proxyGuard = null;
function startProxyGuard(port) {
  stopProxyGuard();
  const server = '127.0.0.1:' + port;
  proxyGuard = setInterval(async () => {
    if (!state.systemProxyOn) return;
    try {
      if (!(await proxy.isSystemProxyActive(server))) {
        await proxy.enableSystemProxy('127.0.0.1', port);
        sendLog('[gui] system proxy was changed by another app; restored');
      }
    } catch (_) {
      /* ignore */
    }
  }, 30000); // re-assert at most twice a minute (each check spawns reg.exe)
}
function stopProxyGuard() {
  if (proxyGuard) {
    clearInterval(proxyGuard);
    proxyGuard = null;
  }
}

async function cleanup() {
  try {
    await stopCore();
  } catch (e) {
    /* ignore */
  }
}

/** Restart the core if it is running, so config changes (e.g. rules) apply. */
let restartPromise = null;
async function restartIfRunning() {
  if (restartPromise) return restartPromise;
  if (!state.singbox.isRunning()) return;
  restartPromise = (async () => {
    try {
      await stopCore();
      await startCore();
      sendLog('[gui] core restarted to apply changes');
    } catch (e) {
      sendLog('[gui] restart to apply changes failed: ' + e.message);
    } finally {
      restartPromise = null;
    }
  })();
  return restartPromise;
}

/**
 * Query the latency of a node via the sing-box Clash API.
 * @param {string} name outbound tag (node name)
 * @returns {Promise<number>} delay in ms
 */
function testNodeDelay(name) {
  return new Promise((resolve, reject) => {
    const settings = state.store.getSettings();
    // Configurable test target (default: the HTTP — not HTTPS — generate_204,
    // the Clash-ecosystem default). The core dials a fresh outbound per test, so
    // an HTTPS target would add a full TLS handshake to the destination on every
    // probe; that cost is amortized away by connection reuse during real
    // browsing, so an HTTP target better tracks the latency users actually feel
    // and has lower variance. Empty/blank falls back to the default.
    const url = (settings.testUrl || '').trim() || 'http://www.gstatic.com/generate_204';
    const testUrl = encodeURIComponent(url);
    const reqPath = `/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=${testUrl}`;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: settings.clashApiPort,
        path: reqPath,
        method: 'GET',
        timeout: 8000,
        agent: clashAgent,
        headers: { Authorization: 'Bearer ' + state.clashApiSecret },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (typeof data.delay === 'number') resolve(data.delay);
            else reject(new Error(data.message || 'timeout'));
          } catch (e) {
            reject(new Error('timeout'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Generic Clash API request (sing-box external controller). Resolves parsed JSON. */
function clashApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const settings = state.store.getSettings();
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + state.clashApiSecret };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: '127.0.0.1', port: settings.clashApiPort, path: apiPath, method, headers, timeout: 6000, agent: clashAgent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('clash api ' + res.statusCode));
          }
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            resolve({});
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Switch the proxy selector to a given outbound live via the Clash API. */
function setClashSelector(name) {
  return clashApi('PUT', '/proxies/' + encodeURIComponent('🚀 Proxy'), { name });
}

/**
 * Set the proxy mode (rule / global / direct). Persists it, applies it live via
 * the Clash API when running, refreshes the tray, and notifies the renderer.
 */
async function setProxyMode(mode) {
  state.store.updateSettings({ clashMode: mode });
  if (state.singbox.isRunning()) {
    try {
      await clashApi('PATCH', '/configs', { mode });
    } catch (e) {
      /* ignore */
    }
  }
  refreshTray();
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('mode:changed', mode);
  }
  return mode;
}

/** Refresh subscriptions + custom rule-sets whose auto-update interval is due (one tick). */
let autoUpdateRunning = false;
async function autoUpdateTick() {
  if (autoUpdateRunning) return;
  autoUpdateRunning = true;
  try {
    await runAutoUpdateTick();
  } finally {
    autoUpdateRunning = false;
  }
}

async function runAutoUpdateTick() {
  const subs = state.store.get('subscriptions') || [];
  let changed = false;
  let activeConfigChanged = false;
  for (const sub of subs) {
    const mins = parseInt(sub.autoUpdateMinutes || 0, 10);
    if (mins > 0 && sub.url && Date.now() - (sub.updatedAt || 0) >= mins * 60000) {
      try {
        const proxyPort = sub.updateViaProxy ? currentProxyPort() : 0;
        const r = await subscription.fetchSubscription(sub.url, sendLog, { proxyPort });
        if (r.nodes.length) {
          const configChanged =
            JSON.stringify(sub.nodes || []) !== JSON.stringify(r.nodes || []) ||
            JSON.stringify(sub.clashRules || []) !== JSON.stringify(r.rules || []) ||
            JSON.stringify(sub.clashRuleProviders || {}) !== JSON.stringify(r.ruleProviders || {});
          sub.nodes = r.nodes;
          sub.format = r.format;
          sub.clashRules = r.rules || [];
          sub.clashRuleProviders = r.ruleProviders || {};
          sub.raw = r.raw || sub.raw || '';
          sub.userInfo = r.userInfo || sub.userInfo;
          sub.updatedAt = Date.now();
          changed = true;
          if (configChanged && sub.id === getActiveSubId()) activeConfigChanged = true;
          sendLog('[gui] auto-updated config: ' + sub.name);
        }
      } catch (e) {
        sendLog('[gui] auto-update failed for ' + sub.name + ': ' + e.message);
      }
    }
  }
  if (changed) {
    state.store.set('subscriptions', subs);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('subs:changed');
    }
    // The live profile's node list changed: restart so the core serves the
    // same outbounds the UI shows (custom rule-set auto-update already does
    // this; subscriptions must too, or selection/delay tests start failing).
    if (activeConfigChanged) await restartIfRunning();
  }

  // Custom rule-sets on a schedule: re-download + convert, then restart the
  // running core once so the refreshed rules actually apply (same as a manual
  // refresh).
  const crs = state.store.get('customRuleSets') || [];
  let crsChanged = false;
  for (let i = 0; i < crs.length; i++) {
    const c = crs[i];
    const mins = parseInt(c.autoUpdateMinutes || 0, 10);
    if (mins > 0 && c.enabled !== false && c.url && Date.now() - (c.updatedAt || 0) >= mins * 60000) {
      try {
        crs[i] = await processCustomRuleSet(c);
        crsChanged = true;
        sendLog('[gui] auto-updated rule-set: ' + c.name);
      } catch (e) {
        sendLog('[gui] rule-set auto-update failed for ' + c.name + ': ' + e.message);
      }
    }
  }
  if (crsChanged) {
    state.store.set('customRuleSets', crs);
    await restartIfRunning();
  }
}

// Arm the once-a-minute timer only while at least one subscription or custom
// rule-set actually has auto-update enabled; otherwise no periodic wakeup.
let autoUpdateTimer = null;
function rescheduleAutoUpdate() {
  const hasDue = (list) => (list || []).some((x) => parseInt(x.autoUpdateMinutes || 0, 10) > 0 && x.url);
  const need =
    hasDue(state.store.get('subscriptions')) || hasDue(state.store.get('customRuleSets'));
  if (need && !autoUpdateTimer) {
    autoUpdateTimer = setInterval(autoUpdateTick, 60000);
  } else if (!need && autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
}

// Weekly geodata refresh. The rule-sets are bundled (and self-heal on start),
// but stay fresh on their own: once a week re-download geoip-cn/geosite-cn.
const GEO_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
let geoTimer = null;

async function checkGeoUpdate() {
  const checkedKey = 'geoCheckedAt_' + state.singbox.getCoreType().replace(/[^a-z0-9]/gi, '');
  let last = state.store.get(checkedKey) || 0;
  if (!last) {
    // First run on this version: seed the clock from the last known update
    // (or now for bundled geodata) so we don't re-download immediately.
    const meta = state.singbox.geoMeta();
    const stamps = Object.values(meta).map((m) => (m && m.updatedAt) || 0);
    last = Math.max(0, ...stamps) || Date.now();
    state.store.set(checkedKey, last);
  }
  if (Date.now() - last < GEO_UPDATE_INTERVAL_MS) return;
  // Advance the clock first, so a failure retries next week — not every tick.
  state.store.set(checkedKey, Date.now());
  try {
    await state.singbox.updateGeoData(() => {}, currentProxyPort());
    sendLog('[gui] geodata weekly auto-update complete');
    await restartIfRunning();
  } catch (e) {
    sendLog('[gui] geodata weekly auto-update failed: ' + e.message);
  }
}

/** Start the weekly geodata refresh: a check shortly after boot, then every 6h. */
function startGeoAutoUpdate() {
  if (geoTimer) return;
  setTimeout(() => checkGeoUpdate().catch(() => {}), 30000);
  geoTimer = setInterval(() => checkGeoUpdate().catch(() => {}), 6 * 60 * 60 * 1000);
}

// Name of the Windows logon task used for elevated auto-start (see below).
const AUTOSTART_TASK = 'Dart-AutoStart';

/** True if the current Windows process already holds administrator rights. */
function isAdminSync() {
  if (process.platform !== 'win32') return true;
  try {
    const { spawnSync } = require('child_process');
    return spawnSync('net', ['session'], { windowsHide: true }).status === 0;
  } catch (_) {
    return false;
  }
}

/** Set (or clear) the plain HKCU "Run" login item via Electron. */
function setRunItem(enable, silent) {
  app.setLoginItemSettings({
    openAtLogin: !!enable,
    openAsHidden: !!silent,
    path: process.execPath,
    args: silent ? ['--hidden'] : [],
  });
}

/** True if our scheduled logon task exists (read-only query; no elevation). */
function autostartTaskExists() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('schtasks.exe', ['/query', '/tn', AUTOSTART_TASK], {
      windowsHide: true,
      encoding: 'utf-8',
    });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Run a schtasks command, elevating via UAC only when we are not already admin.
 * Returns true on success (exit 0). When `elevate` is true and the user declines
 * UAC, Start-Process throws and PowerShell exits non-zero, so we return false.
 */
function runSchtasks(args, elevate) {
  const { spawnSync } = require('child_process');
  if (!elevate) {
    const r = spawnSync('schtasks.exe', args, { windowsHide: true, encoding: 'utf-8' });
    return !r.error && r.status === 0;
  }
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = `$p = Start-Process -FilePath 'schtasks.exe' -ArgumentList @(${argList}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    windowsHide: true,
    encoding: 'utf-8',
  });
  return !r.error && r.status === 0;
}

/**
 * Task Scheduler XML for a logon task that runs Dart with highest privileges.
 * The command is just the exe path (no --hidden): silent start is driven by the
 * persisted `silentStart` setting at startup, so toggling it never needs the
 * task to be rebuilt. ExecutionTimeLimit is disabled (PT0S) so the long-running
 * GUI is never killed by the default 72h task limit.
 */
function buildAutostartTaskXml() {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME || ''}\\${process.env.USERNAME || ''}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Dart auto-start (elevated for TUN mode)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${esc(process.execPath)}</Command></Exec></Actions>
</Task>`;
}

/** (Re)create the elevated logon task. Returns true on success. */
function createAutostartTask() {
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `dart-autostart-${process.pid}.xml`);
  try {
    // UTF-16LE + BOM (﻿) to match the XML declaration schtasks expects.
    fs.writeFileSync(tmp, '﻿' + buildAutostartTaskXml(), { encoding: 'utf16le' });
    const ok = runSchtasks(['/create', '/tn', AUTOSTART_TASK, '/xml', tmp, '/f'], !isAdminSync());
    sendLog('[gui] autostart task ' + (ok ? '(re)created' : 'create failed'));
    return ok;
  } catch (e) {
    sendLog('[gui] autostart task error: ' + e.message);
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/** Delete the elevated logon task if present. */
function deleteAutostartTask() {
  if (runSchtasks(['/delete', '/tn', AUTOSTART_TASK, '/f'], !isAdminSync())) {
    sendLog('[gui] autostart task removed');
  }
}

/**
 * Windows: pick the auto-launch mechanism. TUN needs administrator rights, and a
 * plain HKCU "Run" entry can never start elevated (by UAC design), so when both
 * auto-launch and TUN are on we register a Task Scheduler logon task with
 * highest privileges instead — it starts Dart elevated at login with no UAC
 * prompt. Creating/removing such a task itself needs admin: when we are already
 * elevated it happens silently; otherwise it costs a single UAC prompt, which we
 * only pay on an explicit user action (`interactive`), never at startup.
 */
function applyAutoLaunchWindows(enable, silent, interactive) {
  const wantTask = !!enable && !!state.store.getSettings().enableTun;
  if (wantTask) {
    const admin = isAdminSync();
    if (admin) {
      // (Re)create silently to keep the stored exe path current (e.g. post-update).
      createAutostartTask();
      setRunItem(false);
      return;
    }
    if (interactive && createAutostartTask()) {
      setRunItem(false);
      return;
    }
    if (autostartTaskExists()) {
      setRunItem(false);
      return;
    }
    // Not elevated and no task yet (e.g. a background startup sync): fall back to
    // a plain Run item so the app still auto-launches; TUN then prompts as before.
    setRunItem(enable, silent);
    return;
  }
  // No elevated task wanted: drop any we created, use the plain Run item.
  if (autostartTaskExists() && (isAdminSync() || interactive)) deleteAutostartTask();
  setRunItem(enable, silent);
}

/**
 * Apply the auto-launch (login item) setting on supported platforms. When
 * `silent` is set, the login launch starts hidden in the tray: pass `--hidden`
 * (read at startup) and openAsHidden (the macOS equivalent). On Windows, an
 * elevated logon task is used instead when TUN is on (see applyAutoLaunchWindows).
 * `interactive` is set for explicit user actions, gating the one-time UAC prompt.
 */
function applyAutoLaunch(enable, silent, { interactive = false } = {}) {
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    // setLoginItemSettings has limited support on plain Linux; best-effort only.
    return;
  }
  if (process.platform === 'win32') {
    applyAutoLaunchWindows(enable, silent, interactive);
    return;
  }
  setRunItem(enable, silent);
}

/**
 * Startup safety net: if a previous run exited uncleanly (crash, force-kill, or
 * a shutdown too fast for cleanup), the Windows system proxy can be left
 * pointing at our local port — which means no network until the app runs again.
 * Always clear it on boot when it still points at us, even when we will
 * auto-resume: the invariant is "system proxy on only while the core runs", and
 * startCore re-asserts the proxy once the core is up. Callers that auto-resume
 * await this first so the clear can't race the re-enable.
 */
async function healStaleSystemProxy() {
  if (process.platform !== 'win32') return;
  try {
    const settings = state.store.getSettings();
    const ours = await proxy.isSystemProxyActive(`127.0.0.1:${settings.mixedPort}`);
    if (ours) {
      await proxy.disableSystemProxy();
      state.systemProxyOn = false;
      sendLog('[gui] cleared a stale system proxy left from a previous session');
    }
  } catch (_) {
    /* best-effort */
  }
}

module.exports = {
  currentProxyPort,
  getActiveSubId,
  activeSubData,
  buildLocalRuleObject,
  splitInlineRule,
  customRuleSetFileName,
  collectCustomRules,
  processCustomRuleSet,
  detectCustomRuleSetFormat,
  normalizeCustomRuleSetFormat,
  buildCurrentConfig,
  currentRouteInfo,
  ruleGroupInfo,
  startCore,
  stopCore,
  restartIfRunning,
  cleanup,
  startProxyGuard,
  stopProxyGuard,
  testNodeDelay,
  clashApi,
  setClashSelector,
  setProxyMode,
  rescheduleAutoUpdate,
  startGeoAutoUpdate,
  applyAutoLaunch,
  healStaleSystemProxy,
};
