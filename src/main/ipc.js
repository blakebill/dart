'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, ipcMain, shell, dialog } = require('electron');

const { state, runtimeDir, resourcesBinDir, sendLog, sendStatus, coreStatusInfo } = require('./state');
const core = require('./core-control');
const { isWindowsAdmin, relaunchElevated, promptRestartForTun } = require('./admin');
const update = require('./update');
const { buildSingboxConfig } = require('./converter');
const subscription = require('./subscription');
const proxy = require('./proxy');
const uwp = require('./uwp');
const fetch = require('./fetch');
const { notify } = require('./notify');

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

// Where converted rules may route to.
const VALID_TARGETS = ['proxy', 'direct', 'reject'];
// Custom rule-set source formats the converter understands.
const VALID_CRS_FORMATS = ['clash', 'surge', 'loon', 'quantumultx', 'sing-box'];

// Settings keys the renderer may write; anything else in a patch is dropped so
// a malformed payload cannot pollute the persisted store.
const SETTING_KEYS = new Set([
  'mixedPort', 'clashApiPort', 'enableTun', 'enableClashApi', 'logLevel',
  'autoSetSystemProxy', 'autoLaunch', 'silentStart', 'notifications', 'enableIpv6',
  'dnsRemote', 'dnsLocal', 'dnsStrategy', 'language', 'theme', 'clashMode', 'hardwareAcceleration',
  'testUrl', 'testConcurrency', 'useBuiltinRules', 'ruleOverrides',
]);

const VALID_MODES = ['rule', 'global', 'direct', 'block'];

