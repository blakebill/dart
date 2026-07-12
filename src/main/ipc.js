'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const { state, runtimeDir, resourcesBinDir, sendLog, sendStatus, coreStatusInfo } = require('./state');
const core = require('./core-control');
const { isWindowsAdmin, relaunchElevated, promptRestartForTun } = require('./admin');
const update = require('./update');
const { buildMihomoConfig, buildSingboxConfig } = require('./converter');
const subscription = require('./subscription');
const proxy = require('./proxy');
const uwp = require('./uwp');
const fetch = require('./fetch');
const { notify } = require('./notify');
const toolbox = require('./toolbox');

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

function recentConnections(items, limit) {
  const key = (item) => String(item.start || '') + '\0' + String(item.id || '');
  if (items.length <= limit) return items.slice().sort((a, b) => key(a).localeCompare(key(b)));
  const heap = [];
  const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; };
  const siftUp = (index) => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (key(heap[parent]).localeCompare(key(heap[index])) <= 0) break;
      swap(parent, index);
      index = parent;
    }
  };
  const siftDown = (index) => {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && key(heap[left]).localeCompare(key(heap[smallest])) < 0) smallest = left;
      if (right < heap.length && key(heap[right]).localeCompare(key(heap[smallest])) < 0) smallest = right;
      if (smallest === index) return;
      swap(index, smallest);
      index = smallest;
    }
  };
  for (const item of items) {
    if (heap.length < limit) {
      heap.push(item);
      siftUp(heap.length - 1);
    } else if (key(item).localeCompare(key(heap[0])) > 0) {
      heap[0] = item;
      siftDown(0);
    }
  }
  return heap.sort((a, b) => key(a).localeCompare(key(b)));
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

let pendingBackup = null;

