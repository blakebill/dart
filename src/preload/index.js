'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a controlled API to the renderer via contextBridge.
 * The renderer has no Node access; all privileged operations go through
 * the main process over IPC.
 */
contextBridge.exposeInMainWorld('api', {
  // State
  getState: () => ipcRenderer.invoke('app:getState'),
  getNodes: () => ipcRenderer.invoke('nodes:get'),
  getRecentLogs: () => ipcRenderer.invoke('logs:get'),
  clearRecentLogs: () => ipcRenderer.invoke('logs:clear'),
  coreStatus: () => ipcRenderer.invoke('core:status'),

  // Frameless window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // Native secondary dialogs. The main renderer may open an allowlisted
  // dialog; only that child window can read its context, close itself or
  // report a completed change back to the main page.
  prepareDialog: () => ipcRenderer.invoke('dialog:prepare'),
  openDialog: (type, payload = {}) => ipcRenderer.invoke('dialog:open', { type, payload }),
  getDialogContext: () => ipcRenderer.invoke('dialog:getContext'),
  dialogViewReady: () => ipcRenderer.invoke('dialog:viewReady'),
  closeDialog: () => ipcRenderer.invoke('dialog:close'),
  dialogChanged: (scope, message = '') => ipcRenderer.invoke('dialog:changed', { scope, message }),

  // Subscriptions
  addSubscription: (payload) => ipcRenderer.invoke('sub:add', payload),
  updateSubscription: (payload) => ipcRenderer.invoke('sub:update', payload),
  removeSubscription: (payload) => ipcRenderer.invoke('sub:remove', payload),
  editSubscription: (payload) => ipcRenderer.invoke('sub:edit', payload),
  importSubscription: (payload) => ipcRenderer.invoke('sub:import', payload),
  setActiveSub: (payload) => ipcRenderer.invoke('sub:setActive', payload),
  getSubRaw: (payload) => ipcRenderer.invoke('sub:getRaw', payload),
  saveSubRaw: (payload) => ipcRenderer.invoke('sub:saveRaw', payload),

  // Conversion
  convertPreview: (payload) => ipcRenderer.invoke('convert:preview', payload),
  exportConfig: () => ipcRenderer.invoke('convert:export'),

  // Settings
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  // Desktop notification (renderer passes already-localized text)
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),

  // Node latency test
  // options.force=true skips the short-lived result cache (manual re-test).
  testNodeDelay: async (name, options = {}) => {
    const result = await ipcRenderer.invoke('node:delay', {
      name,
      force: !!(options && options.force),
    });
    if (result && result.ok === false) throw new Error(result.error || 'timeout');
    return result && result.ok === true ? result.delay : result;
  },
  applyAutoCandidate: (name) => ipcRenderer.invoke('node:autoCandidate', { name }),
  getNodeQualities: () => ipcRenderer.invoke('node:qualities'),

  // Node selection (+ current picks for the automatic groups)
  selectNode: (name) => ipcRenderer.invoke('node:select', { name }),
  getGroupSelections: (all = false) => ipcRenderer.invoke('node:groupSelections', { all: !!all }),

  // Rules / connections / proxy mode
  getRules: () => ipcRenderer.invoke('rules:get'),
  getRuleGroups: () => ipcRenderer.invoke('rules:groups'),
  setRuleGroupOutbound: (group, outbound) => ipcRenderer.invoke('rules:setGroupOutbound', { group, outbound }),
  getConnections: () => ipcRenderer.invoke('connections:get'),
  closeAllConnections: () => ipcRenderer.invoke('connections:closeAll'),
  closeConnection: (id) => ipcRenderer.invoke('connections:close', { id }),
  setMode: (mode) => ipcRenderer.invoke('mode:set', { mode }),

  // Windows admin (for TUN)
  isAdmin: () => ipcRenderer.invoke('app:isAdmin'),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  setTun: (enable) => ipcRenderer.invoke('tun:set', { enable }),

  // UWP loopback exemption tool
  warmUwpApps: () => ipcRenderer.invoke('uwp:warm'),
  listUwpApps: (force = false) => ipcRenderer.invoke('uwp:list', { force: !!force }),
  setUwpLoopback: (sids) => ipcRenderer.invoke('uwp:set', { sids }),

  // Diagnostics and maintenance toolbox
  inspectRoute: (payload) => ipcRenderer.invoke('tools:routeInspect', payload),
  runNetworkDiagnostics: () => ipcRenderer.invoke('tools:networkDiagnostics'),
  checkAllConfigs: () => ipcRenderer.invoke('tools:configCheck'),
  inspectPorts: (payload) => ipcRenderer.invoke('tools:portCheck', payload),
  compareDns: (payload) => ipcRenderer.invoke('tools:dnsCompare', payload),
  saveToolReport: (payload) => ipcRenderer.invoke('tools:saveReport', payload),
  exportBackup: () => ipcRenderer.invoke('tools:backupExport'),
  selectBackup: () => ipcRenderer.invoke('tools:backupSelect'),
  restoreBackup: (payload) => ipcRenderer.invoke('tools:backupRestore', payload),

  // Local rules
  listLocalRules: () => ipcRenderer.invoke('localrules:list'),
  addLocalRule: (payload) => ipcRenderer.invoke('localrules:add', payload),
  editLocalRule: (payload) => ipcRenderer.invoke('localrules:edit', payload),
  removeLocalRule: (payload) => ipcRenderer.invoke('localrules:remove', payload),

  // Core control
  startCore: () => ipcRenderer.invoke('core:start'),
  stopCore: () => ipcRenderer.invoke('core:stop'),
  restartCore: () => ipcRenderer.invoke('core:restart'),
  checkConfig: () => ipcRenderer.invoke('core:check'),
  downloadCore: (payload) => ipcRenderer.invoke('core:download', payload),
  updateGeoData: () => ipcRenderer.invoke('core:updateGeo'),
  getRuleSets: () => ipcRenderer.invoke('ruleset:list'),
  listCustomRuleSets: () => ipcRenderer.invoke('customrs:list'),
  addCustomRuleSet: (payload) => ipcRenderer.invoke('customrs:add', payload),
  editCustomRuleSet: (payload) => ipcRenderer.invoke('customrs:edit', payload),
  refreshCustomRuleSet: (payload) => ipcRenderer.invoke('customrs:refresh', payload),
  removeCustomRuleSet: (payload) => ipcRenderer.invoke('customrs:remove', payload),

  // Version / updates
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', { url }),
  openCoreFolder: () => ipcRenderer.invoke('core:openFolder'),

  // System proxy
  setSystemProxy: (enable) => ipcRenderer.invoke('proxy:set', { enable }),
  openClashApi: () => ipcRenderer.invoke('app:openClashApi'),

  // Event subscriptions
  onLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('singbox:log', handler);
    return () => ipcRenderer.removeListener('singbox:log', handler);
  },
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('singbox:status', handler);
    return () => ipcRenderer.removeListener('singbox:status', handler);
  },
  onDownloadProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('core:downloadProgress', handler);
    return () => ipcRenderer.removeListener('core:downloadProgress', handler);
  },
  onTraffic: (cb) => {
    const handler = (_e, sample) => cb(sample);
    ipcRenderer.on('singbox:traffic', handler);
    return () => ipcRenderer.removeListener('singbox:traffic', handler);
  },
  onSubsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('subs:changed', handler);
    return () => ipcRenderer.removeListener('subs:changed', handler);
  },
  onModeChanged: (cb) => {
    const handler = (_e, mode) => cb(mode);
    ipcRenderer.on('mode:changed', handler);
    return () => ipcRenderer.removeListener('mode:changed', handler);
  },
  onWindowMaximized: (cb) => {
    const handler = (_e, maximized) => cb(!!maximized);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },
  onDialogChanged: (cb) => {
    const handler = (_e, change) => cb(change);
    ipcRenderer.on('dialog:changed', handler);
    return () => ipcRenderer.removeListener('dialog:changed', handler);
  },
  onDialogContext: (cb) => {
    const handler = (_e, context) => cb(context);
    ipcRenderer.on('dialog:context', handler);
    return () => ipcRenderer.removeListener('dialog:context', handler);
  },
});
