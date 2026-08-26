'use strict';

/**
 * Main-process smoke test (no Electron runtime needed).
 *
 * Boots src/main/index.js against a stubbed `electron` module and asserts the
 * IPC surface: every channel the preload script invokes must be registered by
 * the main process, and vice versa. This pins the app's IPC contract, so a
 * refactor that moves handlers between files cannot silently drop one.
 *
 * NOTE: index.js installs process-level diagnostics. Every assertion here runs
 * inside the explicit try/catch below so failures still produce a deterministic
 * test exit instead of depending on Electron's lifecycle.
 */

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-gui-test-'));
const registered = [];
const handlers = {};
const appListeners = new Map();
const appExitCodes = [];
let crashReporterOptions = null;

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
    on: (event, listener) => {
      const listeners = appListeners.get(event) || [];
      listeners.push(listener);
      appListeners.set(event, listeners);
    },
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    quit: () => {},
    exit: (code) => { appExitCodes.push(code); },
    disableHardwareAcceleration: () => {},
    commandLine: { appendSwitch: () => {} },
    setLoginItemSettings: () => {},
  },
  crashReporter: {
    start: (options) => { crashReporterOptions = options; },
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
// Outside a packaged Electron app process.resourcesPath does not exist. The
// Electron-as-Node fallback exposes it as configurable but read-only.
Object.defineProperty(process, 'resourcesPath', {
  value: tmpDir,
  configurable: true,
});

// Stub the subscription fetcher so handler-level tests need no network: each
// URL yields one distinct node.
const subscriptionPath = path.join(__dirname, '..', 'src', 'main', 'subscription.js');
const subscriptionFetchCalls = [];
const parseSubscriptionStub = (content) => {
  if (/^\s*proxy-providers\s*:/m.test(String(content || ''))) {
    return {
      nodes: [],
      policyGroups: [{ name: 'Provider Group', type: 'select', members: [], providers: ['airport'] }],
      proxyProviders: {
        airport: { type: 'http', url: 'https://provider.example/sub', interval: 3600 },
      },
      format: 'clash',
      rules: ['MATCH,Provider Group'],
      ruleProviders: {},
    };
  }
  return { nodes: [], policyGroups: [], proxyProviders: {}, format: 'unknown', rules: [], ruleProviders: {} };
};
require.cache[require.resolve(subscriptionPath)] = {
  exports: {
    fetchSubscription: async (url, _log, options = {}) => {
      subscriptionFetchCalls.push({ url, options });
      return {
        nodes: [{ name: 'node-of-' + new URL(url).pathname.slice(1), type: 'trojan', server: 's.example.com', port: 443, password: 'p' }],
        policyGroups: [],
        format: 'links',
        rules: [],
        proxyProviders: {},
        raw: 'stub',
        userInfo: null,
      };
    },
    parseSubscriptionContent: parseSubscriptionStub,
    parseSubscriptionContentAsync: async (content) => parseSubscriptionStub(content),
    hasUsableProxySource: (value) => !!(
      value && ((Array.isArray(value.nodes) && value.nodes.length) ||
        Object.keys(value.proxyProviders || value.clashProxyProviders || {}).length)
    ),
    formatSubscriptionForEditing: (value, target) => `editable:${target}:${value}`,
    nodeFingerprint: (node) => JSON.stringify({
      type: node && node.type,
      server: node && node.server,
      port: node && node.port,
      password: node && node.password,
      uuid: node && node.uuid,
    }),
    configFingerprint: (value) => JSON.stringify([
      value.nodes || [],
      value.policyGroups || value.groups || [],
      value.clashRules || value.rules || [],
      value.clashRuleProviders || value.ruleProviders || {},
      value.clashProxyProviders || value.proxyProviders || {},
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

  assert.strictEqual(crashReporterOptions.uploadToServer, false);
  assert.strictEqual(crashReporterOptions.ignoreSystemCrashHandler, false);
  assert.strictEqual((appListeners.get('render-process-gone') || []).length, 1);
  assert.strictEqual((appListeners.get('child-process-gone') || []).length, 1);
  const rejectionHandler = process.listeners('unhandledRejection').at(-1);
  const exitsBeforeRejection = appExitCodes.length;
  rejectionHandler(new Error('recoverable test rejection'));
  assert.strictEqual(appExitCodes.length, exitsBeforeRejection, 'an async rejection terminated the whole app');
  assert.ok(
    fs.readFileSync(path.join(tmpDir, 'crash.log'), 'utf-8').includes('recoverable test rejection'),
    'async rejection was not persisted for diagnosis'
  );
  console.log('✓ native crashes and recoverable async failures leave local diagnostics');

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
  assert.ok(fromMain.includes('connections:closeMany'), 'filtered connection close IPC is missing');

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
    assert.strictEqual(childWindow.options.backgroundColor, '#f3f3f5');
  }
  assert.ok(childWindow.loadedUrl.startsWith('file://'));
  assert.ok(childWindow.loadedUrl.endsWith('/dialog.html'));
  assert.ok(!childWindow.loadedUrl.includes('\\'));
  assert.deepStrictEqual(await handlers['dialog:getContext'](childEvent), {
    type: 'route', payload: {}, language: 'zh', theme: 'system', themeEffective: 'light',
  });
  assert.deepStrictEqual(childWindow.webContents.sent.at(-1), {
    channel: 'dialog:context',
    payload: { type: 'route', payload: {}, language: 'zh', theme: 'system', themeEffective: 'light' },
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

  const stateModule = require(path.join(__dirname, '..', 'src', 'main', 'state'));
  const sentLogCount = () => mainWindow.webContents.sent
    .filter((event) => event.channel === 'core:log').length;
  const logEventsBefore = sentLogCount();
  stateModule.sendLog('[gui] retained without a stream');
  assert.strictEqual(sentLogCount(), logEventsBefore);
  assert.throws(() => handlers['logs:stream'](windowEvent, { enabled: 'yes' }), /invalid enabled/);
  assert.strictEqual(handlers['logs:stream'](windowEvent, { enabled: true }), true);
  stateModule.sendLog('[gui] streamed on demand');
  assert.strictEqual(sentLogCount(), logEventsBefore + 1);
  assert.strictEqual(handlers['logs:stream'](windowEvent, { enabled: false }), false);
  stateModule.sendLog('[gui] retained after leaving logs');
  assert.strictEqual(sentLogCount(), logEventsBefore + 1);
  console.log('✓ main process streams chatty logs only while the Logs tab requests them');

  const activeWindow = stateModule.state.mainWindow;
  const tearingDownWindow = {
    isDestroyed: () => false,
    get webContents() { throw new Error('Object has been destroyed'); },
  };
  stateModule.state.mainWindow = tearingDownWindow;
  assert.strictEqual(stateModule.sendToMain('test:event', {}), false);
  assert.doesNotThrow(() => stateModule.sendLog('[gui] renderer teardown race'));
  stateModule.state.mainWindow = activeWindow;
  console.log('✓ renderer teardown races cannot crash main-process logging');

  const providerProfile = await handlers['sub:import'](windowEvent, {
    name: 'Provider only',
    content: [
      'proxy-providers:',
      '  airport:',
      '    type: http',
      '    url: https://provider.example/sub',
      'proxy-groups:',
      '  - {name: Provider Group, type: select, use: [airport]}',
    ].join('\n'),
  });
  assert.strictEqual(providerProfile.nodeCount, 0);
  assert.strictEqual(providerProfile.providerCount, 1);
  const providerState = await handlers['app:getState']();
  assert.strictEqual(providerState.subscriptions.find((item) => item.id === providerProfile.id).providerCount, 1);
  const stoppedInventory = await handlers['nodes:get']();
  assert.strictEqual(stoppedInventory.providerStatus.configured, 1);
  assert.strictEqual(stoppedInventory.providerStatus.state, 'stopped');
  console.log('✓ provider-only profiles import, persist and expose an explicit stopped state');

  await handlers['window:close'](windowEvent);
  assert.strictEqual(mainWindow.closed, true);
  console.log('✓ Mihomo-only main process smoke checks passed');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ main-process smoke test failed:', e && e.stack || e);
    process.exit(1);
  });
