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
  setWindowOpenHandler() {}
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

  // Updating only rules/providers still changes the generated core config.
  const subscriptionStub = require(subscriptionPath);
  const originalFetchSubscription = subscriptionStub.fetchSubscription;
  const originalRestartIfRunning = core.restartIfRunning;
  let restartCount = 0;
  subscriptionStub.fetchSubscription = async () => ({
    nodes: subA.nodes,
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
  assert.deepStrictEqual(
    state.store.get('subscriptions').find((s) => s.id === subA.id).clashRuleProviders,
    { remote: { type: 'http', behavior: 'domain', url: 'https://example.com/rules.yaml', format: 'yaml' } },
    'rule providers are persisted during updates'
  );

  const savedSubA = JSON.stringify(state.store.get('subscriptions').find((s) => s.id === subA.id));
  subscriptionStub.fetchSubscription = async () => ({ nodes: [], format: 'unknown', rules: [], raw: '' });
  await assert.rejects(handlers['sub:update'](null, { id: subA.id }), /no nodes parsed/);
  subscriptionStub.fetchSubscription = originalFetchSubscription;
  assert.strictEqual(
    JSON.stringify(state.store.get('subscriptions').find((s) => s.id === subA.id)),
    savedSubA,
    'an empty update must preserve the last working profile'
  );

  // Explicit activation still works and is the only way to switch.
  await handlers['sub:setActive'](null, { id: subB.id });
  assert.strictEqual(core.getActiveSubId(), subB.id, 'explicit activation switches the profile');

  console.log('✓ adding a subscription never steals the active profile (legacy-store regression)');

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
    handlers['proxy:set'](null, { enable: true }),
    /start the core/
  );
  await assert.rejects(
    handlers['core:download'](null, { version: '../../bad' }),
    /invalid version/
  );
  console.log('✓ settings reject invalid ports and cannot enable a dead system proxy');

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
  console.log('✓ app updates select the matching Dart installer asset');

  state.singbox.setCoreType('mihomo');
  const mihomoDir = state.singbox.ensureCoreDir('mihomo');
  for (const file of ['geoip.dat', 'geosite.dat', 'country.mmdb']) {
    fs.writeFileSync(path.join(mihomoDir, file), Buffer.alloc(2048, 1));
  }
  fs.writeFileSync(path.join(mihomoDir, 'geodata-meta.json'), JSON.stringify({
    'geoip.dat': { version: 'latest', updatedAt: Date.now() },
    'geosite.dat': { version: 'latest', updatedAt: Date.now() },
    'country.mmdb': { version: 'latest', updatedAt: Date.now() },
  }));
  const mihomoGeo = handlers['ruleset:list']();
  assert.deepStrictEqual(
    mihomoGeo.map((x) => x.file),
    ['geoip.dat', 'geosite.dat', 'country.mmdb'],
    'mihomo mode reports mihomo geodata files'
  );
  assert.deepStrictEqual(mihomoGeo.map((x) => x.version), [null, null, null], 'latest is not a displayable mihomo geodata version');
  assert.ok(
    mihomoGeo.every((x) => !String(x.url || '').includes('/latest/')),
    'mihomo geodata status must not expose latest URLs as versions'
  );

  fs.writeFileSync(path.join(mihomoDir, 'geodata-meta.json'), JSON.stringify({
    'geoip.dat': { version: '202607010001', updatedAt: Date.now() },
    'geosite.dat': { version: '202607010001', updatedAt: Date.now() },
    'country.mmdb': { version: '202607010001', updatedAt: Date.now() },
  }));
  const versionedMihomoGeo = handlers['ruleset:list']();
  assert.deepStrictEqual(
    versionedMihomoGeo.map((x) => x.version),
    ['202607010001', '202607010001', '202607010001'],
    'mihomo mode reports concrete geodata versions'
  );
  state.singbox.setCoreType('sing-box');

  console.log('✓ rule-set status switches to mihomo geodata in mihomo mode');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ main-process smoke test failed:', e.message);
    process.exit(1);
  });
