'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const { state, runtimeDir, resourcesBinDir, sendToMain, sendLog, getRecentLogs, clearRecentLogs, sendStatus, coreStatusInfo } = require('./state');
const core = require('./core-control');
const { isWindowsAdmin, relaunchElevated, promptRestartForTun } = require('./admin');
const update = require('./update');
const { buildMihomoConfig, buildSingboxConfig, dnsServerFromAddress } = require('./converter');
const subscription = require('./subscription');
const proxy = require('./proxy');
const uwp = require('./uwp');
const fetch = require('./fetch');
const { notify } = require('./notify');
const toolbox = require('./toolbox');
const dialogWindows = require('./dialog-window');
const { uniqueSibling, replaceFileSync } = require('./file-utils');

/** Validate an IPC payload field: must be a non-empty string. */
function reqStr(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new Error('invalid ' + name);
  return v;
}

/** Validate an IPC payload field: must be an http(s) URL. */
function reqUrl(v, name) {
  reqStr(v, name);
  let u;
  try {
    u = new URL(v);
  } catch (_) {
    throw new Error('invalid ' + name);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(name + ' must be an http(s) URL');
  }
  return v;
}

/** Validate an IPC payload field against an allowlist of values. */
function reqEnum(v, allowed, name) {
  if (!allowed.includes(v)) throw new Error('invalid ' + name);
  return v;
}

function reqBoolean(v, name) {
  if (typeof v !== 'boolean') throw new Error('invalid ' + name);
  return v;
}

function senderWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== state.mainWindow || win.isDestroyed()) throw new Error('invalid window');
  return win;
}

// Where converted rules may route to.
const VALID_TARGETS = ['proxy', 'direct', 'reject'];
const VALID_CRS_FORMATS = ['clash', 'sing-box'];

// Settings keys the renderer may write; anything else in a patch is dropped so
// a malformed payload cannot pollute the persisted store.
const SETTING_KEYS = new Set([
  'mixedPort', 'clashApiPort', 'enableClashApi', 'logLevel',
  'autoSetSystemProxy', 'autoLaunch', 'silentStart', 'notifications', 'enableIpv6',
  'dnsRemote', 'dnsLocal', 'dnsStrategy', 'language', 'theme', 'clashMode',
  'testUrl', 'testConcurrency', 'useBuiltinRules', 'ruleOverrides', 'coreType',
]);

const VALID_MODES = ['rule', 'global', 'direct', 'block'];
const MAX_IPC_CONNECTIONS = 600;
const MAX_CONFIG_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_AUTO_UPDATE_MINUTES = 365 * 24 * 60;

function reqAutoUpdateMinutes(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_AUTO_UPDATE_MINUTES) {
    throw new Error('invalid autoUpdateMinutes');
  }
  return value;
}

function reqConfigText(value) {
  reqStr(value, 'content');
  if (Buffer.byteLength(value, 'utf-8') > MAX_CONFIG_INPUT_BYTES) {
    throw new Error('config content exceeds 32 MB');
  }
  return value;
}

function recentConnections(items, limit) {
  const keyEntry = (item) => ({
    item,
    key: String(item.start || '') + '\0' + String(item.id || ''),
  });
  if (items.length <= limit) {
    return items.map(keyEntry).sort((a, b) => b.key.localeCompare(a.key)).map((entry) => entry.item);
  }
  const heap = [];
  const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; };
  const siftUp = (index) => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].key.localeCompare(heap[index].key) <= 0) break;
      swap(parent, index);
      index = parent;
    }
  };
  const siftDown = (index) => {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && heap[left].key.localeCompare(heap[smallest].key) < 0) smallest = left;
      if (right < heap.length && heap[right].key.localeCompare(heap[smallest].key) < 0) smallest = right;
      if (smallest === index) return;
      swap(index, smallest);
      index = smallest;
    }
  };
  for (const item of items) {
    const entry = keyEntry(item);
    if (heap.length < limit) {
      heap.push(entry);
      siftUp(heap.length - 1);
    } else if (entry.key.localeCompare(heap[0].key) > 0) {
      heap[0] = entry;
      siftDown(0);
    }
  }
  return heap.sort((a, b) => b.key.localeCompare(a.key)).map((entry) => entry.item);
}
const CORE_CONFIG_SETTINGS = new Set([
  'mixedPort', 'clashApiPort', 'enableClashApi', 'logLevel', 'autoSetSystemProxy',
  'enableIpv6', 'dnsRemote', 'dnsLocal', 'dnsStrategy', 'useBuiltinRules',
  'ruleOverrides', 'coreType', 'testUrl',
]);

function validateSettingsPatch(patch, current) {
  for (const key of ['mixedPort', 'clashApiPort']) {
    if (!(key in patch)) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 65535) {
      throw new Error(`invalid ${key}`);
    }
  }
  for (const key of [
    'enableClashApi', 'autoSetSystemProxy', 'autoLaunch', 'silentStart', 'enableTun',
    'notifications', 'enableIpv6', 'useBuiltinRules',
  ]) {
    if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`invalid ${key}`);
  }
  if ('coreType' in patch) reqEnum(patch.coreType, ['sing-box', 'mihomo'], 'coreType');
  if ('logLevel' in patch) reqEnum(patch.logLevel, ['trace', 'debug', 'info', 'warn', 'error'], 'logLevel');
  if ('dnsStrategy' in patch) {
    reqEnum(patch.dnsStrategy, ['prefer_ipv4', 'prefer_ipv6', 'ipv4_only', 'ipv6_only'], 'dnsStrategy');
  }
  if ('language' in patch) reqEnum(patch.language, ['zh', 'en'], 'language');
  if ('theme' in patch) reqEnum(patch.theme, ['dark', 'light', 'system'], 'theme');
  if ('clashMode' in patch) reqEnum(patch.clashMode, VALID_MODES, 'clashMode');
  for (const key of ['dnsRemote', 'dnsLocal']) {
    if (!(key in patch)) continue;
    const value = reqStr(patch[key], key).trim();
    const allowedScheme = /^(?:https|tls|quic|h3|http3|tcp|udp):\/\//i.test(value);
    if (
      /\s/.test(value) ||
      (value.includes('://') && !allowedScheme) ||
      !/^(?:(?:https|tls|quic|h3|http3|tcp|udp):\/\/)?[^/]+(?:\/\S*)?$/i.test(value)
    ) {
      throw new Error('invalid ' + key);
    }
    patch[key] = value;
    dnsServerFromAddress(value, 'validate');
  }
  if ('testUrl' in patch && patch.testUrl) reqUrl(patch.testUrl, 'testUrl');
  if ('testConcurrency' in patch) {
    if (!Number.isInteger(patch.testConcurrency) || patch.testConcurrency < 1 || patch.testConcurrency > 32) {
      throw new Error('invalid testConcurrency');
    }
  }
  if ('ruleOverrides' in patch) {
    if (!patch.ruleOverrides || typeof patch.ruleOverrides !== 'object' || Array.isArray(patch.ruleOverrides)) {
      throw new Error('invalid ruleOverrides');
    }
    for (const value of Object.values(patch.ruleOverrides)) reqEnum(value, VALID_TARGETS, 'ruleOverrides');
  }
  const next = { ...current, ...patch };
  if (next.enableClashApi && next.mixedPort === next.clashApiPort) {
    throw new Error('mixedPort and clashApiPort must be different');
  }
}

async function rollbackSettingsAfterFailure(previous, wasRunning, originalError) {
  try {
    state.store.updateSettings(previous);
    state.singbox.setCoreType(previous.coreType || 'sing-box');
    try { require('./window').applyNativeThemeSource(); } catch (_) {}
    try { core.applyAutoLaunch(previous.autoLaunch, previous.silentStart); } catch (_) {}
    if (wasRunning && !state.singbox.isRunning()) await core.startCore();
    sendStatus();
  } catch (recoveryError) {
    originalError.recoveryError = recoveryError;
    sendLog('[gui] failed to restore the previous settings after restart error: ' + recoveryError.message);
  }
  throw originalError;
}

async function rollbackProfileSelection(previousActive, previousSelected, wasRunning, originalError, restore = null) {
  try {
    if (restore) await restore();
    state.store.set('activeSub', previousActive);
    state.store.set('selected', previousSelected);
    if (wasRunning && !state.singbox.isRunning()) await core.startCore();
    sendStatus();
  } catch (recoveryError) {
    originalError.recoveryError = recoveryError;
    sendLog('[gui] failed to restore the previous config after restart error: ' + recoveryError.message);
  }
  throw originalError;
}

