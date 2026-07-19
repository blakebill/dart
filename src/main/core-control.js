'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');

const { state, runtimeDir, resourcesBinDir, sendToMain, sendLog, sendStatus, refreshTray } = require('./state');
const { isWindowsAdmin, isWindowsAdminSync, ensureAdminForTun } = require('./admin');
const { startTrafficStream, stopTrafficStream } = require('./traffic');
const { buildRoute, ruleListToSingboxRule, extractRuleGroups, extractGeoCategories, extractRuleSetRefs, parseRuleList } = require('./converter');
const { normalizePolicyGroups } = require('./policy-groups');
const { geoDataUrls } = require('./singbox');
const { getCoreAdapter, normalizeCoreType } = require('./core-adapters');
const { ManagedAutoSelection } = require('./managed-auto-selection');
const { SmartSelectionModel } = require('./smart-selection');
const { OperationCoordinator } = require('./operation-coordinator');
const { createAutoLaunchService } = require('./auto-launch');
const crypto = require('crypto');
const subscription = require('./subscription');
const proxy = require('./proxy');
const fetch = require('./fetch');
const { cleanupTunAdapters, syncTunDisplayName } = require('./tun-adapter');
const { buildDelayApiPath, selectAutoTestBatch } = require('./delay');
const { uniqueSibling, replaceFileSync } = require('./file-utils');

/**
 * Core control: everything that drives the selected proxy core — building the
 * config from the active profile + settings, start/stop/restart, the system
 * proxy guard, the Clash API client, proxy-mode switching, and the
 * subscription auto-update timer.
 */

// Reuse sockets for the frequent Clash API calls (connection polling, latency
// tests) instead of opening a fresh TCP connection each time.
const clashAgent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 2 });
const MAX_CLASH_RESPONSE_BYTES = 32 * 1024 * 1024;
const APP_PROXY_GROUP = '🚀 Proxy';
const AUTO_PROXY_GROUP = '♻️ Auto';
const SMART_PROXY_GROUP = '🧠 Smart';
const MANAGED_AUTO_INTERVAL_MS = 60_000;
const delayRequestCache = new Map();
let tunWasActive = false;
let tunAdaptersClean = false;
const operations = new OperationCoordinator();
let staleProxyHealPromise = null;

function assertLifecycleOpen() {
  operations.assertOpen();
}

/** Serialize persisted config changes through their restart/rollback phase. */
function queueConfigMutation(operation) {
  return operations.queue('config', operation);
}

/** Keep binary rule-set file snapshots ordered without blocking other downloads. */
function queueCustomRuleMutation(operation) {
  return operations.queue('custom-rules', operation);
}

/** Last-started manual update wins; background updates yield to active work. */
function beginRemoteUpdate(scope, id, { background = false } = {}) {
  return operations.beginRemote(scope, id, { background });
}

function assertRemoteUpdate(scope, id, token) {
  operations.assertRemote(scope, id, token);
}

function finishRemoteUpdate(scope, id, token) {
  operations.finishRemote(scope, id, token);
}

function cancelRemoteUpdate(scope, id) {
  operations.cancelRemote(scope, id);
}

function cancelAllRemoteUpdates() {
  operations.cancelAllRemote();
}

function responseLatch(resolve, reject) {
  let settled = false;
  return {
    ok(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    fail(error) {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error || 'request failed')));
    },
  };
}

// Locally served control panel: the active core hosts zashboard at
// http://127.0.0.1:<api-port>/ui/ — the same origin as the Clash API. That
// sidesteps every remote-panel failure mode at once: mixed content, CORS,
// and Chrome blocking public-site requests to 127.0.0.1 ("failed to fetch").
// Both core configs use Zashboard's latest-release URL for the first download.
const PANEL_UI_URL = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';
const SYSTEM_PROXY_OWNER_KEY = 'ownedSystemProxyServer';

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

/** Exact endpoint Dart persisted before changing the Windows proxy registry. */
function persistedSystemProxyOwnership() {
  return state.store ? state.store.get(SYSTEM_PROXY_OWNER_KEY) || null : null;
}

function forgetSystemProxyOwnership(expectedServer = null) {
  if (!state.store) return false;
  const current = persistedSystemProxyOwnership();
  if (expectedServer && current && current !== expectedServer) return false;
  state.store.set(SYSTEM_PROXY_OWNER_KEY, null);
  return true;
}

