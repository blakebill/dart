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
  coreStatus: () => ipcRenderer.invoke('core:status'),

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

  // Node latency test
  testNodeDelay: (name) => ipcRenderer.invoke('node:delay', { name }),

  // Node selection (+ the urltest group's current pick)
  selectNode: (name) => ipcRenderer.invoke('node:select', { name }),
  getAutoSelected: () => ipcRenderer.invoke('node:autoNow'),

  // Rules / connections / proxy mode
  getRules: () => ipcRenderer.invoke('rules:get'),
  getConnections: () => ipcRenderer.invoke('connections:get'),
  closeAllConnections: () => ipcRenderer.invoke('connections:closeAll'),
  closeConnection: (id) => ipcRenderer.invoke('connections:close', { id }),
  setMode: (mode) => ipcRenderer.invoke('mode:set', { mode }),

  // Windows admin (for TUN)
  isAdmin: () => ipcRenderer.invoke('app:isAdmin'),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  setTun: (enable) => ipcRenderer.invoke('tun:set', { enable }),

  // UWP loopback exemption tool
  listUwpApps: () => ipcRenderer.invoke('uwp:list'),
  setUwpLoopback: (sids) => ipcRenderer.invoke('uwp:set', { sids }),

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
});