async function rollbackMutationAfterFailure(restore, wasRunning, originalError, label) {
  let recoveryError = null;
  try {
    await restore();
  } catch (error) {
    recoveryError = error;
  }
  if (wasRunning && !state.singbox.isRunning()) {
    try {
      await core.startCore();
    } catch (error) {
      if (!recoveryError) recoveryError = error;
    }
  }
  sendStatus();
  if (recoveryError) {
    originalError.recoveryError = recoveryError;
    sendLog(`[gui] failed to restore the previous ${label}: ${recoveryError.message}`);
  }
  throw originalError;
}

function customRuleFileSnapshot(id) {
  const target = path.join(state.singbox.ensureCoreDir('sing-box'), core.customRuleSetFileName(id));
  if (!fs.existsSync(target)) return { target, backup: null };
  const backup = uniqueSibling(target, 'edit-backup');
  fs.copyFileSync(target, backup);
  return { target, backup };
}

function restoreCustomRuleFile(snapshot) {
  if (!snapshot) return;
  if (snapshot.backup && fs.existsSync(snapshot.backup)) {
    replaceFileSync(snapshot.backup, snapshot.target);
    snapshot.backup = null;
    return;
  }
  try { fs.unlinkSync(snapshot.target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function discardCustomRuleFileSnapshot(snapshot) {
  if (!snapshot || !snapshot.backup) return;
  try { fs.unlinkSync(snapshot.backup); } catch (_) {}
  snapshot.backup = null;
}

function purgeCustomRuleBinaries() {
  let removed = 0;
  for (const dir of new Set([state.singbox.ensureCoreDir('sing-box'), path.join(runtimeDir, 'bin')])) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!/^custom-[A-Za-z0-9_-]+\.srs$/.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch (_) {}
    }
  }
  return removed;
}

let pendingBackup = null;
let updateDownloadRunning = false;
let updateQuitPending = false;
let updateDownloadController = null;
let appUpdateTask = null;
let coreUpdateTask = null;

async function cancelPendingUpdates() {
  if (updateDownloadController) updateDownloadController.abort();
  if (state.singbox && typeof state.singbox.cancelCoreDownload === 'function') {
    state.singbox.cancelCoreDownload();
  }
  const pending = [appUpdateTask, coreUpdateTask].filter(Boolean);
  if (pending.length) await Promise.allSettled(pending);
}

async function writeAtomicText(file, text) {
  const tmp = uniqueSibling(file, 'tmp');
  try {
    await fs.promises.writeFile(tmp, text, 'utf-8');
    replaceFileSync(tmp, file);
  } finally {
    try { await fs.promises.unlink(tmp); } catch (_) {}
  }
}

async function readBackupDocument(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('backup is not a file or exceeds 64 MB');
  const text = await fs.promises.readFile(file, 'utf-8');
  const document = JSON.parse(text);
  return {
    document,
    normalized: toolbox.validateBackupDocument(document),
    digest: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

/** Remove decorative built-in group emoji from standalone converted files. */
function plainConversionLabels(value) {
  if (typeof value === 'string') {
    return value
      .replace(/🚀 Proxy/g, 'Dart Proxy')
      .replace(/♻️ Auto/g, 'Dart Auto')
      .replace(/🛟 Fallback/g, 'Dart Fallback');
  }
  if (Array.isArray(value)) return value.map(plainConversionLabels);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainConversionLabels(item)]));
  }
  return value;
}

function subscriptionResult(sub) {
  return {
    id: sub.id,
    name: sub.name || '',
    format: sub.format || 'unknown',
    nodeCount: Array.isArray(sub.nodes) ? sub.nodes.length : Math.max(0, Number(sub.nodeCount) || 0),
  };
}

function currentSubscriptionForUpdate(id, sourceUrl, token = null) {
  if (token) core.assertRemoteUpdate('subscription', id, token);
  const latest = state.store.getSubscription(id);
  if (!latest) throw new Error('config was removed while update was in progress');
  if (latest.url !== sourceUrl) throw new Error('config URL changed while update was in progress');
  return latest;
}

function mergeFetchedSubscription(latest, result, { replaceRaw = false } = {}) {
  const next = {
    ...latest,
    nodes: result.nodes,
    format: result.format,
    clashRules: result.rules || [],
    clashRuleProviders: result.ruleProviders || {},
    userInfo: result.userInfo || null,
    updatedAt: Date.now(),
    configHash: subscription.configFingerprint(result),
  };
  if (replaceRaw || result.raw) next.raw = result.raw || '';
  return next;
}

function currentRuleSetForUpdate(id, sourceKey, token = null) {
  if (token) core.assertRemoteUpdate('rule-set', id, token);
  const latest = state.store.getCustomRuleSet(id);
  if (!latest) throw new Error('rule-set was removed while update was in progress');
  if (core.customRuleSetSourceKey(latest) !== sourceKey) {
    throw new Error('rule-set source changed while update was in progress');
  }
  return latest;
}

function nodeResult(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const name = String(node.name || '').trim();
  if (!name) return null;
  return {
    name,
    type: typeof node.type === 'string' ? node.type : '',
    server: typeof node.server === 'string' ? node.server : '',
    port: Number.isInteger(node.port) ? node.port : null,
  };
}

