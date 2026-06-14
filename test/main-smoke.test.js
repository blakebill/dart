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
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-gui-test-'));
const registered = [];
const handlers = {};

class FakeWebContents {
  send() {}
  on() {}
  once() {}
  openDevTools() {}
}
class FakeBrowserWindow {
  constructor() {
    this.webContents = new FakeWebContents();
  }
  loadFile() {}
  setMenuBarVisibility() {}
  on() {}
  isDestroyed() {
    return false;
  }
  isVisible() {
    return false;
  }
  isMinimized() {
    return false;
  }
  show() {}
  hide() {}
  focus() {}
  restore() {}
  static getAllWindows() {
    return [];
  }
}
class FakeTray {
  setToolTip() {}
  setContextMenu() {}
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
  nativeImage: { createFromDataURL: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
  Notification: class { static isSupported() { return false; } show() {} on() {} },
  shell: { openExternal: () => {}, openPath: () => {}, showItemInFolder: () => {} },
  dialog: {
    showErrorBox: () => {},
    showMessageBox: async () => ({ response: 1 }),
    showSaveDialog: async () => ({ canceled: true }),
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

  // ---- Regression: adding a subscription must never steal the active profile ----
  // Legacy stores (pre-profiles) have subscriptions but no activeSub; the core
  // runs subs[0] via the getActiveSubId fallback. sub:add used to flip the NEW
  // subscription to active (without a restart), so the UI showed nodes the
  // running core didn't have: delay tests "timed out" and node selection
  // failed with "clash api 400".
  const { state } = require(path.join(__dirname, '..', 'src', 'main', 'state'));
  const core = require(path.join(__dirname, '..', 'src', 'main', 'core-control'));

  const subA = await handlers['sub:add'](null, { name: 'A', url: 'https://example.com/a' });
  assert.strictEqual(state.store.get('activeSub'), subA.id, 'the first subscription becomes active');

  state.store.set('activeSub', null); // simulate a legacy store
  const subB = await handlers['sub:add'](null, { name: 'B', url: 'https://example.com/b' });
  assert.notStrictEqual(state.store.get('activeSub'), subB.id, 'a later add must not steal activeness');
  assert.strictEqual(core.getActiveSubId(), subA.id, 'the effective profile remains subs[0]');
  assert.strictEqual(state.store.get('activeSub'), subA.id, 'getActiveSubId pins the legacy fallback');

  // Explicit activation still works and is the only way to switch.
  await handlers['sub:setActive'](null, { id: subB.id });
  assert.strictEqual(core.getActiveSubId(), subB.id, 'explicit activation switches the profile');

  console.log('✓ adding a subscription never steals the active profile (legacy-store regression)');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ main-process smoke test failed:', e.message);
    process.exit(1);
  });
