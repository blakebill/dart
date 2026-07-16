'use strict';

/**
 * Main-process smoke test (no Electron runtime needed).
 *
 * Boots src/main/index.js against a stubbed `electron` module and asserts the
 * IPC surface: every channel the preload script invokes must be registered by
 * the main process, and vice versa. This pins the app's IPC contract, so a
 * refactor that moves handlers between files cannot silently drop one.
 *
 * NOTE: index.js installs uncaughtException/unhandledRejection handlers that
 * swallow errors, so every assertion here runs inside the explicit try/catch
 * below — a bare throw could otherwise vanish and fake a green run.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-gui-test-'));
const registered = [];
const handlers = {};

class FakeWebContents {
  constructor(owner) {
    this.owner = owner;
    this.sent = [];
  }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  on() {}
  once() {}
  openDevTools() {}
  setWindowOpenHandler() {}
  setFrameRate(rate) { this.frameRate = rate; }
}
class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents(this);
    this.maximized = false;
    this.minimized = false;
    this.shown = false;
    this.closed = false;
    this.bounds = {
      x: options.x || 100,
      y: options.y || 100,
      width: options.width || 800,
      height: options.height || 600,
    };
    this.loadedUrl = null;
    FakeBrowserWindow.instances.push(this);
    FakeBrowserWindow.last = this;
  }
  loadURL(url) { this.loadedUrl = url; return Promise.resolve(); }
  loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
  setMenuBarVisibility() {}
  isDestroyed() {
    return this.closed;
  }
  isVisible() {
    return this.shown;
  }
  isMinimized() {
    return this.minimized;
  }
  show() { this.shown = true; this.emit('show'); }
  hide() { this.shown = false; this.emit('hide'); }
  focus() {}
  restore() { this.minimized = false; this.emit('restore'); }
  minimize() { this.minimized = true; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  isMaximized() { return this.maximized; }
  close() { this.closed = true; this.emit('closed'); }
  destroy() { this.closed = true; this.emit('closed'); }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  setBackgroundMaterial() {}
  setBackgroundColor() {}
  static getAllWindows() {
    return FakeBrowserWindow.instances.filter((win) => !win.closed);
  }
  static fromWebContents(contents) {
    return FakeBrowserWindow.instances.find((win) => win.webContents === contents) || null;
  }
}
FakeBrowserWindow.instances = [];
class FakeTray {
  setToolTip() {}
  setContextMenu() {}
  setImage() {}
  on() {}
}

const electronStub = {
  app: {
    getPath: () => tmpDir,
    getVersion: () => '0.0.0',
    whenReady: () => Promise.resolve(),
    on: () => {},
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    quit: () => {},
    disableHardwareAcceleration: () => {},
    commandLine: { appendSwitch: () => {} },
    setLoginItemSettings: () => {},
  },
  BrowserWindow: FakeBrowserWindow,
  Tray: FakeTray,
  Menu: { buildFromTemplate: (tpl) => tpl },
  nativeImage: { createFromDataURL: () => ({}), createFromPath: (file) => ({ file }) },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' },
  Notification: class { static isSupported() { return false; } show() {} on() {} },
  shell: { openExternal: () => {}, openPath: () => {}, showItemInFolder: () => {} },
  dialog: {
    showErrorBox: () => {},
    showMessageBox: async () => ({ response: 1 }),
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel, fn) => {
      registered.push(channel);
      handlers[channel] = fn;
    },
  },
};

// Inject the stub before any main-process module resolves 'electron'.
require.cache[require.resolve('electron')] = { exports: electronStub };
// Outside a packaged Electron app process.resourcesPath does not exist.
process.resourcesPath = tmpDir;

// Stub the subscription fetcher so handler-level tests need no network: each
// URL yields one distinct node.
const subscriptionPath = path.join(__dirname, '..', 'src', 'main', 'subscription.js');
require.cache[require.resolve(subscriptionPath)] = {
  exports: {
    fetchSubscription: async (url) => ({
      nodes: [{ name: 'node-of-' + new URL(url).pathname.slice(1), type: 'trojan', server: 's.example.com', port: 443, password: 'p' }],
      format: 'links',
      rules: [],
      raw: 'stub',
      userInfo: null,
    }),
    parseSubscriptionContent: () => ({ nodes: [], format: 'unknown', rules: [], raw: '' }),
    configFingerprint: (value) => JSON.stringify([
      value.nodes || [],
      value.clashRules || value.rules || [],
      value.clashRuleProviders || value.ruleProviders || {},
    ]),
    uniqueNodeNames: (nodes) => nodes || [],
  },
};

/** IPC channels the preload script invokes, parsed from its source. */
function preloadChannels() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  return [...new Set([...src.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]))].sort();
}