/** Register every IPC handler. Called once during boot. */
function registerIpc() {
  state.cancelPendingUpdates = cancelPendingUpdates;
  const toolContext = { state, core, proxy, isAdmin: isWindowsAdmin };
  ipcMain.handle('app:getState', async () => {
    const status = await coreStatusInfo();
    const activeSub = core.getActiveSubId();
    return {
      // Profile payloads and node details are loaded through focused IPC calls,
      // keeping the normal dashboard state compact.
      subscriptions: state.store.listSubscriptions().map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        format: s.format,
        autoUpdateMinutes: s.autoUpdateMinutes || 0,
        updateViaProxy: !!s.updateViaProxy,
        updatedAt: s.updatedAt || 0,
        userInfo: s.userInfo || null,
        nodeCount: s.nodeCount || 0,
      })),
      settings: state.store.getSettings(),
      selected: state.store.get('selected'),
      activeSub,
      status,
    };
  });

  ipcMain.handle('logs:get', () => getRecentLogs());
  ipcMain.handle('logs:clear', () => {
    clearRecentLogs();
    return true;
  });

  ipcMain.handle('nodes:get', () => {
    const activeSub = core.getActiveSubId();
    const active = activeSub ? core.getActiveSubscription() : null;
    return {
      activeSub,
      nodes: active && Array.isArray(active.nodes) ? active.nodes.map(nodeResult).filter(Boolean) : [],
    };
  });

  // Add/update a subscription (fetch and parse).
  ipcMain.handle('sub:add', async (_e, { name, url }) => {
    reqUrl(url, 'url');
    const result = await subscription.fetchSubscription(url, sendLog);
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    const sub = {
      id: crypto.randomUUID(),
      name: name || new URL(url).hostname,
      url,
      format: result.format,
      nodes: result.nodes,
      clashRules: result.rules || [],
      clashRuleProviders: result.ruleProviders || {},
      raw: result.raw || '',
      autoUpdateMinutes: 0,
      userInfo: result.userInfo || null,
      updatedAt: Date.now(),
      configHash: subscription.configFingerprint(result),
    };
    return core.queueConfigMutation(() => {
      const isFirst = state.store.listSubscriptions().length === 0;
      state.store.upsertSubscription(sub);
      // Only the FIRST subscription becomes the active profile automatically.
      // (Checking `!activeSub` here used to steal activeness on legacy stores
      // where activeSub was never set — see getActiveSubId.)
      if (isFirst) state.store.set('activeSub', sub.id);
      core.rescheduleAutoUpdate();
      return subscriptionResult(sub);
    });
  });

  // Update a specific subscription.
  ipcMain.handle('sub:update', async (_e, { id }) => {
    reqStr(id, 'id');
    const sub = state.store.getSubscription(id);
    if (!sub) throw new Error('config not found');
    const token = core.beginRemoteUpdate('subscription', id);
    const sourceUrl = sub.url;
    try {
      const proxyPort = sub.updateViaProxy ? core.currentProxyPort() : 0;
      const result = await subscription.fetchSubscription(sourceUrl, sendLog, { proxyPort });
      if (!result.nodes.length) {
        throw new Error('no nodes parsed (format: ' + result.format + ')');
      }
      return await core.queueConfigMutation(async () => {
        const latest = currentSubscriptionForUpdate(id, sourceUrl, token);
        const next = mergeFetchedSubscription(latest, result);
        const configChanged = (latest.configHash || subscription.configFingerprint(latest)) !== next.configHash;
        const shouldRestart = configChanged && id === core.getActiveSubId();
        const previous = shouldRestart ? state.store.getSubscription(id, { includeRaw: true }) : null;
        const wasRunning = shouldRestart && state.singbox.isRunning();
        state.store.upsertSubscription(next);
        // Apply the active profile's new node list to a running core; otherwise
        // the Clash API keeps serving outbounds the UI no longer shows.
        if (shouldRestart) {
          try {
            await core.restartIfRunning();
          } catch (error) {
            return rollbackMutationAfterFailure(
              () => state.store.upsertSubscription(previous),
              wasRunning,
              error,
              'config after update failure'
            );
          }
        }
        return subscriptionResult(next);
      });
    } finally {
      core.finishRemoteUpdate('subscription', id, token);
    }
  });

  ipcMain.handle('sub:remove', (_e, { id }) => core.queueConfigMutation(async () => {
    reqStr(id, 'id');
    const removed = state.store.getSubscription(id, { includeRaw: true });
    if (!removed) throw new Error('config not found');
    const previousActive = core.getActiveSubId();
    const previousSelected = state.store.get('selected');
    const wasRunning = state.singbox.isRunning();
    core.cancelRemoteUpdate('subscription', id);
    state.store.removeSubscription(id);
    const subs = state.store.listSubscriptions();
    // If the active profile was removed, fall back to the first remaining one.
    if (previousActive === id) {
      state.store.set('activeSub', subs[0] ? subs[0].id : null);
      state.store.set('selected', null);
      try {
        if (subs.length) await core.restartIfRunning();
        else if (wasRunning) await core.stopCore(true);
      } catch (error) {
        return rollbackProfileSelection(
          previousActive,
          previousSelected,
          wasRunning,
          error,
          () => state.store.upsertSubscription(removed)
        );
      }
    }
    core.rescheduleAutoUpdate();
    return true;
  }));

  // Switch the active profile (subscription). Restarts the core to apply.
  ipcMain.handle('sub:setActive', (_e, { id }) => core.queueConfigMutation(async () => {
    reqStr(id, 'id');
    const subs = state.store.listSubscriptions();
    if (!subs.some((s) => s.id === id)) throw new Error('config not found');
    const previousActive = core.getActiveSubId();
    if (id === previousActive) return id;
    const previousSelected = state.store.get('selected');
    const wasRunning = state.singbox.isRunning();
    state.store.set('activeSub', id);
    state.store.set('selected', null); // reset node selection for the new profile
    try {
      await core.restartIfRunning();
    } catch (error) {
      return rollbackProfileSelection(previousActive, previousSelected, wasRunning, error);
    }
    return id;
  }));

  // Edit a subscription's name / url / auto-update interval. Re-fetches if the
  // URL changed.
  ipcMain.handle('sub:edit', async (_e, { id, name, url, autoUpdateMinutes, updateViaProxy }) => {
    reqStr(id, 'id');
    if (autoUpdateMinutes !== undefined) reqAutoUpdateMinutes(autoUpdateMinutes);
    if (updateViaProxy !== undefined) reqBoolean(updateViaProxy, 'updateViaProxy');
    const original = state.store.getSubscription(id);
    if (!original) throw new Error('config not found');
    // Imported profiles legitimately have an empty URL; validate only when set.
    if (url) reqUrl(url, 'url');
    const sourceUrl = original.url;
    const requestedUrl = url !== undefined ? url : sourceUrl;
    const urlChanged = requestedUrl !== sourceUrl;
    const token = urlChanged ? core.beginRemoteUpdate('subscription', id) : null;
    const applyEdits = (sub) => {
      if (name !== undefined) sub.name = name;
      if (url !== undefined) sub.url = url;
      if (autoUpdateMinutes !== undefined) sub.autoUpdateMinutes = autoUpdateMinutes;
      if (updateViaProxy !== undefined) sub.updateViaProxy = updateViaProxy;
      return sub;
    };
    try {
      let fetched = null;
      if (urlChanged && url) {
        const proxyPort = (updateViaProxy !== undefined ? updateViaProxy : !!original.updateViaProxy)
          ? core.currentProxyPort()
          : 0;
        fetched = await subscription.fetchSubscription(url, sendLog, { proxyPort });
        if (!fetched.nodes.length) throw new Error('no nodes parsed from the new URL');
      }
      return await core.queueConfigMutation(async () => {
        const latest = currentSubscriptionForUpdate(id, sourceUrl, token);
        const sub = fetched
          ? mergeFetchedSubscription(applyEdits({ ...latest }), fetched, { replaceRaw: true })
          : applyEdits({ ...latest });
        const shouldRestart = urlChanged && !!url && sub.id === core.getActiveSubId();
        const previous = shouldRestart ? state.store.getSubscription(id, { includeRaw: true }) : null;
        const wasRunning = shouldRestart && state.singbox.isRunning();
        state.store.upsertSubscription(sub);
        core.rescheduleAutoUpdate();
        // A URL change replaced the node list — apply it if this is the live profile.
        if (shouldRestart) {
          try {
            await core.restartIfRunning();
          } catch (error) {
            return rollbackMutationAfterFailure(
              () => {
                state.store.upsertSubscription(previous);
                core.rescheduleAutoUpdate();
              },
              wasRunning,
              error,
              'config after edit failure'
            );
          }
        }
        return subscriptionResult(sub);
      });
    } finally {
      if (token) core.finishRemoteUpdate('subscription', id, token);
    }
  });

  // Import from pasted text (Clash YAML or share links).
  ipcMain.handle('sub:import', async (_e, { name, content }) => {
    reqConfigText(content);
    const result = subscription.parseSubscriptionContent(content);
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    const sub = {
      id: crypto.randomUUID(),
      name: name || 'Local import',
      url: '',
      format: result.format,
      nodes: result.nodes,
      clashRules: result.rules || [],
      clashRuleProviders: result.ruleProviders || {},
      raw: String(content || ''),
      autoUpdateMinutes: 0,
      userInfo: null,
      updatedAt: Date.now(),
      configHash: subscription.configFingerprint(result),
    };
    return core.queueConfigMutation(() => {
      const isFirst = state.store.listSubscriptions().length === 0;
      state.store.upsertSubscription(sub);
      if (isFirst) state.store.set('activeSub', sub.id);
      return subscriptionResult(sub);
    });
  });

  // Raw profile content (the fetched/imported source text) for in-app editing.
  // Kept out of app:getState so large profiles don't bloat every state refresh.
  ipcMain.handle('sub:getRaw', (_e, { id }) => {
    reqStr(id, 'id');
    const sub = state.store.getSubscription(id, { includeRaw: true });
    if (!sub) throw new Error('config not found');
    return { raw: sub.raw || null };
  });
  ipcMain.handle('sub:saveRaw', async (_e, { id, content }) => {
    reqStr(id, 'id');
    reqConfigText(content);
    const result = subscription.parseSubscriptionContent(content);
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    return core.queueConfigMutation(async () => {
      const previous = state.store.getSubscription(id, { includeRaw: true });
      if (!previous) throw new Error('config not found');
      const sub = {
        ...previous,
        nodes: result.nodes,
        format: result.format,
        clashRules: result.rules || [],
        clashRuleProviders: result.ruleProviders || {},
        raw: String(content),
        userInfo: null,
        updatedAt: Date.now(),
        configHash: subscription.configFingerprint(result),
      };
      const configChanged = (previous.configHash || subscription.configFingerprint(previous)) !== sub.configHash;
      const wasRunning = state.singbox.isRunning();
      // A manual source edit is authoritative. Invalidate an older network
      // refresh before committing so its late response cannot overwrite this.
      core.cancelRemoteUpdate('subscription', id);
      state.store.upsertSubscription(sub);
      if (configChanged && sub.id === core.getActiveSubId()) {
        try {
          await core.restartIfRunning();
        } catch (error) {
          return rollbackMutationAfterFailure(
            () => state.store.upsertSubscription(previous),
            wasRunning,
            error,
            'config after raw edit failure'
          );
        }
      }
      return { nodeCount: result.nodes.length, format: result.format };
    });
  });

  // Bidirectional standalone conversion (no save, no run). Auto mode converts
  // sing-box input to Clash and every other supported source to sing-box.
  ipcMain.handle('convert:preview', (_e, { content, target = 'auto' }) => {
    reqConfigText(content);
    reqEnum(target, ['auto', 'sing-box', 'clash'], 'conversion target');
    const result = subscription.parseSubscriptionContent(content);
    if (!result.nodes.length) throw new Error('no nodes parsed');
    const settings = state.store.getSettings();
    const outputTarget = target === 'auto'
      ? (result.format === 'singbox' ? 'clash' : 'sing-box')
      : target;
    if (outputTarget === 'clash') {
      const config = plainConversionLabels(buildMihomoConfig(result.nodes, {
        ...settings,
        clashRules: result.rules || [],
        ruleProviders: result.ruleProviders || {},
      }));
      return {
        text: yaml.dump(config, { lineWidth: -1, noRefs: true }),
        nodeCount: result.nodes.length,
        format: result.format,
        target: 'clash',
      };
    }
    const config = plainConversionLabels(buildSingboxConfig(result.nodes, {
      ...settings,
      ruleSetDir: state.singbox.resolveRuleSetDir(),
      clashRules: result.rules || [],
    }));
    return { config, nodeCount: result.nodes.length, format: result.format, target: 'sing-box' };
  });

  // Export the current sing-box config to a file.
  ipcMain.handle('convert:export', async (event) => {
    if (state.singbox.getCoreType() === 'mihomo') await state.singbox.validateMihomoGeoData();
    const { config, settings } = core.buildCurrentConfig();
    // The per-run API secret is runtime-only; keep it out of shared exports.
    if (config.experimental && config.experimental.clash_api) {
      delete config.experimental.clash_api.secret;
    }
    if (settings.coreType === 'mihomo' && config.secret) delete config.secret;
    const isMihomo = settings.coreType === 'mihomo';
    const { canceled, filePath } = await dialog.showSaveDialog(dialogWindows.ownerWindow(event), {
      title: isMihomo ? 'Export mihomo config' : 'Export sing-box config',
      defaultPath: isMihomo ? 'config.yaml' : 'config.json',
      filters: isMihomo ? [{ name: 'YAML', extensions: ['yaml', 'yml'] }] : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    await writeAtomicText(
      filePath,
      isMihomo ? yaml.dump(config, { lineWidth: -1, noRefs: true }) : JSON.stringify(config, null, 2)
    );
    return filePath;
  });

  ipcMain.handle('settings:update', (_e, input) => core.queueConfigMutation(async () => {
    let patch = input;
    patch = Object.fromEntries(
      Object.entries(patch && typeof patch === 'object' ? patch : {}).filter(([k]) => SETTING_KEYS.has(k))
    );
    const previous = state.store.getSettings();
    validateSettingsPatch(patch, previous);
    const coreTypeChanged = Object.prototype.hasOwnProperty.call(patch, 'coreType') &&
      patch.coreType !== (previous.coreType || 'sing-box');
    const configChanged = [...CORE_CONFIG_SETTINGS].some(
      (key) => Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== previous[key]
    );
    if (configChanged && state.singbox.isCoreDownloadInProgress()) {
      throw new Error('wait for the core update to finish before changing core settings');
    }
    const wasRunning = state.singbox.isRunning();
    const settings = state.store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      try { require('./window').applyNativeThemeSource(); } catch (_) { /* ignore */ }
    }
    if (coreTypeChanged) {
      try {
        state.singbox.setCoreType(settings.coreType);
        sendStatus();
      } catch (error) {
        return rollbackSettingsAfterFailure(previous, wasRunning, error);
      }
    }
    // The login item carries the --hidden flag when silent start is on, and on
    // Windows the auto-launch mechanism depends on whether TUN is on (elevated
    // logon task vs plain Run item), so a change to any of these must re-register
    // it. interactive: this is an explicit user action, so a one-time UAC prompt
    // is acceptable here.
    if (
      Object.prototype.hasOwnProperty.call(patch, 'autoLaunch') ||
      Object.prototype.hasOwnProperty.call(patch, 'silentStart')
    ) {
      try {
        core.applyAutoLaunch(settings.autoLaunch, settings.silentStart, { interactive: true });
      } catch (error) {
        return rollbackSettingsAfterFailure(previous, wasRunning, error);
      }
    }
    // These change routing, so rebuild and restart the core (when running) for
    // them to take effect immediately.
    if (configChanged && wasRunning) {
      try {
        await core.restartIfRunning();
      } catch (error) {
        return rollbackSettingsAfterFailure(previous, wasRunning, error);
      }
    }
    return settings;
  }));

  // Show a desktop notification (renderer-triggered, already localized). Gated
  // by the `notifications` setting inside notify().
  ipcMain.handle('app:notify', (_e, payload) => {
    const { title, body } = payload && typeof payload === 'object' ? payload : {};
    notify(title, body);
    return true;
  });

  // Test a single node's latency via the Clash API.
  ipcMain.handle('node:delay', async (_e, { name }) => {
    reqStr(name, 'name');
    if (!state.singbox.isRunning()) throw new Error('core not running');
    return core.testNodeDelay(name);
  });

  // Resolve the live outer selector plus the health-check groups. Outside the
  // Nodes tab only the active automatic group is queried, keeping polling tiny.
  ipcMain.handle('node:groupSelections', async (_e, { all = false } = {}) => {
    if (!state.singbox.isRunning()) return { proxy: null, auto: null, fallback: null };
    const current = async (name) => {
      try {
        const group = await core.clashApi('GET', '/proxies/' + encodeURIComponent(name));
        return group && group.now || null;
      } catch (_) {
        return null;
      }
    };
    const proxy = await current('🚀 Proxy');
    const selected = proxy || state.store.get('selected') || '♻️ Auto';
    const [auto, fallback] = await Promise.all([
      all || selected === '♻️ Auto' ? current('♻️ Auto') : null,
      all || selected === '🛟 Fallback' ? current('🛟 Fallback') : null,
    ]);
    return { proxy, auto, fallback };
  });

  // Select an outbound and persist it as the default for the next start.

  ipcMain.handle('node:select', async (_e, { name }) => {
    reqStr(name, 'name');
    const active = core.getActiveSubscription();
    const validNames = new Set([
      '♻️ Auto',
      '🛟 Fallback',
      ...((active && active.nodes) || []).map((node) => node && node.name).filter(Boolean),
    ]);
    if (!validNames.has(name)) throw new Error('node is not part of the active config');
    if (state.singbox.isRunning()) {
      try {
        await core.setClashSelector(name);
      } catch (e) {
        // A 400 here means the running core's selector does not contain this
        // node (its config predates the current profile/node list).
        throw new Error(`${e.message} — the running core does not have this node; restart the core to apply the current profile`);
      }
    }
    state.store.set('selected', name);
    return name;
  });

  // Routing rules: live rules from the Clash API when the core is running,
  // otherwise computed from the generated config. The renderer shows live
  // rules when present, so the config route is only built when needed.
  ipcMain.handle('rules:get', async () => {
    const running = state.singbox.isRunning();
    let live = null;
    if (running) {
      try {
        const d = await core.clashApi('GET', '/rules');
        live = d.rules || null;
      } catch (e) {
        /* ignore */
      }
    }
    const fromConfig = live && live.length ? { rules: [], ruleSets: [] } : core.currentRouteInfo();
    return { ...fromConfig, live, running };
  });

  // The active subscription's policy groups + the user's outbound overrides.
  ipcMain.handle('rules:groups', () => core.ruleGroupInfo());

  // Live connections from the Clash API.
  ipcMain.handle('connections:get', async () => {
    if (!state.singbox.isRunning()) return { running: false, connections: [], up: 0, down: 0 };
    try {
      const d = await core.clashApi('GET', '/connections');
      const all = Array.isArray(d.connections) ? d.connections : [];
      const recent = recentConnections(all, MAX_IPC_CONNECTIONS)
        .map((c) => {
          const m = c.metadata || {};
          return {
            id: c.id,
            start: c.start,
            upload: c.upload || 0,
            download: c.download || 0,
            rule: c.rule || '',
            chains: Array.isArray(c.chains) ? c.chains : [],
            metadata: {
              host: m.host || '',
              destinationIP: m.destinationIP || '',
              destinationPort: m.destinationPort || '',
              network: m.network || '',
            },
          };
        });
      return {
        running: true,
        connections: recent,
        totalConnections: all.length,
        up: d.uploadTotal || 0,
        down: d.downloadTotal || 0,
      };
    } catch (e) {
      return {
        running: state.singbox.isRunning(),
        connections: [],
        up: 0,
        down: 0,
        error: String(e && e.message || e || 'Clash API unavailable'),
      };
    }
  });

  // Close a single connection by its Clash API id.
  ipcMain.handle('connections:close', async (_e, { id }) => {
    if (state.singbox.isRunning() && typeof id === 'string' && id) {
      await core.clashApi('DELETE', '/connections/' + encodeURIComponent(id));
    }
    return true;
  });

  ipcMain.handle('connections:closeAll', async () => {
    if (state.singbox.isRunning()) {
      await core.clashApi('DELETE', '/connections');
    }
    return true;
  });

  // Rule-set management: report status of each routing rule-set.
  ipcMain.handle('ruleset:list', async () => {
    const isMihomo = state.singbox.getCoreType() === 'mihomo';
    const items = isMihomo
      ? [
          { tag: 'geoip', file: 'geoip.dat' },
          { tag: 'geosite', file: 'geosite.dat' },
          { tag: 'country-mmdb', file: 'country.mmdb' },
        ]
      : [
          { tag: 'geoip-cn', file: 'geoip-cn.srs' },
          { tag: 'geosite-cn', file: 'geosite-cn.srs' },
        ];
    const dirs = [
      { loc: 'updated', dir: state.singbox.coreDir(isMihomo ? 'mihomo' : 'sing-box') },
      ...state.singbox.resourceDirs(isMihomo ? 'mihomo' : 'sing-box').map((dir) => ({ loc: 'bundled', dir })),
      // Legacy fallback for users upgrading from the shared runtime layout.
      ...(isMihomo
        ? [{ loc: 'updated', dir: runtimeDir }, { loc: 'bundled', dir: resourcesBinDir }]
        : [{ loc: 'updated', dir: path.join(runtimeDir, 'bin') }, { loc: 'bundled', dir: resourcesBinDir }]),
    ].filter((d, i, arr) => d.dir && arr.findIndex((x) => x.dir === d.dir) === i);
    const readUpdatedAt = (dir, file) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'geodata-meta.json'), 'utf-8'));
        const updatedAt = Number(meta && meta[file] && meta[file].updatedAt);
        return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
      } catch (_) {
        return 0;
      }
    };
    return items.map((it) => {
      let found = null;
      for (const d of dirs) {
        const p = path.join(d.dir, it.file);
        try {
          if (fs.existsSync(p)) {
            const st = fs.statSync(p);
            found = {
              location: d.loc,
              size: st.size,
              valid: isMihomo ? state.singbox._validGeoFile(p) : state.singbox._validSrs(p),
              mtime: st.mtimeMs,
              dir: d.dir,
            };
            break;
          }
        } catch (_) {
          /* ignore */
        }
      }
      return {
        tag: it.tag,
        file: it.file,
        present: !!found,
        size: found ? found.size : 0,
        location: found ? found.location : 'none',
        valid: found ? found.valid : false,
        updatedAt: found ? readUpdatedAt(found.dir, it.file) || found.mtime : 0,
      };
    });
  });

  // App version + update check.
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('dialog:prepare', (event) => {
    senderWindow(event);
    return dialogWindows.prepareDialog();
  });
  ipcMain.handle('dialog:open', async (event, request) => {
    senderWindow(event);
    const { type, payload } = request && typeof request === 'object' ? request : {};
    return dialogWindows.openDialog(type, payload);
  });
  ipcMain.handle('dialog:getContext', (event) => dialogWindows.getDialogContext(event));
  ipcMain.handle('dialog:viewReady', (event) => dialogWindows.viewReady(event));
  ipcMain.handle('dialog:close', (event) => {
    dialogWindows.requireDialogSender(event);
    setImmediate(() => dialogWindows.closeDialog());
    return true;
  });
  ipcMain.handle('dialog:changed', (event, change) => dialogWindows.notifyChanged(event, change));
  ipcMain.handle('window:minimize', (event) => {
    senderWindow(event).minimize();
    return true;
  });
  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = senderWindow(event);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:isMaximized', (event) => senderWindow(event).isMaximized());
  ipcMain.handle('window:close', (event) => {
    senderWindow(event).close();
    return true;
  });
  // Only web URLs may leave the app: openExternal with e.g. file:// or
  // ms-settings: from a (hypothetically compromised) renderer is an easy
  // sandbox escape, so allowlist the protocol here in the main process.
  ipcMain.handle('app:openExternal', async (_e, { url }) => {
    let u;
    try {
      u = new URL(String(url));
    } catch (_) {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(u.toString());
    return true;
  });
  ipcMain.handle('app:checkUpdate', () => update.checkUpdate(app.getVersion(), core.currentProxyPort(), sendLog));

  // Download the new installer (proxy-first with direct fallback), launch it,
  // then quit so it can replace our files.
  ipcMain.handle('update:download', () => {
    if (updateDownloadRunning || updateQuitPending || app.isQuitting) return Promise.reject(new Error('app update download already in progress'));
    updateDownloadRunning = true;
    const controller = new AbortController();
    updateDownloadController = controller;
    let task;
    task = (async () => {
      try {
      const proxyPort = core.currentProxyPort();
      const info = await update.checkUpdate(app.getVersion(), proxyPort, sendLog, { signal: controller.signal });
      if (controller.signal.aborted || app.isQuitting) throw Object.assign(new Error('app is shutting down'), { code: 'ABORT_ERR' });
      if (info.error) throw new Error(info.error);
      if (!info.hasUpdate) throw new Error('already up to date');
      if (!info.assetUrl || !info.assetName) throw new Error('no installer asset on the latest release');
      const assetName = path.basename(info.assetName);
      if (assetName !== info.assetName || /[\\/]/.test(info.assetName)) {
        throw new Error('invalid installer asset name');
      }
      const dest = path.join(app.getPath('temp'), assetName);
      sendLog('[gui] downloading update: ' + info.assetUrl + (proxyPort ? ' (via proxy)' : ' (direct — start the core to download via proxy)'));
      try {
        await fetch.downloadWithFallback(info.assetUrl, dest, {
          proxyPort,
          signal: controller.signal,
          log: sendLog,
          onProgress: (p) => sendToMain('core:downloadProgress', p),
        });
      } catch (e) {
        if (e && e.code === 'ABORT_ERR') throw e;
        throw new Error(
          e.message + (proxyPort ? '' : ' — start the core first so the download can go through the proxy')
        );
      }
      if (controller.signal.aborted || app.isQuitting) {
        try { fs.unlinkSync(dest); } catch (_) {}
        throw Object.assign(new Error('app is shutting down'), { code: 'ABORT_ERR' });
      }
      try {
        update.validateInstaller(dest, Number(info.assetSize) || 0);
      } catch (error) {
        try { fs.unlinkSync(dest); } catch (_) {}
        throw error;
      }
      const err = await shell.openPath(dest);
      if (err) {
        try { fs.unlinkSync(dest); } catch (_) {}
        throw new Error('failed to launch installer: ' + err);
      }
      sendLog('[gui] installer launched; quitting for the update');
      updateQuitPending = true;
      // Keep normal before-quit cleanup active while the installer starts. If
      // another quit arrives during this delay, its cleanup owns the shutdown.
      setTimeout(async () => {
        if (app.isQuitting) return;
        app.isQuitting = true;
        try { await core.cleanup(); } catch (_) { /* best-effort */ }
        app.quit();
      }, 1200);
      return true;
      } finally {
        updateDownloadRunning = false;
        if (updateDownloadController === controller) updateDownloadController = null;
      }
    })();
    appUpdateTask = task;
    task.finally(() => {
      if (appUpdateTask === task) appUpdateTask = null;
    }).catch(() => {});
    return task;
  });

  // Custom rule-sets (remote, multi-format -> converted & applied).
  const sanitizeCrs = (c) => ({
    id: c.id, name: c.name, url: c.url, format: core.normalizeCustomRuleSetFormat(c.format, c.url), target: c.target,
    enabled: c.enabled !== false, kind: c.kind || null, count: c.count ?? null,
    autoUpdateMinutes: c.autoUpdateMinutes || 0,
    updatedAt: c.updatedAt || 0, error: c.error || null,
  });
  ipcMain.handle('customrs:list', () => state.store.listCustomRuleSets().map(sanitizeCrs));
  ipcMain.handle('customrs:add', (_e, { name, url, format, target }) => core.queueCustomRuleMutation(async () => {
    reqUrl(url, 'url');
    const fmt = format ? reqEnum(format, VALID_CRS_FORMATS, 'format') : core.detectCustomRuleSetFormat(url);
    const tgt = target ? reqEnum(target, VALID_TARGETS, 'target') : 'proxy';
    let c = { id: crypto.randomUUID(), name: name || url, url, format: fmt, target: tgt, enabled: true };
    const snapshot = customRuleFileSnapshot(c.id);
    let processed = false;
    try {
      c = await core.processCustomRuleSet(c);
      processed = true;
      return await core.queueConfigMutation(async () => {
        let committed = false;
        const wasRunning = state.singbox.isRunning();
        try {
          state.store.upsertCustomRuleSet(c);
          committed = true;
          core.rescheduleAutoUpdate();
          await core.restartIfRunning();
          return sanitizeCrs(c);
        } catch (error) {
          const restore = () => {
            restoreCustomRuleFile(snapshot);
            if (committed) state.store.removeCustomRuleSet(c.id);
            core.rescheduleAutoUpdate();
          };
          if (committed) {
            return rollbackMutationAfterFailure(restore, wasRunning, error, 'remote rules after add failure');
          }
          try { restore(); } catch (recoveryError) { error.recoveryError = recoveryError; }
          throw error;
        }
      });
    } catch (error) {
      if (!processed) {
        try { restoreCustomRuleFile(snapshot); } catch (recoveryError) { error.recoveryError = recoveryError; }
      }
      throw error;
    } finally {
      discardCustomRuleFileSnapshot(snapshot);
    }
  }));
  ipcMain.handle('customrs:edit', (_e, payload) => core.queueCustomRuleMutation(async () => {
    const { id, name, url, format, target, enabled, autoUpdateMinutes } = payload;
    reqStr(id, 'id');
    if (url !== undefined) reqUrl(url, 'url');
    if (format !== undefined) reqEnum(format, VALID_CRS_FORMATS, 'format');
    if (target !== undefined) reqEnum(target, VALID_TARGETS, 'target');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid enabled flag');
    if (autoUpdateMinutes !== undefined) reqAutoUpdateMinutes(autoUpdateMinutes);
    const original = state.store.getCustomRuleSet(id);
    if (!original) throw new Error('rule-set not found');
    const sourceKey = core.customRuleSetSourceKey(original);
    let c = { ...original };
    if (name !== undefined) c.name = name;
    if (enabled !== undefined) c.enabled = enabled;
    if (autoUpdateMinutes !== undefined) c.autoUpdateMinutes = autoUpdateMinutes;
    const nextFormat = format !== undefined ? format : url !== undefined ? core.detectCustomRuleSetFormat(url) : core.normalizeCustomRuleSetFormat(c.format, c.url);
    const sourceChanged = (url !== undefined && url !== c.url) ||
      nextFormat !== core.normalizeCustomRuleSetFormat(c.format, c.url);
    const targetChanged = target !== undefined && target !== c.target;
    // Binary .srs content is independent of its outbound target. Inline rules
    // embed that target and therefore need to be parsed again.
    const reprocess = sourceChanged || (targetChanged && c.kind === 'inline');
    if (url !== undefined) c.url = url;
    c.format = nextFormat;
    if (target !== undefined) c.target = target;
    const configChanged = sourceChanged || targetChanged || (c.enabled !== false) !== (original.enabled !== false);
    const token = reprocess ? core.beginRemoteUpdate('rule-set', id) : null;
    const snapshot = reprocess ? customRuleFileSnapshot(id) : null;
    let processedRule = null;
    let prepared = !reprocess;
    try {
      if (reprocess) {
        processedRule = await core.processCustomRuleSet(c, {
          beforeCommit: () => currentRuleSetForUpdate(id, sourceKey, token),
        });
        prepared = true;
      }
      return await core.queueConfigMutation(async () => {
        const latest = currentRuleSetForUpdate(id, sourceKey, token);
        const desired = { ...latest };
        if (name !== undefined) desired.name = name;
        if (enabled !== undefined) desired.enabled = enabled;
        if (autoUpdateMinutes !== undefined) desired.autoUpdateMinutes = autoUpdateMinutes;
        if (url !== undefined) desired.url = c.url;
        desired.format = c.format;
        if (target !== undefined) desired.target = c.target;
        c = processedRule ? core.mergeProcessedCustomRuleSet(desired, processedRule) : desired;
        const wasRunning = state.singbox.isRunning();
        let committed = false;
        try {
          state.store.upsertCustomRuleSet(c);
          committed = true;
          if (c.kind !== 'ruleset' && snapshot) {
            try { fs.unlinkSync(snapshot.target); } catch (_) {}
          }
          core.rescheduleAutoUpdate();
          if (configChanged) await core.restartIfRunning();
          return sanitizeCrs(c);
        } catch (error) {
          const restore = () => {
            restoreCustomRuleFile(snapshot);
            if (committed) state.store.upsertCustomRuleSet(latest);
            core.rescheduleAutoUpdate();
          };
          if (committed) {
            return rollbackMutationAfterFailure(restore, wasRunning, error, 'remote rules after edit failure');
          }
          try { restore(); } catch (recoveryError) { error.recoveryError = recoveryError; }
          throw error;
        }
      });
    } catch (error) {
      if (!prepared) {
        try { restoreCustomRuleFile(snapshot); } catch (recoveryError) { error.recoveryError = recoveryError; }
      }
      throw error;
    } finally {
      if (token) core.finishRemoteUpdate('rule-set', id, token);
      discardCustomRuleFileSnapshot(snapshot);
    }
  }));
  ipcMain.handle('customrs:refresh', (_e, { id }) => core.queueCustomRuleMutation(async () => {
    reqStr(id, 'id');
    const current = state.store.getCustomRuleSet(id);
    if (!current) throw new Error('rule-set not found');
    const sourceKey = core.customRuleSetSourceKey(current);
    const token = core.beginRemoteUpdate('rule-set', id);
    const snapshot = customRuleFileSnapshot(id);
    let prepared = false;
    try {
      const processed = await core.processCustomRuleSet(current, {
        beforeCommit: () => currentRuleSetForUpdate(id, sourceKey, token),
      });
      prepared = true;
      return await core.queueConfigMutation(async () => {
        const latest = currentRuleSetForUpdate(id, sourceKey, token);
        const c = core.mergeProcessedCustomRuleSet(latest, processed);
        const wasRunning = state.singbox.isRunning();
        let committed = false;
        try {
          state.store.upsertCustomRuleSet(c);
          committed = true;
          if (c.kind !== 'ruleset') {
            try { fs.unlinkSync(snapshot.target); } catch (_) {}
          }
          await core.restartIfRunning();
          return sanitizeCrs(c);
        } catch (error) {
          const restore = () => {
            restoreCustomRuleFile(snapshot);
            if (committed) state.store.upsertCustomRuleSet(latest);
          };
          if (committed) {
            return rollbackMutationAfterFailure(restore, wasRunning, error, 'remote rules after refresh failure');
          }
          try { restore(); } catch (recoveryError) { error.recoveryError = recoveryError; }
          throw error;
        }
      });
    } catch (error) {
      if (!prepared) {
        try { restoreCustomRuleFile(snapshot); } catch (recoveryError) { error.recoveryError = recoveryError; }
      }
      throw error;
    } finally {
      core.finishRemoteUpdate('rule-set', id, token);
      discardCustomRuleFileSnapshot(snapshot);
    }
  }));
  ipcMain.handle('customrs:remove', (_e, { id }) => core.queueCustomRuleMutation(async () => {
    return core.queueConfigMutation(async () => {
      reqStr(id, 'id');
      const current = state.store.getCustomRuleSet(id);
      if (!current) throw new Error('rule-set not found');
      const snapshot = customRuleFileSnapshot(id);
      const wasRunning = state.singbox.isRunning();
      core.cancelRemoteUpdate('rule-set', id);
      state.store.removeCustomRuleSet(id);
      try { fs.unlinkSync(snapshot.target); } catch (_) {}
      try { fs.unlinkSync(path.join(runtimeDir, 'bin', core.customRuleSetFileName(id))); } catch (_) {}
      try {
        core.rescheduleAutoUpdate();
        await core.restartIfRunning();
        return true;
      } catch (error) {
        return rollbackMutationAfterFailure(
          () => {
            restoreCustomRuleFile(snapshot);
            state.store.upsertCustomRuleSet(current);
            core.rescheduleAutoUpdate();
          },
          wasRunning,
          error,
          'remote rules after remove failure'
        );
      } finally {
        discardCustomRuleFileSnapshot(snapshot);
      }
    });
  }));

  // Local rules (user-added domain/ip_cidr/... -> proxy/direct/reject).
  const VALID_MATCH = ['domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'process_name'];
  const normValues = (v) =>
    (Array.isArray(v) ? v : String(v || '').split(/[\r\n,]+/))
      .map((s) => String(s).trim())
      .filter(Boolean);
  const sanitizeLr = (lr) => ({
    id: lr.id, name: lr.name || '', matchType: lr.matchType,
    values: lr.values || [], target: lr.target || 'proxy', enabled: lr.enabled !== false,
  });
  ipcMain.handle('localrules:list', () => (state.store.get('localRules') || []).map(sanitizeLr));
  ipcMain.handle('localrules:add', (_e, { name, matchType, values, target }) => core.queueConfigMutation(async () => {
    if (!VALID_MATCH.includes(matchType)) throw new Error('invalid rule type');
    const vals = normValues(values);
    if (!vals.length) throw new Error('no rule values provided');
    const tgt = target ? reqEnum(target, VALID_TARGETS, 'target') : 'proxy';
    const lr = { id: crypto.randomUUID(), name: name || '', matchType, values: vals, target: tgt, enabled: true };
    const previous = state.store.get('localRules') || [];
    const wasRunning = state.singbox.isRunning();
    state.store.set('localRules', [...previous, lr]);
    try {
      await core.restartIfRunning();
    } catch (error) {
      return rollbackMutationAfterFailure(
        () => state.store.set('localRules', previous),
        wasRunning,
        error,
        'local rules after add failure'
      );
    }
    return sanitizeLr(lr);
  }));
  ipcMain.handle('localrules:edit', (_e, { id, name, matchType, values, target, enabled }) => core.queueConfigMutation(async () => {
    reqStr(id, 'id');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid enabled flag');
    const previous = state.store.get('localRules') || [];
    const list = previous.slice();
    const idx = previous.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('local rule not found');
    const lr = { ...list[idx] };
    if (name !== undefined) lr.name = name;
    if (matchType !== undefined) {
      if (!VALID_MATCH.includes(matchType)) throw new Error('invalid rule type');
      lr.matchType = matchType;
    }
    if (values !== undefined) {
      lr.values = normValues(values);
      if (!lr.values.length) throw new Error('no rule values provided');
    }
    if (target !== undefined) lr.target = reqEnum(target, VALID_TARGETS, 'target');
    if (enabled !== undefined) lr.enabled = enabled;
    list[idx] = lr;
    const configChanged = [matchType, values, target, enabled].some((value) => value !== undefined);
    const wasRunning = state.singbox.isRunning();
    state.store.set('localRules', list);
    if (configChanged) {
      try {
        await core.restartIfRunning();
      } catch (error) {
        return rollbackMutationAfterFailure(
          () => state.store.set('localRules', previous),
          wasRunning,
          error,
          'local rules after edit failure'
        );
      }
    }
    return sanitizeLr(lr);
  }));
  ipcMain.handle('localrules:remove', (_e, { id }) => core.queueConfigMutation(async () => {
    reqStr(id, 'id');
    const previous = state.store.get('localRules') || [];
    if (!previous.some((x) => x.id === id)) throw new Error('local rule not found');
    const list = previous.filter((x) => x.id !== id);
    const wasRunning = state.singbox.isRunning();
    state.store.set('localRules', list);
    try {
      await core.restartIfRunning();
    } catch (error) {
      return rollbackMutationAfterFailure(
        () => state.store.set('localRules', previous),
        wasRunning,
        error,
        'local rules after remove failure'
      );
    }
    return true;
  }));

  // Diagnostics and maintenance tools. Renderer input is deliberately small;
  // all network, process, filesystem and core operations remain in main.
  ipcMain.handle('tools:routeInspect', (_e, { value }) => {
    reqStr(value, 'domain or IP');
    return toolbox.inspectRoute(value, toolContext);
  });
  ipcMain.handle('tools:networkDiagnostics', () => toolbox.networkDiagnostics(toolContext));
  ipcMain.handle('tools:configCheck', () => toolbox.checkAllConfigs(toolContext));
  ipcMain.handle('tools:portCheck', (_e, { ports }) => toolbox.inspectPorts(ports, toolContext));
  ipcMain.handle('tools:dnsCompare', (_e, { host }) => {
    reqStr(host, 'host');
    return toolbox.dnsComparison(host, toolContext);
  });

  ipcMain.handle('tools:saveReport', async (event, { name, content, format }) => {
    reqStr(content, 'report');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('report exceeds 2 MB');
    format = format === 'txt' ? 'txt' : 'json';
    const safeBase = String(name || 'dart-report').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 96) || 'dart-report';
    const fileName = safeBase.toLowerCase().endsWith('.' + format) ? safeBase : safeBase + '.' + format;
    const result = await dialog.showSaveDialog(dialogWindows.ownerWindow(event), {
      title: 'Export diagnostic report',
      defaultPath: fileName,
      filters: [{ name: format === 'json' ? 'JSON' : 'Text', extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomicText(result.filePath, content);
    return result.filePath;
  });

  ipcMain.handle('tools:backupExport', async (event) => {
    const backup = toolbox.buildBackup(state.store, app.getVersion());
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const result = await dialog.showSaveDialog(dialogWindows.ownerWindow(event), {
      title: 'Export Dart backup',
      defaultPath: `Dart-backup-${stamp}.json`,
      filters: [{ name: 'Dart backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomicText(result.filePath, JSON.stringify(backup, null, 2));
    return result.filePath;
  });

  ipcMain.handle('tools:backupSelect', async (event) => {
    const result = await dialog.showOpenDialog(dialogWindows.ownerWindow(event), {
      title: 'Select Dart backup',
      properties: ['openFile'],
      filters: [{ name: 'Dart backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const { document, normalized, digest } = await readBackupDocument(file);
    const token = crypto.randomUUID();
    const summary = toolbox.backupSummary(document, normalized);
    pendingBackup = { token, file, digest, expiresAt: Date.now() + 10 * 60 * 1000 };
    return { token, fileName: path.basename(file), summary };
  });

  ipcMain.handle('tools:backupRestore', async (_e, { token }) => {
    reqStr(token, 'backup token');
    if (!pendingBackup || pendingBackup.token !== token || pendingBackup.expiresAt < Date.now()) {
      pendingBackup = null;
      throw new Error('backup selection expired; select the file again');
    }
    if (state.singbox.isCoreDownloadInProgress()) {
      throw new Error('wait for the core update to finish before restoring a backup');
    }
    const selected = pendingBackup;
    const loaded = await readBackupDocument(selected.file);
    if (loaded.digest !== selected.digest) {
      pendingBackup = null;
      throw new Error('backup file changed after selection; select it again');
    }
    const restored = {
      ...loaded.normalized,
      // Backups intentionally omit downloaded .srs files. Never let restored
      // metadata attach to an unrelated stale file that happens to share its id.
      customRuleSets: loaded.normalized.customRuleSets.map((item) => item.kind === 'ruleset'
        ? {
            ...item,
            kind: null,
            count: null,
            updatedAt: 0,
            autoUpdateLastAttemptAt: 0,
            error: null,
          }
        : item),
    };
    const currentSettings = state.store.getSettings();
    const knownSettings = new Set(Object.keys(currentSettings));
    restored.settings = Object.fromEntries(
      Object.entries(restored.settings).filter(([key]) => knownSettings.has(key))
    );
    validateSettingsPatch(restored.settings, currentSettings);

    return core.queueCustomRuleMutation(() => core.queueConfigMutation(async () => {
      const before = toolbox.validateBackupDocument(toolbox.buildBackup(state.store, app.getVersion()));
      const wasRunning = state.singbox.isRunning();
      core.cancelAllRemoteUpdates();
      if (wasRunning) await core.stopCore(true);
      const apply = (data) => {
        state.store.set('subscriptions', data.subscriptions);
        state.store.updateSettings(data.settings);
        state.store.set('activeSub', data.activeSub);
        state.store.set('selected', data.selected);
        state.store.set('customRuleSets', data.customRuleSets);
        state.store.set('localRules', data.localRules);
      };
      const activate = (data) => {
        apply(data);
        const settings = state.store.getSettings();
        state.singbox.setCoreType(settings.coreType);
        core.applyAutoLaunch(settings.autoLaunch, settings.silentStart);
        core.rescheduleAutoUpdate();
      };
      try {
        activate(restored);
        // Also invalidate a manual update that may have started while the backup
        // data was being written. Any later request starts against restored data.
        core.cancelAllRemoteUpdates();
        const removed = purgeCustomRuleBinaries();
        if (removed) sendLog(`[gui] removed ${removed} stale custom rule-set file(s) after backup restore`);
      } catch (error) {
        core.cancelAllRemoteUpdates();
        pendingBackup = null;
        try {
          activate(before);
          if (wasRunning) await core.startCore();
        } catch (recoveryError) {
          error.recoveryError = recoveryError;
        }
        throw error;
      }

      pendingBackup = null;
      sendToMain('subs:changed');
      sendStatus();
      return { restored: true, stoppedCore: wasRunning, summary: toolbox.backupSummary({ appVersion: app.getVersion(), createdAt: new Date().toISOString() }, restored) };
    }));
  });

  // UWP loopback exemption tool (Windows). Listing is unprivileged; applying
  // changes needs admin rights.
  ipcMain.handle('uwp:warm', () => {
    uwp.listApps(sendLog).catch((error) => sendLog(`[gui] UWP prefetch failed: ${error.message}`));
    return true;
  });
  ipcMain.handle('uwp:list', (_event, request = {}) => {
    if (request.force !== undefined && typeof request.force !== 'boolean') throw new Error('invalid force flag');
    return uwp.listApps(sendLog, { force: request.force === true });
  });
  ipcMain.handle('uwp:set', async (_e, { sids }) => {
    if (!Array.isArray(sids)) throw new Error('invalid sids');
    const validSids = sids.filter((sid) => /^S-1-15-2-[0-9-]+$/i.test(String(sid)));
    if (validSids.length !== sids.length) throw new Error('invalid sids');
    if (!(await isWindowsAdmin())) {
      state.store.set('pendingUwpLoopbackSids', validSids);
      const r = relaunchElevated();
      if (!r || r.ok === false) {
        state.store.set('pendingUwpLoopbackSids', null);
        throw new Error((r && r.error) || 'administrator rights required');
      }
      return { restarting: true };
    }
    await uwp.setExemptions(validSids);
    state.store.set('pendingUwpLoopbackSids', null);
    return true;
  });

  // Windows admin status / elevate (needed for TUN).
  ipcMain.handle('app:isAdmin', () => isWindowsAdmin());
  ipcMain.handle('app:relaunchElevated', () => relaunchElevated());

  // Toggle TUN mode. On Windows without admin rights, offer to restart elevated.
  ipcMain.handle('tun:set', (_e, { enable }) => core.queueConfigMutation(async () => {
    reqBoolean(enable, 'enable');
    if (state.singbox.isCoreDownloadInProgress()) {
      throw new Error('wait for the core update to finish before changing TUN mode');
    }
    const previous = state.store.getSettings();
    const wasRunning = state.singbox.isRunning();
    state.store.updateSettings({ enableTun: !!enable });
    if (enable && process.platform === 'win32' && !(await isWindowsAdmin())) {
      try {
        if (await promptRestartForTun()) {
          return { restarting: true, settings: state.store.getSettings() };
        }
      } catch (e) {
        state.store.updateSettings({ enableTun: !!previous.enableTun });
        throw e;
      }
      // Declined: revert the setting so the UI stays consistent.
      state.store.updateSettings({ enableTun: !!previous.enableTun });
      return { enabled: !!previous.enableTun, settings: state.store.getSettings() };
    }
    // TUN changed: if auto-launch is on, this flips the Windows mechanism between
    // the plain Run item and the elevated logon task. We are already admin on the
    // enable path here (the non-admin case relaunched above), so it is silent.
    const s = state.store.getSettings();
    if (s.autoLaunch) {
      try {
        core.applyAutoLaunch(s.autoLaunch, s.silentStart, { interactive: true });
      } catch (error) {
        return rollbackSettingsAfterFailure(previous, wasRunning, error);
      }
    }
    if (wasRunning) {
      try {
        await core.restartIfRunning();
      } catch (error) {
        return rollbackSettingsAfterFailure(previous, wasRunning, error);
      }
    }
    return { enabled: !!enable, settings: state.store.getSettings() };
  }));

  ipcMain.handle('mode:set', async (_e, { mode }) => {
    if (!VALID_MODES.includes(mode)) throw new Error('invalid mode');
    await core.setProxyMode(mode);
    return mode;
  });

  ipcMain.handle('core:start', async () => {
    await core.queueConfigMutation(() => core.startCore());
    return true;
  });

  ipcMain.handle('core:stop', async () => {
    await core.queueConfigMutation(() => core.stopCore(true));
    return true;
  });

  ipcMain.handle('core:restart', async () => {
    await core.queueConfigMutation(() => core.restartCore());
    return true;
  });

  ipcMain.handle('core:check', () => core.queueConfigMutation(async () => {
    if (state.singbox.getCoreType() === 'mihomo') await state.singbox.validateMihomoGeoData();
    const { config } = core.buildCurrentConfig();
    await state.singbox.checkConfigFor(state.singbox.getCoreType(), config);
    return true;
  }));

  // Download either core. The active core can keep serving the download when
  // installing the other one; an active target is stopped only for extraction.
  ipcMain.handle('core:download', (_event, payload = {}) => {
    if (coreUpdateTask) return Promise.reject(new Error('core update already in progress'));
    let task;
    task = (async () => {
    let { version } = payload || {};
    if (version !== undefined && typeof version !== 'string') throw new Error('invalid version');
    version = String(version || '').trim();
    if (version && !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('invalid version');
    }
    const selectedCoreType = state.singbox.getCoreType();
    const coreType = payload.coreType === undefined
      ? selectedCoreType
      : reqEnum(payload.coreType, ['sing-box', 'mihomo'], 'coreType');
    const target = path.join(state.singbox.ensureCoreDir(coreType), state.singbox.binNameFor(coreType));
    let restartAfterInstall = false;
    let backup = null;
    let installedPath = null;
    let installError = null;
    try {
      installedPath = await state.singbox.downloadCore(
        version,
        (progress) => {
          sendToMain('core:downloadProgress', progress);
          dialogWindows.sendToDialog('core:downloadProgress', progress);
        },
        {
          coreType,
          proxyPort: core.currentProxyPort(),
          beforeInstall: async () => {
            if (state.singbox.getCoreType() !== selectedCoreType) {
              throw new Error('core type changed during update; retry the update');
            }
            if (coreType === selectedCoreType && state.singbox.isRunning()) {
              restartAfterInstall = true;
              sendLog('[gui] stopping core to install the update...');
              await core.stopCore(undefined, { allowDuringCoreUpdate: true });
            }
            if (fs.existsSync(target)) {
              backup = uniqueSibling(target, 'update-backup');
              fs.copyFileSync(target, backup);
              if (process.platform !== 'win32') fs.chmodSync(backup, fs.statSync(target).mode);
            }
          },
        }
      );
    } catch (error) {
      installError = error;
    }

    // beforeInstall snapshots the currently working runtime binary. Extraction
    // is atomic in the normal case, but if the filesystem also rejects its
    // internal rollback, do not discard this independent copy: restore it before
    // attempting to bring the previously running core back online.
    if (installError && backup && fs.existsSync(backup)) {
      try {
        replaceFileSync(backup, target);
        backup = null;
        state.singbox.invalidateVersionCache();
        sendLog('[gui] restored the previous core after an interrupted install');
      } catch (recoveryError) {
        installError.recoveryError = recoveryError;
        sendLog('[gui] failed to restore the previous core after install error: ' + recoveryError.message);
      }
    }

    let restartError = null;
    if (restartAfterInstall && !state.singbox.isRunning()) {
      try {
        await core.startCore();
        sendLog('[gui] core restarted after update');
      } catch (error) {
        restartError = error;
      }
    }

    let rolledBack = false;
    if (installedPath && restartError) {
      try {
        if (backup && fs.existsSync(backup)) {
          replaceFileSync(backup, target);
          backup = null;
        } else {
          // The previous core came from the bundled resources directory. Remove
          // the failed runtime override so resolution falls back to that copy.
          try { fs.unlinkSync(target); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        state.singbox.invalidateVersionCache();
        await core.startCore();
        rolledBack = true;
        sendLog('[gui] core update failed to start and was rolled back');
      } catch (recoveryError) {
        restartError.recoveryError = recoveryError;
        sendLog('[gui] failed to restore the previous core after update error: ' + recoveryError.message);
      }
    }

    if (backup) {
      if (installError && installError.recoveryError) {
        sendLog('[gui] preserved the previous core backup at ' + backup);
      } else {
        try { fs.unlinkSync(backup); } catch (_) {}
      }
    }
    sendStatus();

    if (installError) {
      if (restartError) installError.recoveryError = restartError;
      throw installError;
    }
    if (restartError) {
      if (rolledBack) {
        throw new Error('updated core failed to start and the previous core was restored: ' + restartError.message);
      }
      const recovery = restartError.recoveryError;
      throw new Error(
        'updated core failed to start' +
        (recovery ? '; restoring the previous core also failed: ' + recovery.message : ': ' + restartError.message)
      );
    }
      return installedPath;
    })();
    coreUpdateTask = task;
    task.finally(() => {
      if (coreUpdateTask === task) coreUpdateTask = null;
    }).catch(() => {});
    return task;
  });

  // Update geodata (geoip-cn / geosite-cn rule-sets) into the runtime dir.
  ipcMain.handle('core:updateGeo', async () => {
    const dir = await core.refreshGeoData((progress) => {
      sendToMain('core:downloadProgress', progress);
      dialogWindows.sendToDialog('core:downloadProgress', progress);
    });
    return dir;
  });

  ipcMain.handle('core:status', () => coreStatusInfo());

  // Open the folder that holds the core binary in the OS file manager.
  ipcMain.handle('core:openFolder', async () => {
    const bin = state.singbox.resolveBinaryPath();
    if (bin) {
      shell.showItemInFolder(bin);
      return true;
    }
    const dir = state.singbox.ensureCoreDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return true;
  });

  // System proxy toggle.
  ipcMain.handle('proxy:set', async (_e, { enable }) => {
    reqBoolean(enable, 'enable');
    return core.queueConfigMutation(() => core.setSystemProxyEnabled(enable));
  });

  ipcMain.handle('app:openClashApi', async () => {
    if (!state.singbox.isRunning()) {
      throw new Error('start the core first — the panel is served by the core at /ui');
    }
    const settings = state.store.getSettings();
    const port = settings.clashApiPort;
    const secret = state.clashApiSecret;
    // The panel is served BY the core (clash_api.external_ui) on the same
    // origin as the API itself, so mixed content, CORS and Chrome's
    // public-site→127.0.0.1 blocking ("failed to fetch") can't break it.
    // zashboard reads the connection params from the #/setup route.
    const q = `hostname=127.0.0.1&port=${port}&secret=${encodeURIComponent(secret)}&protocol=http`;
    await shell.openExternal(`http://127.0.0.1:${port}/ui/#/setup?${q}`);
    return true;
  });
}

module.exports = { registerIpc };
