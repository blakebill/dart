'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');

const { state, runtimeDir, resourcesBinDir, sendToMain, sendLog, sendStatus, refreshTray } = require('./state');
const { isWindowsAdmin, isWindowsAdminSync, ensureAdminForTun } = require('./admin');
const { startTrafficStream, stopTrafficStream } = require('./traffic');
const {
  buildRoute,
  ruleListToSingboxRule,
  extractRuleGroups,
  extractGeoCategories,
  extractRuleSetRefs,
  parseRuleList,
  coreSupportsKernelSmart,
  prepareSourcePolicyGroups,
  applySourceGroupSelections,
  sourceGroupPickOptions,
  sourcePicksForWiredGroup,
} = require('./converter');
const { normalizePolicyGroups } = require('./policy-groups');
const { geoDataUrls } = require('./singbox');
const { getCoreAdapter, normalizeCoreType } = require('./core-adapters');
const { ManagedAutoSelection } = require('./managed-auto-selection');
const {
  CALIBRATION_OPTION_KEYS,
  SmartSelectionModel,
  ConnectionFeedbackTracker,
  hostnameFromUrl,
} = require('./smart-selection');
const { SmartProbeSignalWeights, buildSmartProbeFamilies } = require('./smart-probe-signals');
const { SmartShadowEvaluator } = require('./smart-shadow-evaluator');
const { KernelDialFeedback } = require('./kernel-dial-feedback');
const { OperationCoordinator } = require('./operation-coordinator');
const { createAutoLaunchService } = require('./auto-launch');
const crypto = require('crypto');
const subscription = require('./subscription');
const proxy = require('./proxy');
const fetch = require('./fetch');
const { cleanupTunAdapters, syncTunDisplayName } = require('./tun-adapter');
const { buildDelayApiPath, selectAutoTestBatch, selectSmartTestBatch } = require('./delay');
const { smartRegionMembers } = require('./node-region');
const os = require('os');
const { uniqueSibling, replaceFileSync, writeJsonAtomicSync } = require('./file-utils');

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
// Non-selected Auto/Smart groups still pre-warm winners, but much less often.
const MANAGED_IDLE_INTERVAL_MS = 4 * 60_000;
const SMART_INTERVAL_URGENT_MS = 30_000;
const SMART_INTERVAL_NORMAL_MS = 60_000;
const SMART_INTERVAL_RELAXED_MS = 150_000;
const SMART_INTERVAL_OVERRIDE_MS = 90_000;
const SMART_FEEDBACK_INTERVAL_MS = 3_000;
const SMART_SHADOW_PERSIST_DELAY_MS = 60_000;
const SMART_SHADOW_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SMART_SHADOW_HISTORY_FILE = 'smart-shadow-history.json';
// Secondary latency URL for Smart dual-probe (A4) — same 204 style as gstatic.
const SMART_SECONDARY_TEST_URL = 'http://cp.cloudflare.com/generate_204';
const OVERRIDE_FAIL_CLEAR_STREAK = 2;
// Secondary Cloudflare probe can reuse a short in-memory cache (not UI delay cache).
const SECONDARY_DELAY_TTL_MS = 90_000;
const SECONDARY_DELAY_FAIL_TTL_MS = 12_000;
let overrideFailStreak = 0;
let managedSelectionSyncRevision = 0;
const secondaryDelayCache = new Map();
const DELAY_RESULT_TTL_MS = 45_000;
const DELAY_FAILURE_TTL_MS = 8_000;
const delayRequestCache = new Map();
// Successful (and briefly failed) delay results shared by Auto + Smart sweeps.
const delayResultCache = new Map();
// Last successful version probe → whether config emits type: smart.
// Used only for diagnostics / optional UI; config path always re-resolves.
let lastKernelSmartMeta = {
  coreType: null,
  version: null,
  kernelSmart: false,
  kernelSmartMode: false,
};
const kernelSmartProbeCache = new Map();
let tunWasActive = false;
let tunAdaptersClean = false;
const operations = new OperationCoordinator();
let staleProxyHealPromise = null;
// When a restart (not an explicit user Stop) tears down the core, remember that
// the system proxy was owned so startCoreNow can re-assert it even if the user
// turned off autoSetSystemProxy and only enabled the proxy manually.
let pendingSystemProxyResume = false;

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
const SYSTEM_PROXY_RESTORE_KEY = 'ownedSystemProxyRestore';

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

function persistedSystemProxyRestore(expectedServer = null) {
  if (!state.store) return null;
  const restore = state.store.get(SYSTEM_PROXY_RESTORE_KEY);
  if (!restore || typeof restore !== 'object') return null;
  if (expectedServer && restore.ownedServer && restore.ownedServer !== expectedServer) return null;
  if (!restore.enable || !restore.server || !restore.override) return null;
  return {
    enable: restore.enable,
    server: restore.server,
    override: restore.override,
  };
}

function forgetSystemProxyOwnership(expectedServer = null) {
  if (!state.store) return false;
  const current = persistedSystemProxyOwnership();
  if (expectedServer && current && current !== expectedServer) return false;
  state.store.set(SYSTEM_PROXY_OWNER_KEY, null);
  try {
    const restore = state.store.get(SYSTEM_PROXY_RESTORE_KEY);
    if (!expectedServer || !restore || !restore.ownedServer || restore.ownedServer === expectedServer) {
      state.store.set(SYSTEM_PROXY_RESTORE_KEY, null);
    }
  } catch (_) {}
  return true;
}

/** Disable our system proxy and restore the user's previous ProxyOverride when known. */
async function disableOwnedSystemProxy(server) {
  if (!server) return false;
  const restore = persistedSystemProxyRestore(server);
  return proxy.disableSystemProxyIfOurs(server, restore ? { restore } : {});
}