async function main() {
  require(path.join(__dirname, '..', 'src', 'main', 'index.js'));
  // Boot continues in microtasks after the stubbed whenReady() resolves.
  await new Promise((resolve) => setImmediate(resolve));

  const { buildElevatedHandoffScript } = require(path.join(__dirname, '..', 'src', 'main', 'admin.js'));
  const handoffScript = buildElevatedHandoffScript(
    "C:\\Program Files\\O'Brien\\Dart.exe",
    ['D:\\Work Files\\Dart', '--dev'],
    4321
  );
  assert.ok(handoffScript.indexOf('Wait-Process -Id 4321') < handoffScript.indexOf('Start-Process'));
  assert.ok(handoffScript.includes("O''Brien"), 'PowerShell path literal was not escaped');
  assert.ok(handoffScript.includes("'D:\\Work Files\\Dart'"));
  assert.ok(handoffScript.includes("'--dev'"));
  console.log('✓ elevated relaunch waits for clean shutdown before starting its replacement');

  const fromMain = [...new Set(registered)].sort();
  const fromPreload = preloadChannels();

  assert.ok(fromMain.length >= 40, `expected a full IPC surface, got ${fromMain.length} channels`);
  assert.strictEqual(
    registered.length,
    fromMain.length,
    'an IPC channel was registered more than once'
  );
  const missing = fromPreload.filter((c) => !fromMain.includes(c));
  const unused = fromMain.filter((c) => !fromPreload.includes(c));
  assert.deepStrictEqual(missing, [], 'preload invokes channels with no main handler');
  assert.deepStrictEqual(unused, [], 'main registers channels the preload never invokes');

  console.log(`✓ main process boots with ${fromMain.length} IPC handlers, all matching preload`);

  const mainWindow = FakeBrowserWindow.last;
  const windowEvent = { sender: mainWindow.webContents };
  assert.strictEqual(await handlers['window:isMaximized'](windowEvent), false);
  assert.strictEqual(await handlers['window:toggleMaximize'](windowEvent), true);
  assert.strictEqual(await handlers['window:toggleMaximize'](windowEvent), false);
  await handlers['window:minimize'](windowEvent);
  assert.strictEqual(mainWindow.minimized, true);
  assert.strictEqual(mainWindow.options.frame, false);
  assert.strictEqual(mainWindow.options.titleBarStyle, 'hidden');
  console.log('✓ frameless window controls invoke the active BrowserWindow');

  await handlers['dialog:prepare'](windowEvent);
  const childWindow = FakeBrowserWindow.last;
  const childEvent = { sender: childWindow.webContents };
  assert.notStrictEqual(childWindow, mainWindow);
  assert.strictEqual(childWindow.shown, false);
  assert.strictEqual(await handlers['dialog:getContext'](childEvent), null);
  await handlers['dialog:open'](windowEvent, { type: 'route', payload: {} });
  assert.strictEqual(FakeBrowserWindow.last, childWindow, 'open should reuse the prewarmed child');
  assert.strictEqual(childWindow.options.parent, mainWindow);
  assert.strictEqual(childWindow.options.modal, true);
  assert.strictEqual(childWindow.options.frame, false);
  assert.strictEqual(childWindow.options.skipTaskbar, true);
  if (childWindow.options.backgroundMaterial !== undefined) {
    assert.strictEqual(childWindow.options.backgroundMaterial, 'mica');
  } else {
    assert.strictEqual(childWindow.options.backgroundColor, '#202024');
  }
  assert.ok(childWindow.loadedUrl.startsWith('file://'));
  assert.ok(childWindow.loadedUrl.endsWith('/dialog.html'));
  assert.ok(!childWindow.loadedUrl.includes('\\'));
  assert.deepStrictEqual(await handlers['dialog:getContext'](childEvent), {
    type: 'route', payload: {}, language: 'zh', theme: 'dark',
  });
  assert.deepStrictEqual(childWindow.webContents.sent.at(-1), {
    channel: 'dialog:context',
    payload: { type: 'route', payload: {}, language: 'zh', theme: 'dark' },
  });
  assert.strictEqual(await handlers['dialog:viewReady'](childEvent), true);
  assert.strictEqual(childWindow.shown, true);
  await handlers['dialog:changed'](childEvent, { scope: 'state', message: 'updated' });
  assert.deepStrictEqual(mainWindow.webContents.sent.at(-1), {
    channel: 'dialog:changed', payload: { scope: 'state', message: 'updated' },
  });
  await handlers['dialog:close'](childEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(childWindow.closed, true);
  console.log('✓ native dialog reuses a short-lived prewarm and releases it on close');

  assert.strictEqual(handlers['uwp:warm'](), true);
  assert.throws(() => handlers['uwp:list'](null, { force: 'yes' }), /invalid force flag/);
  const uwp = require(path.join(__dirname, '..', 'src', 'main', 'uwp'));
  const oldSid = 'S-1-15-2-1-2-3-4-5-6-7';
  const newSid = 'S-1-15-2-8-9-10-11-12-13-14';
  const exemptionCommands = [];
  let failNewSid = true;
  await assert.rejects(uwp.replaceExemptions([newSid], async (command) => {
    exemptionCommands.push(command);
    if (command.endsWith(' -s')) return `Name: old\nSID: ${oldSid}`;
    if (command.includes(newSid) && failNewSid) {
      failNewSid = false;
      throw new Error('add failed');
    }
    return '';
  }), /add failed/);
  assert.ok(exemptionCommands.filter((command) => command.endsWith(' -c')).length === 2);
  assert.ok(exemptionCommands.at(-1).includes(oldSid), 'failed UWP update did not restore the previous exemptions');
  console.log('✓ UWP exemption replacement rolls back a partial privileged write');

  await handlers['window:close'](windowEvent);
  assert.strictEqual(mainWindow.closed, true);
  const stateModule = require(path.join(__dirname, '..', 'src', 'main', 'state'));
  const { state } = stateModule;
  const statusManager = state.singbox;
  const statusSettings = state.store.getSettings();
  const statusCoreType = statusManager.getCoreType();
  const nextStatusCoreType = statusCoreType === 'mihomo' ? 'sing-box' : 'mihomo';
  const originalGetCoreVersion = statusManager.getCoreVersion;
  let releaseOldVersion;
  const oldVersionProbe = new Promise((resolve) => { releaseOldVersion = resolve; });
  statusManager.getCoreVersion = (type) => type === statusCoreType
    ? oldVersionProbe
    : Promise.resolve('new-core-version');
  const stateSnapshotPromise = handlers['app:getState']();
  state.store.updateSettings({ coreType: nextStatusCoreType });
  statusManager.setCoreType(nextStatusCoreType);
  releaseOldVersion('old-core-version');
  try {
    const stateSnapshot = await stateSnapshotPromise;
    assert.strictEqual(stateSnapshot.settings.coreType, nextStatusCoreType);
    assert.strictEqual(stateSnapshot.status.coreType, nextStatusCoreType);
    assert.strictEqual(stateSnapshot.status.coreVersion, 'new-core-version');
  } finally {
    statusManager.getCoreVersion = originalGetCoreVersion;
    state.store.updateSettings({ coreType: statusSettings.coreType });
    statusManager.setCoreType(statusCoreType);
  }
  console.log('✓ delayed state snapshots cannot mix old settings with a newly selected core');
  stateModule.sendLog('[gui] startup history marker');
  const logHistory = handlers['logs:get']();
  assert.strictEqual(logHistory.entries.at(-1).line, '[gui] startup history marker');
  assert.ok(logHistory.entries.at(-1).sequence > 0);
  assert.strictEqual(handlers['logs:clear'](), true);
  assert.deepStrictEqual(handlers['logs:get']().entries, []);
  console.log('✓ bounded main-process log history survives lazy renderer loading and can be cleared');
  const { createWindow, showMainWindow } = require(path.join(__dirname, '..', 'src', 'main', 'window'));
  const originalLoadFile = FakeBrowserWindow.prototype.loadFile;
  FakeBrowserWindow.prototype.loadFile = function loadFileFailure(file) {
    this.loadedFile = file;
    return Promise.reject(new Error('renderer file unavailable'));
  };
  const failedWindow = createWindow(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(failedWindow.closed, true);
  assert.strictEqual(state.mainWindow, null, 'failed renderer window remained registered');
  FakeBrowserWindow.prototype.loadFile = originalLoadFile;
  const reopenedWindow = showMainWindow();
  assert.notStrictEqual(reopenedWindow, mainWindow);
  assert.strictEqual(state.mainWindow, reopenedWindow);
  reopenedWindow.emit('ready-to-show');
  assert.strictEqual(reopenedWindow.shown, true);
  console.log('✓ a released tray renderer is recreated on demand');

  // ---- Regression: adding a subscription must never steal the active profile ----
  // Legacy stores (pre-profiles) have subscriptions but no activeSub; the core
  // runs subs[0] via the getActiveSubId fallback. sub:add used to flip the NEW
  // subscription to active (without a restart), so the UI showed nodes the
  // running core didn't have: delay tests "timed out" and node selection
  // failed with "clash api 400".
  const core = require(path.join(__dirname, '..', 'src', 'main', 'core-control'));

  const persistentStore = state.store;
  const fallbackProfiles = [{ id: 'stable-a' }, { id: 'stable-b' }];
  state.store = {
    listSubscriptions: () => fallbackProfiles.slice(),
    get: () => null,
    set: () => { throw new Error('disk temporarily read-only'); },
  };
  try {
    assert.strictEqual(core.getActiveSubId(), 'stable-a');
    fallbackProfiles.unshift({ id: 'new-profile' });
    assert.strictEqual(
      core.getActiveSubId(),
      'stable-a',
      'a failed fallback write let a new profile steal the session'
    );
  } finally {
    state.store = persistentStore;
  }

  const proxyAfterExit = require(path.join(__dirname, '..', 'src', 'main', 'proxy'));
  const originalExitProxyDisable = proxyAfterExit.disableSystemProxyIfOurs;
  state.systemProxyOn = true;
  state.systemProxyServer = '127.0.0.1:7890';
  proxyAfterExit.disableSystemProxyIfOurs = async () => { throw new Error('registry temporarily locked'); };
  state.singbox.onExit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(state.systemProxyOn, true, 'failed crash cleanup forgot that Dart may still own the proxy');
  assert.strictEqual(state.systemProxyServer, '127.0.0.1:7890');
  proxyAfterExit.disableSystemProxyIfOurs = originalExitProxyDisable;
  state.systemProxyOn = false;
  state.systemProxyServer = null;

  const subA = await handlers['sub:add'](null, { name: 'A', url: 'https://example.com/a' });
  assert.strictEqual(state.store.get('activeSub'), subA.id, 'the first subscription becomes active');

  state.store.set('activeSub', null); // simulate a legacy store
  const subB = await handlers['sub:add'](null, { name: 'B', url: 'https://example.com/b' });
  assert.notStrictEqual(state.store.get('activeSub'), subB.id, 'a later add must not steal activeness');
  assert.strictEqual(core.getActiveSubId(), subA.id, 'the effective profile remains subs[0]');
  assert.strictEqual(state.store.get('activeSub'), subA.id, 'getActiveSubId pins the legacy fallback');
  const rendererState = await handlers['app:getState']();
  const rendererSubA = rendererState.subscriptions.find((s) => s.id === subA.id);
  const rendererSubB = rendererState.subscriptions.find((s) => s.id === subB.id);
  assert.ok(!('nodes' in rendererSubA), 'global state must not hydrate active node details');
  assert.ok(!('nodes' in rendererSubB), 'inactive profile payload stays out of renderer IPC');
  assert.strictEqual(rendererSubB.nodeCount, 1, 'inactive profile still exposes its node count');
  const rendererNodes = await handlers['nodes:get']();
  assert.strictEqual(rendererNodes.activeSub, subA.id);
  assert.deepStrictEqual(rendererNodes.nodes, [{ name: 'node-of-a', type: 'trojan', server: 's.example.com', port: 443 }]);

  // Updating only rules/providers still changes the generated core config.
  const subscriptionStub = require(subscriptionPath);
  const originalFetchSubscription = subscriptionStub.fetchSubscription;
  const originalRestartIfRunning = core.restartIfRunning;
  let restartCount = 0;
  const subWithUsage = state.store.getSubscription(subA.id);
  subWithUsage.userInfo = { upload: 10, download: 20, total: 100 };
  state.store.upsertSubscription(subWithUsage);
  subscriptionStub.fetchSubscription = async () => ({
    nodes: state.store.getSubscription(subA.id).nodes,
    format: 'clash',
    rules: ['DOMAIN-SUFFIX,example.com,PROXY'],
    ruleProviders: { remote: { type: 'http', behavior: 'domain', url: 'https://example.com/rules.yaml', format: 'yaml' } },
    raw: 'updated',
    userInfo: null,
  });
  core.restartIfRunning = async () => { restartCount += 1; };
  await handlers['sub:update'](null, { id: subA.id });
  core.restartIfRunning = originalRestartIfRunning;
  subscriptionStub.fetchSubscription = originalFetchSubscription;
  assert.strictEqual(restartCount, 1, 'active rule-only updates restart the core');
  assert.strictEqual(
    state.store.getSubscription(subA.id).userInfo,
    null,
    'an update without subscription-userinfo kept stale usage data'
  );
  assert.deepStrictEqual(
    state.store.get('subscriptions').find((s) => s.id === subA.id).clashRuleProviders,
    { remote: { type: 'http', behavior: 'domain', url: 'https://example.com/rules.yaml', format: 'yaml' } },
    'rule providers are persisted during updates'
  );

  const manualWithUsage = state.store.getSubscription(subA.id);
  manualWithUsage.userInfo = { upload: 1, download: 2, total: 3 };
  state.store.upsertSubscription(manualWithUsage);
  const originalRawParser = subscriptionStub.parseSubscriptionContent;
  subscriptionStub.parseSubscriptionContent = () => ({
    nodes: manualWithUsage.nodes,
    format: manualWithUsage.format,
    rules: manualWithUsage.clashRules,
    ruleProviders: manualWithUsage.clashRuleProviders,
  });
  await handlers['sub:saveRaw'](null, { id: subA.id, content: 'manually-edited-profile' });
  subscriptionStub.parseSubscriptionContent = originalRawParser;
  assert.strictEqual(state.store.getSubscription(subA.id).userInfo, null, 'manual raw edit kept stale usage data');

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let scheduledAutoUpdate = null;
  let autoUpdateAttempts = 0;
  global.setInterval = (callback, milliseconds) => {
    assert.strictEqual(milliseconds, 60000);
    scheduledAutoUpdate = callback;
    return { fakeTimer: true };
  };
  global.clearInterval = () => {};
  subscriptionStub.fetchSubscription = async () => {
    autoUpdateAttempts += 1;
    throw new Error('offline');
  };
  try {
    const autoSub = state.store.listSubscriptions().find((s) => s.id === subA.id);
    state.store.upsertSubscription({
      ...autoSub,
      autoUpdateMinutes: 60,
      updatedAt: 0,
      autoUpdateLastAttemptAt: Date.now(),
    });
    core.rescheduleAutoUpdate();
    assert.ok(scheduledAutoUpdate, 'auto-update timer was not armed');
    await scheduledAutoUpdate();
    assert.strictEqual(autoUpdateAttempts, 0, 'a backed-off update attempted network access');

    const dueSub = state.store.listSubscriptions().find((s) => s.id === subA.id);
    state.store.upsertSubscription({ ...dueSub, autoUpdateLastAttemptAt: 0 });
    await scheduledAutoUpdate();
    await scheduledAutoUpdate();
    assert.strictEqual(autoUpdateAttempts, 1, 'a failed auto-update retried on the next minute tick');

    const autoRollbackSnapshot = state.store.getSubscription(subA.id, { includeRaw: true });
    const autoManager = state.singbox;
    const autoManagerOriginals = {
      isRunning: autoManager.isRunning,
      start: autoManager.start,
      stop: autoManager.stop,
    };
    const autoSettings = state.store.getSettings();
    let autoCoreRunning = true;
    autoManager.isRunning = () => autoCoreRunning;
    autoManager.stop = async () => { autoCoreRunning = false; };
    autoManager.start = async (config) => {
      if (config.outbounds.some((outbound) => outbound.tag === 'broken-auto-update')) {
        throw new Error('auto-updated config does not start');
      }
      autoCoreRunning = true;
    };
    subscriptionStub.fetchSubscription = async () => ({
      nodes: [{ name: 'broken-auto-update', type: 'trojan', server: 'broken.example.com', port: 443, password: 'p' }],
      format: 'links',
      rules: [],
      ruleProviders: {},
      raw: 'broken-auto-update',
      userInfo: null,
    });
    try {
      state.store.set('activeSub', subA.id);
      state.store.updateSettings({ autoSetSystemProxy: false, enableClashApi: false });
      state.store.upsertSubscription({
        ...autoRollbackSnapshot,
        autoUpdateMinutes: 60,
        updatedAt: 0,
        autoUpdateLastAttemptAt: 0,
      });
      await scheduledAutoUpdate();
      const restored = state.store.getSubscription(subA.id, { includeRaw: true });
      assert.deepStrictEqual(restored.nodes, autoRollbackSnapshot.nodes);
      assert.strictEqual(restored.raw, autoRollbackSnapshot.raw);
      assert.strictEqual(autoCoreRunning, true, 'failed auto-update did not restart the previous active config');
    } finally {
      autoManager.isRunning = autoManagerOriginals.isRunning;
      autoManager.start = autoManagerOriginals.start;
      autoManager.stop = autoManagerOriginals.stop;
      state.store.updateSettings({
        autoSetSystemProxy: autoSettings.autoSetSystemProxy,
        enableClashApi: autoSettings.enableClashApi,
      });
    }

    const fetchModule = require(path.join(__dirname, '..', 'src', 'main', 'fetch'));
    const originalRuleFetch = fetchModule.getBufferWithFallback;
    const ruleManager = state.singbox;
    const ruleManagerOriginals = {
      isRunning: ruleManager.isRunning,
      start: ruleManager.start,
      stop: ruleManager.stop,
    };
    const ruleSettings = state.store.getSettings();
    const autoRuleId = 'auto-rule-rollback';
    const previousAutoRule = {
      id: autoRuleId,
      name: 'Auto rollback rule',
      url: 'https://example.com/auto-rule.list',
      format: 'clash',
      target: 'proxy',
      enabled: true,
      kind: 'inline',
      count: 1,
      rules: [{ domain_suffix: ['old-rule.example'], outbound: '🚀 Proxy' }],
      rule: { domain_suffix: ['old-rule.example'], outbound: '🚀 Proxy' },
      autoUpdateMinutes: 60,
      updatedAt: 0,
      autoUpdateLastAttemptAt: 0,
      error: null,
    };
    let ruleCoreRunning = true;
    ruleManager.isRunning = () => ruleCoreRunning;
    ruleManager.stop = async () => { ruleCoreRunning = false; };
    ruleManager.start = async (config) => {
      if (JSON.stringify(config).includes('broken-rule.example')) {
        throw new Error('auto-updated remote rule does not start');
      }
      ruleCoreRunning = true;
    };
    fetchModule.getBufferWithFallback = async () => ({
      body: Buffer.from('DOMAIN-SUFFIX,broken-rule.example,PROXY'),
    });
    try {
      state.store.updateSettings({ autoSetSystemProxy: false, enableClashApi: false });
      state.store.upsertCustomRuleSet(previousAutoRule);
      await scheduledAutoUpdate();
      const restoredRule = state.store.getCustomRuleSet(autoRuleId);
      assert.deepStrictEqual(restoredRule.rules, previousAutoRule.rules);
      assert.strictEqual(ruleCoreRunning, true, 'failed remote-rule auto-update did not restart the previous config');
    } finally {
      state.store.removeCustomRuleSet(autoRuleId);
      fetchModule.getBufferWithFallback = originalRuleFetch;
      ruleManager.isRunning = ruleManagerOriginals.isRunning;
      ruleManager.start = ruleManagerOriginals.start;
      ruleManager.stop = ruleManagerOriginals.stop;
      state.store.updateSettings({
        autoSetSystemProxy: ruleSettings.autoSetSystemProxy,
        enableClashApi: ruleSettings.enableClashApi,
      });
    }
  } finally {
    const autoSub = state.store.listSubscriptions().find((s) => s.id === subA.id);
    state.store.upsertSubscription({ ...autoSub, autoUpdateMinutes: 0 });
    core.rescheduleAutoUpdate();
    subscriptionStub.fetchSubscription = originalFetchSubscription;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
  console.log('✓ stale usage is cleared and failed auto-updates back off');

  const savedSubA = JSON.stringify(state.store.get('subscriptions').find((s) => s.id === subA.id));
  subscriptionStub.fetchSubscription = async () => ({ nodes: [], format: 'unknown', rules: [], raw: '' });
  await assert.rejects(handlers['sub:update'](null, { id: subA.id }), /no nodes parsed/);
  subscriptionStub.fetchSubscription = originalFetchSubscription;
  assert.strictEqual(
    JSON.stringify(state.store.get('subscriptions').find((s) => s.id === subA.id)),
    savedSubA,
    'an empty update must preserve the last working profile'
  );

  const rollbackProfile = state.store.getSubscription(subA.id, { includeRaw: true });
  const originalRollbackRunning = state.singbox.isRunning;
  const originalRollbackRestart = core.restartIfRunning;
  const originalRollbackStart = core.startCore;
  let rollbackRunning = true;
  state.singbox.isRunning = () => rollbackRunning;
  core.restartIfRunning = async () => {
    rollbackRunning = false;
    throw new Error('replacement config failed');
  };
  core.startCore = async () => { rollbackRunning = true; };
  subscriptionStub.fetchSubscription = async () => ({
    nodes: [{ name: 'broken-replacement', type: 'trojan', server: 'broken.example.com', port: 443, password: 'p' }],
    format: 'links', rules: [], ruleProviders: {}, raw: 'broken-replacement', userInfo: null,
  });
  try {
    await assert.rejects(handlers['sub:update'](null, { id: subA.id }), /replacement config failed/);
    assert.deepStrictEqual(
      state.store.getSubscription(subA.id, { includeRaw: true }),
      rollbackProfile,
      'failed active-profile restart left the replacement persisted'
    );
    assert.strictEqual(rollbackRunning, true, 'the previous profile was not restarted');
  } finally {
    subscriptionStub.fetchSubscription = originalFetchSubscription;
    state.singbox.isRunning = originalRollbackRunning;
    core.restartIfRunning = originalRollbackRestart;
    core.startCore = originalRollbackStart;
  }
  console.log('✓ failed active config updates restore the prior profile and running core');

  const originalRuleRunning = state.singbox.isRunning;
  const originalRuleRestart = core.restartIfRunning;
  const originalRuleStart = core.startCore;
  const localRulesBeforeFailure = state.store.get('localRules') || [];
  let ruleRunning = true;
  state.singbox.isRunning = () => ruleRunning;
  core.restartIfRunning = async () => {
    ruleRunning = false;
    throw new Error('rule config failed');
  };
  core.startCore = async () => { ruleRunning = true; };
  try {
    await assert.rejects(
      handlers['localrules:add'](null, { name: 'bad', matchType: 'domain', values: ['bad.example'], target: 'proxy' }),
      /rule config failed/
    );
    assert.deepStrictEqual(state.store.get('localRules') || [], localRulesBeforeFailure);
    assert.strictEqual(ruleRunning, true, 'the prior local-rule config was not restarted');
  } finally {
    state.singbox.isRunning = originalRuleRunning;
    core.restartIfRunning = originalRuleRestart;
    core.startCore = originalRuleStart;
  }

  const ruleSetId = 'rollback-ruleset';
  const ruleSetRecord = {
    id: ruleSetId,
    name: 'Working rules',
    url: 'https://example.com/working.srs',
    format: 'sing-box',
    target: 'proxy',
    enabled: true,
    kind: 'ruleset',
    updatedAt: 1,
  };
  state.store.upsertCustomRuleSet(ruleSetRecord);
  const ruleSetFile = path.join(state.singbox.ensureCoreDir('sing-box'), core.customRuleSetFileName(ruleSetId));
  fs.writeFileSync(ruleSetFile, 'working-srs');
  const originalProcessRuleSet = core.processCustomRuleSet;
  state.singbox.isRunning = () => ruleRunning;
  core.restartIfRunning = async () => {
    ruleRunning = false;
    throw new Error('new ruleset failed');
  };
  core.startCore = async () => { ruleRunning = true; };
  core.processCustomRuleSet = async (item, options = {}) => {
    if (options.beforeCommit) await options.beforeCommit();
    fs.writeFileSync(ruleSetFile, 'replacement-srs');
    return { ...item, kind: 'ruleset', updatedAt: 2 };
  };
  ruleRunning = true;
  try {
    await assert.rejects(
      handlers['customrs:edit'](null, { id: ruleSetId, url: 'https://example.com/replacement.srs' }),
      /new ruleset failed/
    );
    assert.strictEqual(state.store.getCustomRuleSet(ruleSetId).url, ruleSetRecord.url);
    assert.strictEqual(fs.readFileSync(ruleSetFile, 'utf-8'), 'working-srs');
    assert.strictEqual(ruleRunning, true, 'the prior remote-rule config was not restarted');
  } finally {
    core.processCustomRuleSet = originalProcessRuleSet;
    state.singbox.isRunning = originalRuleRunning;
    core.restartIfRunning = originalRuleRestart;
    core.startCore = originalRuleStart;
    state.store.removeCustomRuleSet(ruleSetId);
    try { fs.unlinkSync(ruleSetFile); } catch (_) {}
  }
  console.log('✓ failed local and remote rule changes restore records, files and runtime state');

  const raceSub = await handlers['sub:add'](null, { name: 'Race', url: 'https://example.com/race' });
  const fetchedRaceResult = {
    nodes: [{ name: 'race-new', type: 'trojan', server: 'new.example.com', port: 443, password: 'p' }],
    format: 'links', rules: [], ruleProviders: {}, raw: 'race-new', userInfo: null,
  };
  let releaseRaceFetch;
  let announceRaceFetch;
  subscriptionStub.fetchSubscription = () => new Promise((resolve) => {
    releaseRaceFetch = resolve;
    if (announceRaceFetch) announceRaceFetch();
  });
  try {
    let raceStarted = new Promise((resolve) => { announceRaceFetch = resolve; });
    const updateWhileRenaming = handlers['sub:update'](null, { id: raceSub.id });
    await raceStarted;
    await handlers['sub:edit'](null, { id: raceSub.id, name: 'Renamed while fetching' });
    releaseRaceFetch(fetchedRaceResult);
    await updateWhileRenaming;
    assert.strictEqual(
      state.store.getSubscription(raceSub.id).name,
      'Renamed while fetching',
      'a completed fetch overwrote newer profile metadata'
    );

    raceStarted = new Promise((resolve) => { announceRaceFetch = resolve; });
    const updateWhileEditingRaw = handlers['sub:update'](null, { id: raceSub.id });
    await raceStarted;
    const rawNode = state.store.getSubscription(raceSub.id).nodes[0];
    subscriptionStub.parseSubscriptionContent = () => ({
      nodes: [{ ...rawNode, name: 'manual-raw-node' }],
      format: 'links',
      rules: [],
      ruleProviders: {},
    });
    await handlers['sub:saveRaw'](null, { id: raceSub.id, content: 'manual-raw-source' });
    subscriptionStub.parseSubscriptionContent = originalRawParser;
    releaseRaceFetch(fetchedRaceResult);
    await assert.rejects(updateWhileEditingRaw, /superseded/);
    const manuallyEdited = state.store.getSubscription(raceSub.id, { includeRaw: true });
    assert.strictEqual(manuallyEdited.raw, 'manual-raw-source');
    assert.strictEqual(manuallyEdited.nodes[0].name, 'manual-raw-node');

    raceStarted = new Promise((resolve) => { announceRaceFetch = resolve; });
    const updateWhileRemoving = handlers['sub:update'](null, { id: raceSub.id });
    await raceStarted;
    await handlers['sub:remove'](null, { id: raceSub.id });
    releaseRaceFetch(fetchedRaceResult);
    await assert.rejects(updateWhileRemoving, /superseded|removed/);
    assert.strictEqual(state.store.getSubscription(raceSub.id), null, 'a late update resurrected a removed profile');
  } finally {
    subscriptionStub.parseSubscriptionContent = originalRawParser;
    subscriptionStub.fetchSubscription = originalFetchSubscription;
  }
  console.log('✓ late config updates preserve newer edits and cannot resurrect deleted profiles');

  const savedProfiles = state.store.getSubscriptions({ includeRaw: true });
  const savedActive = state.store.get('activeSub');
  const savedSelected = state.store.get('selected');
  const originalRemoveRunning = state.singbox.isRunning;
  const originalStopCore = core.stopCore;
  const onlyProfile = state.store.getSubscription(subA.id, { includeRaw: true });
  let stopRemember = null;
  state.store.set('subscriptions', [onlyProfile]);
  state.store.set('activeSub', onlyProfile.id);
  state.singbox.isRunning = () => true;
  core.stopCore = async (remember) => { stopRemember = remember; };
  try {
    await handlers['sub:remove'](null, { id: onlyProfile.id });
    assert.deepStrictEqual(state.store.listSubscriptions(), []);
    assert.strictEqual(stopRemember, true, 'removing the last config must stop and disable auto-resume');
  } finally {
    state.store.set('subscriptions', savedProfiles);
    state.store.set('activeSub', savedActive);
    state.store.set('selected', savedSelected);
    state.singbox.isRunning = originalRemoveRunning;
    core.stopCore = originalStopCore;
  }

  const originalSwitchRestart = core.restartIfRunning;
  const originalSwitchStart = core.startCore;
  const originalSwitchRunning = state.singbox.isRunning;
  let switchRunning = true;
  let switchRecoveryStarts = 0;
  state.store.set('activeSub', subA.id);
  state.store.set('selected', 'node-of-a');
  state.singbox.isRunning = () => switchRunning;
  core.restartIfRunning = async () => {
    switchRunning = false;
    throw new Error('new profile failed to start');
  };
  core.startCore = async () => {
    switchRecoveryStarts += 1;
    switchRunning = true;
  };
  try {
    await assert.rejects(handlers['sub:setActive'](null, { id: subB.id }), /new profile failed to start/);
    assert.strictEqual(state.store.get('activeSub'), subA.id);
    assert.strictEqual(state.store.get('selected'), 'node-of-a');
    assert.strictEqual(switchRecoveryStarts, 1);
  } finally {
    core.restartIfRunning = originalSwitchRestart;
    core.startCore = originalSwitchStart;
    state.singbox.isRunning = originalSwitchRunning;
  }

  state.store.set('activeSub', subA.id);
  state.store.set('selected', 'node-of-a');
  state.singbox.isRunning = () => true;
  let queuedProfileRestarts = 0;
  let releaseProfileRestart;
  let signalProfileRestart;
  const profileRestartEntered = new Promise((resolve) => { signalProfileRestart = resolve; });
  const profileRestartGate = new Promise((resolve) => { releaseProfileRestart = resolve; });
  core.restartIfRunning = async () => {
    queuedProfileRestarts += 1;
    if (queuedProfileRestarts === 1) {
      signalProfileRestart();
      await profileRestartGate;
    }
  };
  try {
    const activateB = handlers['sub:setActive'](null, { id: subB.id });
    await profileRestartEntered;
    const activateA = handlers['sub:setActive'](null, { id: subA.id });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      state.store.get('activeSub'),
      subB.id,
      'a later profile transaction ran before the active restart completed'
    );
    releaseProfileRestart();
    await Promise.all([activateB, activateA]);
    assert.strictEqual(state.store.get('activeSub'), subA.id);
    assert.strictEqual(queuedProfileRestarts, 2);
  } finally {
    core.restartIfRunning = originalSwitchRestart;
    state.singbox.isRunning = originalSwitchRunning;
  }
  console.log('✓ removing the last config stops cleanly and failed profile switches roll back');

  // Explicit activation still works and is the only way to switch.
  await handlers['sub:setActive'](null, { id: subB.id });
  assert.strictEqual(core.getActiveSubId(), subB.id, 'explicit activation switches the profile');

  const originalAutoCandidateRunning = state.singbox.isRunning;
  const originalApplyAutoCandidate = core.applyMeasuredAutoCandidate;
  let appliedAutoCandidate = null;
  state.singbox.isRunning = () => true;
  core.applyMeasuredAutoCandidate = async (name) => {
    appliedAutoCandidate = name;
    return name;
  };
  try {
    assert.strictEqual(
      await handlers['node:autoCandidate'](null, { name: 'node-of-b' }),
      'node-of-b'
    );
    assert.strictEqual(appliedAutoCandidate, 'node-of-b');
    await assert.rejects(
      handlers['node:autoCandidate'](null, { name: 'not-in-profile' }),
      /not part of the active config/
    );
  } finally {
    core.applyMeasuredAutoCandidate = originalApplyAutoCandidate;
    state.singbox.isRunning = originalAutoCandidateRunning;
  }
  console.log('✓ test-all can apply its fastest valid node to Auto');

  const selectedBeforeFailure = state.store.get('selected');
  const originalSelectRunning = state.singbox.isRunning;
  const originalSetClashSelector = core.setClashSelector;
  state.singbox.isRunning = () => true;
  core.setClashSelector = async () => { throw new Error('clash api 400'); };
  await assert.rejects(
    handlers['node:select'](null, { name: 'node-of-b' }),
    /running core does not have this node/
  );
  assert.strictEqual(state.store.get('selected'), selectedBeforeFailure, 'failed live selection was persisted');
  await assert.rejects(
    handlers['node:select'](null, { name: 'not-in-profile' }),
    /not part of the active config/
  );
  core.setClashSelector = originalSetClashSelector;
  state.singbox.isRunning = originalSelectRunning;

  console.log('✓ adding a subscription never steals the active profile (legacy-store regression)');

  // A second config change arriving after the first restart has built its
  // config must trigger another pass instead of sharing a stale completion.
  const restartManager = state.singbox;
  const restartOriginals = {
    isRunning: restartManager.isRunning,
    start: restartManager.start,
    stop: restartManager.stop,
    ensureSingBoxGeoData: restartManager.ensureSingBoxGeoData,
    updateGeoData: restartManager.updateGeoData,
  };
  const restartSettings = state.store.getSettings();
  let fakeRunning = true;
  let releaseFirstStart;
  let announceFirstStart;
  const firstStartGate = new Promise((resolve) => { releaseFirstStart = resolve; });
  const firstStartSeen = new Promise((resolve) => { announceFirstStart = resolve; });
  const startedConfigs = [];
  restartManager.isRunning = () => fakeRunning;
  restartManager.stop = async () => { fakeRunning = false; };
  restartManager.start = async (config) => {
    startedConfigs.push(config);
    if (startedConfigs.length === 1) {
      announceFirstStart();
      await firstStartGate;
    }
    fakeRunning = true;
  };
  restartManager.ensureSingBoxGeoData = () => true;
  restartManager.updateGeoData = async () => null;
  try {
    state.store.updateSettings({ autoSetSystemProxy: false, enableClashApi: false });
    state.store.set('activeSub', subA.id);
    const firstRestart = core.restartIfRunning();
    await firstStartSeen;
    state.store.set('activeSub', subB.id);
    const secondRestart = core.restartIfRunning();
    releaseFirstStart();
    await Promise.all([firstRestart, secondRestart]);
    assert.strictEqual(startedConfigs.length, 2, 'a config change during restart was dropped');
    assert.ok(startedConfigs[0].outbounds.some((outbound) => outbound.tag === 'node-of-a'));
    assert.ok(startedConfigs[1].outbounds.some((outbound) => outbound.tag === 'node-of-b'));

    fakeRunning = true;
    restartManager.start = async () => { throw new Error('simulated start failure'); };
    await assert.rejects(core.restartIfRunning(), /simulated start failure/);
  } finally {
    fakeRunning = false;
    restartManager.isRunning = restartOriginals.isRunning;
    restartManager.start = restartOriginals.start;
    restartManager.stop = restartOriginals.stop;
    restartManager.ensureSingBoxGeoData = restartOriginals.ensureSingBoxGeoData;
    restartManager.updateGeoData = restartOriginals.updateGeoData;
    state.store.updateSettings({
      autoSetSystemProxy: restartSettings.autoSetSystemProxy,
      enableClashApi: restartSettings.enableClashApi,
    });
    state.store.set('activeSub', subB.id);
  }
  console.log('✓ restart scheduling applies late changes and reports start failures');

  // Restart must be one lifecycle operation. Otherwise a Stop queued while
  // restart is awaiting its first stop can run before restart's later Start,
  // leaving the core running even though Stop was the final user action.
  const lifecycleManager = state.singbox;
  const lifecycleOriginals = {
    isRunning: lifecycleManager.isRunning,
    start: lifecycleManager.start,
    stop: lifecycleManager.stop,
    ensureSingBoxGeoData: lifecycleManager.ensureSingBoxGeoData,
    updateGeoData: lifecycleManager.updateGeoData,
  };
  const lifecycleLastRunning = state.store.get('lastRunning');
  let lifecycleRunning = true;
  let lifecycleStops = 0;
  let lifecycleStarts = 0;
  let releaseRestartStop;
  let announceRestartStop;
  const restartStopGate = new Promise((resolve) => { releaseRestartStop = resolve; });
  const restartStopSeen = new Promise((resolve) => { announceRestartStop = resolve; });
  lifecycleManager.isRunning = () => lifecycleRunning;
  lifecycleManager.stop = async () => {
    lifecycleStops += 1;
    lifecycleRunning = false;
    if (lifecycleStops === 1) {
      announceRestartStop();
      await restartStopGate;
    }
  };
  lifecycleManager.start = async () => {
    lifecycleStarts += 1;
    lifecycleRunning = true;
  };
  lifecycleManager.ensureSingBoxGeoData = () => true;
  lifecycleManager.updateGeoData = async () => null;
  try {
    const restartRequest = handlers['core:restart']();
    await restartStopSeen;
    const stopRequest = handlers['core:stop']();
    releaseRestartStop();
    await Promise.all([restartRequest, stopRequest]);
    assert.strictEqual(lifecycleRunning, false, 'a queued Stop was overtaken by restart Start');
    assert.strictEqual(lifecycleStarts, 1);
    assert.strictEqual(lifecycleStops, 2);
  } finally {
    lifecycleManager.isRunning = lifecycleOriginals.isRunning;
    lifecycleManager.start = lifecycleOriginals.start;
    lifecycleManager.stop = lifecycleOriginals.stop;
    lifecycleManager.ensureSingBoxGeoData = lifecycleOriginals.ensureSingBoxGeoData;
    lifecycleManager.updateGeoData = lifecycleOriginals.updateGeoData;
    state.store.set('lastRunning', lifecycleLastRunning);
  }
  console.log('✓ explicit restart cannot overtake a later Stop request');

  const originalParseSubscription = subscriptionStub.parseSubscriptionContent;
  const conversionNode = { name: 'Converted', type: 'trojan', server: 'proxy.example.com', port: 443, password: 'p', tls: true };
  subscriptionStub.parseSubscriptionContent = (content) => content === 'singbox-source'
    ? { nodes: [conversionNode], rules: ['DOMAIN-SUFFIX,example.com,DIRECT'], format: 'singbox' }
    : { nodes: [conversionNode], rules: ['DOMAIN-SUFFIX,example.com,Proxy'], format: 'clash' };
  const toClash = handlers['convert:preview'](null, { content: 'singbox-source', target: 'auto' });
  assert.strictEqual(toClash.target, 'clash');
  assert.ok(toClash.text.includes('name: Dart Proxy'));
  assert.ok(!/[🚀♻️]/u.test(toClash.text), 'converted Clash output still contains decorative emoji');
  const toSingbox = handlers['convert:preview'](null, { content: 'clash-source', target: 'auto' });
  assert.strictEqual(toSingbox.target, 'sing-box');
  assert.ok(toSingbox.config.outbounds.some((outbound) => outbound.tag === 'Dart Proxy'));
  assert.ok(!/[🚀♻️]/u.test(JSON.stringify(toSingbox.config)), 'converted sing-box output still contains decorative emoji');
  await assert.rejects(
    Promise.resolve().then(() => handlers['convert:preview'](null, { content: 'clash-source', target: 'invalid' })),
    /invalid conversion target/
  );
  subscriptionStub.parseSubscriptionContent = originalParseSubscription;
  console.log('✓ config conversion auto-detects both directions and emits plain group names');

  await assert.rejects(
    handlers['settings:update'](null, { mixedPort: 0 }),
    /invalid mixedPort/
  );
  await assert.rejects(
    handlers['settings:update'](null, { mixedPort: 9090, clashApiPort: 9090 }),
    /must be different/
  );
  await assert.rejects(
    handlers['settings:update'](null, { dnsRemote: 'file:///etc/hosts' }),
    /invalid dnsRemote/
  );
  await assert.rejects(
    handlers['sub:edit'](null, { id: subA.id, autoUpdateMinutes: -1 }),
    /invalid autoUpdateMinutes/
  );
  await assert.rejects(
    handlers['sub:edit'](null, { id: subA.id, updateViaProxy: 'false' }),
    /invalid updateViaProxy/
  );
  await assert.rejects(
    handlers['customrs:edit'](null, { id: 'missing', autoUpdateMinutes: 1.5 }),
    /invalid autoUpdateMinutes/
  );
  await assert.rejects(
    handlers['tun:set'](null, { enable: 'false' }),
    /invalid enable/
  );
  await assert.rejects(
    handlers['proxy:set'](null, { enable: 1 }),
    /invalid enable/
  );
  await assert.rejects(
    handlers['proxy:set'](null, { enable: true }),
    /start the core/
  );
  const proxyModule = require(path.join(__dirname, '..', 'src', 'main', 'proxy'));
  const originalDisableOwnedProxy = proxyModule.disableSystemProxyIfOurs;
  let ownedProxyClears = 0;
  proxyModule.disableSystemProxyIfOurs = async (server) => {
    ownedProxyClears += 1;
    assert.strictEqual(server, '127.0.0.1:7890');
  };
  try {
    state.systemProxyOn = true;
    state.systemProxyServer = null;
    await handlers['proxy:set'](null, { enable: false });
    assert.strictEqual(ownedProxyClears, 0);

    state.systemProxyOn = true;
    state.systemProxyServer = '127.0.0.1:7890';
    await handlers['proxy:set'](null, { enable: false });
    assert.strictEqual(ownedProxyClears, 1, 'the exact Dart proxy endpoint was not cleared');
  } finally {
    state.systemProxyOn = false;
    state.systemProxyServer = null;
    proxyModule.disableSystemProxyIfOurs = originalDisableOwnedProxy;
  }

  const originalProxyRaceRunning = state.singbox.isRunning;
  const originalProxyRaceStop = state.singbox.stop;
  let proxyRaceRunning = true;
  let releaseProxyRaceStop;
  let signalProxyRaceStop;
  const proxyRaceStopEntered = new Promise((resolve) => { signalProxyRaceStop = resolve; });
  const proxyRaceStopGate = new Promise((resolve) => { releaseProxyRaceStop = resolve; });
  state.singbox.isRunning = () => proxyRaceRunning;
  state.singbox.stop = async () => {
    signalProxyRaceStop();
    await proxyRaceStopGate;
    proxyRaceRunning = false;
  };
  try {
    const stopping = core.stopCore();
    await proxyRaceStopEntered;
    const lateEnable = handlers['proxy:set'](null, { enable: true });
    releaseProxyRaceStop();
    await stopping;
    await assert.rejects(lateEnable, /start the core/);
  } finally {
    state.singbox.isRunning = originalProxyRaceRunning;
    state.singbox.stop = originalProxyRaceStop;
  }
  console.log('✓ system-proxy cleanup never disables an endpoint Dart cannot prove it owns');

  const originalStopProxyAsync = proxyModule.disableSystemProxyIfOurs;
  const originalStopProxySync = proxyModule.disableSystemProxySyncIfOurs;
  const originalManagerStop = state.singbox.stop;
  const originalProxyOwner = state.store.get('ownedSystemProxyServer');
  let stopProxyAttempt = 0;
  proxyModule.disableSystemProxyIfOurs = async () => {
    stopProxyAttempt += 1;
    if (stopProxyAttempt === 1) throw new Error('registry temporarily locked');
    return true;
  };
  proxyModule.disableSystemProxySyncIfOurs = () => false;
  state.singbox.stop = async () => {};
  try {
    state.systemProxyOn = true;
    state.systemProxyServer = '127.0.0.1:7890';
    state.store.set('ownedSystemProxyServer', '127.0.0.1:7890');
    await core.stopCore();
    assert.strictEqual(state.systemProxyOn, true, 'failed stop cleanup forgot proxy ownership');
    assert.strictEqual(state.systemProxyServer, '127.0.0.1:7890');
    assert.strictEqual(state.store.get('ownedSystemProxyServer'), '127.0.0.1:7890');

    await core.stopCore();
    assert.strictEqual(state.systemProxyOn, false, 'a later stop did not retry proxy cleanup');
    assert.strictEqual(state.systemProxyServer, null);
    assert.strictEqual(state.store.get('ownedSystemProxyServer'), null);
  } finally {
    state.systemProxyOn = false;
    state.systemProxyServer = null;
    proxyModule.disableSystemProxyIfOurs = originalStopProxyAsync;
    proxyModule.disableSystemProxySyncIfOurs = originalStopProxySync;
    state.singbox.stop = originalManagerStop;
    state.store.set('ownedSystemProxyServer', originalProxyOwner || null);
  }
  console.log('✓ failed stop cleanup retains proxy ownership for a later retry');

  await assert.rejects(
    handlers['core:download'](null, { version: '../../bad' }),
    /invalid version/
  );
  await assert.rejects(
    handlers['core:download'](null, { version: '1.2.3', coreType: 'other' }),
    /invalid coreType/
  );
  const updateType = state.singbox.getCoreType();
  const updateDir = state.singbox.ensureCoreDir(updateType);
  const updateTarget = path.join(updateDir, state.singbox.binNameFor(updateType));
  const originalTarget = fs.existsSync(updateTarget) ? fs.readFileSync(updateTarget) : null;
  const originalDownloadCore = state.singbox.downloadCore;
  const originalUpdateRunning = state.singbox.isRunning;
  const originalStopForUpdate = core.stopCore;
  const originalStartAfterUpdate = core.startCore;
  let updateRunning = true;
  let updateStarts = 0;
  fs.writeFileSync(updateTarget, 'old-core');
  state.singbox.isRunning = () => updateRunning;
  core.stopCore = async () => { updateRunning = false; };
  core.startCore = async () => {
    updateStarts += 1;
    if (fs.readFileSync(updateTarget, 'utf-8') === 'new-core') throw new Error('new core is incompatible');
    updateRunning = true;
  };
  try {
    state.singbox.downloadCore = async (_version, _progress, options) => {
      await options.beforeInstall();
      fs.writeFileSync(updateTarget, 'partial-core');
      throw new Error('install interrupted after replacement');
    };
    await assert.rejects(
      handlers['core:download'](null, { version: '1.2.3' }),
      /install interrupted after replacement/
    );
    assert.strictEqual(fs.readFileSync(updateTarget, 'utf-8'), 'old-core');
    assert.strictEqual(updateRunning, true, 'an interrupted install did not restart the old core');
    assert.strictEqual(updateStarts, 1);

    updateStarts = 0;
    state.singbox.downloadCore = async (_version, _progress, options) => {
      await options.beforeInstall();
      fs.writeFileSync(updateTarget, 'new-core');
      return updateTarget;
    };
    await assert.rejects(
      handlers['core:download'](null, { version: '1.2.3' }),
      /previous core was restored/
    );
    assert.strictEqual(fs.readFileSync(updateTarget, 'utf-8'), 'old-core');
    assert.strictEqual(updateRunning, true, 'the restored core was not restarted');
    assert.strictEqual(updateStarts, 2, 'the handler did not retry with the previous core');

    updateStarts = 0;
    let requestedCoreType = null;
    const alternateType = updateType === 'mihomo' ? 'sing-box' : 'mihomo';
    state.singbox.downloadCore = async (_version, _progress, options) => {
      requestedCoreType = options.coreType;
      await options.beforeInstall();
      return path.join(state.singbox.ensureCoreDir(alternateType), state.singbox.binNameFor(alternateType));
    };
    await handlers['core:download'](null, { version: '1.2.3', coreType: alternateType });
    assert.strictEqual(requestedCoreType, alternateType);
    assert.strictEqual(updateRunning, true, 'installing the inactive core stopped the active core');
    assert.strictEqual(updateStarts, 0, 'installing the inactive core restarted the active core');
  } finally {
    state.singbox.downloadCore = originalDownloadCore;
    state.singbox.isRunning = originalUpdateRunning;
    core.stopCore = originalStopForUpdate;
    core.startCore = originalStartAfterUpdate;
    if (originalTarget) fs.writeFileSync(updateTarget, originalTarget);
    else try { fs.unlinkSync(updateTarget); } catch (_) {}
  }
  console.log('✓ interrupted and incompatible core updates restore and restart the previous binary');
  const previousTestUrl = state.store.getSettings().testUrl;
  const originalSettingsRunning = state.singbox.isRunning;
  const originalSettingsRestart = core.restartIfRunning;
  const originalApplyAutoLaunch = core.applyAutoLaunch;
  const originalSetCoreType = state.singbox.setCoreType;
  let settingsRestartCount = 0;
  state.singbox.isRunning = () => true;
  core.restartIfRunning = async () => { settingsRestartCount += 1; };
  try {
    const testUrl = 'https://example.com/dart-204';
    await handlers['settings:update'](null, { testUrl });
    assert.strictEqual(settingsRestartCount, 1, 'changing the health-check URL must rebuild a running core config');
    const singboxHealth = core.buildCurrentConfig('sing-box').config.outbounds.filter((outbound) => outbound.type === 'urltest');
    const mihomoHealth = core.buildCurrentConfig('mihomo').config['proxy-groups'].filter((group) => ['url-test', 'fallback'].includes(group.type));
    assert.ok(singboxHealth.length && singboxHealth.every((outbound) => outbound.url === testUrl));
    assert.ok(mihomoHealth.length && mihomoHealth.every((group) => group.url === testUrl));

    const savedLogLevel = state.store.getSettings().logLevel;
    const [firstLogLevel, secondLogLevel] = ['debug', 'warn', 'error'].filter((level) => level !== savedLogLevel);
    let releaseFirstSettingsRestart;
    let signalFirstSettingsRestart;
    const firstSettingsRestartEntered = new Promise((resolve) => { signalFirstSettingsRestart = resolve; });
    const firstSettingsRestartGate = new Promise((resolve) => { releaseFirstSettingsRestart = resolve; });
    let queuedSettingsRestarts = 0;
    core.restartIfRunning = async () => {
      queuedSettingsRestarts += 1;
      if (queuedSettingsRestarts === 1) {
        signalFirstSettingsRestart();
        await firstSettingsRestartGate;
      }
    };
    const firstSettingsWrite = handlers['settings:update'](null, { logLevel: firstLogLevel });
    await firstSettingsRestartEntered;
    const secondSettingsWrite = handlers['settings:update'](null, { logLevel: secondLogLevel });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      state.store.getSettings().logLevel,
      firstLogLevel,
      'a later settings transaction ran before the active restart completed'
    );
    releaseFirstSettingsRestart();
    await Promise.all([firstSettingsWrite, secondSettingsWrite]);
    assert.strictEqual(state.store.getSettings().logLevel, secondLogLevel);
    assert.strictEqual(queuedSettingsRestarts, 2);
    state.store.updateSettings({ logLevel: savedLogLevel });

    core.restartIfRunning = async () => { throw new Error('new config failed to start'); };
    await assert.rejects(
      handlers['settings:update'](null, { testUrl: 'https://invalid.example.com/check' }),
      /new config failed to start/
    );
    assert.strictEqual(state.store.getSettings().testUrl, testUrl, 'failed settings restart was persisted');

    const previousTun = state.store.getSettings().enableTun;
    await assert.rejects(
      handlers['tun:set'](null, { enable: !previousTun }),
      /new config failed to start/
    );
    assert.strictEqual(state.store.getSettings().enableTun, previousTun, 'failed TUN restart was persisted');

    core.applyAutoLaunch = () => { throw new Error('login registration failed'); };
    const previousAutoLaunch = state.store.getSettings().autoLaunch;
    await assert.rejects(
      handlers['settings:update'](null, { autoLaunch: !previousAutoLaunch }),
      /login registration failed/
    );
    assert.strictEqual(
      state.store.getSettings().autoLaunch,
      previousAutoLaunch,
      'failed auto-launch registration was persisted'
    );

    const previousCoreType = state.store.getSettings().coreType;
    const rejectedCoreType = previousCoreType === 'mihomo' ? 'sing-box' : 'mihomo';
    state.singbox.setCoreType = function failNewCoreDirectory(type) {
      if (type === rejectedCoreType) throw new Error('core directory unavailable');
      return originalSetCoreType.call(this, type);
    };
    await assert.rejects(
      handlers['settings:update'](null, { coreType: rejectedCoreType }),
      /core directory unavailable/
    );
    assert.strictEqual(state.store.getSettings().coreType, previousCoreType);
    assert.strictEqual(state.singbox.getCoreType(), previousCoreType);
    state.singbox.setCoreType = originalSetCoreType;

    state.store.updateSettings({ autoLaunch: true });
    core.applyAutoLaunch = () => { throw new Error('TUN login registration failed'); };
    await assert.rejects(
      handlers['tun:set'](null, { enable: !previousTun }),
      /TUN login registration failed/
    );
    assert.strictEqual(state.store.getSettings().enableTun, previousTun, 'failed TUN login registration was persisted');
    state.store.updateSettings({ autoLaunch: previousAutoLaunch });
  } finally {
    state.store.updateSettings({ testUrl: previousTestUrl });
    state.singbox.isRunning = originalSettingsRunning;
    state.singbox.setCoreType = originalSetCoreType;
    core.restartIfRunning = originalSettingsRestart;
    core.applyAutoLaunch = originalApplyAutoLaunch;
  }
  console.log('✓ settings reject invalid values and apply custom health-check URLs to both cores');

  const http = require('http');
  const originalHttpRequest = http.request;
  const originalModeRunning = state.singbox.isRunning;
  const storedMode = state.store.getSettings().clashMode;
  const storedModeRevision = core.getModeRevision();
  state.singbox.isRunning = () => true;
  http.request = (_options, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 503;
      callback(response);
      queueMicrotask(() => response.emit('end'));
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  try {
    await assert.rejects(core.setProxyMode(storedMode === 'global' ? 'direct' : 'global'), /clash api 503/);
    assert.strictEqual(state.store.getSettings().clashMode, storedMode, 'failed live mode change was persisted');
    assert.strictEqual(core.getModeRevision(), storedModeRevision, 'failed live mode change advanced the revision');
  } finally {
    http.request = originalHttpRequest;
    state.singbox.isRunning = originalModeRunning;
  }
  console.log('✓ failed live proxy-mode changes do not desynchronize persisted state');

  http.request = (_options, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from('{broken'));
        response.emit('end');
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  try {
    await assert.rejects(core.clashApi('GET', '/configs'), /invalid JSON from Clash API/);
  } finally {
    http.request = originalHttpRequest;
  }
  console.log('✓ malformed Clash API responses cannot masquerade as successful state changes');

  const originalAutoRunning = state.singbox.isRunning;
  const originalAutoCoreType = state.singbox.getCoreType;
  const originalAutoApiEnabled = state.store.getSettings().enableClashApi;
  let autoRequest = null;
  let autoRequestBody = '';
  let autoCoreType = 'sing-box';
  state.singbox.isRunning = () => true;
  state.singbox.getCoreType = () => autoCoreType;
  state.store.updateSettings({ enableClashApi: true });
  http.request = (options, callback) => {
    autoRequest = options;
    const request = new EventEmitter();
    request.write = (chunk) => { autoRequestBody += chunk.toString(); };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 204;
      response.headers = {};
      callback(response);
      queueMicrotask(() => response.emit('end'));
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  try {
    assert.strictEqual(await core.applyMeasuredAutoCandidate('fast-node'), 'fast-node');
    assert.strictEqual(autoRequest.method, 'PUT');
    assert.strictEqual(autoRequest.path, '/proxies/%E2%99%BB%EF%B8%8F%20Auto');
    assert.deepStrictEqual(JSON.parse(autoRequestBody), { name: 'fast-node' });

    autoCoreType = 'mihomo';
    autoRequestBody = '';
    assert.strictEqual(await core.applyMeasuredAutoCandidate('mihomo-fast'), 'mihomo-fast');
    assert.strictEqual(autoRequest.method, 'PUT');
    assert.strictEqual(autoRequest.path, '/proxies/%E2%99%BB%EF%B8%8F%20Auto');
    assert.deepStrictEqual(JSON.parse(autoRequestBody), { name: 'mihomo-fast' });
  } finally {
    http.request = originalHttpRequest;
    state.singbox.isRunning = originalAutoRunning;
    state.singbox.getCoreType = originalAutoCoreType;
    state.store.updateSettings({ enableClashApi: originalAutoApiEnabled });
  }
  console.log('✓ both cores apply the fastest measured node through the same managed Auto selector');

  assert.strictEqual(core.modeChangeNeedsRestart('mihomo', 'rule', 'block'), true);
  assert.strictEqual(core.modeChangeNeedsRestart('mihomo', 'block', 'direct'), true);
  assert.strictEqual(core.modeChangeNeedsRestart('mihomo', 'rule', 'global'), false);
  assert.strictEqual(core.modeChangeNeedsRestart('sing-box', 'rule', 'block'), false);

  const modeRecoveryManager = state.singbox;
  const modeRecoverySettings = state.store.getSettings();
  const modeRecoveryCoreType = modeRecoveryManager.getCoreType();
  const modeRecoveryLastRunning = state.store.get('lastRunning');
  const modeRecoveryOriginals = {
    isRunning: modeRecoveryManager.isRunning,
    start: modeRecoveryManager.start,
    stop: modeRecoveryManager.stop,
    validateMihomoGeoData: modeRecoveryManager.validateMihomoGeoData,
    mihomoGeoDataReady: modeRecoveryManager.mihomoGeoDataReady,
  };
  let modeRecoveryRunning = true;
  let modeRecoveryStarts = 0;
  modeRecoveryManager.isRunning = () => modeRecoveryRunning;
  modeRecoveryManager.stop = async () => { modeRecoveryRunning = false; };
  modeRecoveryManager.start = async () => {
    modeRecoveryStarts += 1;
    if (modeRecoveryStarts === 1) throw new Error('new block config failed');
    modeRecoveryRunning = true;
  };
  modeRecoveryManager.validateMihomoGeoData = async () => true;
  modeRecoveryManager.mihomoGeoDataReady = () => true;
  try {
    modeRecoveryManager.setCoreType('mihomo');
    state.store.updateSettings({
      coreType: 'mihomo',
      clashMode: 'rule',
      enableTun: false,
      enableClashApi: false,
      autoSetSystemProxy: false,
    });
    await assert.rejects(core.setProxyMode('block'), /new block config failed/);
    assert.strictEqual(state.store.getSettings().clashMode, 'rule');
    assert.strictEqual(modeRecoveryStarts, 2, 'failed block-mode restart did not restore the old config');
    assert.strictEqual(modeRecoveryRunning, true, 'failed block-mode restart left the core stopped');
  } finally {
    modeRecoveryManager.isRunning = modeRecoveryOriginals.isRunning;
    modeRecoveryManager.start = modeRecoveryOriginals.start;
    modeRecoveryManager.stop = modeRecoveryOriginals.stop;
    modeRecoveryManager.validateMihomoGeoData = modeRecoveryOriginals.validateMihomoGeoData;
    modeRecoveryManager.mihomoGeoDataReady = modeRecoveryOriginals.mihomoGeoDataReady;
    modeRecoveryManager.setCoreType(modeRecoveryCoreType);
    state.store.updateSettings({
      coreType: modeRecoverySettings.coreType,
      clashMode: modeRecoverySettings.clashMode,
      enableTun: modeRecoverySettings.enableTun,
      enableClashApi: modeRecoverySettings.enableClashApi,
      autoSetSystemProxy: modeRecoverySettings.autoSetSystemProxy,
    });
    state.store.set('lastRunning', modeRecoveryLastRunning);
  }
  console.log('✓ failed Mihomo block-mode rebuilds restore the previous running config');

  http.request = (_options, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      queueMicrotask(() => response.emit('aborted'));
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  const deadline = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('response did not settle')), 250)),
  ]);
  try {
    await assert.rejects(deadline(core.clashApi('GET', '/partial')), /response aborted/);
    await assert.rejects(deadline(core.testNodeDelay('partial')), /response aborted/);
  } finally {
    http.request = originalHttpRequest;
  }
  console.log('✓ interrupted Clash API responses reject promptly without an unhandled stream error');

  // ---- Regression: inline custom rule-sets must stay OR-semantics ----
  // A rule with both domain and ip_cidr fields is an AND in sing-box, so older
  // persisted inline rule-sets must be split when building the route.
  state.store.set('customRuleSets', [
    {
      id: 'old-inline',
      kind: 'inline',
      enabled: true,
      rule: { domain_suffix: ['example.com'], ip_cidr: ['1.1.1.0/24'], outbound: 'direct' },
    },
  ]);
  assert.deepStrictEqual(core.collectCustomRules().extraRules, [
    { domain_suffix: ['example.com'], outbound: 'direct' },
    { ip_cidr: ['1.1.1.0/24'], outbound: 'direct' },
  ]);

  state.store.set('customRuleSets', [
    {
      id: 'new-inline',
      kind: 'inline',
      enabled: true,
      rules: [
        { domain_suffix: ['example.com'], action: 'reject' },
        { ip_cidr: ['1.1.1.0/24'], action: 'reject' },
      ],
    },
  ]);
  assert.deepStrictEqual(core.collectCustomRules().extraRules, [
    { domain_suffix: ['example.com'], action: 'reject' },
    { ip_cidr: ['1.1.1.0/24'], action: 'reject' },
  ]);
  const binaryRule = { id: 'binary-srs', kind: 'ruleset', enabled: true, target: 'proxy' };
  state.store.set('customRuleSets', [
    ...state.store.get('customRuleSets'),
    binaryRule,
  ]);
  const binaryPath = path.join(
    state.singbox.coreDir('sing-box'),
    core.customRuleSetFileName(binaryRule.id)
  );
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, Buffer.from('SRSvalid'));
  assert.ok(
    core.collectCustomRules('sing-box').extraRules.some((rule) => rule.rule_set),
    'sing-box binary remote rule was not included'
  );
  assert.ok(
    !core.collectCustomRules('mihomo').extraRules.some((rule) => rule.rule_set),
    'sing-box binary remote rule leaked into Mihomo as an undefined provider'
  );
  assert.strictEqual(
    core.normalizeCustomRuleSetFormat(undefined, 'https://example.com/rules/custom.srs'),
    'sing-box',
    'formatless .srs custom rule-set records must auto-detect as sing-box during refresh/auto-update'
  );
  assert.strictEqual(
    core.normalizeCustomRuleSetFormat('surge', 'https://example.com/rules.txt'),
    'clash',
    'legacy custom rule-set formats are processed as Clash-compatible text'
  );
  assert.ok(!/[\\/]/.test(core.customRuleSetFileName('../../outside')), 'custom rule-set file names cannot traverse');

  console.log('✓ inline custom rule-sets keep OR semantics across old and new stores');

  const github = require(path.join(__dirname, '..', 'src', 'main', 'github'));
  const appUpdate = require(path.join(__dirname, '..', 'src', 'main', 'update'));
  const originalLatestReleaseTag = github.latestReleaseTag;
  github.latestReleaseTag = async () => ({
    tag: 'v0.7.8',
    source: 'github',
    release: {
      html_url: 'https://example.com/release',
      assets: [
        { name: 'Unrelated.Tool.exe', browser_download_url: 'https://example.com/wrong.exe', size: 1 },
        { name: 'Dart.Setup.0.7.8.exe', browser_download_url: 'https://example.com/right.exe', size: 2 },
      ],
    },
  });
  const updateInfo = await appUpdate.checkUpdate('0.7.7');
  github.latestReleaseTag = originalLatestReleaseTag;
  assert.strictEqual(updateInfo.assetName, 'Dart.Setup.0.7.8.exe');
  assert.strictEqual(updateInfo.assetUrl, 'https://example.com/right.exe');

  github.latestReleaseTag = async () => ({ tag: '0.7.9', source: 'jsdelivr', release: null });
  const unprefixedUpdate = await appUpdate.checkUpdate('0.7.8');
  assert.strictEqual(
    unprefixedUpdate.assetUrl,
    'https://github.com/blakebill/dart/releases/download/0.7.9/Dart.Setup.0.7.9.exe'
  );
  github.latestReleaseTag = originalLatestReleaseTag;
  console.log('✓ app updates select the matching Dart installer asset');

  const { SingBoxManager } = require(path.join(__dirname, '..', 'src', 'main', 'singbox'));
  const coreRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-install-'));
  const manager = new SingBoxManager({ runtimeDir: coreRuntime, coreType: 'mihomo' });
  const coreDir = manager.ensureCoreDir('mihomo');
  const binaryName = manager.binNameFor('mihomo');
  const selectedAsset = manager._coreAsset('1.2.3', 'linux', 'amd64', {
    assets: [
      { name: '../mihomo-linux-amd64.gz', browser_download_url: 'https://example.com/escape.gz' },
      { name: 'mihomo-linux-amd64-v1.2.3.gz', browser_download_url: 'https://example.com/safe.gz' },
    ],
  }, 'mihomo');
  assert.strictEqual(selectedAsset.fileName, 'mihomo-linux-amd64-v1.2.3.gz');
  const staleDir = path.join(coreDir, 'mihomo-old-release');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, binaryName), 'stale-binary');
  const archive = path.join(coreDir, 'mihomo-test.gz');
  fs.writeFileSync(archive, zlib.gzipSync(Buffer.from('fresh-binary')));
  manager._runCapture = async () => 'mihomo version v1.2.3';
  await manager._extractCore(archive, coreDir, 'linux', 'mihomo');
  assert.strictEqual(fs.readFileSync(path.join(coreDir, binaryName), 'utf-8'), 'fresh-binary');
  assert.strictEqual(fs.readFileSync(path.join(staleDir, binaryName), 'utf-8'), 'stale-binary');
  assert.ok(!fs.existsSync(archive));
  assert.deepStrictEqual(fs.readdirSync(coreDir).filter((name) => name.startsWith('.extract-')), []);

  const invalidArchive = path.join(coreDir, 'mihomo-invalid.gz');
  fs.writeFileSync(invalidArchive, zlib.gzipSync(Buffer.from('not-a-core')));
  manager._runCapture = async () => 'unexpected output';
  await assert.rejects(manager._extractCore(invalidArchive, coreDir, 'linux', 'mihomo'), /valid version/);
  assert.strictEqual(
    fs.readFileSync(path.join(coreDir, binaryName), 'utf-8'),
    'fresh-binary',
    'an invalid downloaded executable replaced the installed core'
  );

  const extractedTree = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-candidates-'));
  fs.writeFileSync(path.join(extractedTree, 'mihomo-helper'), 'helper');
  fs.mkdirSync(path.join(extractedTree, 'release'));
  fs.writeFileSync(path.join(extractedTree, 'release', 'mihomo'), 'canonical');
  assert.strictEqual(
    manager._findExtractedBinary(extractedTree, 'mihomo', 4, true),
    path.join(extractedTree, 'release', 'mihomo'),
    'a helper binary was preferred over the canonical Mihomo executable'
  );

  let versionRuns = 0;
  let fakeVersion = 'mihomo version v1.2.3';
  manager._runCapture = async () => { versionRuns += 1; return fakeVersion; };
  assert.strictEqual(await manager.getCoreVersion('mihomo'), '1.2.3');
  assert.strictEqual(await manager.getCoreVersion('mihomo'), '1.2.3');
  assert.strictEqual(versionRuns, 1, 'unchanged binaries should reuse the version cache');
  fs.appendFileSync(path.join(coreDir, binaryName), '-changed');
  fakeVersion = 'mihomo version v1.2.4';
  assert.strictEqual(await manager.getCoreVersion('mihomo'), '1.2.4');
  assert.strictEqual(versionRuns, 2, 'replacing a binary at the same path must invalidate its version');
  fs.appendFileSync(path.join(coreDir, binaryName), '-broken');
  let failedVersionRuns = 0;
  manager._runCapture = async () => {
    failedVersionRuns += 1;
    throw new Error('not executable');
  };
  assert.strictEqual(await manager.getCoreVersion('mihomo'), null);
  assert.strictEqual(await manager.getCoreVersion('mihomo'), null);
  assert.strictEqual(failedVersionRuns, 1, 'a failed version probe was respawned on every refresh');
  const geoPayload = Buffer.alloc(4096);
  for (let i = 0; i < geoPayload.length; i++) geoPayload[i] = (i * 29 + 11) & 0xff;
  fs.writeFileSync(path.join(coreDir, 'geoip.dat'), geoPayload);
  fs.writeFileSync(path.join(coreDir, 'geosite.dat'), geoPayload);
  const mmdbPayload = Buffer.from(geoPayload);
  Buffer.from('MaxMind.com').copy(mmdbPayload, mmdbPayload.length - 32);
  fs.writeFileSync(path.join(coreDir, 'country.mmdb'), mmdbPayload);
  let geoChecks = 0;
  manager._checkConfigPath = async () => { geoChecks += 1; return { output: '' }; };
  assert.strictEqual(await manager.validateMihomoGeoData(), true);
  assert.strictEqual(await manager.validateMihomoGeoData(), true);
  assert.strictEqual(geoChecks, 1, 'unchanged GeoData should reuse its async validation result');

  fs.appendFileSync(path.join(coreDir, 'geoip.dat'), '-changed');
  let transientChecks = 0;
  manager._checkConfigPath = async () => {
    transientChecks += 1;
    if (transientChecks === 1) throw new Error('config validation timed out');
    return { output: '' };
  };
  assert.strictEqual(await manager.validateMihomoGeoData(), false);
  assert.strictEqual(await manager.validateMihomoGeoData(), true);
  assert.strictEqual(transientChecks, 2, 'a transient GeoData validation failure was cached permanently');
  console.log('✓ core installs are staged away from stale archives and version caches follow file changes');

  const originalIsRunning = state.singbox.isRunning;
  const originalClashApi = core.clashApi;
  state.singbox.isRunning = () => true;
  core.clashApi = async () => ({
    connections: Array.from({ length: 1000 }, (_, i) => ({
      id: 'c' + i,
      start: 's' + String(i).padStart(4, '0'),
      upload: i,
      download: i * 2,
      chains: ['proxy'],
      rule: 'MATCH',
      metadata: { host: 'example.com', destinationPort: 443, network: 'tcp', ignored: 'large-extra-field' },
      ignored: 'large-extra-field',
    })),
    uploadTotal: 10,
    downloadTotal: 20,
  });
  const connectionSnapshot = await handlers['connections:get']();
  core.clashApi = async () => { throw new Error('temporary API reset'); };
  const failedConnectionSnapshot = await handlers['connections:get']();
  await assert.rejects(handlers['connections:closeAll'](), /temporary API reset/);
  core.clashApi = originalClashApi;
  state.singbox.isRunning = originalIsRunning;
  assert.strictEqual(connectionSnapshot.totalConnections, 1000);
  assert.strictEqual(connectionSnapshot.connections.length, 600);
  assert.strictEqual(connectionSnapshot.connections[0].id, 'c999');
  assert.strictEqual(connectionSnapshot.connections[599].id, 'c400');
  assert.ok(!('ignored' in connectionSnapshot.connections[0]));
  assert.ok(!('ignored' in connectionSnapshot.connections[0].metadata));
  assert.strictEqual(failedConnectionSnapshot.running, true, 'a transient API error was reported as a stopped core');
  assert.match(failedConnectionSnapshot.error, /temporary API reset/);
  console.log('✓ connection IPC keeps only the newest sanitized window and reports close failures');

  state.singbox.setCoreType('mihomo');
  const mihomoDir = state.singbox.ensureCoreDir('mihomo');
  for (const file of ['geoip.dat', 'geosite.dat', 'country.mmdb']) {
    fs.writeFileSync(path.join(mihomoDir, file), Buffer.alloc(2048, 1));
  }
  const geoUpdatedAt = Date.now() - 1234;
  fs.writeFileSync(path.join(mihomoDir, 'geodata-meta.json'), JSON.stringify({
    'geoip.dat': { updatedAt: geoUpdatedAt },
    'geosite.dat': { updatedAt: geoUpdatedAt },
    'country.mmdb': { updatedAt: geoUpdatedAt },
  }));
  const mihomoGeo = await handlers['ruleset:list']();
  assert.deepStrictEqual(
    mihomoGeo.map((x) => x.file),
    ['geoip.dat', 'geosite.dat', 'country.mmdb'],
    'mihomo mode reports mihomo geodata files'
  );
  assert.ok(
    mihomoGeo.every((x) => x.updatedAt === geoUpdatedAt && !Object.prototype.hasOwnProperty.call(x, 'version')),
    'GeoData status only exposes the stored update time, not release versions'
  );
  state.singbox.setCoreType('sing-box');

  console.log('✓ rule-set status switches to mihomo geodata in mihomo mode');

  const originalRouteRunning = state.singbox.isRunning;
  const originalRouteApi = core.clashApi;
  const routeApiPaths = [];
  state.singbox.isRunning = () => true;
  core.clashApi = async (_method, apiPath) => {
    routeApiPaths.push(apiPath);
    if (apiPath === '/configs') return { mode: 'direct' };
    if (apiPath === '/rules') return { rules: [{ type: 'Default', payload: 'ip_cidr=1.1.1.1/32', proxy: '' }] };
    return {};
  };
  const inspectedRoute = await handlers['tools:routeInspect'](null, { value: '1.1.1.1' });
  state.singbox.isRunning = originalRouteRunning;
  core.clashApi = originalRouteApi;
  assert.strictEqual(inspectedRoute.target.host, '1.1.1.1');
  assert.strictEqual(inspectedRoute.policy, 'DIRECT', 'route inspection ignored the live runtime mode');
  assert.strictEqual(inspectedRoute.dnsPath.skipped, true, 'literal IP route checks should not claim a DNS path');
  assert.ok(inspectedRoute.finalOutbound, 'route inspector did not resolve a final outbound');
  assert.ok(!routeApiPaths.includes('/rules'), 'sing-box route inspection used lossy DEFAULT rules from Clash API');
  assert.ok(
    !inspectedRoute.unresolvedBeforeMatch.some((rule) => rule.type === 'DEFAULT'),
    'route inspector still reports structured sing-box rules as DEFAULT'
  );

  const toolbox = require(path.join(__dirname, '..', 'src', 'main', 'toolbox'));
  const forcedModeCalls = [];
  const forcedContext = {
    state: {
      store: { getSettings: () => ({ enableClashApi: true, clashMode: 'rule' }) },
      singbox: { isRunning: () => true },
    },
    core: {
      currentProxyPort: () => 7890,
      clashApi: async (method, apiPath, body) => forcedModeCalls.push({ method, apiPath, body }),
    },
  };
  const forcedResult = await toolbox.withForcedProxy(forcedContext, async (port, forced) => ({ port, forced }));
  assert.deepStrictEqual(forcedResult, { port: 7890, forced: true });
  assert.deepStrictEqual(forcedModeCalls.filter((call) => call.method === 'PATCH').map((call) => call.body.mode), ['global', 'rule']);
  forcedModeCalls.length = 0;
  await assert.rejects(
    toolbox.withForcedProxy(forcedContext, async () => { throw new Error('probe failed'); }),
    /probe failed/
  );
  assert.deepStrictEqual(forcedModeCalls.filter((call) => call.method === 'PATCH').map((call) => call.body.mode), ['global', 'rule']);

  let runtimeMode = 'rule';
  let pendingMode = null;
  const delayedModeContext = {
    state: forcedContext.state,
    core: {
      currentProxyPort: () => 7890,
      clashApi: async (method, apiPath, body) => {
        if (apiPath.startsWith('/proxies/')) return null;
        if (method === 'PATCH') {
          pendingMode = body.mode;
          return {};
        }
        assert.strictEqual(apiPath, '/configs');
        if (pendingMode) {
          const staleMode = runtimeMode;
          runtimeMode = pendingMode;
          pendingMode = null;
          return { mode: staleMode };
        }
        return { mode: runtimeMode };
      },
    },
  };
  const observedMode = await toolbox.withForcedProxy(delayedModeContext, async () => runtimeMode);
  assert.strictEqual(observedMode, 'global', 'probe started before the requested core mode became active');
  assert.strictEqual(runtimeMode, 'rule', 'diagnostics did not wait for the saved mode to be restored');

  let failedSwitchMode = 'rule';
  let failSwitchVerification = true;
  const failedSwitchContext = {
    state: forcedContext.state,
    core: {
      currentProxyPort: () => 7890,
      clashApi: async (method, apiPath, body) => {
        if (apiPath.startsWith('/proxies/')) return null;
        if (method === 'PATCH') {
          failedSwitchMode = body.mode;
          return {};
        }
        if (failedSwitchMode === 'global' && failSwitchVerification) {
          failSwitchVerification = false;
          throw new Error('mode verification failed');
        }
        return { mode: failedSwitchMode };
      },
    },
  };
  await assert.rejects(
    toolbox.withForcedProxy(failedSwitchContext, async () => {}),
    /mode verification failed/
  );
  assert.strictEqual(failedSwitchMode, 'rule', 'a failed diagnostic mode switch was not rolled back');

  let userMode = 'rule';
  let userModeRevision = 0;
  const userModeContext = {
    state: forcedContext.state,
    core: {
      currentProxyPort: () => 7890,
      getModeRevision: () => userModeRevision,
      clashApi: async (method, apiPath, body) => {
        if (apiPath.startsWith('/proxies/')) return null;
        if (method === 'PATCH') userMode = body.mode;
        return { mode: userMode };
      },
    },
  };
  const modeDuringProbe = await toolbox.withForcedProxy(userModeContext, async () => {
    assert.strictEqual(userMode, 'global');
    userModeRevision += 1;
    userMode = 'direct'; // Simulate a newer dashboard mode selection.
    return userMode;
  });
  assert.strictEqual(modeDuringProbe, 'direct');
  assert.strictEqual(userMode, 'direct', 'diagnostic cleanup overwrote a newer user mode');

  let mihomoMode = 'rule';
  let mihomoGlobal = 'DIRECT';
  const mihomoDiagnosticContext = {
    state: {
      store: forcedContext.state.store,
      singbox: { isRunning: () => true, getCoreType: () => 'mihomo' },
    },
    core: {
      currentProxyPort: () => 7890,
      clashApi: async (method, apiPath, body) => {
        if (apiPath === '/configs') {
          if (method === 'PATCH') mihomoMode = body.mode;
          return { mode: mihomoMode };
        }
        if (apiPath === '/proxies/%F0%9F%9A%80%20Proxy') {
          return { now: '♻️ Auto', all: ['♻️ Auto', 'DIRECT'] };
        }
        assert.strictEqual(apiPath, '/proxies/GLOBAL');
        if (method === 'PUT') mihomoGlobal = body.name;
        return { now: mihomoGlobal, all: ['DIRECT', '🚀 Proxy'] };
      },
    },
  };
  const mihomoObserved = await toolbox.withForcedProxy(
    mihomoDiagnosticContext,
    async () => ({ mode: mihomoMode, global: mihomoGlobal })
  );
  assert.deepStrictEqual(mihomoObserved, { mode: 'global', global: '🚀 Proxy' });
  assert.strictEqual(mihomoGlobal, 'DIRECT', 'mihomo GLOBAL selection was not restored');
  assert.strictEqual(mihomoMode, 'rule', 'mihomo mode was not restored');

  let singboxMode = 'rule';
  let singboxProxy = 'direct';
  const singboxDiagnosticContext = {
    state: {
      store: {
        get: () => 'direct',
        getSettings: () => ({ enableClashApi: true, clashMode: 'rule' }),
      },
      singbox: { isRunning: () => true, getCoreType: () => 'sing-box' },
    },
    core: {
      currentProxyPort: () => 7890,
      clashApi: async (method, apiPath, body) => {
        if (apiPath === '/configs') {
          if (method === 'PATCH') singboxMode = body.mode;
          return { mode: singboxMode };
        }
        assert.strictEqual(apiPath, '/proxies/%F0%9F%9A%80%20Proxy');
        if (method === 'PUT') singboxProxy = body.name;
        return { now: singboxProxy, all: ['direct', '♻️ Auto', 'node-a'] };
      },
    },
  };
  const singboxObserved = await toolbox.withForcedProxy(
    singboxDiagnosticContext,
    async () => ({ mode: singboxMode, proxy: singboxProxy })
  );
  assert.deepStrictEqual(singboxObserved, { mode: 'global', proxy: '♻️ Auto' });
  assert.strictEqual(singboxProxy, 'direct', 'sing-box app proxy selection was not restored');
  assert.strictEqual(singboxMode, 'rule', 'sing-box mode was not restored');

  let failedRestoreMode = 'rule';
  let failedRestoreSelector = 'direct';
  let rejectSelectorRestore = false;
  const failedSelectorRestoreContext = {
    state: singboxDiagnosticContext.state,
    core: {
      currentProxyPort: () => 7890,
      clashApi: async (method, apiPath, body) => {
        if (apiPath === '/configs') {
          if (method === 'PATCH') failedRestoreMode = body.mode;
          return { mode: failedRestoreMode };
        }
        if (method === 'PUT') {
          failedRestoreSelector = body.name;
          return {};
        }
        if (rejectSelectorRestore) throw new Error('selector restore failed');
        return { now: failedRestoreSelector, all: ['direct', '♻️ Auto', 'node-a'] };
      },
    },
  };
  let primaryProbeError = null;
  try {
    await toolbox.withForcedProxy(failedSelectorRestoreContext, async () => {
      rejectSelectorRestore = true;
      throw new Error('primary probe failed');
    });
  } catch (error) {
    primaryProbeError = error;
  }
  assert.match(primaryProbeError && primaryProbeError.message, /primary probe failed/);
  assert.match(
    primaryProbeError && primaryProbeError.restoreError && primaryProbeError.restoreError.message,
    /selector restore failed/,
    'selector cleanup hid or discarded the primary diagnostic error'
  );
  assert.strictEqual(failedRestoreMode, 'rule', 'selector cleanup failure prevented mode restoration');

  const geodataSettings = state.store.getSettings();
  const originalGeoUpdate = state.singbox.updateGeoData;
  const originalGeoRunning = state.singbox.isRunning;
  const originalGeoStop = state.singbox.stop;
  const originalGeoStart = state.singbox.start;
  const geoDir = state.singbox.ensureCoreDir('sing-box');
  const oldGeo = Buffer.from('SRS-old-geodata');
  const newGeo = Buffer.from('SRS-new-geodata');
  const geoFiles = ['geoip-cn.srs', 'geosite-cn.srs'];
  const previousGeoSuccess = Date.now() - 8 * 24 * 60 * 60 * 1000;
  geoFiles.forEach((file) => fs.writeFileSync(path.join(geoDir, file), oldGeo));
  fs.writeFileSync(path.join(geoDir, 'geodata-meta.json'), '{"old":true}', 'utf-8');
  state.store.updateSettings({ coreType: 'sing-box', enableTun: false, autoSetSystemProxy: false });
  state.singbox.setCoreType('sing-box');
  state.store.set('geoUpdatedAt_singbox', previousGeoSuccess);
  state.store.set('geoAttemptedAt_singbox', 0);
  let geoRunning = true;
  let geoStartAttempts = 0;
  state.singbox.isRunning = () => geoRunning;
  state.singbox.stop = async () => { geoRunning = false; };
  state.singbox.start = async () => {
    geoStartAttempts += 1;
    if (geoStartAttempts === 1) throw new Error('updated geodata rejected by core');
    geoRunning = true;
  };
  state.singbox.updateGeoData = async () => {
    for (const [file, contents] of [
      ...geoFiles.map((file) => [file, newGeo]),
      ['geodata-meta.json', '{"new":true}'],
    ]) {
      const target = path.join(geoDir, file);
      const staged = target + '.test-update';
      fs.writeFileSync(staged, contents);
      fs.renameSync(staged, target);
    }
    return geoDir;
  };
  try {
    await core.checkGeoUpdate();
    assert.strictEqual(geoRunning, true, 'previous core was not restarted after geodata rollback');
    assert.strictEqual(geoStartAttempts, 2, 'geodata recovery did not retry the previous core exactly once');
    for (const file of geoFiles) {
      assert.deepStrictEqual(fs.readFileSync(path.join(geoDir, file)), oldGeo);
    }
    assert.strictEqual(fs.readFileSync(path.join(geoDir, 'geodata-meta.json'), 'utf-8'), '{"old":true}');
    assert.strictEqual(
      state.store.get('geoUpdatedAt_singbox'),
      previousGeoSuccess,
      'rolled-back geodata was incorrectly recorded as a successful update'
    );
  } finally {
    state.singbox.updateGeoData = originalGeoUpdate;
    state.singbox.isRunning = originalGeoRunning;
    state.singbox.stop = originalGeoStop;
    state.singbox.start = originalGeoStart;
    state.store.updateSettings({
      coreType: geodataSettings.coreType,
      enableTun: geodataSettings.enableTun,
      autoSetSystemProxy: geodataSettings.autoSetSystemProxy,
    });
    state.singbox.setCoreType(geodataSettings.coreType);
    state.store.set('lastRunning', false);
  }
  console.log('✓ failed geodata auto-updates restore prior files and running core');

  const coreBeforeValidation = state.singbox.getCoreType();
  const checkedConfigs = await handlers['tools:configCheck']();
  assert.deepStrictEqual(checkedConfigs.results.map((result) => result.coreType), ['sing-box', 'mihomo']);
  assert.ok(checkedConfigs.results.every((result) => result.summary), 'both generated configs need a comparison summary');
  assert.strictEqual(state.singbox.getCoreType(), coreBeforeValidation, 'dual-core validation switched the active runtime core');
  console.log('✓ route inspection, forced proxy probes and dual-core validation preserve runtime state');

  const backupPath = path.join(tmpDir, 'toolbox-backup.json');
  const originalMixedPort = state.store.getSettings().mixedPort;
  state.store.set('localRules', [{ id: 'backup-rule', name: 'Backup marker', matchType: 'domain', values: ['example.com'], target: 'direct' }]);
  electronStub.dialog.showSaveDialog = async () => ({ canceled: false, filePath: backupPath });
  assert.strictEqual(await handlers['tools:backupExport'](), backupPath);
  assert.ok(fs.existsSync(backupPath), 'backup export did not create a file');

  state.store.updateSettings({ mixedPort: originalMixedPort + 1 });
  state.store.set('localRules', []);
  electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backupPath] });
  const selectedBackup = await handlers['tools:backupSelect']();
  assert.strictEqual(selectedBackup.summary.localRules, 1);
  await assert.rejects(handlers['tools:backupRestore'](null, { token: 'wrong-token' }), /expired/);
  const selectedForChangeCheck = await handlers['tools:backupSelect']();
  const backupText = fs.readFileSync(backupPath, 'utf-8');
  fs.writeFileSync(backupPath, backupText + '\n', 'utf-8');
  await assert.rejects(
    handlers['tools:backupRestore'](null, { token: selectedForChangeCheck.token }),
    /changed after selection/
  );
  fs.writeFileSync(backupPath, backupText, 'utf-8');
  const selectedForRollback = await handlers['tools:backupSelect']();
  const originalBackupAutoLaunch = core.applyAutoLaunch;
  let failBackupActivation = true;
  core.applyAutoLaunch = (...args) => {
    if (failBackupActivation) {
      failBackupActivation = false;
      throw new Error('backup activation failed');
    }
    return originalBackupAutoLaunch(...args);
  };
  try {
    await assert.rejects(
      handlers['tools:backupRestore'](null, { token: selectedForRollback.token }),
      /backup activation failed/
    );
    assert.strictEqual(state.store.getSettings().mixedPort, originalMixedPort + 1);
    assert.deepStrictEqual(state.store.get('localRules'), []);
  } finally {
    core.applyAutoLaunch = originalBackupAutoLaunch;
  }
  const selectedAgain = await handlers['tools:backupSelect']();
  const staleBackupRuleFile = path.join(
    state.singbox.ensureCoreDir('sing-box'),
    core.customRuleSetFileName('stale-backup-rule')
  );
  fs.writeFileSync(staleBackupRuleFile, 'stale rule-set payload');
  const staleRestoreToken = core.beginRemoteUpdate('subscription', 'restore-race');
  const restoredBackup = await handlers['tools:backupRestore'](null, { token: selectedAgain.token });
  assert.strictEqual(restoredBackup.restored, true);
  assert.strictEqual(state.store.getSettings().mixedPort, originalMixedPort);
  assert.strictEqual(state.store.get('localRules')[0].id, 'backup-rule');
  assert.throws(
    () => core.assertRemoteUpdate('subscription', 'restore-race', staleRestoreToken),
    /superseded/,
    'backup restore did not cancel an older remote update'
  );
  assert.strictEqual(fs.existsSync(staleBackupRuleFile), false, 'backup restore retained an unowned binary rule-set');
  console.log('✓ toolbox backup exports, validates and restores settings and rules');

  const shutdownToken = core.beginRemoteUpdate('subscription', 'shutdown-race');
  const originalShutdownStop = state.singbox.stop;
  state.singbox.stop = async () => { throw new Error('shutdown stop failed'); };
  await assert.rejects(core.cleanup(), /shutdown stop failed/);
  assert.throws(
    () => core.assertRemoteUpdate('subscription', 'shutdown-race', shutdownToken),
    /superseded/,
    'shutdown did not cancel an in-flight remote update'
  );
  state.singbox.stop = async () => {};
  try {
    await core.cleanup();
    await assert.rejects(core.startCore(), /shutting down/);
  } finally {
    state.singbox.stop = originalShutdownStop;
  }
  console.log('✓ shutdown cancels background work, reports cleanup errors and blocks late restarts');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ main-process smoke test failed:', e.message);
    process.exit(1);
  });