/** Register every IPC handler. Called once during boot. */
function registerIpc() {
  ipcMain.handle('app:getState', async () => ({
    // Slim the subscriptions: the renderer only needs these fields and the
    // node's name/type/server/port, not full node configs or clash rules — this
    // keeps the IPC payload small for large airports.
    subscriptions: (state.store.get('subscriptions') || []).map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      format: s.format,
      autoUpdateMinutes: s.autoUpdateMinutes || 0,
      updateViaProxy: !!s.updateViaProxy,
      updatedAt: s.updatedAt || 0,
      userInfo: s.userInfo || null,
      nodes: Array.isArray(s.nodes)
        ? s.nodes.map((n) => ({ name: n.name, type: n.type, server: n.server, port: n.port }))
        : [],
    })),
    settings: state.store.getSettings(),
    selected: state.store.get('selected'),
    activeSub: core.getActiveSubId(),
    status: await coreStatusInfo(),
  }));

  // Add/update a subscription (fetch and parse).
  ipcMain.handle('sub:add', async (_e, { name, url }) => {
    reqUrl(url, 'url');
    const result = await subscription.fetchSubscription(url, sendLog);
    if (!result.nodes.length) {
      throw new Error('no nodes parsed (format: ' + result.format + ')');
    }
    const subs = state.store.get('subscriptions') || [];
    const isFirst = subs.length === 0;
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
    };
    subs.push(sub);
    state.store.set('subscriptions', subs);
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
    const subs = state.store.get('subscriptions') || [];
    const sub = subs.find((s) => s.id === id);
    if (!sub) throw new Error('subscription not found');
    const proxyPort = sub.updateViaProxy ? core.currentProxyPort() : 0;
    const result = await subscription.fetchSubscription(sub.url, sendLog, { proxyPort });
    const nodesChanged = JSON.stringify(sub.nodes) !== JSON.stringify(result.nodes);
    sub.nodes = result.nodes;
    sub.format = result.format;
    sub.clashRules = result.rules || [];
    sub.clashRuleProviders = result.ruleProviders || {};
    sub.raw = result.raw || sub.raw || '';
    sub.userInfo = result.userInfo || sub.userInfo;
    sub.updatedAt = Date.now();
    state.store.set('subscriptions', subs);
    // Apply the active profile's new node list to a running core; otherwise
    // the Clash API keeps serving outbounds the UI no longer shows (delay
    // tests "time out", selecting a node fails with 400).
    if (nodesChanged && id === core.getActiveSubId()) await core.restartIfRunning();
    return sub;
  });

  ipcMain.handle('sub:remove', async (_e, { id }) => {
    reqStr(id, 'id');
    let subs = state.store.get('subscriptions') || [];
    subs = subs.filter((s) => s.id !== id);
    state.store.set('subscriptions', subs);
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
    const subs = state.store.get('subscriptions') || [];
    if (!subs.some((s) => s.id === id)) throw new Error('subscription not found');
    state.store.set('activeSub', id);
    state.store.set('selected', null); // reset node selection for the new profile
    await core.restartIfRunning();
    return id;
  });

  // Edit a subscription's name / url / auto-update interval. Re-fetches if the
  // URL changed.
  ipcMain.handle('sub:edit', async (_e, { id, name, url, autoUpdateMinutes, updateViaProxy }) => {
    reqStr(id, 'id');
    const subs = state.store.get('subscriptions') || [];
    const sub = subs.find((s) => s.id === id);
    if (!sub) throw new Error('subscription not found');
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
    }
    state.store.set('subscriptions', subs);
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
    const subs = state.store.get('subscriptions') || [];
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
    };
    subs.push(sub);
    state.store.set('subscriptions', subs);
    return sub;
  });

  // Raw profile content (the fetched/imported source text) for in-app editing.
  // Kept out of app:getState so large profiles don't bloat every state refresh.
  ipcMain.handle('sub:getRaw', (_e, { id }) => {
    reqStr(id, 'id');
    const sub = (state.store.get('subscriptions') || []).find((s) => s.id === id);
    if (!sub) throw new Error('subscription not found');
    return { raw: sub.raw || null };
  });
  ipcMain.handle('sub:saveRaw', async (_e, { id, content }) => {
    reqStr(id, 'id');
    reqStr(content, 'content');
    const subs = state.store.get('subscriptions') || [];
    const sub = subs.find((s) => s.id === id);
    if (!sub) throw new Error('subscription not found');
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
    state.store.set('subscriptions', subs);
    if (sub.id === core.getActiveSubId()) await core.restartIfRunning();
    return { nodeCount: result.nodes.length, format: result.format };
  });

  // Conversion preview: convert subscription content to sing-box config JSON
  // (no save, no run).
  ipcMain.handle('convert:preview', (_e, { content }) => {
    reqStr(content, 'content');
    const result = subscription.parseSubscriptionContent(content);
    if (!result.nodes.length) throw new Error('no nodes parsed');
    const config = buildSingboxConfig(result.nodes, {
      ...state.store.getSettings(),
      ruleSetDir: state.singbox.resolveRuleSetDir(),
      clashRules: result.rules || [],
    });
    return { config, nodeCount: result.nodes.length, format: result.format };
  });

  // Export the current sing-box config to a file.
  ipcMain.handle('convert:export', async () => {
    const { config } = core.buildCurrentConfig();
    // The per-run API secret is runtime-only; keep it out of shared exports.
    if (config.experimental && config.experimental.clash_api) {
      delete config.experimental.clash_api.secret;
    }
    const { canceled, filePath } = await dialog.showSaveDialog(state.mainWindow, {
      title: 'Export sing-box config',
      defaultPath: 'config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
    return filePath;
  });

  ipcMain.handle('settings:update', async (_e, patch) => {
    patch = Object.fromEntries(
      Object.entries(patch && typeof patch === 'object' ? patch : {}).filter(([k]) => SETTING_KEYS.has(k))
    );
    const settings = state.store.updateSettings(patch);
    // The login item carries the --hidden flag when silent start is on, and on
    // Windows the auto-launch mechanism depends on whether TUN is on (elevated
    // logon task vs plain Run item), so a change to any of these must re-register
    // it. interactive: this is an explicit user action, so a one-time UAC prompt
    // is acceptable here.
    if (
      Object.prototype.hasOwnProperty.call(patch, 'autoLaunch') ||
      Object.prototype.hasOwnProperty.call(patch, 'silentStart') ||
      Object.prototype.hasOwnProperty.call(patch, 'enableTun')
    ) {
      core.applyAutoLaunch(settings.autoLaunch, settings.silentStart, { interactive: true });
    }
    // These change routing, so rebuild and restart the core (when running) for
    // them to take effect immediately.
    if (
      (Object.prototype.hasOwnProperty.call(patch, 'useBuiltinRules') ||
        Object.prototype.hasOwnProperty.call(patch, 'ruleOverrides')) &&
      state.singbox.isRunning()
    ) {
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

  // Select an outbound (node tag, '♻️ Auto', or 'direct'). Persisted as the
  // default for the next start; switched live via the Clash API if running.
  // The node the ♻️ Auto (urltest) group is currently routing through.
  ipcMain.handle('node:autoNow', async () => {
    if (!state.singbox.isRunning()) return null;
    try {
      const d = await core.clashApi('GET', '/proxies/' + encodeURIComponent('♻️ Auto'));
      return d.now || null;
    } catch (e) {
      return null;
    }
  });

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
      return {
        running: true,
        connections: Array.isArray(d.connections) ? d.connections : [],
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
  ipcMain.handle('ruleset:list', () => {
    const items = [
      { tag: 'geoip-cn', file: 'geoip-cn.srs', repo: 'sing-geoip' },
      { tag: 'geosite-cn', file: 'geosite-cn.srs', repo: 'sing-geosite' },
    ];
    const dirs = [
      { loc: 'updated', dir: path.join(runtimeDir, 'bin') },
      { loc: 'bundled', dir: resourcesBinDir },
    ];
    const meta = state.singbox.geoMeta();
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
              valid: state.singbox._validSrs(p),
              mtime: st.mtimeMs,
            };
            break;
          }
        } catch (_) {
          /* ignore */
        }
      }
      // The release tag recorded at update time only describes the runtime copy.
      const m = found && found.location === 'updated' ? meta[it.file] : null;
      return {
        tag: it.tag,
        file: it.file,
        url: `https://raw.githubusercontent.com/SagerNet/${it.repo}/rule-set/${it.file}`,
        present: !!found,
        size: found ? found.size : 0,
        location: found ? found.location : 'none',
        valid: found ? found.valid : false,
        version: m ? m.version : null,
        updatedAt: m ? m.updatedAt : found ? found.mtime : 0,
      };
    });
  });

  // App version + update check.
  ipcMain.handle('app:version', () => app.getVersion());
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
    const dest = path.join(app.getPath('temp'), info.assetName);
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
    id: c.id, name: c.name, url: c.url, format: c.format, target: c.target,
    enabled: c.enabled !== false, kind: c.kind || null, count: c.count ?? null,
    autoUpdateMinutes: c.autoUpdateMinutes || 0,
    updatedAt: c.updatedAt || 0, error: c.error || null,
  });
  ipcMain.handle('customrs:list', () => (state.store.get('customRuleSets') || []).map(sanitizeCrs));
  ipcMain.handle('customrs:add', async (_e, { name, url, format, target }) => {
    reqUrl(url, 'url');
    const fmt = format ? reqEnum(format, VALID_CRS_FORMATS, 'format') : 'clash';
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
    const reprocess = (url !== undefined && url !== c.url) || (format !== undefined && format !== c.format) || (target !== undefined && target !== c.target);
    if (url !== undefined) c.url = url;
    if (format !== undefined) c.format = format;
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
    try { fs.unlinkSync(path.join(runtimeDir, 'bin', 'custom-' + id + '.srs')); } catch (_) {}
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

  // UWP loopback exemption tool (Windows). Listing is unprivileged; applying
  // changes needs admin rights.
  ipcMain.handle('uwp:list', () => uwp.listApps(sendLog));
  ipcMain.handle('uwp:set', async (_e, { sids }) => {
    if (!Array.isArray(sids)) throw new Error('invalid sids');
    if (!(await isWindowsAdmin())) {
      throw new Error('administrator rights required (use "Restart as administrator")');
    }
    await uwp.setExemptions(sids || []);
    return true;
  });

  // Windows admin status / elevate (needed for TUN).
  ipcMain.handle('app:isAdmin', () => isWindowsAdmin());
  ipcMain.handle('app:relaunchElevated', () => relaunchElevated());

  // Toggle TUN mode. On Windows without admin rights, offer to restart elevated.
  ipcMain.handle('tun:set', async (_e, { enable }) => {
    state.store.updateSettings({ enableTun: !!enable });
    if (enable && process.platform === 'win32' && !(await isWindowsAdmin())) {
      if (await promptRestartForTun()) {
        return { restarting: true, settings: state.store.getSettings() };
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
    const dir = path.join(runtimeDir, 'bin');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return true;
  });

  // System proxy toggle.
  ipcMain.handle('proxy:set', async (_e, { enable }) => {
    const settings = state.store.getSettings();
    if (enable) {
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