/** Persist ownership first, so a crash after the registry write is recoverable. */
async function enableOwnedSystemProxy(port) {
  if (process.platform !== 'win32') return false;
  const server = `127.0.0.1:${port}`;
  state.store.set(SYSTEM_PROXY_OWNER_KEY, server);
  try {
    const enabled = await proxy.enableSystemProxy('127.0.0.1', port);
    if (!enabled) {
      forgetSystemProxyOwnership(server);
      return false;
    }
    state.systemProxyOn = true;
    state.systemProxyServer = server;
    return true;
  } catch (error) {
    try { forgetSystemProxyOwnership(server); } catch (recoveryError) { error.recoveryError = recoveryError; }
    throw error;
  }
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

function customRuleSetSourceKey(item) {
  if (!item) return '';
  return JSON.stringify([
    String(item.url || ''),
    normalizeCustomRuleSetFormat(item.format, item.url),
    String(item.target || 'proxy'),
  ]);
}

function mergeProcessedCustomRuleSet(latest, processed) {
  const next = {
    ...latest,
    format: processed.format,
    kind: processed.kind,
    count: processed.count ?? null,
    error: processed.error || null,
    updatedAt: processed.updatedAt || Date.now(),
  };
  delete next.rule;
  delete next.rules;
  if (Object.prototype.hasOwnProperty.call(processed, 'rule')) next.rule = processed.rule;
  if (Object.prototype.hasOwnProperty.call(processed, 'rules')) next.rules = processed.rules;
  return next;
}

function restoreAutoUpdatedSubscription(snapshot, applied) {
  const latest = state.store.getSubscription(snapshot.id, { includeRaw: true });
  if (
    !latest ||
    latest.url !== applied.sourceUrl ||
    latest.updatedAt !== applied.updatedAt ||
    subscription.configFingerprint(latest) !== applied.configHash
  ) {
    throw new Error('config changed again before auto-update rollback');
  }
  state.store.upsertSubscription({
    ...latest,
    nodes: snapshot.nodes || [],
    policyGroups: snapshot.policyGroups || [],
    format: snapshot.format || 'unknown',
    clashRules: snapshot.clashRules || [],
    clashRuleProviders: snapshot.clashRuleProviders || {},
    userInfo: Object.prototype.hasOwnProperty.call(snapshot, 'userInfo') ? snapshot.userInfo : null,
    configHash: snapshot.configHash || subscription.configFingerprint(snapshot),
    updatedAt: snapshot.updatedAt || 0,
    autoUpdateLastAttemptAt: Date.now(),
    raw: Object.prototype.hasOwnProperty.call(snapshot, 'raw') ? snapshot.raw : '',
  });
}

function snapshotFile(target, suffix) {
  const targetExisted = !!(target && fs.existsSync(target));
  let backup = null;
  if (targetExisted) {
    backup = uniqueSibling(target, suffix);
    try {
      fs.linkSync(target, backup);
    } catch (_) {
      fs.copyFileSync(target, backup);
    }
  }
  return { target, backup, targetExisted, appliedFingerprint: null };
}

function discardFileSnapshot(snapshot) {
  if (!snapshot || !snapshot.backup) return;
  try { fs.unlinkSync(snapshot.backup); } catch (_) {}
  snapshot.backup = null;
}

function restoreFileSnapshot(snapshot) {
  if (!snapshot || !snapshot.target) return;
  if (snapshot.targetExisted) {
    if (!snapshot.backup || !fs.existsSync(snapshot.backup)) {
      throw new Error('update rollback file is missing: ' + path.basename(snapshot.target));
    }
    replaceFileSync(snapshot.backup, snapshot.target);
    snapshot.backup = null;
  } else {
    try { fs.unlinkSync(snapshot.target); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function snapshotCustomRuleSetUpdate(record) {
  const binaryTouched = normalizeCustomRuleSetFormat(record.format, record.url) === 'sing-box';
  const target = binaryTouched
    ? path.join(state.singbox.ensureCoreDir('sing-box'), customRuleSetFileName(record.id))
    : null;
  return { record, ...snapshotFile(target, 'auto-update-backup'), applied: null };
}

function discardCustomRuleSetUpdateSnapshot(snapshot) {
  discardFileSnapshot(snapshot);
}

function restoreCustomRuleSetUpdateFile(snapshot) {
  restoreFileSnapshot(snapshot);
}

function restoreAutoUpdatedCustomRuleSets(snapshots) {
  const latestRecords = snapshots.map((snapshot) => {
    const latest = state.store.getCustomRuleSet(snapshot.record.id);
    if (
      !latest ||
      !snapshot.applied ||
      customRuleSetSourceKey(latest) !== snapshot.applied.sourceKey ||
      latest.updatedAt !== snapshot.applied.updatedAt
    ) {
      const error = new Error('remote rule changed again before auto-update rollback');
      error.code = 'DART_UPDATE_SUPERSEDED';
      throw error;
    }
    return latest;
  });

  snapshots.forEach((snapshot, index) => {
    restoreCustomRuleSetUpdateFile(snapshot);
    const previous = snapshot.record;
    state.store.upsertCustomRuleSet({
      ...latestRecords[index],
      format: previous.format,
      kind: previous.kind,
      count: previous.count ?? null,
      error: previous.error || null,
      updatedAt: previous.updatedAt || 0,
      autoUpdateLastAttemptAt: Date.now(),
      rule: previous.rule || null,
      rules: Array.isArray(previous.rules) ? previous.rules : [],
    });
  });
}

/** The id of the subscription (profile) currently in use; falls back to the first. */
let sessionActiveSubId = null;
function getActiveSubId() {
  const subs = state.store.listSubscriptions();
  if (!subs.length) {
    sessionActiveSubId = null;
    return null;
  }
  const active = state.store.get('activeSub');
  if (active && subs.some((s) => s.id === active)) {
    sessionActiveSubId = active;
    return active;
  }
  if (sessionActiveSubId && subs.some((s) => s.id === sessionActiveSubId)) {
    return sessionActiveSubId;
  }
  // Legacy stores (pre-profiles) or a stale pointer: pin the fallback choice.
  // Left unpinned, `activeSub` stays null while the core runs subs[0] — and
  // the next sub:add would silently make the NEW subscription active without
  // a restart (UI shows its nodes, the Clash API doesn't know them: delay
  // tests "time out" and selecting a node fails with 400).
  sessionActiveSubId = subs[0].id;
  try {
    state.store.set('activeSub', sessionActiveSubId);
  } catch (error) {
    // A transient disk failure must not prevent an otherwise valid profile from
    // starting or let a later sub:add switch the live profile in this session.
    sendLog('[gui] failed to persist the active config fallback: ' + error.message);
  }
  return sessionActiveSubId;
}

function persistLastRunning(value) {
  try {
    state.store.set('lastRunning', value);
  } catch (error) {
    // The process has already changed state. Keep renderer/tray state truthful
    // and report only the auto-resume preference write as degraded.
    sendLog('[gui] failed to persist the core auto-resume state: ' + error.message);
  }
}

/** Load the active profile and migrate legacy node names/policy groups. */
function getActiveSubscription() {
  const id = getActiveSubId();
  let sub = id ? state.store.getSubscription(id) : null;
  if (!sub || !Array.isArray(sub.nodes)) return sub;
  let profileMigrated = false;

  // Profiles saved before policy groups were persisted can recover them once
  // from the retained source body, without requiring a network refresh.
  if (!Array.isArray(sub.policyGroups)) {
    profileMigrated = true;
    const source = state.store.getSubscription(id, { includeRaw: true });
    const parsed = source && source.raw ? subscription.parseSubscriptionContent(source.raw) : null;
    if (parsed && parsed.nodes.length) {
      sub = {
        ...sub,
        nodes: parsed.nodes,
        policyGroups: parsed.policyGroups || [],
        clashRules: parsed.rules || [],
        clashRuleProviders: parsed.ruleProviders || {},
      };
    } else {
      sub.policyGroups = [];
    }
  }
  const nodes = subscription.uniqueNodeNames(sub.nodes);
  const policyGroups = normalizePolicyGroups(sub.policyGroups, nodes);
  const nodesChanged = nodes.length !== sub.nodes.length ||
    nodes.some((node, index) => node.name !== (sub.nodes[index] && sub.nodes[index].name));
  const groupsChanged = JSON.stringify(policyGroups) !== JSON.stringify(sub.policyGroups);
  if (profileMigrated || nodesChanged || groupsChanged || !sub.configHash) {
    sub.nodes = nodes;
    sub.policyGroups = policyGroups;
    sub.configHash = subscription.configFingerprint(sub);
    try {
      state.store.upsertSubscription(sub);
    } catch (error) {
      // In-memory normalization is enough to build a valid runtime config. A
      // read-only disk should only postpone this legacy migration, not prevent
      // the otherwise usable profile from starting in the current session.
      sendLog('[gui] failed to persist normalized profile routing: ' + error.message);
    }
  }
  return sub;
}

/** Nodes + policy groups + Clash rules/providers of the active subscription. */
function activeSubData() {
  const sub = getActiveSubscription();
  return {
    nodes: (sub && sub.nodes) || [],
    groups: (sub && sub.policyGroups) || [],
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
function collectCustomRules(coreType = 'sing-box') {
  const adapter = getCoreAdapter(coreType);
  const extraRules = [];
  const extraRuleSets = [];
  for (const lr of state.store.get('localRules') || []) {
    if (lr.enabled === false) continue;
    const rule = buildLocalRuleObject(lr);
    if (rule) extraRules.push(rule);
  }
  for (const meta of state.store.listCustomRuleSets()) {
    if (meta.enabled === false) continue;
    const c = state.store.getCustomRuleSet(meta.id);
    if (!c) continue;
    if (c.kind === 'inline') {
      if (Array.isArray(c.rules) && c.rules.length) {
        for (const rule of c.rules) extraRules.push(rule);
      } else if (c.rule) {
        for (const rule of splitInlineRule(c.rule)) extraRules.push(rule);
      }
    } else if (c.kind === 'ruleset' && adapter.supportsBinaryRuleSets) {
      // Mihomo cannot consume sing-box .srs binaries. Emitting a RULE-SET
      // matcher without a Mihomo rule-provider makes the whole config invalid.
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
async function processCustomRuleSet(c, { beforeCommit } = {}) {
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
      if (beforeCommit) await beforeCommit();
      replaceFileSync(tmp, dest);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return { ...c, format, kind: 'ruleset', count: null, error: null, updatedAt: Date.now() };
  }
  const { body } = await fetch.getBufferWithFallback(c.url, {
    proxyPort,
    maxBytes: 32 * 1024 * 1024,
    headers: { 'User-Agent': 'clash-verge/v2.0.2' },
  });
  const { rule, rules, count } = ruleListToSingboxRule(body.toString('utf-8'), c.target);
  if (!rules.length) throw new Error('no rules parsed from the list (unsupported format?)');
  if (beforeCommit) await beforeCommit();
  return { ...c, format, kind: 'inline', rule, rules, count, error: null, updatedAt: Date.now() };
}

function buildCurrentConfig(coreType = null) {
  const storedSettings = state.store.getSettings();
  const settings = coreType
    ? { ...storedSettings, coreType: normalizeCoreType(coreType) }
    : storedSettings;
  // Use only the active subscription's nodes (profiles are not merged).
  const { nodes: allNodes, groups: allGroups, rules: allRules, providers } = activeSubData();
  if (allNodes.length === 0) {
    throw new Error('No nodes available. Add a config first.');
  }
  // Built-in rules mode: ignore the subscription's own Clash rules (which often
  // route nearly everything through the proxy) and fall back to the app's clean
  // default — CN/private direct, everything else proxied — so the user's local
  // rules and custom rule-sets are what actually steer routing.
  const clashRules = settings.useBuiltinRules ? [] : allRules;
  const policyGroups = settings.useBuiltinRules ? [] : allGroups;
  const { extraRules, extraRuleSets } = collectCustomRules(settings.coreType);
  const adapter = getCoreAdapter(settings.coreType);
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
    policyGroups,
    ruleProviders: providers,
    enableIpv6: settings.enableIpv6,
    dnsRemote: settings.dnsRemote,
    dnsLocal: settings.dnsLocal,
    dnsStrategy: settings.dnsStrategy,
    testUrl: settings.testUrl,
    extraRules,
    extraRuleSets,
  };
  const config = adapter.buildConfig(allNodes, commonOpts, {
    manager: state.singbox,
    ui,
    clashRules,
    providers,
    availableGeoSet,
    loadRuleSetData,
  });
  return { config, settings };
}

/** Build the route info (rules + rule-sets) from the current config, without running. */
function currentRouteInfo() {
  const { nodes, groups, rules, providers } = activeSubData();
  // Mirror buildCurrentConfig: in built-in rules mode the subscription's own
  // rules are dropped so the Rules view shows what actually runs.
  const settings = state.store.getSettings();
  const clashRules = settings.useBuiltinRules ? [] : rules;
  const policyGroups = settings.useBuiltinRules ? [] : normalizePolicyGroups(groups, nodes);
  const availableTargets = new Set([
    AUTO_PROXY_GROUP,
    SMART_PROXY_GROUP,
    '🛟 Fallback',
    ...nodes.map((node) => node && node.name).filter(Boolean),
    ...policyGroups.map((group) => group.name),
  ]);
  const { extraRules, extraRuleSets } = collectCustomRules(settings.coreType);
  // Only the route is needed here, so skip converting every node to an outbound.
  const route = buildRoute({
    ruleSetDir: state.singbox.resolveRuleSetDir(),
    clashRules,
    extraRules,
    extraRuleSets,
    ruleOverrides: settings.ruleOverrides,
    geoAvailable: availableGeoSet(clashRules),
    ruleSetData: loadRuleSetData(clashRules, providers),
    availableTargets,
  });
  return { rules: route.rules, ruleSets: route.rule_set };
}

/**
 * The active subscription's policy groups + the user's current outbound
 * overrides, for the rules UI. Empty when built-in rules mode drops them.
 */
function ruleGroupInfo() {
  const settings = state.store.getSettings();
  if (settings.useBuiltinRules) return { groups: [], sourceTargets: [], overrides: settings.ruleOverrides || {} };
  const data = activeSubData();
  const groups = extractRuleGroups(data.rules);
  const policyGroups = normalizePolicyGroups(data.groups, data.nodes);
  const available = new Set([
    APP_PROXY_GROUP,
    AUTO_PROXY_GROUP,
    SMART_PROXY_GROUP,
    '🛟 Fallback',
    ...data.nodes.map((node) => node && node.name).filter(Boolean),
    ...policyGroups.map((group) => group.name),
  ]);
  return {
    groups,
    sourceTargets: groups.filter((name) => available.has(name)),
    overrides: settings.ruleOverrides || {},
  };
}

async function startCoreNow() {
  assertLifecycleOpen();
  // A fast manual Start can otherwise race the startup stale-proxy cleanup:
  // the cleanup may observe and disable the freshly enabled local proxy.
  if (staleProxyHealPromise) await staleProxyHealPromise;
  assertLifecycleOpen();
  await state.singbox.ensureBundledSingBoxPatch();
  await getCoreAdapter(state.singbox.getCoreType()).prepareStart(state.singbox);
  const { config, settings } = buildCurrentConfig();
  if (settings.enableTun && !(await isWindowsAdmin())) {
    if (await ensureAdminForTun()) return; // relaunching elevated
  }
  if ((settings.enableTun || tunWasActive) && !tunAdaptersClean) {
    tunAdaptersClean = await cleanupTunAdapters(sendLog);
  }
  assertLifecycleOpen();
  await state.singbox.start(config);
  tunWasActive = !!settings.enableTun;
  if (tunWasActive) {
    tunAdaptersClean = false;
    // Renaming is cosmetic and the adapter may appear slightly after the core
    // is ready. Keep it off the user-visible TUN startup path.
    void syncTunDisplayName(sendLog);
  }
  if (settings.autoSetSystemProxy && !settings.enableTun) {
    try {
      const enabled = await enableOwnedSystemProxy(settings.mixedPort);
      if (enabled) startProxyGuard(settings.mixedPort);
    } catch (e) {
      sendLog('[gui] failed to set system proxy: ' + e.message);
    }
  }
  persistLastRunning(true);
  sendStatus();
  startTrafficStream();
  startManagedAutoSelection();
  try {
    maybeFetchGeodata();
    // Pull anything the subscription's rules reference but that isn't on disk
    // yet. This housekeeping is non-fatal and applies on the next start.
    if (getCoreAdapter(settings.coreType).supportsDynamicRuleData) {
      const { rules, providers } = effectiveSub();
      maybeFetchGeoCategories(rules);
      maybeFetchRuleProviders(rules, providers);
    }
  } catch (error) {
    sendLog('[gui] post-start rule data check failed (non-fatal): ' + error.message);
  }
}

// Self-heal for installs that booted without geodata (e.g. dev runs, or a
// build whose bundling didn't land): the config above already degrades
// gracefully (no geoip-cn/geosite-cn rules), so the core is up. Fetch the
// rule-sets in the background — now that the proxy is available — so the next
// start gets the full CN-direct routing. Best-effort and non-blocking; it
// does not restart the running core.
const geodataFetchTried = {};
const backgroundFetchKeys = new Set();
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
  return getCoreAdapter(state.singbox.getCoreType()).geoDataReady(state.singbox);
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
function runBackgroundFetch(label, items, perItem, keyFor) {
  const admitted = [];
  for (const item of items) {
    const key = keyFor ? keyFor(item) : null;
    if (key && backgroundFetchKeys.has(key)) continue;
    if (key) backgroundFetchKeys.add(key);
    admitted.push({ item, key });
  }
  if (!admitted.length) return;
  (async () => {
    let got = 0;
    for (const entry of admitted) {
      try {
        if (await perItem(entry.item)) got += 1;
      } catch (_) {
        /* skip a failed item */
      } finally {
        if (entry.key) backgroundFetchKeys.delete(entry.key);
      }
    }
    if (got) sendLog(`[gui] fetched ${got} ${label}; restart to apply`);
  })().catch((e) => {
    for (const entry of admitted) if (entry.key) backgroundFetchKeys.delete(entry.key);
    sendLog(`[gui] ${label} fetch failed (non-fatal): ` + e.message);
  });
}

/**
 * Download one rule-set .srs (trying each mirror in turn), validating before
 * swapping it into place so a blocked/HTML response never replaces a good file.
 * Returns true when a valid .srs landed at dest.
 */
async function fetchSrs(repo, file, dest, proxyPort) {
  const tmp = uniqueSibling(dest, 'tmp');
  for (const url of geoDataUrls(repo, file)) {
    try {
      await fetch.downloadWithFallback(url, tmp, { proxyPort });
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      continue;
    }
    if (state.singbox._validSrs(tmp)) {
      try {
        replaceFileSync(tmp, dest);
        return true;
      } catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        return false;
      }
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
  runBackgroundFetch(
    'subscription rule-set(s)',
    missing,
    (c) => fetchSrs(c.repo, c.file, path.join(dir, c.file), proxyPort),
    (c) => 'geo:' + path.join(dir, c.file)
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
      maxBytes: 32 * 1024 * 1024,
      headers: { 'User-Agent': 'clash-verge/v2.0.2' },
    });
    const m = parseRuleList(body.toString('utf-8'));
    const total = Object.values(m).reduce((n, a) => n + a.length, 0);
    if (total === 0) return false;
    const tmp = f + `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(m), 'utf-8');
      replaceFileSync(tmp, f);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return true;
  }, ({ f }) => 'provider:' + f);
}

/**
 * Stop the core. When `remember` is true (an explicit user stop) we also clear
 * the auto-resume flag, so the app does not start itself on the next launch.
 */
async function stopCoreNow(remember) {
  // Mark the stop as intentional so the exit handler doesn't fire a "core
  // crashed" notification for a stop/restart we initiated.
  state.coreStopping = true;
  delayRequestCache.clear();
  stopManagedAutoSelection();
  stopTrafficStream();
  stopProxyGuard();
  if (state.systemProxyOn) {
    const ownedServer = state.systemProxyServer || persistedSystemProxyOwnership();
    let released = true;
    try {
      if (ownedServer) await proxy.disableSystemProxyIfOurs(ownedServer);
      else sendLog('[gui] system proxy ownership endpoint is missing; left the current OS proxy unchanged');
    } catch (e) {
      sendLog('[gui] failed to disable system proxy: ' + e.message);
      released = !!ownedServer && proxy.disableSystemProxySyncIfOurs(ownedServer);
      if (released) sendLog('[gui] cleared the system proxy using the synchronous fallback');
      else sendLog('[gui] retained system proxy ownership so shutdown can retry cleanup');
    }
    if (released) {
      try { forgetSystemProxyOwnership(ownedServer); } catch (error) {
        sendLog('[gui] failed to clear persisted system proxy ownership: ' + error.message);
      }
      state.systemProxyOn = false;
      state.systemProxyServer = null;
    }
  }
  try {
    await state.singbox.stop();
    if (tunWasActive) tunAdaptersClean = await cleanupTunAdapters(sendLog);
    tunWasActive = false;
    if (remember) persistLastRunning(false);
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
let proxyGuardGeneration = 0;
let proxyGuardBusy = false;
function startProxyGuard(port) {
  stopProxyGuard();
  const server = '127.0.0.1:' + port;
  const generation = ++proxyGuardGeneration;
  proxyGuard = setInterval(async () => {
    if (!state.systemProxyOn || proxyGuardBusy || generation !== proxyGuardGeneration) return;
    proxyGuardBusy = true;
    try {
      const active = await proxy.isSystemProxyActive(server);
      if (generation !== proxyGuardGeneration || !state.systemProxyOn) return;
      if (!active) {
        const restored = await proxy.enableSystemProxy('127.0.0.1', port);
        if (!restored) return;
        // Stop may have landed while reg.exe was still writing. Clear the
        // just-written value again instead of leaving a dead local proxy.
        if (!state.systemProxyOn) {
          await proxy.disableSystemProxyIfOurs(server);
          return;
        }
        sendLog('[gui] system proxy was changed by another app; restored');
      }
    } catch (_) {
      /* ignore */
    } finally {
      proxyGuardBusy = false;
    }
  }, 30000); // re-assert at most twice a minute (each check spawns reg.exe)
}
function stopProxyGuard() {
  proxyGuardGeneration++;
  if (proxyGuard) {
    clearInterval(proxyGuard);
    proxyGuard = null;
  }
}

// Serialize lifecycle operations from the sidebar, dashboard, settings and
// auto-update paths. Rapid clicks must never spawn two cores or interleave a
// stop halfway through a restart.
let lifecycleTail = Promise.resolve();
function queueLifecycle(operation) {
  const run = lifecycleTail.then(operation, operation);
  lifecycleTail = run.catch(() => {});
  return run;
}

function startCore() {
  try {
    assertLifecycleOpen();
  } catch (error) {
    return Promise.reject(error);
  }
  return queueLifecycle(() => {
    if (state.singbox.isCoreDownloadInProgress()) throw new Error('wait for the core update to finish');
    return state.singbox.isRunning() ? true : startCoreNow();
  });
}

function stopCore(remember, { allowDuringCoreUpdate = false } = {}) {
  return queueLifecycle(() => {
    if (!allowDuringCoreUpdate && state.singbox.isCoreDownloadInProgress()) {
      throw new Error('wait for the core update to finish');
    }
    return stopCoreNow(remember);
  });
}

/** Explicit user restart: stop and start as one lifecycle transaction. */
function restartCore() {
  return queueLifecycle(async () => {
    assertLifecycleOpen();
    if (state.singbox.isCoreDownloadInProgress()) throw new Error('wait for the core update to finish');
    if (state.singbox.isRunning()) await stopCoreNow();
    return startCoreNow();
  });
}

/** Apply a manual system-proxy toggle in the same queue as core start/stop. */
function setSystemProxyEnabled(enable) {
  return queueLifecycle(async () => {
    if (enable) {
      if (!state.singbox.isRunning()) throw new Error('start the core before enabling the system proxy');
      const port = state.store.getSettings().mixedPort;
      const enabled = await enableOwnedSystemProxy(port);
      if (enabled) startProxyGuard(port);
    } else {
      stopProxyGuard();
      const ownedServer = state.systemProxyServer || persistedSystemProxyOwnership();
      if (ownedServer) await proxy.disableSystemProxyIfOurs(ownedServer);
      else if (state.systemProxyOn) {
        sendLog('[gui] system proxy ownership endpoint is missing; left the current OS proxy unchanged');
      }
      try { forgetSystemProxyOwnership(ownedServer); } catch (error) {
        sendLog('[gui] failed to clear persisted system proxy ownership: ' + error.message);
      }
      state.systemProxyOn = false;
      state.systemProxyServer = null;
    }
    sendStatus();
    return state.systemProxyOn;
  });
}

async function cleanup() {
  operations.close();
  stopManagedAutoSelection();
  if (typeof state.cancelPendingUpdates === 'function') {
    await state.cancelPendingUpdates();
  }
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
  if (geoInitialTimer) {
    clearTimeout(geoInitialTimer);
    geoInitialTimer = null;
  }
  if (geoTimer) {
    clearInterval(geoTimer);
    geoTimer = null;
  }
  proxy.beginShutdown();
  await stopCore(undefined, { allowDuringCoreUpdate: true });
  clashAgent.destroy();
}

/** Restart the core if it is running, so config changes (e.g. rules) apply. */
let restartPromise = null;
let restartGeneration = 0;
async function restartIfRunning() {
  restartGeneration += 1;
  if (restartPromise) return restartPromise;
  restartPromise = queueLifecycle(async () => {
    let appliedGeneration = 0;
    let restarts = 0;
    try {
      if (state.singbox.isCoreDownloadInProgress()) throw new Error('wait for the core update to finish');
      while (appliedGeneration !== restartGeneration) {
        appliedGeneration = restartGeneration;
        if (!state.singbox.isRunning()) return false;
        const coreType = state.singbox.getCoreType();
        await getCoreAdapter(coreType).prepareStart(state.singbox);
        const { config } = buildCurrentConfig(coreType);
        await state.singbox.checkConfigFor(coreType, config);
        await stopCoreNow();
        await startCoreNow();
        restarts += 1;
      }
      sendLog(`[gui] core restarted to apply changes${restarts > 1 ? ` (${restarts} passes)` : ''}`);
      return true;
    } catch (e) {
      sendLog('[gui] restart to apply changes failed: ' + e.message);
      sendStatus();
      throw e;
    } finally {
      restartPromise = null;
    }
  });
  return restartPromise;
}

/**
 * Query the latency of a node via the sing-box Clash API.
 * @param {string} name outbound tag (node name)
 * @returns {Promise<number>} delay in ms
 */
function testNodeDelay(name) {
  const settings = state.store.getSettings();
  const testUrl = String(settings.testUrl || '').trim();
  const requestKey = JSON.stringify([state.singbox.getCoreType(), settings.clashApiPort, name, testUrl]);
  const pending = delayRequestCache.get(requestKey);
  if (pending) return pending;

  const request = new Promise((resolve, reject) => {
    const done = responseLatch(resolve, reject);
    // Keep `url` first: this is the documented Clash API shape and avoids older
    // compatibility layers silently falling back to their built-in test URL.
    const reqPath = buildDelayApiPath(name, testUrl);
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
        let bytes = 0;
        let tooLarge = false;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > 1024 * 1024) {
            tooLarge = true;
            done.fail(new Error('delay response too large'));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (tooLarge) return;
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (typeof data.delay === 'number') done.ok(data.delay);
            else done.fail(new Error(data.message || 'timeout'));
          } catch (e) {
            done.fail(new Error('timeout'));
          }
        });
        res.once('aborted', () => done.fail(new Error('delay response aborted')));
        res.once('error', done.fail);
      }
    );
    req.on('error', done.fail);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
  const shared = request.finally(() => {
    if (delayRequestCache.get(requestKey) === shared) delayRequestCache.delete(requestKey);
  });
  delayRequestCache.set(requestKey, shared);
  return shared;
}

/** Generic Clash API request (sing-box external controller). Resolves parsed JSON. */
function clashApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const done = responseLatch(resolve, reject);
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
        res.once('aborted', () => done.fail(new Error('clash api response aborted')));
        res.once('error', done.fail);
        const contentLength = parseInt((res.headers && res.headers['content-length']) || '0', 10);
        if (contentLength > MAX_CLASH_RESPONSE_BYTES) {
          done.fail(new Error('clash api response too large'));
          res.resume();
          return;
        }
        const bodyBuffer = contentLength > 0 ? Buffer.allocUnsafe(contentLength) : null;
        const chunks = bodyBuffer ? null : [];
        let bytes = 0;
        let tooLarge = false;
        res.on('data', (c) => {
          if (tooLarge) return;
          const offset = bytes;
          bytes += c.length;
          if (bytes > MAX_CLASH_RESPONSE_BYTES || (bodyBuffer && bytes > bodyBuffer.length)) {
            tooLarge = true;
            done.fail(new Error('clash api response too large'));
            res.destroy();
            return;
          }
          if (bodyBuffer) c.copy(bodyBuffer, offset);
          else chunks.push(c);
        });
        res.on('end', () => {
          if (tooLarge) return;
          if (bodyBuffer && bytes !== bodyBuffer.length) {
            done.fail(new Error('clash api response ended early'));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return done.fail(new Error('clash api ' + res.statusCode));
          }
          const text = (bodyBuffer || Buffer.concat(chunks)).toString('utf-8');
          try {
            done.ok(text ? JSON.parse(text) : {});
          } catch (e) {
            done.fail(new Error('invalid JSON from Clash API'));
          }
        });
      }
    );
    req.on('error', done.fail);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const managedAutoSelection = new ManagedAutoSelection({
  appGroup: APP_PROXY_GROUP,
  autoGroup: AUTO_PROXY_GROUP,
  clashApi,
  getSettings: () => state.store.getSettings(),
  intervalMs: MANAGED_AUTO_INTERVAL_MS,
  isRunning: () => state.singbox.isRunning(),
  selectBatch: selectAutoTestBatch,
  testDelay: testNodeDelay,
});
const smartSelectionModel = new SmartSelectionModel();

function smartSelectionContextKey() {
  const id = getActiveSubId() || '';
  const profile = id ? state.store.getSubscription(id) : null;
  const fingerprint = profile && (profile.configHash || profile.updatedAt) || '';
  const settings = state.store.getSettings();
  return `${state.singbox.getCoreType()}:${id}:${fingerprint}:${settings.testUrl || ''}`;
}

const managedSmartSelection = new ManagedAutoSelection({
  appGroup: APP_PROXY_GROUP,
  autoGroup: SMART_PROXY_GROUP,
  clashApi,
  getSettings: () => state.store.getSettings(),
  intervalMs: MANAGED_AUTO_INTERVAL_MS,
  isRunning: () => state.singbox.isRunning(),
  selectBatch: selectAutoTestBatch,
  selectCandidate: ({ names, current, measurements }) => smartSelectionModel.choose({
    contextKey: smartSelectionContextKey(),
    names,
    current,
    measurements,
  }),
  testDelay: testNodeDelay,
});

/** Apply the fastest result from the visible node sweep without testing twice. */
function applyMeasuredAutoCandidate(name) {
  return managedAutoSelection.applyMeasuredCandidate(name);
}

function stopManagedAutoSelection() {
  managedAutoSelection.stop();
  managedSmartSelection.stop();
}

function startManagedAutoSelection() {
  managedAutoSelection.start();
  managedSmartSelection.start();
}

/** Switch the outer proxy selector live via the Clash API. */
async function setClashSelector(name) {
  const result = await managedAutoSelection.setOuterSelector(name);
  if (name === SMART_PROXY_GROUP) managedSmartSelection.refresh().catch(() => null);
  return result;
}

/**
 * Set the proxy mode (rule / global / direct). Persists it, applies it live via
 * the Clash API when running, refreshes the tray, and notifies the renderer.
 */
let modeRevision = 0;
function modeChangeNeedsRestart(coreType, currentMode, nextMode) {
  return getCoreAdapter(coreType).modeChangeNeedsRestart(currentMode, nextMode);
}

function setProxyMode(mode) {
  const apply = async () => {
    if (state.singbox.isCoreDownloadInProgress()) throw new Error('wait for the core update to finish');
    const previous = state.store.getSettings().clashMode;
    const running = state.singbox.isRunning();
    const rebuild = modeChangeNeedsRestart(state.singbox.getCoreType(), previous, mode);
    if (running && rebuild) {
      state.store.updateSettings({ clashMode: mode });
      try {
        await restartIfRunning();
      } catch (error) {
        state.store.updateSettings({ clashMode: previous });
        // restartIfRunning stops the old core before starting the rebuilt
        // config. If the new mode fails validation/startup, restore the old
        // mode and bring that known-good configuration back online.
        if (!state.singbox.isRunning()) {
          try {
            await startCore();
          } catch (recoveryError) {
            error.recoveryError = recoveryError;
            sendLog('[gui] failed to restore the previous proxy mode: ' + recoveryError.message);
          }
        }
        throw error;
      }
    } else {
      if (running) await clashApi('PATCH', '/configs', { mode });
      state.store.updateSettings({ clashMode: mode });
    }
    modeRevision += 1;
    refreshTray();
    sendToMain('mode:changed', mode);
    return mode;
  };
  return queueConfigMutation(apply);
}

function getModeRevision() {
  return modeRevision;
}

/** Refresh subscriptions + custom rule-sets whose auto-update interval is due (one tick). */
const AUTO_UPDATE_RETRY_MAX_MS = 5 * 60 * 1000;
function autoUpdateDue(item, minutes, now = Date.now()) {
  const intervalMs = minutes * 60000;
  return minutes > 0 &&
    now - (item.updatedAt || 0) >= intervalMs &&
    now - (item.autoUpdateLastAttemptAt || 0) >= Math.min(intervalMs, AUTO_UPDATE_RETRY_MAX_MS);
}

let autoUpdateRunning = false;
async function autoUpdateTick() {
  if (operations.closing || autoUpdateRunning) return;
  autoUpdateRunning = true;
  try {
    await runAutoUpdateTick();
  } catch (error) {
    // Timer callbacks do not observe returned promises. Keep an unexpected
    // store/network failure from becoming an unhandled rejection.
    sendLog('[gui] automatic update pass failed: ' + error.message);
  } finally {
    autoUpdateRunning = false;
  }
}

async function runAutoUpdateTick() {
  const epoch = operations.remoteEpoch;
  const subs = state.store.listSubscriptions();
  let changed = false;
  let activeConfigChanged = false;
  let activeConfigRollback = null;
  for (const sub of subs) {
    if (epoch !== operations.remoteEpoch) return;
    const mins = parseInt(sub.autoUpdateMinutes || 0, 10);
    if (sub.url && autoUpdateDue(sub, mins)) {
      const token = beginRemoteUpdate('subscription', sub.id, { background: true });
      if (!token) continue;
      let sourceUrl = sub.url;
      try {
        const current = state.store.getSubscription(sub.id);
        if (!current || !current.url) continue;
        sourceUrl = current.url;
        const proxyPort = current.updateViaProxy ? currentProxyPort() : 0;
        const r = await subscription.fetchSubscription(sourceUrl, sendLog, {
          proxyPort,
          coreType: state.store.getSettings().coreType,
          userAgentMode: ['sing-box', 'clash'].includes(current.userAgentMode)
            ? current.userAgentMode
            : 'auto',
        });
        if (!r.nodes.length) throw new Error('no nodes parsed from the updated config');
        const applied = await queueConfigMutation(() => {
          assertRemoteUpdate('subscription', sub.id, token);
          const latest = state.store.getSubscription(current.id);
          if (!latest || latest.url !== sourceUrl) return null;
          const previous = state.store.getSubscription(current.id, { includeRaw: true }) || current;
          const nextHash = subscription.configFingerprint(r);
          const configChanged = (latest.configHash || subscription.configFingerprint(latest)) !== nextHash;
          const updatedAt = Date.now();
          const next = {
            ...latest,
            nodes: r.nodes,
            policyGroups: r.policyGroups || [],
            format: r.format,
            clashRules: r.rules || [],
            clashRuleProviders: r.ruleProviders || {},
            userInfo: r.userInfo || null,
            updatedAt,
            autoUpdateLastAttemptAt: updatedAt,
            configHash: nextHash,
          };
          if (r.raw) next.raw = r.raw;
          state.store.upsertSubscription(next);
          return { next, previous, configChanged, updatedAt, nextHash };
        });
        if (!applied) {
          sendLog('[gui] discarded stale config auto-update: ' + current.name);
          continue;
        }
        changed = true;
        if (applied.configChanged && applied.next.id === getActiveSubId()) {
          activeConfigChanged = true;
          activeConfigRollback = {
            snapshot: applied.previous,
            applied: { sourceUrl, updatedAt: applied.updatedAt, configHash: applied.nextHash },
          };
        }
        sendLog('[gui] auto-updated config: ' + applied.next.name);
      } catch (e) {
        try {
          const recorded = await queueConfigMutation(() => {
            assertRemoteUpdate('subscription', sub.id, token);
            const latest = state.store.getSubscription(sub.id);
            if (!latest || latest.url !== sourceUrl) return false;
            state.store.upsertSubscription({ id: latest.id, autoUpdateLastAttemptAt: Date.now() });
            return true;
          });
          if (!recorded) {
            sendLog('[gui] discarded stale config auto-update error: ' + sub.name);
            continue;
          }
        } catch (_) {
          sendLog('[gui] discarded stale config auto-update error: ' + sub.name);
          continue;
        }
        sendLog('[gui] auto-update failed for ' + sub.name + ': ' + e.message);
      } finally {
        finishRemoteUpdate('subscription', sub.id, token);
      }
    }
  }
  if (changed) {
    sendToMain('subs:changed');
    // The live profile's node list changed: restart so the core serves the
    // same outbounds the UI shows (custom rule-set auto-update already does
    // this; subscriptions must too, or selection/delay tests start failing).
    if (activeConfigChanged) {
      await queueConfigMutation(async () => {
        // A user may have switched profiles while the download was in flight.
        // The updated profile is no longer live, so no restart is needed.
        if (!activeConfigRollback || getActiveSubId() !== activeConfigRollback.snapshot.id) return;
        try {
          await restartIfRunning();
        } catch (error) {
          let recoveryError = null;
          try {
            restoreAutoUpdatedSubscription(activeConfigRollback.snapshot, activeConfigRollback.applied);
            sendToMain('subs:changed');
            sendLog('[gui] restored the previous active config after an auto-update restart failure');
          } catch (restoreError) {
            recoveryError = restoreError;
          }
          if (!state.singbox.isRunning()) {
            try {
              await startCore();
            } catch (startError) {
              if (!recoveryError) recoveryError = startError;
            }
          }
          if (recoveryError) {
            error.recoveryError = recoveryError;
            sendLog('[gui] failed to recover from the config auto-update error: ' + recoveryError.message);
          }
        }
      });
    }
  }

  // Custom rule-sets on a schedule: re-download + convert, then restart the
  // running core once so the refreshed rules actually apply (same as a manual
  // refresh).
  const crs = state.store.listCustomRuleSets();
  let crsChanged = false;
  const crsRollbacks = [];
  for (const c of crs) {
    if (epoch !== operations.remoteEpoch) return;
    const mins = parseInt(c.autoUpdateMinutes || 0, 10);
    if (c.enabled !== false && c.url && autoUpdateDue(c, mins)) {
      await queueCustomRuleMutation(async () => {
        const token = beginRemoteUpdate('rule-set', c.id, { background: true });
        if (!token) return;
        let sourceKey = customRuleSetSourceKey(c);
        let rollback = null;
        let committed = false;
        try {
          const current = state.store.getCustomRuleSet(c.id);
          if (!current || current.enabled === false || !current.url) return;
          sourceKey = customRuleSetSourceKey(current);
          rollback = snapshotCustomRuleSetUpdate(current);
          const assertCurrent = () => {
            assertRemoteUpdate('rule-set', c.id, token);
            const latest = state.store.getCustomRuleSet(c.id);
            if (!latest || customRuleSetSourceKey(latest) !== sourceKey) {
              throw new Error('rule-set changed while auto-update was in progress');
            }
            return latest;
          };
          const processed = await processCustomRuleSet(current, { beforeCommit: assertCurrent });
          const updated = mergeProcessedCustomRuleSet(assertCurrent(), processed);
          updated.autoUpdateLastAttemptAt = updated.updatedAt;
          state.store.upsertCustomRuleSet(updated);
          rollback.applied = { sourceKey, updatedAt: updated.updatedAt };
          crsRollbacks.push(rollback);
          committed = true;
          crsChanged = true;
          sendLog('[gui] auto-updated rule-set: ' + c.name);
        } catch (e) {
          try {
            assertRemoteUpdate('rule-set', c.id, token);
            const latest = state.store.getCustomRuleSet(c.id);
            if (!latest || customRuleSetSourceKey(latest) !== sourceKey) {
              sendLog('[gui] discarded stale rule-set auto-update: ' + c.name);
              return;
            }
            state.store.upsertCustomRuleSet({
              id: latest.id,
              autoUpdateLastAttemptAt: Date.now(),
              error: String(e.message || e).slice(0, 500),
            });
          } catch (_) {
            sendLog('[gui] discarded stale rule-set auto-update: ' + c.name);
            return;
          }
          sendLog('[gui] rule-set auto-update failed for ' + c.name + ': ' + e.message);
        } finally {
          if (!committed && rollback) {
            try {
              restoreCustomRuleSetUpdateFile(rollback);
              discardCustomRuleSetUpdateSnapshot(rollback);
            } catch (restoreError) {
              sendLog('[gui] failed to restore a remote-rule file after update error: ' + restoreError.message);
            }
          }
          finishRemoteUpdate('rule-set', c.id, token);
        }
      });
    }
  }
  if (crsChanged) {
    await queueCustomRuleMutation(() => queueConfigMutation(async () => {
      sendToMain('dialog:changed', { scope: 'rules' });
      let discardSnapshots = true;
      try {
        await restartIfRunning();
      } catch (error) {
        let recoveryError = null;
        try {
          restoreAutoUpdatedCustomRuleSets(crsRollbacks);
          sendToMain('dialog:changed', { scope: 'rules' });
          sendLog('[gui] restored previous remote rules after an auto-update restart failure');
        } catch (restoreError) {
          recoveryError = restoreError;
          // A newer user edit owns the files now, so old snapshots are stale.
          // For an actual I/O failure, preserve the backup as the last good copy.
          discardSnapshots = restoreError.code === 'DART_UPDATE_SUPERSEDED';
        }
        if (!state.singbox.isRunning()) {
          try {
            await startCore();
          } catch (startError) {
            if (!recoveryError) recoveryError = startError;
          }
        }
        if (recoveryError) {
          error.recoveryError = recoveryError;
          sendLog('[gui] failed to recover from the remote-rule auto-update error: ' + recoveryError.message);
        }
      } finally {
        if (discardSnapshots) crsRollbacks.forEach(discardCustomRuleSetUpdateSnapshot);
      }
    }));
  }
}

// Arm the once-a-minute timer only while at least one subscription or custom
// rule-set actually has auto-update enabled; otherwise no periodic wakeup.
let autoUpdateTimer = null;
function rescheduleAutoUpdate() {
  const hasDue = (list) => (list || []).some((x) => parseInt(x.autoUpdateMinutes || 0, 10) > 0 && x.url);
  const need =
    hasDue(state.store.listSubscriptions()) ||
    hasDue(state.store.listCustomRuleSets().filter((item) => item.enabled !== false));
  if (!operations.closing && need && !autoUpdateTimer) {
    autoUpdateTimer = setInterval(autoUpdateTick, 60000);
  } else if (!need && autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
}

// Weekly geodata refresh. The rule-sets are bundled (and self-heal on start),
// but stay fresh on their own: once a week re-download geoip-cn/geosite-cn.
const GEO_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const GEO_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
let geoTimer = null;
let geoInitialTimer = null;

function fileFingerprint(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function snapshotGeoData(coreType) {
  const dir = state.singbox.ensureCoreDir(coreType);
  const snapshots = [];
  try {
    for (const file of getCoreAdapter(coreType).geoDataFiles) {
      snapshots.push(snapshotFile(path.join(dir, file), 'geo-update-backup'));
    }
    return snapshots;
  } catch (error) {
    snapshots.forEach(discardFileSnapshot);
    throw error;
  }
}

function markGeoDataApplied(snapshots) {
  for (const snapshot of snapshots) {
    snapshot.appliedFingerprint = fileFingerprint(snapshot.target);
  }
}

function restoreGeoData(snapshots) {
  for (const snapshot of snapshots) {
    if (fileFingerprint(snapshot.target) !== snapshot.appliedFingerprint) {
      const error = new Error('GeoData changed again before auto-update rollback');
      error.code = 'DART_UPDATE_SUPERSEDED';
      throw error;
    }
  }
  snapshots.forEach(restoreFileSnapshot);
}

async function refreshGeoData(onProgress = () => {}) {
  const coreType = state.singbox.getCoreType();
  const successKey = 'geoUpdatedAt_' + coreType.replace(/[^a-z0-9]/gi, '');
  const snapshots = snapshotGeoData(coreType);
  try {
    const dir = await state.singbox.updateGeoData(onProgress, currentProxyPort());
    markGeoDataApplied(snapshots);
    if (
      !operations.closing &&
      state.singbox.getCoreType() === coreType &&
      state.singbox.isRunning()
    ) {
      try {
        await restartIfRunning();
      } catch (error) {
        let recoveryError = null;
        try {
          restoreGeoData(snapshots);
          sendLog('[gui] restored previous geodata after an update restart failure');
        } catch (restoreError) {
          recoveryError = restoreError;
        }
        if (
          !operations.closing &&
          !state.singbox.isRunning() &&
          state.singbox.getCoreType() === coreType
        ) {
          try {
            await startCore();
          } catch (startError) {
            if (!recoveryError) recoveryError = startError;
          }
        }
        if (recoveryError) {
          error.recoveryError = recoveryError;
          sendLog('[gui] failed to recover from the geodata update error: ' + recoveryError.message);
        }
        throw error;
      }
    }
    state.store.set(successKey, Date.now());
    return dir;
  } finally {
    snapshots.forEach(discardFileSnapshot);
  }
}

async function checkGeoUpdate() {
  if (operations.closing) return;
  const coreType = state.singbox.getCoreType();
  const suffix = coreType.replace(/[^a-z0-9]/gi, '');
  const successKey = 'geoUpdatedAt_' + suffix;
  const attemptKey = 'geoAttemptedAt_' + suffix;
  let lastSuccess = state.store.get(successKey) || 0;
  if (!lastSuccess) {
    // First run on this version: seed the clock from the last known update
    // (or now for bundled geodata) so we don't re-download immediately.
    const meta = state.singbox.geoMeta();
    const stamps = Object.values(meta).map((m) => (m && m.updatedAt) || 0);
    lastSuccess = Math.max(0, ...stamps) || Date.now();
    state.store.set(successKey, lastSuccess);
  }
  const now = Date.now();
  if (now - lastSuccess < GEO_UPDATE_INTERVAL_MS) return;
  if (now - (state.store.get(attemptKey) || 0) < GEO_RETRY_INTERVAL_MS) return;
  state.store.set(attemptKey, now);
  try {
    await refreshGeoData();
    sendLog('[gui] geodata weekly auto-update complete');
  } catch (e) {
    sendLog('[gui] geodata weekly auto-update failed: ' + e.message);
  }
}

/** Start the weekly geodata refresh: a check shortly after boot, then every 6h. */
function startGeoAutoUpdate() {
  if (operations.closing || geoTimer) return;
  geoInitialTimer = setTimeout(() => {
    geoInitialTimer = null;
    checkGeoUpdate().catch(() => {});
  }, 30000);
  geoTimer = setInterval(() => checkGeoUpdate().catch(() => {}), 6 * 60 * 60 * 1000);
}

const autoLaunch = createAutoLaunchService({
  app: require('electron').app,
  getSettings: () => state.store.getSettings(),
  isAdmin: isWindowsAdminSync,
  log: sendLog,
});

function applyAutoLaunch(enable, silent, options) {
  return autoLaunch.apply(enable, silent, options);
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
function healStaleSystemProxy() {
  if (process.platform !== 'win32') return Promise.resolve();
  if (staleProxyHealPromise) return staleProxyHealPromise;
  let tracked;
  tracked = (async () => {
    const server = persistedSystemProxyOwnership();
    if (!/^127\.0\.0\.1:\d{1,5}$/.test(String(server || ''))) {
      if (server) {
        try { forgetSystemProxyOwnership(); } catch (_) {}
        sendLog('[gui] discarded an invalid persisted system proxy ownership record');
      }
      return;
    }
    try {
      const disabled = await proxy.disableSystemProxyIfOurs(server);
      forgetSystemProxyOwnership(server);
      state.systemProxyOn = false;
      state.systemProxyServer = null;
      if (disabled) {
        sendLog('[gui] cleared a stale system proxy left from a previous session');
      }
    } catch (error) {
      // Startup is the one place where a synchronous fallback is preferable to
      // leaving Windows pointed at a dead localhost port after a crash.
      if (proxy.disableSystemProxySyncIfOurs(server)) {
        try { forgetSystemProxyOwnership(server); } catch (_) {}
        state.systemProxyOn = false;
        state.systemProxyServer = null;
        sendLog('[gui] cleared a stale system proxy using the startup fallback');
      } else {
        sendLog('[gui] failed to verify or clear a stale system proxy: ' + error.message);
      }
    }
  })().finally(() => {
    if (staleProxyHealPromise === tracked) staleProxyHealPromise = null;
  });
  staleProxyHealPromise = tracked;
  return tracked;
}

module.exports = {
  currentProxyPort,
  enableOwnedSystemProxy,
  persistedSystemProxyOwnership,
  forgetSystemProxyOwnership,
  beginRemoteUpdate,
  assertRemoteUpdate,
  finishRemoteUpdate,
  cancelRemoteUpdate,
  cancelAllRemoteUpdates,
  queueConfigMutation,
  queueCustomRuleMutation,
  getActiveSubId,
  getActiveSubscription,
  activeSubData,
  buildLocalRuleObject,
  splitInlineRule,
  customRuleSetFileName,
  collectCustomRules,
  processCustomRuleSet,
  detectCustomRuleSetFormat,
  normalizeCustomRuleSetFormat,
  customRuleSetSourceKey,
  mergeProcessedCustomRuleSet,
  buildCurrentConfig,
  currentRouteInfo,
  ruleGroupInfo,
  startCore,
  stopCore,
  restartCore,
  restartIfRunning,
  setSystemProxyEnabled,
  cleanup,
  startProxyGuard,
  stopProxyGuard,
  testNodeDelay,
  applyMeasuredAutoCandidate,
  clashApi,
  setClashSelector,
  setProxyMode,
  getModeRevision,
  modeChangeNeedsRestart,
  rescheduleAutoUpdate,
  refreshGeoData,
  checkGeoUpdate,
  startGeoAutoUpdate,
  applyAutoLaunch,
  healStaleSystemProxy,
};
