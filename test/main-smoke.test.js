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
  constructor(options = {}) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.maximized = false;
    this.minimized = false;
    this.closed = false;
    FakeBrowserWindow.last = this;
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
  minimize() { this.minimized = true; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  isMaximized() { return this.maximized; }
  close() { this.closed = true; }
  setBackgroundMaterial() {}
  setBackgroundColor() {}
  static getAllWindows() {
    return [];
  }
  static fromWebContents(contents) {
    return FakeBrowserWindow.last && FakeBrowserWindow.last.webContents === contents ? FakeBrowserWindow.last : null;
  }
}
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

  const windowEvent = { sender: FakeBrowserWindow.last.webContents };
  assert.strictEqual(await handlers['window:isMaximized'](windowEvent), false);
  assert.strictEqual(await handlers['window:toggleMaximize'](windowEvent), true);
  assert.strictEqual(await handlers['window:toggleMaximize'](windowEvent), false);
  await handlers['window:minimize'](windowEvent);
  await handlers['window:close'](windowEvent);
  assert.strictEqual(FakeBrowserWindow.last.minimized, true);
  assert.strictEqual(FakeBrowserWindow.last.closed, true);
  assert.strictEqual(FakeBrowserWindow.last.options.frame, false);
  assert.strictEqual(FakeBrowserWindow.last.options.titleBarStyle, 'hidden');
  console.log('✓ frameless window controls invoke the active BrowserWindow');

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
  const rendererState = await handlers['app:getState']();
  const rendererSubA = rendererState.subscriptions.find((s) => s.id === subA.id);
  const rendererSubB = rendererState.subscriptions.find((s) => s.id === subB.id);
  assert.strictEqual(rendererSubA.nodes.length, 1, 'active profile exposes node summaries');
  assert.strictEqual(rendererSubB.nodes.length, 0, 'inactive profile payload stays out of renderer IPC');
  assert.strictEqual(rendererSubB.nodeCount, 1, 'inactive profile still exposes its node count');

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
    handlers['proxy:set'](null, { enable: true }),
    /start the core/
  );
  await assert.rejects(
    handlers['core:download'](null, { version: '../../bad' }),
    /invalid version/
  );
  const previousTestUrl = state.store.getSettings().testUrl;
  const originalSettingsRunning = state.singbox.isRunning;
  const originalSettingsRestart = core.restartIfRunning;
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
  } finally {
    state.store.updateSettings({ testUrl: previousTestUrl });
    state.singbox.isRunning = originalSettingsRunning;
    core.restartIfRunning = originalSettingsRestart;
  }
  console.log('✓ settings reject invalid values and apply custom health-check URLs to both cores');

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
  core.clashApi = originalClashApi;
  state.singbox.isRunning = originalIsRunning;
  assert.strictEqual(connectionSnapshot.totalConnections, 1000);
  assert.strictEqual(connectionSnapshot.connections.length, 600);
  assert.strictEqual(connectionSnapshot.connections[0].id, 'c400');
  assert.strictEqual(connectionSnapshot.connections[599].id, 'c999');
  assert.ok(!('ignored' in connectionSnapshot.connections[0]));
  assert.ok(!('ignored' in connectionSnapshot.connections[0].metadata));
  console.log('✓ connection IPC keeps only the newest sanitized window');

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
    if (apiPath === '/rules') return { rules: [{ type: 'Default', payload: 'ip_cidr=1.1.1.1/32', proxy: '' }] };
    return {};
  };
  const inspectedRoute = await handlers['tools:routeInspect'](null, { value: '1.1.1.1' });
  state.singbox.isRunning = originalRouteRunning;
  core.clashApi = originalRouteApi;
  assert.strictEqual(inspectedRoute.target.host, '1.1.1.1');
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
  const selectedAgain = await handlers['tools:backupSelect']();
  const restoredBackup = await handlers['tools:backupRestore'](null, { token: selectedAgain.token });
  assert.strictEqual(restoredBackup.restored, true);
  assert.strictEqual(state.store.getSettings().mixedPort, originalMixedPort);
  assert.strictEqual(state.store.get('localRules')[0].id, 'backup-rule');
  console.log('✓ toolbox backup exports, validates and restores settings and rules');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ main-process smoke test failed:', e.message);
    process.exit(1);
  });