async function writeAtomicText(file, text) {
  const tmp = file + `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf-8');
    await fs.promises.rename(tmp, file);
  } finally {
    try { await fs.promises.unlink(tmp); } catch (_) {}
  }
}

/** Remove decorative built-in group emoji from standalone converted files. */
function plainConversionLabels(value) {
  if (typeof value === 'string') {
    return value.replace(/🚀 Proxy/g, 'Dart Proxy').replace(/♻️ Auto/g, 'Dart Auto');
  }
  if (Array.isArray(value)) return value.map(plainConversionLabels);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainConversionLabels(item)]));
  }
  return value;
}

/** Register every IPC handler. Called once during boot. */
function registerIpc() {
  const toolContext = { state, core, proxy, isAdmin: isWindowsAdmin };
  ipcMain.handle('app:getState', async () => {
    const activeSub = core.getActiveSubId();
    const active = activeSub ? core.getActiveSubscription() : null;
    const activeNodes = new Map(
      active && Array.isArray(active.nodes)
        ? [[active.id, active.nodes.map((n) => ({ name: n.name, type: n.type, server: n.server, port: n.port }))]]
        : []
    );
    return {
      // The renderer receives summaries for every profile and node details only
      // for the active one, keeping inactive profiles out of its heap.
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
        nodes: activeNodes.get(s.id) || [],
      })),
      settings: state.store.getSettings(),
      selected: state.store.get('selected'),
      activeSub,
      status: await coreStatusInfo(),
    };
  });

  // Add/update a subscription (fetch and parse).
  ipcMain.handle('sub:add', async (_e, { name, url }) => {
    reqUrl(url, 'url');
    const result = await subscription.fetchSubscription(url, sendLog);
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    const isFirst = state.store.listSubscriptions().length === 0;
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
    state.store.upsertSubscription(sub);
    // Only the FIRST subscription becomes the active profile automatically.
    // (Checking `!activeSub` here used to steal activeness on legacy stores
    // where activeSub was never set — see getActiveSubId.)
    if (isFirst) state.store.set('activeSub', sub.id);
    core.rescheduleAutoUpdate();
    return sub;
  });

  // Update a specific subscription.
  ipcMain.handle('sub:update', async (_e, { id }) => {
    reqStr(id, 'id');
    const sub = state.store.getSubscription(id);
    if (!sub) throw new Error('config not found');
    const proxyPort = sub.updateViaProxy ? core.currentProxyPort() : 0;
    const result = await subscription.fetchSubscription(sub.url, sendLog, { proxyPort });
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    const nextHash = subscription.configFingerprint(result);
    const configChanged = (sub.configHash || subscription.configFingerprint(sub)) !== nextHash;
    sub.nodes = result.nodes;
    sub.format = result.format;
    sub.clashRules = result.rules || [];
    sub.clashRuleProviders = result.ruleProviders || {};
    sub.raw = result.raw || sub.raw || '';
    sub.userInfo = result.userInfo || sub.userInfo;
    sub.updatedAt = Date.now();
    sub.configHash = nextHash;
    state.store.upsertSubscription(sub);
    // Apply the active profile's new node list to a running core; otherwise
    // the Clash API keeps serving outbounds the UI no longer shows (delay
    // tests "time out", selecting a node fails with 400).
    if (configChanged && id === core.getActiveSubId()) await core.restartIfRunning();
    return sub;
  });

  ipcMain.handle('sub:remove', async (_e, { id }) => {
    reqStr(id, 'id');
    state.store.removeSubscription(id);
    const subs = state.store.listSubscriptions();
    // If the active profile was removed, fall back to the first remaining one.
    if (state.store.get('activeSub') === id) {
      state.store.set('activeSub', subs[0] ? subs[0].id : null);
      state.store.set('selected', null);
      await core.restartIfRunning();
    }
    core.rescheduleAutoUpdate();
    return true;
  });

  // Switch the active profile (subscription). Restarts the core to apply.
  ipcMain.handle('sub:setActive', async (_e, { id }) => {
    reqStr(id, 'id');
    const subs = state.store.listSubscriptions();
    if (!subs.some((s) => s.id === id)) throw new Error('config not found');
    state.store.set('activeSub', id);
    state.store.set('selected', null); // reset node selection for the new profile
    await core.restartIfRunning();
    return id;
  });

  // Edit a subscription's name / url / auto-update interval. Re-fetches if the
  // URL changed.
  ipcMain.handle('sub:edit', async (_e, { id, name, url, autoUpdateMinutes, updateViaProxy }) => {
    reqStr(id, 'id');
    const sub = state.store.getSubscription(id);
    if (!sub) throw new Error('config not found');
    if (name !== undefined) sub.name = name;
    if (autoUpdateMinutes !== undefined) sub.autoUpdateMinutes = parseInt(autoUpdateMinutes, 10) || 0;
    if (updateViaProxy !== undefined) sub.updateViaProxy = !!updateViaProxy;
    // Imported profiles legitimately have an empty URL; validate only when set.
    if (url) reqUrl(url, 'url');
    const urlChanged = url !== undefined && url !== sub.url;
    if (url !== undefined) sub.url = url;
    if (urlChanged && url) {
      const proxyPort = sub.updateViaProxy ? core.currentProxyPort() : 0;
      const result = await subscription.fetchSubscription(url, sendLog, { proxyPort });
      if (!result.nodes.length) throw new Error('no nodes parsed from the new URL');
      sub.nodes = result.nodes;
      sub.format = result.format;
      sub.clashRules = result.rules || [];
      sub.clashRuleProviders = result.ruleProviders || {};
      sub.raw = result.raw || '';
      sub.userInfo = result.userInfo || sub.userInfo;
      sub.updatedAt = Date.now();
      sub.configHash = subscription.configFingerprint(result);
    }
    state.store.upsertSubscription(sub);
    core.rescheduleAutoUpdate();
    // A URL change replaced the node list — apply it if this is the live profile.
    if (urlChanged && url && sub.id === core.getActiveSubId()) await core.restartIfRunning();
    return sub;
  });

  // Import from pasted text (Clash YAML or share links).
  ipcMain.handle('sub:import', (_e, { name, content }) => {
    reqStr(content, 'content');
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
    state.store.upsertSubscription(sub);
    return sub;
  });

  // Raw profile content (the fetched/imported source text) for in-app editing.
  // Kept out of app:getState so large profiles don't bloat every state refresh.
  ipcMain.handle('sub:getRaw', (_e, { id }) => {
    reqStr(id, 'id');
    const sub = state.store.getSubscription(id);
    if (!sub) throw new Error('config not found');
    return { raw: sub.raw || null };
  });
  ipcMain.handle('sub:saveRaw', async (_e, { id, content }) => {
    reqStr(id, 'id');
    reqStr(content, 'content');
    const sub = state.store.getSubscription(id);
    if (!sub) throw new Error('config not found');
    const result = subscription.parseSubscriptionContent(content);
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    sub.nodes = result.nodes;
    sub.format = result.format;
    sub.clashRules = result.rules || [];
    sub.clashRuleProviders = result.ruleProviders || {};
    sub.raw = String(content);
    sub.updatedAt = Date.now();
    sub.configHash = subscription.configFingerprint(result);
    state.store.upsertSubscription(sub);
    if (sub.id === core.getActiveSubId()) await core.restartIfRunning();
    return { nodeCount: result.nodes.length, format: result.format };
  });

  // Bidirectional standalone conversion (no save, no run). Auto mode converts
  // sing-box input to Clash and every other supported source to sing-box.
  ipcMain.handle('convert:preview', (_e, { content, target = 'auto' }) => {
    reqStr(content, 'content');
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
  ipcMain.handle('convert:export', async () => {
    const { config, settings } = core.buildCurrentConfig();
    // The per-run API secret is runtime-only; keep it out of shared exports.
    if (config.experimental && config.experimental.clash_api) {
      delete config.experimental.clash_api.secret;
    }
    if (settings.coreType === 'mihomo' && config.secret) delete config.secret;
    const isMihomo = settings.coreType === 'mihomo';
    const { canceled, filePath } = await dialog.showSaveDialog(state.mainWindow, {
      title: isMihomo ? 'Export mihomo config' : 'Export sing-box config',
      defaultPath: isMihomo ? 'config.yaml' : 'config.json',
      filters: isMihomo ? [{ name: 'YAML', extensions: ['yaml', 'yml'] }] : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, isMihomo ? yaml.dump(config, { lineWidth: -1, noRefs: true }) : JSON.stringify(config, null, 2), 'utf-8');
    return filePath;
  });

  ipcMain.handle('settings:update', async (_e, patch) => {
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
    const settings = state.store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      try { require('./window').applyNativeThemeSource(); } catch (_) { /* ignore */ }
    }
    if (coreTypeChanged) {
      state.singbox.setCoreType(settings.coreType);
      sendStatus();
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
      core.applyAutoLaunch(settings.autoLaunch, settings.silentStart, { interactive: true });
    }
    // These change routing, so rebuild and restart the core (when running) for
    // them to take effect immediately.
    if (configChanged && state.singbox.isRunning()) {
      await core.restartIfRunning();
    }
    return settings;
  });

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
    state.store.set('selected', name);
    if (state.singbox.isRunning()) {
      try {
        await core.setClashSelector(name);
      } catch (e) {
        // A 400 here means the running core's selector does not contain this
        // node (its config predates the current profile/node list).
        throw new Error(`${e.message} — the running core does not have this node; restart the core to apply the current profile`);
      }
    }
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
      return { running: false, connections: [], up: 0, down: 0 };
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
      try {
        await core.clashApi('DELETE', '/connections');
      } catch (e) {
        /* ignore */
      }
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
  ipcMain.handle('app:openExternal', (_e, { url }) => {
    let u;
    try {
      u = new URL(String(url));
    } catch (_) {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    shell.openExternal(u.toString());
    return true;
  });
  ipcMain.handle('app:checkUpdate', () => update.checkUpdate(app.getVersion(), core.currentProxyPort(), sendLog));

  // Download the new installer (proxy-first with direct fallback), launch it,
  // then quit so it can replace our files.
  ipcMain.handle('update:download', async () => {
    const proxyPort = core.currentProxyPort();
    const info = await update.checkUpdate(app.getVersion(), proxyPort, sendLog);
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
        log: sendLog,
        onProgress: (p) => {
          if (state.mainWindow) state.mainWindow.webContents.send('core:downloadProgress', p);
        },
      });
    } catch (e) {
      throw new Error(
        e.message + (proxyPort ? '' : ' — start the core first so the download can go through the proxy')
      );
    }
    const err = await shell.openPath(dest);
    if (err) throw new Error('failed to launch installer: ' + err);
    sendLog('[gui] installer launched; quitting for the update');
    // Give the installer a moment to start, then shut down cleanly.
    setTimeout(async () => {
      app.isQuitting = true;
      try { await core.cleanup(); } catch (_) { /* best-effort */ }
      app.quit();
    }, 1200);
    return true;
  });

  // Custom rule-sets (remote, multi-format -> converted & applied).
  const sanitizeCrs = (c) => ({
    id: c.id, name: c.name, url: c.url, format: core.normalizeCustomRuleSetFormat(c.format, c.url), target: c.target,
    enabled: c.enabled !== false, kind: c.kind || null, count: c.count ?? null,
    autoUpdateMinutes: c.autoUpdateMinutes || 0,
    updatedAt: c.updatedAt || 0, error: c.error || null,
  });
  ipcMain.handle('customrs:list', () => (state.store.get('customRuleSets') || []).map(sanitizeCrs));
  ipcMain.handle('customrs:add', async (_e, { name, url, format, target }) => {
    reqUrl(url, 'url');
    const fmt = format ? reqEnum(format, VALID_CRS_FORMATS, 'format') : core.detectCustomRuleSetFormat(url);
    const tgt = target ? reqEnum(target, VALID_TARGETS, 'target') : 'proxy';
    let c = { id: crypto.randomUUID(), name: name || url, url, format: fmt, target: tgt, enabled: true };
    c = await core.processCustomRuleSet(c);
    const list = state.store.get('customRuleSets') || [];
    list.push(c);
    state.store.set('customRuleSets', list);
    core.rescheduleAutoUpdate();
    await core.restartIfRunning();
    return sanitizeCrs(c);
  });
  ipcMain.handle('customrs:edit', async (_e, { id, name, url, format, target, enabled, autoUpdateMinutes }) => {
    reqStr(id, 'id');
    if (url !== undefined) reqUrl(url, 'url');
    if (format !== undefined) reqEnum(format, VALID_CRS_FORMATS, 'format');
    if (target !== undefined) reqEnum(target, VALID_TARGETS, 'target');
    const list = state.store.get('customRuleSets') || [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('rule-set not found');
    let c = { ...list[idx] };
    if (name !== undefined) c.name = name;
    if (enabled !== undefined) c.enabled = enabled;
    if (autoUpdateMinutes !== undefined) c.autoUpdateMinutes = parseInt(autoUpdateMinutes, 10) || 0;
    const nextFormat = format !== undefined ? format : url !== undefined ? core.detectCustomRuleSetFormat(url) : core.normalizeCustomRuleSetFormat(c.format, c.url);
    const reprocess = (url !== undefined && url !== c.url) || nextFormat !== core.normalizeCustomRuleSetFormat(c.format, c.url) || (target !== undefined && target !== c.target);
    if (url !== undefined) c.url = url;
    c.format = nextFormat;
    if (target !== undefined) c.target = target;
    if (reprocess) c = await core.processCustomRuleSet(c);
    list[idx] = c;
    state.store.set('customRuleSets', list);
    core.rescheduleAutoUpdate();
    await core.restartIfRunning();
    return sanitizeCrs(c);
  });
  ipcMain.handle('customrs:refresh', async (_e, { id }) => {
    reqStr(id, 'id');
    const list = state.store.get('customRuleSets') || [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('rule-set not found');
    const c = await core.processCustomRuleSet(list[idx]);
    list[idx] = c;
    state.store.set('customRuleSets', list);
    await core.restartIfRunning();
    return sanitizeCrs(c);
  });
  ipcMain.handle('customrs:remove', async (_e, { id }) => {
    reqStr(id, 'id');
    let list = state.store.get('customRuleSets') || [];
    list = list.filter((x) => x.id !== id);
    state.store.set('customRuleSets', list);
    const file = core.customRuleSetFileName(id);
    try { fs.unlinkSync(path.join(state.singbox.coreDir('sing-box'), file)); } catch (_) {}
    try { fs.unlinkSync(path.join(runtimeDir, 'bin', file)); } catch (_) {}
    core.rescheduleAutoUpdate();
    await core.restartIfRunning();
    return true;
  });

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
  ipcMain.handle('localrules:add', async (_e, { name, matchType, values, target }) => {
    if (!VALID_MATCH.includes(matchType)) throw new Error('invalid rule type');
    const vals = normValues(values);
    if (!vals.length) throw new Error('no rule values provided');
    const tgt = target ? reqEnum(target, VALID_TARGETS, 'target') : 'proxy';
    const lr = { id: crypto.randomUUID(), name: name || '', matchType, values: vals, target: tgt, enabled: true };
    const list = state.store.get('localRules') || [];
    list.push(lr);
    state.store.set('localRules', list);
    await core.restartIfRunning();
    return sanitizeLr(lr);
  });
  ipcMain.handle('localrules:edit', async (_e, { id, name, matchType, values, target, enabled }) => {
    reqStr(id, 'id');
    const list = state.store.get('localRules') || [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('local rule not found');
    const lr = { ...list[idx] };
    if (name !== undefined) lr.name = name;
    if (matchType !== undefined) {
      if (!VALID_MATCH.includes(matchType)) throw new Error('invalid rule type');
      lr.matchType = matchType;
    }
    if (values !== undefined) lr.values = normValues(values);
    if (target !== undefined) lr.target = reqEnum(target, VALID_TARGETS, 'target');
    if (enabled !== undefined) lr.enabled = enabled;
    list[idx] = lr;
    state.store.set('localRules', list);
    await core.restartIfRunning();
    return sanitizeLr(lr);
  });
  ipcMain.handle('localrules:remove', async (_e, { id }) => {
    reqStr(id, 'id');
    let list = state.store.get('localRules') || [];
    list = list.filter((x) => x.id !== id);
    state.store.set('localRules', list);
    await core.restartIfRunning();
    return true;
  });

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

  ipcMain.handle('tools:saveReport', async (_e, { name, content, format }) => {
    reqStr(content, 'report');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('report exceeds 2 MB');
    format = format === 'txt' ? 'txt' : 'json';
    const safeBase = String(name || 'dart-report').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 96) || 'dart-report';
    const fileName = safeBase.toLowerCase().endsWith('.' + format) ? safeBase : safeBase + '.' + format;
    const result = await dialog.showSaveDialog(state.mainWindow, {
      title: 'Export diagnostic report',
      defaultPath: fileName,
      filters: [{ name: format === 'json' ? 'JSON' : 'Text', extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomicText(result.filePath, content);
    return result.filePath;
  });

  ipcMain.handle('tools:backupExport', async () => {
    const backup = toolbox.buildBackup(state.store, app.getVersion());
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const result = await dialog.showSaveDialog(state.mainWindow, {
      title: 'Export Dart backup',
      defaultPath: `Dart-backup-${stamp}.json`,
      filters: [{ name: 'Dart backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomicText(result.filePath, JSON.stringify(backup, null, 2));
    return result.filePath;
  });

  ipcMain.handle('tools:backupSelect', async () => {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: 'Select Dart backup',
      properties: ['openFile'],
      filters: [{ name: 'Dart backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('backup is not a file or exceeds 64 MB');
    const document = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    const normalized = toolbox.validateBackupDocument(document);
    const token = crypto.randomUUID();
    const summary = toolbox.backupSummary(document, normalized);
    pendingBackup = { token, normalized, summary, expiresAt: Date.now() + 10 * 60 * 1000 };
    return { token, fileName: path.basename(file), summary };
  });

  ipcMain.handle('tools:backupRestore', async (_e, { token }) => {
    reqStr(token, 'backup token');
    if (!pendingBackup || pendingBackup.token !== token || pendingBackup.expiresAt < Date.now()) {
      pendingBackup = null;
      throw new Error('backup selection expired; select the file again');
    }
    const restored = pendingBackup.normalized;
    const currentSettings = state.store.getSettings();
    const knownSettings = new Set(Object.keys(currentSettings));
    restored.settings = Object.fromEntries(
      Object.entries(restored.settings).filter(([key]) => knownSettings.has(key))
    );
    validateSettingsPatch(restored.settings, currentSettings);

    const before = toolbox.validateBackupDocument(toolbox.buildBackup(state.store, app.getVersion()));
    const wasRunning = state.singbox.isRunning();
    if (wasRunning) await core.stopCore(true);
    const apply = (data) => {
      state.store.set('subscriptions', data.subscriptions);
      state.store.updateSettings(data.settings);
      state.store.set('activeSub', data.activeSub);
      state.store.set('selected', data.selected);
      state.store.set('customRuleSets', data.customRuleSets);
      state.store.set('localRules', data.localRules);
    };
    try {
      apply(restored);
    } catch (error) {
      try { apply(before); } catch (_) {}
      throw error;
    }

    const settings = state.store.getSettings();
    state.singbox.setCoreType(settings.coreType);
    core.applyAutoLaunch(settings.autoLaunch, settings.silentStart);
    core.rescheduleAutoUpdate();
    pendingBackup = null;
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('subs:changed');
    }
    sendStatus();
    return { restored: true, stoppedCore: wasRunning, summary: toolbox.backupSummary({ appVersion: app.getVersion(), createdAt: new Date().toISOString() }, restored) };
  });

  // UWP loopback exemption tool (Windows). Listing is unprivileged; applying
  // changes needs admin rights.
  ipcMain.handle('uwp:list', () => uwp.listApps(sendLog));
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
  ipcMain.handle('tun:set', async (_e, { enable }) => {
    state.store.updateSettings({ enableTun: !!enable });
    if (enable && process.platform === 'win32' && !(await isWindowsAdmin())) {
      try {
        if (await promptRestartForTun()) {
          return { restarting: true, settings: state.store.getSettings() };
        }
      } catch (e) {
        state.store.updateSettings({ enableTun: false });
        throw e;
      }
      // Declined: revert the setting so the UI stays consistent.
      state.store.updateSettings({ enableTun: false });
      return { enabled: false, settings: state.store.getSettings() };
    }
    // TUN changed: if auto-launch is on, this flips the Windows mechanism between
    // the plain Run item and the elevated logon task. We are already admin on the
    // enable path here (the non-admin case relaunched above), so it is silent.
    const s = state.store.getSettings();
    if (s.autoLaunch) core.applyAutoLaunch(s.autoLaunch, s.silentStart, { interactive: true });
    if (state.singbox.isRunning()) await core.restartIfRunning();
    return { enabled: !!enable, settings: state.store.getSettings() };
  });

  ipcMain.handle('mode:set', async (_e, { mode }) => {
    if (!VALID_MODES.includes(mode)) throw new Error('invalid mode');
    await core.setProxyMode(mode);
    return mode;
  });

  ipcMain.handle('core:start', async () => {
    await core.startCore();
    return true;
  });

  ipcMain.handle('core:stop', async () => {
    await core.stopCore(true);
    return true;
  });

  ipcMain.handle('core:restart', async () => {
    if (state.singbox.isRunning()) await core.stopCore();
    await core.startCore();
    return true;
  });

  ipcMain.handle('core:check', async () => {
    const { config } = core.buildCurrentConfig();
    state.singbox.writeConfig(config);
    await state.singbox.checkConfig();
    return true;
  });

  // Download the sing-box core. While running, the download goes through the
  // proxy, then the core is stopped just before extraction (so the .exe is not
  // locked on Windows) and restarted afterwards.
  ipcMain.handle('core:download', async (_e, { version }) => {
    if (version !== undefined && typeof version !== 'string') throw new Error('invalid version');
    version = String(version || '').trim();
    if (version && !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('invalid version');
    }
    const wasRunning = state.singbox.isRunning();
    let p;
    try {
      p = await state.singbox.downloadCore(
        version,
        (progress) => {
          if (state.mainWindow) state.mainWindow.webContents.send('core:downloadProgress', progress);
        },
        {
          proxyPort: core.currentProxyPort(),
          beforeInstall: async () => {
            if (state.singbox.isRunning()) {
              sendLog('[gui] stopping core to install the update...');
              await core.stopCore();
            }
          },
        }
      );
    } finally {
      if (wasRunning && !state.singbox.isRunning()) {
        try {
          await core.startCore();
          sendLog('[gui] core restarted after update');
        } catch (e) {
          sendLog('[gui] restart after core update failed: ' + e.message);
        }
      }
      sendStatus();
    }
    return p;
  });

  // Update geodata (geoip-cn / geosite-cn rule-sets) into the runtime dir.
  ipcMain.handle('core:updateGeo', async () => {
    const dir = await state.singbox.updateGeoData((progress) => {
      if (state.mainWindow) state.mainWindow.webContents.send('core:downloadProgress', progress);
    }, core.currentProxyPort());
    return dir;
  });

  ipcMain.handle('core:status', () => coreStatusInfo());

  // Open the folder that holds the core binary in the OS file manager.
  ipcMain.handle('core:openFolder', () => {
    const bin = state.singbox.resolveBinaryPath();
    if (bin) {
      shell.showItemInFolder(bin);
      return true;
    }
    const dir = state.singbox.ensureCoreDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return true;
  });

  // System proxy toggle.
  ipcMain.handle('proxy:set', async (_e, { enable }) => {
    const settings = state.store.getSettings();
    if (enable) {
      if (!state.singbox.isRunning()) throw new Error('start the core before enabling the system proxy');
      await proxy.enableSystemProxy('127.0.0.1', settings.mixedPort);
      state.systemProxyOn = true;
      core.startProxyGuard(settings.mixedPort);
    } else {
      core.stopProxyGuard();
      await proxy.disableSystemProxy();
      state.systemProxyOn = false;
    }
    sendStatus();
    return state.systemProxyOn;
  });

  ipcMain.handle('app:openClashApi', () => {
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
    shell.openExternal(`http://127.0.0.1:${port}/ui/#/setup?${q}`);
  });
}

module.exports = { registerIpc };