/** Persist ownership first, so a crash after the registry write is recoverable. */
async function enableOwnedSystemProxy(port) {
  if (process.platform !== 'win32') return false;
  const server = `127.0.0.1:${port}`;
  const alreadyOwned = persistedSystemProxyOwnership() === server;
  const existingRestore = alreadyOwned ? state.store.get(SYSTEM_PROXY_RESTORE_KEY) : null;
  state.store.set(SYSTEM_PROXY_OWNER_KEY, server);
  try {
    const enabled = await proxy.enableSystemProxy('127.0.0.1', port);
    if (!enabled || enabled.ok === false) {
      forgetSystemProxyOwnership(server);
      return false;
    }
    // Keep the pre-Dart registry snapshot so disable can restore ProxyOverride.
    // Re-asserting an endpoint we already own must not overwrite that snapshot
    // with Dart's own ProxyOverride as if it were the user's original bypass list.
    if (enabled.restore && !(
      existingRestore &&
      existingRestore.ownedServer === server &&
      existingRestore.enable &&
      existingRestore.server &&
      existingRestore.override
    )) {
      try {
        state.store.set(SYSTEM_PROXY_RESTORE_KEY, {
          ownedServer: server,
          enable: enabled.restore.enable,
          server: enabled.restore.server,
          override: enabled.restore.override,
        });
      } catch (error) {
        sendLog('[gui] failed to persist system proxy restore snapshot: ' + error.message);
      }
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

// Hot paths (nodes:get, delay checks, config builds) call getActiveSubscription
// frequently. Re-running uniqueNodeNames + normalizePolicyGroups on multi-hundred
// node profiles dominated main-process time; cache by a cheap store fingerprint.
let activeSubscriptionCache = null;

function activeSubscriptionFingerprint(sub) {
  if (!sub) return '';
  return [
    sub.id || '',
    sub.updatedAt || 0,
    sub.configHash || '',
    Array.isArray(sub.nodes) ? sub.nodes.length : -1,
    Array.isArray(sub.policyGroups) ? sub.policyGroups.length : -1,
    Array.isArray(sub.clashRules) ? sub.clashRules.length : -1,
  ].join('\0');
}

/** Load the active profile and migrate legacy node names/policy groups. */
function getActiveSubscription() {
  const id = getActiveSubId();
  if (!id) {
    activeSubscriptionCache = null;
    return null;
  }
  let sub = state.store.getSubscription(id);
  if (!sub || !Array.isArray(sub.nodes)) {
    activeSubscriptionCache = null;
    return sub;
  }
  const fingerprint = activeSubscriptionFingerprint(sub);
  if (
    activeSubscriptionCache &&
    activeSubscriptionCache.fingerprint === fingerprint &&
    activeSubscriptionCache.sub
  ) {
    return activeSubscriptionCache.sub;
  }

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
  activeSubscriptionCache = {
    fingerprint: activeSubscriptionFingerprint(sub),
    sub,
  };
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

function kernelSmartProbeConfig(coreType, includeMode = false) {
  if (coreType === 'mihomo') {
    const group = {
      name: 'Dart Smart Capability Probe',
      type: 'smart',
      proxies: ['DIRECT'],
      url: 'http://www.gstatic.com/generate_204',
    };
    if (includeMode) group.mode = 'balanced';
    return {
      proxies: [],
      'proxy-groups': [group],
      rules: ['MATCH,Dart Smart Capability Probe'],
    };
  }
  const group = { type: 'smart', tag: 'dart-smart-capability-probe', outbounds: ['direct-probe'] };
  if (includeMode) group.mode = 'balanced';
  return {
    log: { disabled: true },
    outbounds: [
      group,
      { type: 'direct', tag: 'direct-probe' },
    ],
    route: { final: 'dart-smart-capability-probe' },
  };
}

function kernelSmartProbeKey(coreType, coreVersion) {
  const bin = state.singbox.resolveBinaryPath(coreType);
  if (!bin) return null;
  try {
    const stat = fs.statSync(bin);
    return `${coreType}:${bin}:${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return `${coreType}:${bin}:${coreVersion || 'unknown'}`;
  }
}

async function probeKernelSmart(coreType, coreVersion) {
  const fallback = coreSupportsKernelSmart(coreType, coreVersion);
  if (
    !state.singbox.isCoreInstalled(coreType) ||
    typeof state.singbox.checkConfigFor !== 'function'
  ) return { supported: fallback, mode: false, detection: 'version' };
  const key = kernelSmartProbeKey(coreType, coreVersion);
  if (!key) return { supported: fallback, mode: false, detection: 'version' };
  const cached = kernelSmartProbeCache.get(key);
  if (cached) return cached;
  const operation = state.singbox.checkConfigFor(coreType, kernelSmartProbeConfig(coreType, true))
    .then(() => ({ supported: true, mode: true, detection: 'probe' }))
    .catch(() => state.singbox.checkConfigFor(coreType, kernelSmartProbeConfig(coreType, false))
      .then(() => ({ supported: true, mode: false, detection: 'probe' }))
      .catch(() => ({ supported: false, mode: false, detection: 'probe' })));
  if (kernelSmartProbeCache.size >= 16) {
    kernelSmartProbeCache.delete(kernelSmartProbeCache.keys().next().value);
  }
  kernelSmartProbeCache.set(key, operation);
  return operation;
}

/** Resolve type: smart support from the binary itself, not its release suffix. */
async function resolveKernelSmart(coreType = null) {
  const resolvedCoreType = normalizeCoreType(coreType || state.singbox.getCoreType());
  let coreVersion = state.singbox.peekCoreVersion(resolvedCoreType);
  if (coreVersion == null && state.singbox.isCoreInstalled(resolvedCoreType)) {
    try {
      coreVersion = await state.singbox.getCoreVersion(resolvedCoreType);
    } catch (_) {
      coreVersion = null;
    }
  }
  const capability = await probeKernelSmart(resolvedCoreType, coreVersion);
  const kernelSmart = capability.supported;
  const kernelSmartMode = capability.mode;
  lastKernelSmartMeta = {
    coreType: resolvedCoreType,
    version: coreVersion,
    kernelSmart,
    kernelSmartMode,
    detection: capability.detection,
  };
  return lastKernelSmartMeta;
}

function buildCurrentConfig(coreType = null, options = {}) {
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
  const resolvedCoreType = normalizeCoreType(settings.coreType);
  // Prefer explicit meta from resolveKernelSmart(); else peek cache.
  const coreVersion = options.coreVersion !== undefined
    ? options.coreVersion
    : state.singbox.peekCoreVersion(resolvedCoreType);
  const probedCapability = lastKernelSmartMeta.detection === 'probe' &&
    lastKernelSmartMeta.coreType === resolvedCoreType &&
    lastKernelSmartMeta.version === coreVersion;
  const kernelSmart = options.kernelSmart !== undefined
    ? !!options.kernelSmart
    : probedCapability
      ? !!lastKernelSmartMeta.kernelSmart
      : coreSupportsKernelSmart(resolvedCoreType, coreVersion);
  const kernelSmartMode = options.kernelSmartMode !== undefined
    ? !!options.kernelSmartMode
    : probedCapability
      ? !!lastKernelSmartMeta.kernelSmartMode
      : false;
  lastKernelSmartMeta = {
    coreType: resolvedCoreType,
    version: coreVersion,
    kernelSmart,
    kernelSmartMode,
    detection: probedCapability ? 'probe' : 'version',
  };
  const commonOpts = {
    ruleOverrides: settings.ruleOverrides,
    ruleGroupSelections: settings.ruleGroupSelections,
    mixedPort: settings.mixedPort,
    clashApiPort: settings.clashApiPort,
    clashApiSecret: state.clashApiSecret,
    enableTun: settings.enableTun,
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
    smartMode: settings.smartMode,
    smartRegions: settings.smartRegions,
    extraRules,
    extraRuleSets,
    kernelSmart,
    kernelSmartMode,
    coreVersion,
  };
  const config = adapter.buildConfig(allNodes, commonOpts, {
    manager: state.singbox,
    ui,
    clashRules,
    providers,
    availableGeoSet,
    loadRuleSetData,
  });
  return { config, settings, kernelSmart, kernelSmartMode, coreVersion };
}

/** Always probe core version before building (start/export/validate paths). */
async function buildCurrentConfigAsync(coreType = null) {
  const resolved = normalizeCoreType(
    coreType || state.store.getSettings().coreType || state.singbox.getCoreType()
  );
  const meta = await resolveKernelSmart(resolved);
  return buildCurrentConfig(resolved, meta);
}

/** Build the route info (rules + rule-sets) from the current config, without running. */
function currentRouteInfo() {
  const { nodes, groups, rules, providers } = activeSubData();
  // Mirror buildCurrentConfig: in built-in rules mode the subscription's own
  // rules are dropped so the Rules view shows what actually runs.
  const settings = state.store.getSettings();
  const clashRules = settings.useBuiltinRules ? [] : rules;
  // Same folding as runtime config: main-proxy aliases (e.g. "Proxy") are not
  // freestanding source targets and must not appear as available outbounds.
  const policyGroups = settings.useBuiltinRules ? [] : prepareSourcePolicyGroups(groups, nodes);
  const availableTargets = new Set([
    AUTO_PROXY_GROUP,
    SMART_PROXY_GROUP,
    '🛟 Fallback',
    APP_PROXY_GROUP,
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
  if (settings.useBuiltinRules) {
    return {
      groups: [],
      sourceTargets: [],
      selectableTargets: [],
      overrides: settings.ruleOverrides || {},
      selections: settings.ruleGroupSelections || {},
      pickOptions: [],
      picksByGroup: {},
      defaults: {},
    };
  }
  const data = activeSubData();
  const groups = extractRuleGroups(data.rules);
  const policyGroups = prepareSourcePolicyGroups(data.groups, data.nodes);
  const wired = applySourceGroupSelections(
    policyGroups,
    data.nodes,
    settings.ruleGroupSelections
  );
  const byName = new Map(wired.map((group) => [group.name, group]));
  const available = new Set([
    APP_PROXY_GROUP,
    AUTO_PROXY_GROUP,
    SMART_PROXY_GROUP,
    '🛟 Fallback',
    ...data.nodes.map((node) => node && node.name).filter(Boolean),
    ...policyGroups.map((group) => group.name),
  ]);
  const sourceTargets = groups.filter((name) => available.has(name));
  // Only plain select groups expose a node picker; url-test/fallback keep force modes only.
  const selectableTargets = sourceTargets.filter((name) => {
    const group = byName.get(name);
    return group && (group.type === 'select' || group.type === 'selector');
  });
  const defaults = {};
  const picksByGroup = {};
  for (const name of selectableTargets) {
    const group = byName.get(name);
    if (group && group.default) defaults[name] = group.default;
    picksByGroup[name] = sourcePicksForWiredGroup(group);
  }
  return {
    groups,
    sourceTargets,
    selectableTargets,
    overrides: settings.ruleOverrides || {},
    selections: settings.ruleGroupSelections || {},
    pickOptions: sourceGroupPickOptions(data.nodes, policyGroups),
    picksByGroup,
    defaults,
  };
}

/** Persist a source-group outbound pick and apply it live via the Clash API when possible. */
async function setRuleGroupSelection(groupName, outbound) {
  const name = String(groupName || '').trim();
  const target = String(outbound || '').trim();
  if (!name || name.length > 256 || /[\r\n,]/.test(name)) throw new Error('invalid group');
  if (!target || target.length > 256 || /[\r\n,]/.test(target)) throw new Error('invalid outbound');
  const info = ruleGroupInfo();
  if (!info.selectableTargets.includes(name)) throw new Error('group is not selectable');
  const allowed = new Set([
    ...((info.picksByGroup && info.picksByGroup[name]) || info.pickOptions || []),
  ]);
  const normalized = target === 'DIRECT' ? 'direct'
    : (target === 'REJECT' || target === 'REJECT-DROP') ? 'reject'
      : target;
  if (!allowed.has(normalized) && !allowed.has(target)) {
    throw new Error('outbound is not available');
  }
  const previous = state.store.getSettings();
  const nextSelections = { ...(previous.ruleGroupSelections || {}) };
  // Store empty omission when equal to computed default without explicit user... always store explicit picks.
  nextSelections[name] = normalized === 'direct' ? 'direct' : normalized;
  const settings = state.store.updateSettings({ ruleGroupSelections: nextSelections });
  if (!state.singbox.isRunning()) return { settings, applied: true, live: false };
  try {
    const candidates = normalized === 'direct' ? ['direct', 'DIRECT']
      : normalized === 'reject' ? ['reject', 'REJECT']
        : [normalized];
    let lastError = null;
    for (const liveName of candidates) {
      try {
        await clashApi('PUT', '/proxies/' + encodeURIComponent(name), { name: liveName });
        return { settings, applied: true, live: true };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('failed to apply group selection');
  } catch (error) {
    // Config may predate enriched members — caller can restart. Selection is still persisted.
    return { settings, applied: false, live: false, error: error.message || String(error) };
  }
}

async function startCoreNow() {
  assertLifecycleOpen();
  // A fast manual Start can otherwise race the startup stale-proxy cleanup:
  // the cleanup may observe and disable the freshly enabled local proxy.
  if (staleProxyHealPromise) await staleProxyHealPromise;
  assertLifecycleOpen();
  await state.singbox.ensureBundledSingBoxPatch();
  const coreType = state.singbox.getCoreType();
  await getCoreAdapter(coreType).prepareStart(state.singbox);
  const { config, settings } = await buildCurrentConfigAsync(coreType);
  if (settings.enableTun && !(await isWindowsAdmin())) {
    if (await ensureAdminForTun()) return; // relaunching elevated
  }
  if ((settings.enableTun || tunWasActive) && !tunAdaptersClean) {
    tunAdaptersClean = await cleanupTunAdapters(sendLog);
  }
  assertLifecycleOpen();
  await state.singbox.start(config);
  kernelDialFeedback.reset();
  tunWasActive = !!settings.enableTun;
  if (tunWasActive) {
    tunAdaptersClean = false;
    // Renaming is cosmetic and the adapter may appear slightly after the core
    // is ready. Keep it off the user-visible TUN startup path.
    void syncTunDisplayName(sendLog);
  }
  const resumeSystemProxy = pendingSystemProxyResume;
  pendingSystemProxyResume = false;
  if (!settings.enableTun && (settings.autoSetSystemProxy || resumeSystemProxy)) {
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
async function stopCoreNow(remember, { preserveSystemProxyIntent = false } = {}) {
  // Mark the stop as intentional so the exit handler doesn't fire a "core
  // crashed" notification for a stop/restart we initiated.
  state.coreStopping = true;
  delayRequestCache.clear();
  delayResultCache.clear();
  stopManagedAutoSelection();
  stopTrafficStream();
  stopProxyGuard();
  const persistedOwnedProxy = persistedSystemProxyOwnership();
  const hadOwnedProxy = state.systemProxyOn || !!persistedOwnedProxy;
  // Restarts must re-assert a manually enabled system proxy; explicit Stop must
  // not leave a resume intent that would surprise the user on the next Start.
  pendingSystemProxyResume = !!(preserveSystemProxyIntent && hadOwnedProxy);
  if (state.systemProxyOn || persistedOwnedProxy) {
    const ownedServer = state.systemProxyServer || persistedOwnedProxy;
    let released = true;
    try {
      if (ownedServer) await disableOwnedSystemProxy(ownedServer);
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
    kernelDialFeedback.reset();
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
        if (!restored || restored.ok === false) return;
        // Stop may have landed while reg.exe was still writing. Clear the
        // just-written value again instead of leaving a dead local proxy.
        if (!state.systemProxyOn) {
          await disableOwnedSystemProxy(server);
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
    if (state.singbox.isRunning()) await stopCoreNow(undefined, { preserveSystemProxyIntent: true });
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
      pendingSystemProxyResume = false;
      if (ownedServer) await disableOwnedSystemProxy(ownedServer);
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
  flushSmartShadowHistory();
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
        const { config } = await buildCurrentConfigAsync(coreType);
        await state.singbox.checkConfigFor(coreType, config);
        await stopCoreNow(undefined, { preserveSystemProxyIntent: true });
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

function delayResultKey(name, contextKey = smartSelectionContextKey(), testUrl = null) {
  const settings = state.store.getSettings();
  const identity = activeSmartNodeIdentities().get(name) || name;
  return JSON.stringify([
    contextKey,
    String(testUrl == null ? settings.testUrl || '' : testUrl).trim(),
    identity,
  ]);
}

function readDelayResultCache(key) {
  const hit = delayResultCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    delayResultCache.delete(key);
    return null;
  }
  return hit;
}

function writeDelayResultCache(key, delay) {
  if (delayResultCache.size >= 2048) {
    let drop = 256;
    for (const key of delayResultCache.keys()) {
      delayResultCache.delete(key);
      if (--drop <= 0) break;
    }
  }
  // Clash-compatible cores may encode a timeout as delay: 0. A measured RTT
  // is always positive, so never cache zero as a successful/fast result.
  const ok = Number.isFinite(delay) && delay > 0;
  delayResultCache.set(key, {
    delay: ok ? Number(delay) : null,
    expires: Date.now() + (ok ? DELAY_RESULT_TTL_MS : DELAY_FAILURE_TTL_MS),
  });
}

function networkFingerprint() {
  const now = Date.now();
  if (networkFingerprint.cached && networkFingerprint.expires > now) {
    return networkFingerprint.cached;
  }
  try {
    const nics = os.networkInterfaces() || {};
    const parts = [];
    for (const [name, addrs] of Object.entries(nics)) {
      // App-owned tunnel adapters appear after the core starts and must not
      // masquerade as a physical network change.
      if (/(^|[\s_-])(dart|tun\d*|meta|sing-tun|wintun)([\s_-]|$)/i.test(name)) continue;
      const usable = (addrs || []).filter((addr) => {
        if (!addr || addr.internal) return false;
        const address = String(addr.address || '').toLowerCase();
        if (!address || address.startsWith('169.254.') || address.startsWith('fe80:')) return false;
        return true;
      });
      const hasIpv4 = usable.some((addr) => String(addr.family).toLowerCase() === 'ipv4' || addr.family === 4);
      for (const addr of usable) {
        const family = String(addr.family).toLowerCase();
        // IPv6 privacy addresses rotate independently of the actual network.
        // Prefer the stable IPv4 identity when an interface has both.
        if (hasIpv4 && (family === 'ipv6' || addr.family === 6)) continue;
        parts.push(`${name}|${addr.mac || ''}|${family}|${addr.address}`);
      }
    }
    networkFingerprint.cached = parts.sort().join(';') || 'none';
  } catch (_) {
    networkFingerprint.cached = 'unknown';
  }
  networkFingerprint.expires = now + 5_000;
  return networkFingerprint.cached;
}
networkFingerprint.cached = null;
networkFingerprint.expires = 0;

function ensureSmartModelContext() {
  const key = smartSelectionContextKey();
  smartSelectionModel.setMode(state.store.getSettings().smartMode);
  if (smartSelectionModel.contextKey !== key) {
    smartSelectionModel.clear(key);
    appliedSmartIdentities = null;
    connectionFeedbackTracker.reset();
  }
  const identities = activeSmartNodeIdentities();
  if (appliedSmartIdentities !== identities) {
    if (appliedSmartIdentities) connectionFeedbackTracker.reset();
    smartSelectionModel.setNodeIdentities(identities);
    appliedSmartIdentities = identities;
  }
  smartSelectionModel.setNetworkKey(networkFingerprint());
  ensureSmartShadowContext(key);
}

/**
 * Query the latency of a node via the sing-box Clash API.
 * Results are shared across Auto/Smart sweeps for a short TTL. A standalone
 * probe updates the UI delay only; Smart route history requires dual-source
 * measurements from testNodeDelayDual.
 * @param {string} name outbound tag (node name)
 * @param {{ force?: boolean }} [options] `force: true` skips the result cache
 *   (used by explicit UI tests so a click always re-probes).
 * @returns {Promise<number>} delay in ms
 */
function testNodeDelay(name, options = {}) {
  const force = !!(options && options.force);
  const skipObserve = !!(options && options.skipObserve);
  const skipResultCache = !!(options && (options.skipResultCache || options.url));
  const resultMeta = options && options.resultMeta && typeof options.resultMeta === 'object'
    ? options.resultMeta
    : null;
  const timeoutMs = Math.max(2_000, Math.min(30_000, Number(options.timeoutMs) || 8_000));
  const settings = state.store.getSettings();
  const contextKey = smartSelectionContextKey();
  const testUrl = String(options.url || settings.testUrl || '').trim();
  const resultKey = delayResultKey(name, contextKey, settings.testUrl || '');
  if (!force && !skipResultCache) {
    const cached = readDelayResultCache(resultKey);
    if (cached) {
      if (resultMeta) resultMeta.fresh = false;
      if (cached.delay != null) return Promise.resolve(cached.delay);
      const error = new Error('timeout');
      error.fresh = false;
      return Promise.reject(error);
    }
  } else if (!skipResultCache) {
    // Drop any stale success/failure so concurrent background readers also refresh.
    delayResultCache.delete(resultKey);
  }

  // Coalesce concurrent probes of the same node (force or not); only the
  // result-cache short-circuit is skipped when force is set.
  const requestKey = JSON.stringify([
    contextKey,
    settings.clashApiPort,
    activeSmartNodeIdentities().get(name) || name,
    testUrl,
    skipObserve ? 1 : 0,
  ]);
  const pending = delayRequestCache.get(requestKey);
  if (pending) {
    if (resultMeta) resultMeta.fresh = true;
    return pending;
  }
  if (resultMeta) resultMeta.fresh = true;

  const request = new Promise((resolve, reject) => {
    const done = responseLatch(resolve, reject);
    // Keep `url` first: this is the documented Clash API shape and avoids older
    // compatibility layers silently falling back to their built-in test URL.
    const reqPath = buildDelayApiPath(name, testUrl, timeoutMs);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: settings.clashApiPort,
        path: reqPath,
        method: 'GET',
        timeout: timeoutMs + 2_000,
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
            if (Number.isFinite(data.delay) && data.delay > 0) done.ok(data.delay);
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
  const shared = request.then(
    (delay) => {
      if (!skipResultCache) writeDelayResultCache(resultKey, delay);
      if (!skipObserve && smartSelectionContextKey() === contextKey) {
        try {
          ensureSmartModelContext();
          if (smartSelectionModel.contextKey === contextKey) {
            smartSelectionModel.observeDisplayDelay(name, delay);
          }
        } catch (_) {}
      }
      return delay;
    },
    (error) => {
      if (!skipResultCache) writeDelayResultCache(resultKey, null);
      if (!skipObserve && smartSelectionContextKey() === contextKey) {
        try {
          ensureSmartModelContext();
          if (smartSelectionModel.contextKey === contextKey) {
            smartSelectionModel.observeDisplayDelay(name, null);
          }
        } catch (_) {}
      }
      throw error;
    }
  ).finally(() => {
    if (delayRequestCache.get(requestKey) === shared) delayRequestCache.delete(requestKey);
  });
  delayRequestCache.set(requestKey, shared);
  return shared;
}

/** Smart quality grades for the active profile's nodes (UI badge). */
function smartNodeQualities() {
  ensureSmartModelContext();
  const sub = getActiveSubscription();
  const names = ((sub && sub.nodes) || []).map((node) => node && node.name).filter(Boolean);
  return smartSelectionModel.qualities(names);
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

const smartSelectionModel = new SmartSelectionModel();
const connectionFeedbackTracker = new ConnectionFeedbackTracker();
const smartProbeSignalWeights = new SmartProbeSignalWeights();
const smartShadowEvaluator = new SmartShadowEvaluator();
const kernelDialFeedback = new KernelDialFeedback();
let smartIdentityCache = { subscription: null, identities: new Map() };
let smartProbeFamilyCache = { subscription: null, families: new Map() };
let appliedSmartIdentities = null;
let smartFeedbackTimer = null;
let smartFeedbackRun = null;
let smartFeedbackGeneration = 0;
let smartShadowLoadedPath = null;
let smartShadowPersistTimer = null;
let smartShadowPersistFailed = false;

function smartSelectionContextKey() {
  const id = getActiveSubId() || '';
  const settings = state.store.getSettings();
  return `${state.singbox.getCoreType()}:${id}:${settings.testUrl || ''}`;
}

function smartShadowHistoryPath() {
  const dir = state.store && typeof state.store.dir === 'string'
    ? state.store.dir
    : '';
  return dir ? path.join(dir, SMART_SHADOW_HISTORY_FILE) : '';
}

function loadSmartShadowHistory() {
  const file = smartShadowHistoryPath();
  if (!file || smartShadowLoadedPath === file) return;
  smartShadowLoadedPath = file;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > SMART_SHADOW_MAX_FILE_BYTES) return;
    smartShadowEvaluator.restore(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (_) {
    // History is advisory. A missing/corrupt sidecar must never affect routing.
  }
}

function flushSmartShadowHistory() {
  if (smartShadowPersistTimer) clearTimeout(smartShadowPersistTimer);
  smartShadowPersistTimer = null;
  const file = smartShadowHistoryPath();
  if (!file || smartShadowLoadedPath !== file) return false;
  try {
    const snapshot = smartShadowEvaluator.snapshot();
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf-8') > SMART_SHADOW_MAX_FILE_BYTES) {
      return false;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomicSync(file, snapshot);
    smartShadowPersistFailed = false;
    return true;
  } catch (error) {
    if (!smartShadowPersistFailed) {
      smartShadowPersistFailed = true;
      sendLog('[gui] local Smart shadow history could not be saved: ' + error.message);
    }
    return false;
  }
}

function scheduleSmartShadowPersist() {
  if (smartShadowPersistTimer || !smartShadowHistoryPath()) return;
  smartShadowPersistTimer = setTimeout(
    flushSmartShadowHistory,
    SMART_SHADOW_PERSIST_DELAY_MS
  );
  if (smartShadowPersistTimer.unref) smartShadowPersistTimer.unref();
}

function smartShadowHash(namespace, value) {
  return crypto
    .createHash('sha256')
    .update(`${namespace}\0${String(value || '')}`)
    .digest('hex')
    .slice(0, 24);
}

function smartShadowNetworkKey() {
  return smartShadowHash('network', networkFingerprint());
}

function smartShadowContextKey(contextKey = smartSelectionContextKey()) {
  // The production context contains subscription IDs and a probe URL. Shadow
  // replay only needs a stable namespace, so never persist those raw values.
  return smartShadowHash('context', contextKey || 'default');
}

function smartShadowNodeKey(name) {
  if (typeof name !== 'string' || !name) return '';
  const identity = activeSmartNodeIdentities().get(name) || name;
  return smartShadowHash('node', identity);
}

function smartShadowLegacyOptions() {
  // These switches are intentionally local to shadow models. Production keeps
  // every current feature enabled; the legacy arm exists only as a benchmark.
  return {
    routeChangeDetection: false,
    multiSignalHealth: false,
  };
}

function applySmartShadowCalibration(calibration) {
  if (typeof smartSelectionModel.setCalibrationOptions !== 'function') return false;
  const desired = calibration && typeof calibration === 'object' ? calibration : {};
  const current = smartSelectionModel.calibrationOptions || {};
  const patch = {};
  for (const key of CALIBRATION_OPTION_KEYS || []) {
    if (Object.prototype.hasOwnProperty.call(desired, key)) {
      patch[key] = desired[key];
    } else if (Object.prototype.hasOwnProperty.call(current, key)) {
      patch[key] = null;
    }
  }
  return Object.keys(patch).length > 0
    ? smartSelectionModel.setCalibrationOptions(patch)
    : false;
}

function ensureSmartShadowContext(contextKey = smartSelectionContextKey()) {
  loadSmartShadowHistory();
  const baseOptions = typeof smartSelectionModel.getUncalibratedOptions === 'function'
    ? smartSelectionModel.getUncalibratedOptions()
    : smartSelectionModel.options;
  const summary = smartShadowEvaluator.configure({
    contextKey: smartShadowContextKey(contextKey),
    mode: smartSelectionModel.mode,
    baseOptions,
    legacyOptions: smartShadowLegacyOptions(),
  });
  if (summary) applySmartShadowCalibration(summary.calibration);
}

function recordSmartShadowRound({
  contextKey,
  names,
  current,
  measurements,
  productionPick,
  now = Date.now(),
}) {
  ensureSmartShadowContext(contextKey);
  const shadowNames = (names || []).map(smartShadowNodeKey);
  const shadowMeasurements = (measurements || []).map((measurement) => ({
    ...measurement,
    name: smartShadowNodeKey(measurement && measurement.name),
  }));
  const result = smartShadowEvaluator.recordRound({
    contextKey: smartShadowContextKey(contextKey),
    networkKey: smartShadowNetworkKey(),
    names: shadowNames,
    current: current ? smartShadowNodeKey(current) : null,
    measurements: shadowMeasurements,
    productionPick: productionPick ? smartShadowNodeKey(productionPick) : null,
    now,
  });
  const calibration = result && result.calibration;
  if (
    calibration &&
    calibration.patch &&
    typeof smartSelectionModel.setCalibrationOptions === 'function'
  ) {
    const changed = applySmartShadowCalibration(calibration.patch);
    if (changed) {
      sendLog(`[gui] Smart shadow calibration applied (${calibration.variant})`);
    }
  }
  scheduleSmartShadowPersist();
  return result;
}

function observeSmartShadowConnection(event, now = Date.now()) {
  ensureSmartShadowContext();
  if (smartShadowEvaluator.observeConnection({
    ...event,
    name: smartShadowNodeKey(event && event.name),
  }, now)) {
    scheduleSmartShadowPersist();
  }
}

function activeSmartNodeIdentities() {
  const active = getActiveSubscription();
  if (smartIdentityCache.subscription === active) return smartIdentityCache.identities;
  const identities = new Map();
  const duplicates = new Map();
  for (const node of (active && active.nodes) || []) {
    if (!node || typeof node.name !== 'string' || !node.name) continue;
    const base = subscription.nodeFingerprint(node) || node.name;
    const occurrence = (duplicates.get(base) || 0) + 1;
    duplicates.set(base, occurrence);
    identities.set(node.name, occurrence === 1 ? base : `${base}:${occurrence}`);
  }
  smartIdentityCache = { subscription: active, identities };
  return identities;
}

function activeSmartProbeFamilies() {
  const active = getActiveSubscription();
  if (smartProbeFamilyCache.subscription === active) return smartProbeFamilyCache.families;
  const nodes = (active && active.nodes) || [];
  const families = buildSmartProbeFamilies(
    nodes,
    nodes.map((node) => node && node.name).filter(Boolean)
  );
  smartProbeFamilyCache = { subscription: active, families };
  return families;
}

/**
 * Pull the custom-kernel's bounded real dial events when available. Official
 * kernels return 404 and transparently keep using /connections feedback.
 */
async function harvestKernelDialFeedback(nodeNames, contextKey) {
  const result = await kernelDialFeedback.poll(
    (apiPath) => clashApi('GET', apiPath),
    {
      allowedNames: new Set(nodeNames),
      group: SMART_PROXY_GROUP,
      now: Date.now(),
    }
  );
  if (smartSelectionContextKey() !== contextKey) {
    return { ...result, events: [] };
  }
  const preferred = getManagedSmartPreferred();
  let preferredFailed = false;
  for (const event of result.events || []) {
    try { smartSelectionModel.observeConnection(event); } catch (_) { /* advisory */ }
    try { observeSmartShadowConnection(event); } catch (_) { /* advisory */ }
    if (
      (event.kind === 'dialFailure' || event.kind === 'softFail') &&
      event.name === preferred &&
      typeof smartSelectionModel.isConnectionUnavailable === 'function' &&
      smartSelectionModel.isConnectionUnavailable(preferred)
    ) {
      preferredFailed = true;
    }
  }
  if (preferredFailed && managedSmartSelection.isActive()) {
    // The kernel already failed over this one dial. Prompt the GUI's long-term
    // model now as well instead of waiting out a previously relaxed timer.
    queueMicrotask(() => {
      if (
        !state.singbox.isRunning() ||
        !managedSmartSelection.isActive() ||
        smartSelectionContextKey() !== contextKey
      ) return;
      managedSmartSelection.refresh({ force: true }).catch(() => null);
    });
  }
  return result;
}

/**
 * Fold real kernel dial outcomes plus Clash /connections traffic into Smart.
 * Destination addresses never leave the core; only node-level health is used.
 */
async function harvestConnectionFeedback() {
  if (!state.singbox.isRunning()) return 0;
  ensureSmartModelContext();
  const contextKey = smartSelectionContextKey();
  const settings = state.store.getSettings();
  const extraIgnore = [];
  const host = hostnameFromUrl(settings.testUrl);
  if (host) extraIgnore.push(host);
  const secondaryHost = hostnameFromUrl(SMART_SECONDARY_TEST_URL);
  if (secondaryHost) extraIgnore.push(secondaryHost);
  connectionFeedbackTracker.setIgnoreHosts(extraIgnore);
  const nodeNames = configuredManagedGroupNames(SMART_PROXY_GROUP);
  const dialResult = await harvestKernelDialFeedback(nodeNames, contextKey);
  let data;
  try {
    data = await clashApi('GET', '/connections');
  } catch (_) {
    return (dialResult.events || []).length;
  }
  if (smartSelectionContextKey() !== contextKey) return 0;
  connectionFeedbackTracker.setNodeNames(nodeNames);
  const connections = Array.isArray(data && data.connections) ? data.connections : [];
  let events = connectionFeedbackTracker.ingest(connections, Date.now());
  // A custom kernel reports the actual dial failure directly. Keep traffic and
  // completed-connection evidence, but avoid counting the heuristic short-life
  // detector as a second copy of the same failure.
  if (dialResult.available === true) {
    events = events.filter((event) => event.kind !== 'softFail');
  }
  for (const event of events) {
    try { smartSelectionModel.observeConnection(event); } catch (_) { /* ignore */ }
    try { observeSmartShadowConnection(event); } catch (_) { /* ignore */ }
  }
  return (dialResult.events || []).length + events.length;
}

function stopSmartFeedbackSampler() {
  smartFeedbackGeneration += 1;
  if (smartFeedbackTimer) clearTimeout(smartFeedbackTimer);
  smartFeedbackTimer = null;
  smartFeedbackRun = null;
  connectionFeedbackTracker.reset();
}

/** Sample local Clash connection snapshots only while Smart carries traffic. */
function setSmartFeedbackSamplerActive(active) {
  if (!active || !state.singbox.isRunning()) {
    stopSmartFeedbackSampler();
    return;
  }
  if (smartFeedbackTimer || smartFeedbackRun) return;
  const generation = ++smartFeedbackGeneration;
  const schedule = (delayMs) => {
    if (generation !== smartFeedbackGeneration) return;
    smartFeedbackTimer = setTimeout(tick, Math.max(0, Number(delayMs) || 0));
    if (smartFeedbackTimer.unref) smartFeedbackTimer.unref();
  };
  const tick = async () => {
    smartFeedbackTimer = null;
    if (
      generation !== smartFeedbackGeneration ||
      !managedSmartSelection.isActive() ||
      !state.singbox.isRunning()
    ) return;
    const operation = harvestConnectionFeedback();
    smartFeedbackRun = operation;
    try { await operation; } catch (_) { /* advisory signal */ }
    if (smartFeedbackRun === operation) smartFeedbackRun = null;
    if (generation === smartFeedbackGeneration) schedule(SMART_FEEDBACK_INTERVAL_MS);
  };
  schedule(0);
}

function smartActiveIntervalMs() {
  if (readManagedOverride()) return SMART_INTERVAL_OVERRIDE_MS;
  ensureSmartModelContext();
  const hint = smartSelectionModel.scheduleHint(Date.now());
  if (hint === 'urgent') return SMART_INTERVAL_URGENT_MS;
  if (hint === 'relaxed') return SMART_INTERVAL_RELAXED_MS;
  return SMART_INTERVAL_NORMAL_MS;
}

/**
 * Force-override pin: { name, group } where group is Auto or Smart only.
 * Legacy string values migrate to Smart.
 */
function readManagedOverride() {
  if (!state.store) return null;
  const raw = state.store.get('managedNodeOverride');
  if (!raw) return null;
  if (typeof raw === 'string' && raw) {
    return { name: raw, group: SMART_PROXY_GROUP, profileId: getActiveSubId() || '' };
  }
  if (raw && typeof raw === 'object' && typeof raw.name === 'string' && raw.name) {
    const profileId = typeof raw.profileId === 'string' ? raw.profileId : (getActiveSubId() || '');
    if (profileId && profileId !== (getActiveSubId() || '')) return null;
    const group = raw.group === AUTO_PROXY_GROUP ? AUTO_PROXY_GROUP : SMART_PROXY_GROUP;
    return { name: raw.name, group, profileId };
  }
  return null;
}

/** Full pin info for UI (name + Auto/Smart group). */
function getManagedNodeOverrideInfo() {
  const ov = readManagedOverride();
  if (!ov) return { override: null, group: null, profileId: getActiveSubId() || '' };
  if (!managedOverrideEligible(ov.name, ov.group)) {
    clearManagedNodeOverride('pinned node is unavailable in the selected group');
    return { override: null, group: null, profileId: getActiveSubId() || '' };
  }
  return { override: ov.name, group: ov.group, profileId: ov.profileId || getActiveSubId() || '' };
}

/** Candidate names implied by the current profile and Smart region scope. */
function configuredManagedGroupNames(group) {
  const active = getActiveSubscription();
  const entries = ((active && active.nodes) || [])
    .filter((node) => node && typeof node.name === 'string' && node.name);
  const names = entries.map((node) => node.name);
  if (group !== SMART_PROXY_GROUP) return names;
  const settings = state.store ? state.store.getSettings() : {};
  return smartRegionMembers(entries, names, settings.smartRegions);
}

function managedOverrideEligible(name, group) {
  return configuredManagedGroupNames(group).includes(name);
}

/** Resolve pin for a specific managed group (Auto or Smart). */
function resolveManagedOverrideForGroup(group, names) {
  const ov = readManagedOverride();
  if (!ov || ov.group !== group) return null;
  if (!Array.isArray(names) || !names.includes(ov.name)) return null;
  return ov.name;
}

async function resolveOuterManagedGroup() {
  if (!state.singbox.isRunning()) {
    const selected = state.store.get('selected');
    if (selected === AUTO_PROXY_GROUP) return AUTO_PROXY_GROUP;
    if (selected === SMART_PROXY_GROUP) return SMART_PROXY_GROUP;
    return SMART_PROXY_GROUP;
  }
  try {
    const group = await clashApi('GET', '/proxies/' + encodeURIComponent(APP_PROXY_GROUP));
    if (group && group.now === AUTO_PROXY_GROUP) return AUTO_PROXY_GROUP;
    if (group && group.now === SMART_PROXY_GROUP) return SMART_PROXY_GROUP;
  } catch (_) { /* fall through */ }
  const selected = state.store.get('selected');
  if (selected === AUTO_PROXY_GROUP) return AUTO_PROXY_GROUP;
  return SMART_PROXY_GROUP;
}

/**
 * Pin only the active outer managed group (A1). Background still measures.
 * Failed probes on the pin auto-clear after a short streak.
 */
async function setManagedNodeOverride(name) {
  if (typeof name !== 'string' || !name) throw new Error('invalid node name');
  const profileId = getActiveSubId() || '';
  const active = getActiveSubscription();
  const validNames = new Set(
    ((active && active.nodes) || []).map((node) => node && node.name).filter(Boolean)
  );
  if (!validNames.has(name)) throw new Error('node is not part of the active config');
  const group = await resolveOuterManagedGroup();
  if ((getActiveSubId() || '') !== profileId) throw new Error('active config changed');
  if (!managedOverrideEligible(name, group)) {
    throw new Error('node is unavailable in the selected group');
  }
  if (state.singbox.isRunning()) {
    try {
      const target = await clashApi('GET', '/proxies/' + encodeURIComponent(group));
      if ((getActiveSubId() || '') !== profileId) throw new Error('active config changed');
      if (!Array.isArray(target && target.all) || !target.all.includes(name)) {
        throw new Error('node is unavailable in the selected group');
      }
      await clashApi('PUT', '/proxies/' + encodeURIComponent(group), { name });
      if ((getActiveSubId() || '') !== profileId) throw new Error('active config changed');
    } catch (error) {
      sendLog(`[gui] override pin ${group} → ${name} failed: ${error.message}`);
      throw error;
    }
  }
  overrideFailStreak = 0;
  if (state.store) state.store.set('managedNodeOverride', { name, group, profileId });
  return { override: name, group, profileId };
}

function clearManagedNodeOverride(reason = '') {
  overrideFailStreak = 0;
  if (state.store) state.store.set('managedNodeOverride', null);
  if (reason) sendLog('[gui] force override cleared: ' + reason);
  if (managedAutoSelection.isScheduled()) {
    managedAutoSelection.refresh({ force: true }).catch(() => null);
  }
  if (managedSmartSelection.isScheduled()) {
    managedSmartSelection.refresh({ force: true }).catch(() => null);
  }
  return { override: null };
}

/** A1: drop pin when the pinned node fails latency probes repeatedly. */
function noteOverrideProbeResult(group, name, delay) {
  const ov = readManagedOverride();
  if (!ov || ov.group !== group || ov.name !== name) return;
  if (delay == null || !Number.isFinite(delay)) {
    overrideFailStreak += 1;
    if (overrideFailStreak >= OVERRIDE_FAIL_CLEAR_STREAK) {
      clearManagedNodeOverride('pinned node failed latency probes');
    }
  } else {
    overrideFailStreak = 0;
  }
}

/**
 * Dual-URL latency for Smart (A4): primary settings.testUrl + Cloudflare 204.
 * Primary uses the normal short delay cache; secondary has its own ~90s cache
 * so background Smart sweeps do not double-probe every node every cycle.
 */
async function testNodeDelayDual(name, options = {}) {
  const force = !!(options && options.force);
  const contextKey = smartSelectionContextKey();
  const identity = activeSmartNodeIdentities().get(name) || name;
  const secondaryKey = JSON.stringify([contextKey, SMART_SECONDARY_TEST_URL, identity]);
  const primaryMeta = {};
  let secondaryFresh = false;
  const now = Date.now();
  if (secondaryDelayCache.size > 2048) {
    let drop = 256;
    for (const key of secondaryDelayCache.keys()) {
      secondaryDelayCache.delete(key);
      if (--drop <= 0) break;
    }
  }
  const secHit = !force ? secondaryDelayCache.get(secondaryKey) : null;
  // Start both independent requests together. Dead nodes otherwise paid two
  // consecutive 8-second timeouts before Smart could fail over.
  const primaryRequest = testNodeDelay(name, {
    force,
    skipObserve: true,
    skipResultCache: false,
    resultMeta: primaryMeta,
  }).catch(() => null);
  let secondaryRequest;
  if (secHit && secHit.expires > now) {
    secondaryRequest = Promise.resolve(secHit.delay);
  } else {
    secondaryFresh = true;
    secondaryRequest = testNodeDelay(name, {
      force: true,
      url: SMART_SECONDARY_TEST_URL,
      timeoutMs: 8_000,
      skipObserve: true,
      skipResultCache: true,
    }).then((delay) => {
      secondaryDelayCache.set(secondaryKey, {
        delay,
        expires: Date.now() + SECONDARY_DELAY_TTL_MS,
      });
      return delay;
    }).catch(() => {
      secondaryDelayCache.set(secondaryKey, {
        delay: null,
        expires: Date.now() + SECONDARY_DELAY_FAIL_TTL_MS,
      });
      return null;
    });
  }
  const [primary, secondary] = await Promise.all([primaryRequest, secondaryRequest]);
  const primaryFresh = primaryMeta.fresh === true;
  const fresh = primaryFresh || secondaryFresh;
  if (primary == null && secondary == null) {
    if (fresh && smartSelectionContextKey() === contextKey) {
      ensureSmartModelContext();
      smartSelectionModel.observeDisplayDelay(name, null);
      noteOverrideProbeResult(SMART_PROXY_GROUP, name, null);
    }
    // Let ManagedAutoSelection / choose() record the failure once.
    const error = new Error('timeout');
    error.fresh = fresh;
    throw error;
  }
  const sourceWeights = smartProbeSignalWeights.weights(contextKey, networkFingerprint());
  const blended = Math.round(smartProbeSignalWeights.blend(primary, secondary, sourceWeights));
  if (smartSelectionContextKey() === contextKey) {
    ensureSmartModelContext();
    smartSelectionModel.observeDisplayDelay(name, primary != null ? primary : blended);
    if (fresh) noteOverrideProbeResult(SMART_PROXY_GROUP, name, blended);
  }
  // Cached values can rank nodes, but must not become new model samples.
  return {
    delay: blended,
    fresh,
    primaryDelay: primary,
    secondaryDelay: secondary,
    primaryFresh,
    secondaryFresh,
  };
}

/**
 * When outer Auto/Smart changes, remount an existing pin onto that group so
 * "强制" stays meaningful. Non-managed outer leaves the pin stored but inactive.
 */
async function remountManagedOverrideForOuter(outer) {
  const ov = readManagedOverride();
  if (!ov || !ov.name) return null;
  const profileId = getActiveSubId() || '';
  if (outer !== AUTO_PROXY_GROUP && outer !== SMART_PROXY_GROUP) return ov;
  if (state.singbox.isRunning()) {
    try {
      const target = await clashApi('GET', '/proxies/' + encodeURIComponent(outer));
      if ((getActiveSubId() || '') !== profileId) return null;
      if (!Array.isArray(target && target.all) || !target.all.includes(ov.name)) {
        clearManagedNodeOverride('pinned node is unavailable in the selected group');
        return null;
      }
      if (target.now !== ov.name) {
        await clashApi('PUT', '/proxies/' + encodeURIComponent(outer), { name: ov.name });
      }
      if ((getActiveSubId() || '') !== profileId) return null;
      if (ov.group !== outer || target.now !== ov.name) {
        sendLog(`[gui] force override remounted ${ov.name} → ${outer}`);
      }
    } catch (error) {
      sendLog(`[gui] force override remount failed: ${error.message}`);
      return ov;
    }
  }
  overrideFailStreak = 0;
  if ((getActiveSubId() || '') !== profileId) return null;
  const next = { name: ov.name, group: outer, profileId: ov.profileId || profileId };
  if (state.store) state.store.set('managedNodeOverride', next);
  return next;
}

const managedSelectionOptions = {
  appGroup: APP_PROXY_GROUP,
  clashApi,
  activeIntervalMs: MANAGED_AUTO_INTERVAL_MS,
  idleIntervalMs: MANAGED_IDLE_INTERVAL_MS,
  isRunning: () => state.singbox.isRunning(),
  testDelay: testNodeDelay,
};

const managedAutoSelection = new ManagedAutoSelection({
  ...managedSelectionOptions,
  autoGroup: AUTO_PROXY_GROUP,
  selectBatch: selectAutoTestBatch,
  resolveOverride: (names) => resolveManagedOverrideForGroup(AUTO_PROXY_GROUP, names),
  // Fresh probes for selection decisions — stale 45s cache made Auto pick "ghost" winners.
  testDelay: async (name) => {
    try {
      // Auto is intentionally independent: do not mix its primary-only RTT into
      // Smart's dual-URL history model.
      const delay = await testNodeDelay(name, { force: true, skipObserve: true });
      noteOverrideProbeResult(AUTO_PROXY_GROUP, name, delay);
      return delay;
    } catch (error) {
      noteOverrideProbeResult(AUTO_PROXY_GROUP, name, null);
      throw error;
    }
  },
});

const managedSmartSelection = new ManagedAutoSelection({
  ...managedSelectionOptions,
  autoGroup: SMART_PROXY_GROUP,
  authoritativePreferred: true,
  selectionModel: smartSelectionModel,
  resolveOverride: (names) => resolveManagedOverrideForGroup(SMART_PROXY_GROUP, names),
  testDelay: (name, options) => testNodeDelayDual(name, options),
  getIntervalMs: ({ active }) => {
    if (!active) return MANAGED_IDLE_INTERVAL_MS;
    return smartActiveIntervalMs();
  },
  selectBatch: (names, current, cursor, force, opts) => selectSmartTestBatch(
    names,
    current,
    cursor,
    force,
    {
      ...(opts || {}),
      model: smartSelectionModel,
      familyForName: activeSmartProbeFamilies(),
    }
  ),
  selectCandidate: ({ names, current, measurements }) => {
    ensureSmartModelContext();
    const contextKey = smartSelectionContextKey();
    const now = Date.now();
    const weightedMeasurements = smartProbeSignalWeights.annotate(
      measurements,
      smartSelectionModel,
      contextKey,
      networkFingerprint()
    );
    const override = resolveManagedOverrideForGroup(SMART_PROXY_GROUP, names);
    if (override) {
      for (const measurement of weightedMeasurements) {
        try { smartSelectionModel.observe(measurement, now); } catch (_) { /* ignore */ }
      }
      try {
        recordSmartShadowRound({
          contextKey,
          names,
          current,
          measurements: weightedMeasurements,
          productionPick: override,
          now,
        });
      } catch (_) { /* advisory */ }
      return override;
    }
    // Always return the model pick so ManagedAutoSelection can PUT it to Clash.
    // With Dart type:smart the kernel still dial-failovers; GUI preferred "now"
    // must stay aligned with choose() or the Smart badge diverges from routing.
    const pick = smartSelectionModel.choose({
      contextKey,
      names,
      current,
      measurements: weightedMeasurements,
      now,
    });
    try {
      recordSmartShadowRound({
        contextKey,
        names,
        current,
        measurements: weightedMeasurements,
        productionPick: pick,
        now,
      });
    } catch (_) { /* advisory */ }
    return pick;
  },
});

function getManagedSmartPreferred() {
  return managedSmartSelection.getPreferred() || smartSelectionModel.selected || null;
}

/** Apply app-managed Smart weights immediately without discarding observations. */
function applySmartMode(mode) {
  const changed = smartSelectionModel.setMode(mode);
  if (changed && state.singbox.isRunning() && managedSmartSelection.isScheduled()) {
    managedSmartSelection.refresh({ force: true }).catch(() => null);
  }
  return smartSelectionModel.mode;
}

/** Apply the fastest result from the visible node sweep without testing twice. */
function applyMeasuredAutoCandidate(name) {
  const override = readManagedOverride();
  if (override && override.group === AUTO_PROXY_GROUP) return Promise.resolve(override.name);
  return managedAutoSelection.applyMeasuredCandidate(name);
}

function stopManagedAutoSelection() {
  managedSelectionSyncRevision += 1;
  managedAutoSelection.stop();
  managedSmartSelection.stop();
  stopSmartFeedbackSampler();
  overrideFailStreak = 0;
}

/**
 * Keep Auto and Smart probing while the core runs:
 * - the outer-selected group uses the fast interval (~60s)
 * - the other group idles at ~4 minutes so a switch is already warm
 * - a plain node selection leaves both on the idle cadence
 * - with kernel type: smart, JS still measures and PUTs preferred "now";
 *   kernel may failover per dial without permanently desyncing the badge
 */
async function syncManagedSelectionSchedulers({ forceRefresh = null } = {}) {
  const syncRevision = managedSelectionSyncRevision;
  if (!state.singbox.isRunning()) {
    stopManagedAutoSelection();
    return null;
  }
  let outer = state.store.get('selected') || AUTO_PROXY_GROUP;
  try {
    const group = await clashApi('GET', '/proxies/' + encodeURIComponent(APP_PROXY_GROUP));
    if (group && group.now) outer = group.now;
  } catch (_) {
    /* fall back to the persisted selection */
  }
  if (syncRevision !== managedSelectionSyncRevision) return null;
  managedAutoSelection.setActive(outer === AUTO_PROXY_GROUP);
  managedSmartSelection.setActive(outer === SMART_PROXY_GROUP);
  setSmartFeedbackSamplerActive(outer === SMART_PROXY_GROUP);
  // Keep force-override attached to the active Auto/Smart outer when it changes.
  try {
    await remountManagedOverrideForOuter(outer);
  } catch (_) { /* best-effort */ }
  if (syncRevision !== managedSelectionSyncRevision) return null;
  if (!managedAutoSelection.isScheduled()) {
    const active = outer === AUTO_PROXY_GROUP;
    managedAutoSelection.start({ active, initialDelayMs: active ? 250 : 15_000 });
  }
  if (!managedSmartSelection.isScheduled()) {
    const active = outer === SMART_PROXY_GROUP;
    managedSmartSelection.start({ active, initialDelayMs: active ? 250 : 15_000 });
  }
  if (forceRefresh === AUTO_PROXY_GROUP) {
    managedAutoSelection.refresh({ force: true }).catch(() => null);
  } else if (forceRefresh === SMART_PROXY_GROUP) {
    managedSmartSelection.refresh({ force: true }).catch(() => null);
  }
  return outer;
}

function startManagedAutoSelection() {
  stopManagedAutoSelection();
  void syncManagedSelectionSchedulers().catch(() => null);
}

/** Switch the outer proxy selector live via the Clash API. */
async function setClashSelector(name) {
  const result = await managedAutoSelection.setOuterSelector(name);
  const forceRefresh = (name === AUTO_PROXY_GROUP || name === SMART_PROXY_GROUP) ? name : null;
  await syncManagedSelectionSchedulers({ forceRefresh });
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
      const disabled = await disableOwnedSystemProxy(server);
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
  disableOwnedSystemProxy,
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
  buildCurrentConfigAsync,
  resolveKernelSmart,
  getKernelSmartMeta: () => ({ ...lastKernelSmartMeta }),
  currentRouteInfo,
  ruleGroupInfo,
  setRuleGroupSelection,
  startCore,
  stopCore,
  restartCore,
  restartIfRunning,
  setSystemProxyEnabled,
  cleanup,
  startProxyGuard,
  stopProxyGuard,
  testNodeDelay,
  smartNodeQualities,
  getManagedSmartPreferred,
  applySmartMode,
  getManagedNodeOverrideInfo,
  setManagedNodeOverride,
  clearManagedNodeOverride,
  harvestConnectionFeedback,
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
