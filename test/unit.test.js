'use strict';

/**
 * Unit tests for pieces outside the converter: i18n dictionary parity and the
 * store's atomic persistence. Run with: node test/unit.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildDelayApiPath } = require('../src/main/delay');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

console.log('i18n:');

test('manual latency request carries the configured URL in Clash API order', () => {
  const requestPath = buildDelayApiPath('Hong Kong / 01', 'https://example.com/ping?q=a&x=1');
  const parsed = new URL(requestPath, 'http://127.0.0.1');
  assert.strictEqual(parsed.pathname, '/proxies/Hong%20Kong%20%2F%2001/delay');
  assert.strictEqual(parsed.searchParams.get('url'), 'https://example.com/ping?q=a&x=1');
  assert.strictEqual(parsed.searchParams.get('timeout'), '5000');
  assert.ok(parsed.search.startsWith('?url='));
});

// i18n.js is a browser IIFE; evaluate it with a stub window to get the DICT.
function loadDict() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf-8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.i18n.DICT;
}

test('zh and en dictionaries declare exactly the same keys', () => {
  const DICT = loadDict();
  const zh = Object.keys(DICT.zh).sort();
  const en = Object.keys(DICT.en).sort();
  const missingInEn = zh.filter((k) => !en.includes(k));
  const missingInZh = en.filter((k) => !zh.includes(k));
  assert.deepStrictEqual(missingInEn, [], 'keys missing in en');
  assert.deepStrictEqual(missingInZh, [], 'keys missing in zh');
});

test('every data-i18n key used in index.html exists in the dictionary', () => {
  const DICT = loadDict();
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  const used = [...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map((m) => m[1]);
  const missing = used.filter((k) => !(k in DICT.zh));
  assert.deepStrictEqual([...new Set(missing)], [], 'HTML references undefined i18n keys');
});

test('toolbox renderer references only declared i18n keys', () => {
  const DICT = loadDict();
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'toolbox.js'), 'utf-8');
  const literalKeys = [...code.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]).filter((key) => !key.endsWith('.'));
  const dynamicKeys = [
    'toolbox.confidence.exact', 'toolbox.confidence.estimated',
    'toolbox.diag.coreInstalled', 'toolbox.diag.coreRunning', 'toolbox.diag.mixedPort',
    'toolbox.diag.apiPort', 'toolbox.diag.clashApi', 'toolbox.diag.systemProxy',
    'toolbox.diag.tun', 'toolbox.diag.dns', 'toolbox.diag.directIp',
    'toolbox.diag.proxyIp', 'toolbox.diag.egressCompare',
    'toolbox.dns.system', 'toolbox.dns.local', 'toolbox.dns.remote',
    'toolbox.dnsAssessment.no-anomaly', 'toolbox.dnsAssessment.suspicious-private',
    'toolbox.dnsAssessment.divergent', 'toolbox.dnsAssessment.inconclusive',
    'toolbox.portRole.mixed', 'toolbox.portRole.clash-api', 'toolbox.portRole.custom',
    'toolbox.routeSource.live', 'toolbox.routeSource.generated',
    'toolbox.status.pass', 'toolbox.status.warn', 'toolbox.status.fail',
    'toolbox.status.skip', 'toolbox.status.missing',
    'toolbox.via.system', 'toolbox.via.direct', 'toolbox.via.proxy',
  ];
  const missing = [...new Set([...literalKeys, ...dynamicKeys])].filter((key) => !(key in DICT.zh));
  assert.deepStrictEqual(missing, [], 'toolbox references undefined i18n keys');
});

test('zh labels keep config terminology', () => {
  const { zh } = loadDict();
  assert.strictEqual(zh['subs.title'], '📡 配置');
  assert.strictEqual(zh['subs.add'], '添加配置');
  assert.strictEqual(zh['subs.listTitle'], '配置列表');
  assert.strictEqual(zh['rulegroups.section'], '策略组');
  assert.strictEqual(zh['customrs.title'], '远程规则');
  assert.strictEqual(zh['settings.manageGeo'], '管理');
  assert.strictEqual(zh['customrs.targetProxy'], '代理');
  assert.strictEqual(zh['customrs.targetReject'], '拒绝');
});

test('static HTML fallbacks keep config terminology', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  for (const stale of ['机场订阅', '添加订阅', '订阅列表', '走代理', '拦截', '路由用的', '规则集链接', '自定义规则集']) {
    assert.ok(!html.includes(stale), `stale fallback text: ${stale}`);
  }
  for (const stale of ['静默启动（', '桌面通知（', '硬件加速（', '启用 IPv6（']) {
    assert.ok(!html.includes(stale), `settings fallback still has parenthetical hint: ${stale}`);
  }
});

test('rule-set page is folded into rules and geodata settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  assert.ok(!html.includes('data-tab="ruleset"'), 'standalone rule-set nav is still present');
  assert.ok(!html.includes('id="tab-ruleset"'), 'standalone rule-set tab is still present');
  assert.ok(!html.includes('id="crsFormat"'), 'remote rules should auto-detect format when adding');
  assert.ok(!html.includes('id="crsEditFormat"'), 'remote rules should auto-detect format when editing');
  assert.ok(!html.includes('QuantumultX'), 'unsupported remote rule format option is still present');
  assert.ok(!html.includes('Surge'), 'unsupported remote rule format option is still present');
  assert.ok(!html.includes('Loon'), 'unsupported remote rule format option is still present');
  assert.ok(html.indexOf('id="crsList"') > html.indexOf('id="lrList"'), 'remote rules should follow local rules');
  assert.ok(html.indexOf('id="crsList"') < html.indexOf('id="ruleGroupList"'), 'remote rules should be above policy groups');
  assert.ok(html.includes('id="geoModal"'), 'GeoData management modal is missing');
});

console.log('\nRenderer modules:');

// The renderer is split into classic scripts sharing the window.App namespace
// (no bundler), so nothing catches a missing file or a typoed App.* member
// until runtime. These checks stand in for that missing link step.

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const indexHtml = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf-8');
const scriptSrcs = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

test('every <script src> in index.html points to an existing file', () => {
  assert.ok(scriptSrcs.length > 0, 'no script tags found');
  for (const src of scriptSrcs) {
    assert.ok(fs.existsSync(path.join(rendererDir, src)), `missing script: ${src}`);
  }
});

test('module load order: util.js first of the js/ modules, main.js last', () => {
  const mods = scriptSrcs.filter((s) => s.startsWith('js/'));
  assert.strictEqual(mods[0], 'js/util.js');
  assert.strictEqual(mods[mods.length - 1], 'js/main.js');
});

test('frameless window exposes Mica-safe custom desktop controls', () => {
  const windowMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf-8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const controls = fs.readFileSync(path.join(rendererDir, 'js', 'window.js'), 'utf-8');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(windowMain.includes('frame: false'));
  assert.ok(windowMain.includes("titleBarStyle: 'hidden'"));
  assert.ok(windowMain.includes("backgroundMaterial: 'mica'"));
  assert.ok(windowMain.includes("return '#00000000'"));
  assert.ok(windowMain.includes("setBackgroundMaterial('mica')"));
  assert.ok(windowMain.includes('spellcheck: false'));
  for (const id of ['windowMinimize', 'windowMaximize', 'windowClose']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `missing custom control: ${id}`);
  }
  for (const method of ['minimizeWindow', 'toggleMaximizeWindow', 'isWindowMaximized', 'closeWindow']) {
    assert.ok(preload.includes(`${method}:`), `missing window API: ${method}`);
    assert.ok(controls.includes(`api.${method}`), `custom controls do not call ${method}`);
  }
  assert.ok(css.includes('-webkit-app-region: drag'));
  assert.ok(css.includes('-webkit-app-region: no-drag'));
  assert.ok(css.includes('background-color: transparent !important'));
  assert.ok(css.includes('"Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif'));
  assert.ok(css.includes('-webkit-user-drag: none'));
  assert.ok(css.includes('*::-webkit-scrollbar'));
  assert.ok(css.includes('--motion-standard: 200ms cubic-bezier(0.4, 0, 0.2, 1)'));
});

test('all six diagnostic tools have a launcher, modal and preload method', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const tools = [
    ['route', 'inspectRoute'],
    ['diag', 'runNetworkDiagnostics'],
    ['configCheck', 'checkAllConfigs'],
    ['port', 'inspectPorts'],
    ['backup', 'exportBackup'],
    ['dns', 'compareDns'],
  ];
  for (const [id, method] of tools) {
    assert.ok(indexHtml.includes(`id="${id}Open"`), `missing ${id} launcher`);
    assert.ok(indexHtml.includes(`id="${id}Modal"`), `missing ${id} modal`);
    assert.ok(preload.includes(`${method}:`), `missing ${method} preload method`);
  }
});

test('conversion UI exposes both output directions without decorative emoji', () => {
  const { zh, en } = loadDict();
  for (const target of ['auto', 'sing-box', 'clash']) {
    assert.ok(indexHtml.includes(`data-convert-target="${target}"`), `missing conversion target: ${target}`);
  }
  assert.ok(!/[🚀♻️🔄]/u.test(zh['convert.title']));
  assert.ok(!/[🚀♻️🔄]/u.test(en['convert.title']));
  assert.strictEqual(zh['convert.targetSingbox'], 'Sing-Box');
  assert.strictEqual(en['convert.targetSingbox'], 'Sing-Box');
  const tools = fs.readFileSync(path.join(rendererDir, 'js', 'tools.js'), 'utf-8');
  assert.ok(tools.includes('content: lastConvertOutput'), 'save must import the converted output');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(css.includes('grid-template-columns: repeat(3, minmax(72px, auto))'));
  assert.ok(css.includes('width: auto'));
  assert.ok(css.includes('#convertModal .save-row'));
  assert.ok(css.includes('#convertModal .convert-output'));
});

test('UWP list scrolls independently while its actions stay fixed', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(css.includes('#uwpModal .modal-card'));
  assert.ok(css.includes('height: min(620px, calc(100vh - 56px))'));
  assert.ok(css.includes('.uwp-list'));
  assert.ok(css.includes('flex: 1'));
  assert.ok(css.includes('.uwp-footer'));
});

test('tray uses app-derived stopped and running icon assets', () => {
  const trayCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tray.js'), 'utf-8');
  assert.ok(trayCode.includes("nativeImage.createFromPath"));
  assert.ok(trayCode.includes('state.tray.setImage'));
  assert.ok(!trayCode.includes('TRAY_ICON_DATAURL'));
  for (const name of ['tray-stopped.png', 'tray-running.png']) {
    const png = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assets', name));
    assert.strictEqual(png.slice(1, 4).toString('ascii'), 'PNG');
    assert.strictEqual(png.readUInt32BE(16), 32);
    assert.strictEqual(png.readUInt32BE(20), 32);
  }
  assert.notDeepStrictEqual(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assets', 'tray-stopped.png')),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assets', 'tray-running.png'))
  );
});

// util.js is a browser IIFE; evaluate it with a stub window to reach App.*.
function loadRendererUtil() {
  const src = fs.readFileSync(path.join(rendererDir, 'js', 'util.js'), 'utf-8');
  const sandbox = { window: { i18n: { getLang: () => 'zh' } } };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.App;
}

test('escapeHtml neutralizes every HTML metacharacter', () => {
  const App = loadRendererUtil();
  assert.strictEqual(
    App.escapeHtml(`<img src=x onerror="alert('xss')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;'
  );
  // No raw metacharacter may survive, whatever the input.
  assert.ok(!/[<>"']/.test(App.escapeHtml('<script>"\'</script>')));
});

test('external-input fields stay HTML-escaped in the renderer templates', () => {
  // Tripwire: these values come from outside (airport profiles, the Clash
  // API, the OS) and are interpolated into innerHTML templates. If a refactor
  // drops the escaping, this fails before an XSS ships.
  const mustEscape = [
    ['js/subs.js', 'escapeHtml(sub.name)'],
    ['js/dashboard.js', 'escapeHtml(s.name)'],
    ['js/nodes.js', 'escapeHtml(name)'],
    ['js/conns.js', 'escapeHtml(target)'],
    ['js/conns.js', 'escapeHtml(c.rule'],
    ['js/conns.js', 'escapeHtml(chains)'],
    ['js/rules.js', 'escapeHtml(it.payload)'],
    ['js/rulesets.js', 'escapeHtml(it.name)'],
    ['js/logs.js', 'escapeHtml(rest)'],
    ['js/tools.js', 'escapeHtml(a.name)'],
    ['js/toolbox.js', 'escapeHtml(check.detail'],
    ['js/toolbox.js', 'escapeHtml(lastConfigCheck.source.preview)'],
    ['js/toolbox.js', 'escapeHtml(result.preview)'],
  ];
  for (const [file, needle] of mustEscape) {
    const code = fs.readFileSync(path.join(rendererDir, file), 'utf-8');
    assert.ok(code.includes(needle), `${file} no longer escapes: ${needle}`);
  }
});

test('renderer modules parse and every App.* member used is defined somewhere', () => {
  const assigned = new Set();
  const used = new Set();
  for (const src of scriptSrcs.filter((s) => s.startsWith('js/'))) {
    const code = fs.readFileSync(path.join(rendererDir, src), 'utf-8');
    new vm.Script(code, { filename: src }); // throws on syntax errors
    for (const m of code.matchAll(/\bApp\.([\w$]+)\s*=(?!=)/g)) assigned.add(m[1]);
    for (const m of code.matchAll(/\bApp\.([\w$]+)/g)) used.add(m[1]);
    // Names pulled out via `const { x, y } = App;` count as used too.
    for (const m of code.matchAll(/const\s*\{([^}]+)\}\s*=\s*App\b/g)) {
      for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) used.add(name);
    }
  }
  const undefined_ = [...used].filter((n) => !assigned.has(n));
  assert.deepStrictEqual(undefined_, [], 'App members used but never assigned');
});

test('large live lists use bounded virtual windows', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const conns = fs.readFileSync(path.join(rendererDir, 'js', 'conns.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(rendererDir, 'js', 'rules.js'), 'utf-8');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(nodes.includes('VIRTUAL_NODE_ROW_HEIGHT'));
  assert.ok(nodes.includes('NODE_COLUMNS = 2'), 'node virtualization must remain two-column aware');
  assert.ok(nodes.includes('node-grid-window'));
  assert.ok(conns.includes('VIRTUAL_CONNECTION_ROW_HEIGHT'));
  assert.ok(conns.includes("window.addEventListener('resize'"), 'connection virtualization must follow window resizing');
  assert.ok(conns.includes("list.classList.add('is-empty')"));
  assert.ok(conns.includes("list.classList.remove('is-empty')"));
  assert.ok(rules.includes('VIRTUAL_RULE_ROW_HEIGHT'));
  for (const code of [nodes, conns, rules]) assert.ok(code.includes('virtual-spacer'));
  assert.ok(css.includes('.virtual-spacer'));
  assert.ok(css.includes('.conn-list.is-empty'));
  assert.ok(css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
  const nodeList = css.slice(css.indexOf('.node-list {'), css.indexOf('.conn-list.is-empty'));
  assert.ok(nodeList.includes('border: 0'));
  assert.ok(nodeList.includes('background: transparent'));
  assert.ok(nodeList.includes('padding-right: 8px'), 'node cards need space before the scrollbar');
  assert.ok(nodeList.includes('scrollbar-gutter: stable'));
  assert.ok(nodes.includes("App.currentTab !== 'nodes' || nodeWindowFrame"), 'node virtualization must follow window resizing');
});

test('node, connection and log workspaces fill the available window', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  const workspace = css.slice(css.indexOf('#tab-nodes.active,'), css.indexOf('h1 {'));
  assert.ok(workspace.includes('#tab-conns.active'));
  assert.ok(workspace.includes('#tab-conns > .panel'));
  assert.ok(workspace.includes('height: 100%'));
  assert.ok(workspace.includes('flex: 1'));
  assert.ok(css.includes('#tab-conns .conn-list'));
  assert.ok(css.includes('#tab-logs .log-box'));
  assert.ok(css.includes('max-height: none'));
});

test('page surfaces keep an even outer inset without trailing panel space', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  const content = css.slice(css.indexOf('.content {'), css.indexOf('* {', css.indexOf('.content {')));
  const tab = css.slice(css.indexOf('.tab {'), css.indexOf('.tab.active'));
  assert.ok(content.includes('padding: 26px'));
  assert.ok(tab.includes('width: 100%'));
  assert.ok(css.includes('.tab > .panel:last-child'));
});

test('heavy renderer data is bounded and released outside its active view', () => {
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(rendererDir, 'js', 'rules.js'), 'utf-8');
  const logs = fs.readFileSync(path.join(rendererDir, 'js', 'logs.js'), 'utf-8');
  const tools = fs.readFileSync(path.join(rendererDir, 'js', 'tools.js'), 'utf-8');
  assert.ok(main.includes('App.releaseNodes'));
  assert.ok(main.includes('App.releaseRuleCache'));
  assert.ok(nodes.includes('api.getNodes()'));
  assert.ok(rules.includes('ruleItems = []'));
  assert.ok(logs.includes('LOG_LIMIT = 120000'));
  assert.ok(tools.includes("$('#convertInput').value = ''"));
});

test('node strategies keep profile order and expose a stable sidebar readout', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(indexHtml.includes('id="miniCurrentNode"'));
  assert.ok(nodes.includes("{ name: AUTO_GROUP }, { name: FALLBACK_GROUP }, ...nodes"));
  assert.ok(!nodes.includes('const pinned = []'));
  assert.ok(css.includes('.mini-current-node'));
  assert.ok(css.includes('--node-offset'));
});

test('dashboard status cards expose current node latency and click actions', () => {
  const dash = fs.readFileSync(path.join(rendererDir, 'js', 'dashboard.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(indexHtml.includes('id="dashNode"'));
  assert.ok(indexHtml.includes('id="dashDelay"'));
  assert.ok(indexHtml.includes('data-dash-action="power"'));
  assert.ok(indexHtml.includes('data-dash-action="proxy"'));
  assert.ok(indexHtml.includes('data-dash-action="nodes"'));
  assert.ok(indexHtml.includes('data-dash-action="testDelay"'));
  assert.ok(dash.includes('renderDashNodeCards'));
  assert.ok(dash.includes("nodeEl.className = 'card-value'"));
  assert.ok(!css.includes('.card-value-sm'));
  assert.ok(dash.includes("action === 'testDelay'"));
  assert.ok(main.includes('App.showTab = showTab'));
});

test('dashboard traffic chart is compact and tracks session totals with switch toggles', () => {
  const charts = fs.readFileSync(path.join(rendererDir, 'js', 'charts.js'), 'utf-8');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(indexHtml.includes('id="trafficUpTotal"'));
  assert.ok(indexHtml.includes('id="trafficDownTotal"'));
  assert.ok(indexHtml.includes('role="switch"'));
  assert.ok(indexHtml.includes('id="quickProxy"'));
  assert.ok(indexHtml.includes('id="quickTun"'));
  assert.ok(!indexHtml.includes('id="quickRestart"'));
  assert.ok(!indexHtml.includes('id="quickPanel"'));
  assert.ok(indexHtml.includes('id="coreRestartBtn"'));
  assert.ok(indexHtml.includes('id="openPanelBtn"'));
  assert.ok(indexHtml.includes('data-i18n="tools.panelHint"'));
  assert.ok(!indexHtml.includes('settings.clashApiHint'));
  assert.ok(charts.includes('upTotalEl'));
  assert.ok(charts.includes('sessionUp'));
  assert.ok(css.includes('height: 120px'));
  assert.ok(css.includes('.switch-track'));
  assert.ok(css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
});

test('dynamic first-paint regions reserve dimensions to limit layout shift', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(css.includes('min-width: 260px'));
  assert.ok(css.includes('#coreHint'));
  assert.ok(css.includes('#usageList'));
  assert.ok(css.includes('.card-value'));
  assert.ok(css.includes('min-height: 28px'));
});

test('light theme uses quiet system surfaces and independently framed dashboard cards', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  assert.ok(css.includes('--bg: transparent'));
  assert.ok(css.includes('--sidebar: transparent'));
  assert.ok(css.includes('--surface: rgba(255, 255, 255, 0.62)'));
  assert.ok(css.includes('--surface-filter: blur(16px) saturate(1.12)'));
  assert.ok(css.includes('backdrop-filter: var(--surface-filter)'));
  assert.ok(css.includes('--text-faint: #6e6e6e'));
  assert.ok(css.includes('--panel-shadow:'));
  assert.ok(css.includes('.rule-proxy.geodata-status'));
});

test('language changes refresh enhanced select labels immediately', () => {
  const select = fs.readFileSync(path.join(rendererDir, 'js', 'select.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  const languageFlow = main.slice(
    main.indexOf('function setLanguage(lang)'),
    main.indexOf('// ---------- Tab switching ----------')
  );
  assert.ok(select.includes('function refreshSelects('));
  assert.ok(select.includes('selectSync.get(sel)'));
  assert.ok(languageFlow.includes('App.state.settings.language = lang'));
  assert.ok(languageFlow.indexOf('App.state.settings.language = lang') < languageFlow.indexOf('App.renderSettings()'));
  assert.ok(languageFlow.indexOf('App.renderSettings()') < languageFlow.indexOf('App.refreshSelects()'));
  const selectElement = { value: 'zh' };
  let mirroredLanguage = null;
  const noop = () => {};
  const sandbox = {
    App: {
      state: { settings: { language: 'zh' }, status: {} },
      currentTab: 'dashboard',
      renderStatus: noop,
      renderSubs: noop,
      renderNodes: noop,
      renderSettings: noop,
      renderMode: noop,
      renderUsage: noop,
      renderCoreStatus: noop,
      refreshSelects: () => { mirroredLanguage = selectElement.value; },
    },
    setLang: noop,
    applyI18n: noop,
    syncTopbarTitle: noop,
    $: (selector) => (selector === '#setLanguage' ? selectElement : null),
  };
  vm.runInNewContext(`${languageFlow}\nsetLanguage('en');`, sandbox);
  assert.strictEqual(sandbox.App.state.settings.language, 'en');
  assert.strictEqual(mirroredLanguage, 'en');
  assert.ok(main.includes('{ ...previous, ...status }'), 'compact status events must preserve core version fields');
  assert.ok(css.includes('.btn.primary:hover:not(:disabled)'));
  assert.ok(css.includes('background: var(--accent-hover)'), 'primary hover must retain a contrast-safe blue background');
});

test('secondary popups keep card styling without exposing background text', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  const dropdown = css.slice(css.indexOf('.ui-select-menu {'), css.indexOf('.ui-select-opt {'));
  const modal = css.slice(css.indexOf('.modal-card {'), css.indexOf('.modal-lg {'));
  assert.ok(css.includes('--dialog-surface: rgba(250, 251, 252, 0.96)'));
  for (const rule of [dropdown, modal]) {
    assert.ok(rule.includes('background: var(--dialog-surface)'));
    assert.ok(rule.includes('box-shadow: var(--panel-shadow)'));
    assert.ok(rule.includes('backdrop-filter: var(--raised-filter)'));
    assert.ok(!rule.includes('linear-gradient'));
  }
});

test('main surfaces keep their existing subtle highlight', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf-8');
  const panel = css.slice(css.indexOf('.panel {'), css.indexOf('.panel > h2'));
  const card = css.slice(css.indexOf('.card {'), css.indexOf('button.card {'));
  const toast = css.slice(css.indexOf('.toast {'), css.indexOf('.toast.err'));
  assert.ok(css.includes('--surface-highlight: rgba(255, 255, 255, 0.42)'));
  for (const rule of [panel, card, toast]) {
    assert.ok(rule.includes('background-image: linear-gradient'));
  }
});

console.log('\nGitHub release helper:');

const github = require('../src/main/github');

test('compareTags orders semver, v-prefixed and date tags', () => {
  assert.ok(github.compareTags('1.12.4', '1.9.9') > 0);
  assert.ok(github.compareTags('v0.6.1', '0.6.0') > 0);
  assert.strictEqual(github.compareTags('1.2.3', 'v1.2.3'), 0);
  assert.ok(github.compareTags('20250606', '20240101') > 0);
  assert.ok(github.compareTags('1.10', '1.9.9') > 0); // numeric, not lexicographic
});

test('pickLatestTag skips prereleases and picks the newest stable', () => {
  assert.strictEqual(github.pickLatestTag(['1.12.0-beta.1', '1.11.4', 'v1.11.5-alpha', '1.11.3']), '1.11.4');
  assert.strictEqual(github.pickLatestTag(['v0.5.5', 'v0.6.0', 'v0.2.8-pre']), 'v0.6.0');
  assert.strictEqual(github.pickLatestTag([]), null);
  assert.strictEqual(github.pickLatestTag(['1.0.0-rc.1']), null); // nothing stable
});

console.log('\nUWP AppContainer:');

const uwp = require('../src/main/uwp');

test('familyNameToSid matches the documented Windows derivation', () => {
  // Microsoft's loopback-exemption docs publish this SID for the legacy Edge
  // AppContainer — a known-good vector for the SHA-256(UTF-16LE) derivation.
  assert.strictEqual(
    uwp.familyNameToSid('Microsoft.MicrosoftEdge_8wekyb3d8bbwe'),
    'S-1-15-2-3624051433-2125758914-1423191267-1740899205-1073925389-3782572162-737981194'
  );
  // Case-insensitive: Windows lowercases the family name before hashing.
  assert.strictEqual(
    uwp.familyNameToSid('MICROSOFT.MICROSOFTEDGE_8wekyb3d8bbwe'),
    uwp.familyNameToSid('microsoft.microsoftedge_8wekyb3d8bbwe')
  );
});

test('prettyName resolves unreadable display names from the package', () => {
  // A real, resolved display name is kept as-is.
  assert.strictEqual(uwp.prettyName({ displayName: 'Microsoft Edge' }), 'Microsoft Edge');
  // Unresolved references (ms-resource:, @{...}, empty) fall back to the
  // package name's leading segment.
  const pkg = { packageFullName: 'Microsoft.AsyncTextService_8wekyb3d8bbwe' };
  assert.strictEqual(uwp.prettyName({ displayName: 'ms-resource:AppDisplayName', ...pkg }), 'Microsoft.AsyncTextService');
  assert.strictEqual(uwp.prettyName({ displayName: '@{Microsoft.X?ms-resource://...}', ...pkg }), 'Microsoft.AsyncTextService');
  assert.strictEqual(uwp.prettyName({ displayName: '', moniker: 'microsoft.paint_8wekyb3d8bbwe' }), 'microsoft.paint');
  // Nothing usable: the SID is the last resort, never an ugly token.
  assert.strictEqual(uwp.prettyName({ displayName: 'ms-resource:x', sid: 'S-1-15-2-9' }), 'S-1-15-2-9');
  // Raw-GUID names are normalized to canonical {UPPERCASE} braces, whatever
  // the input casing or brace state.
  assert.strictEqual(
    uwp.prettyName({ displayName: '1527c705-839a-4832-9118-54d4Bd6a0c89' }),
    '{1527C705-839A-4832-9118-54D4BD6A0C89}'
  );
  assert.strictEqual(
    uwp.prettyName({ displayName: 'E2A4F912-2574-4A75-9BB0-0D023378592B' }),
    '{E2A4F912-2574-4A75-9BB0-0D023378592B}'
  );
});

console.log('\nToolbox:');

const toolbox = require('../src/main/toolbox');

test('route targets normalize URLs, domains and IP literals', () => {
  assert.deepStrictEqual(
    toolbox.normalizeTarget('https://Example.COM:8443/path?q=1'),
    { input: 'https://Example.COM:8443/path?q=1', host: 'example.com', port: 8443, ipVersion: 0 }
  );
  assert.strictEqual(toolbox.normalizeTarget('1.1.1.1').ipVersion, 4);
  assert.strictEqual(toolbox.normalizeTarget('[2001:db8::1]').ipVersion, 6);
  assert.throws(() => toolbox.normalizeTarget('bad host'), /invalid/);
});

test('CIDR and common Clash/sing-box route rules match correctly', () => {
  assert.strictEqual(toolbox.cidrContains('10.20.30.40', '10.0.0.0/8'), true);
  assert.strictEqual(toolbox.cidrContains('11.20.30.40', '10.0.0.0/8'), false);
  assert.strictEqual(toolbox.cidrContains('2001:db8::7', '2001:db8::/32'), true);
  const target = toolbox.normalizeTarget('https://api.example.com:443');
  assert.strictEqual(toolbox.matchClashRule('DOMAIN-SUFFIX,example.com,Proxy', target, []), true);
  assert.strictEqual(toolbox.matchClashRule('DST-PORT,80,Proxy', target, []), false);
  assert.strictEqual(toolbox.matchClashRule('RULE-SET,private,Proxy', target, []), null);
  assert.strictEqual(toolbox.matchSingboxRule({ domain_suffix: ['example.com'], port: [443] }, target, [], 'rule'), true);
});

test('port input is deduplicated and bounded', () => {
  assert.deepStrictEqual(toolbox.parsePorts('7890, 9090 7890'), [7890, 9090]);
  assert.throws(() => toolbox.parsePorts('0, 70000'), /valid ports/);
  assert.throws(() => toolbox.parsePorts(Array.from({ length: 21 }, (_, index) => index + 1)), /valid ports/);
});

test('DNS wire parser reads an A response built from its query', () => {
  const query = toolbox.buildDnsQuery('example.com', 1);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(4, 10);
  Buffer.from([93, 184, 216, 34]).copy(answer, 12);
  const records = toolbox.parseDnsMessage(Buffer.concat([header, query.slice(12), answer]));
  assert.deepStrictEqual(records, [{ type: 'A', value: '93.184.216.34', ttl: 60 }]);
});

test('DNS endpoints accept bare IPv4 and IPv6 resolver addresses', () => {
  assert.deepStrictEqual(
    { ...toolbox.dnsEndpoint('8.8.8.8'), url: null },
    { raw: '8.8.8.8', scheme: 'udp', host: '8.8.8.8', port: 53, url: null }
  );
  const ipv6 = toolbox.dnsEndpoint('2001:4860:4860::8888');
  assert.strictEqual(ipv6.scheme, 'udp');
  assert.strictEqual(ipv6.host, '2001:4860:4860::8888');
  assert.strictEqual(ipv6.port, 53);
});

test('DNS comparison assessment flags suspicious and divergent answers', () => {
  const suspicious = toolbox.assessDnsResults([
    { id: 'system', status: 'pass', answers: ['127.0.0.1'] },
    { id: 'remote', status: 'pass', answers: ['93.184.216.34'] },
  ]);
  assert.strictEqual(suspicious.result, 'suspicious-private');
  const divergent = toolbox.assessDnsResults([
    { id: 'system', status: 'pass', answers: ['1.1.1.1'] },
    { id: 'remote', status: 'pass', answers: ['8.8.8.8'] },
  ]);
  assert.strictEqual(divergent.result, 'divergent');
  assert.strictEqual(toolbox.assessDnsResults([
    { id: 'system', status: 'pass', answers: ['1.1.1.1'] },
    { id: 'remote', status: 'pass', answers: ['1.1.1.1', '8.8.8.8'] },
  ]).result, 'no-anomaly');
});

test('config validation errors expose common line, column and object paths', () => {
  assert.deepStrictEqual(
    toolbox.extractErrorLocation('yaml: line 42 column 7: invalid value'),
    { line: 42, column: 7, path: null }
  );
  assert.strictEqual(
    toolbox.extractErrorLocation('parse config error: rules[4050] [GEOIP,CN,DIRECT]').path,
    'rules[4050]'
  );
  assert.strictEqual(
    toolbox.extractErrorLocation('decode config: route.rules[3].outbound: unknown outbound').path,
    'route.rules[3].outbound'
  );
});

test('backup validation preserves supported data and rejects duplicate config ids', () => {
  const store = {
    getSettings: () => ({ coreType: 'mihomo', mixedPort: 7890 }),
    getSubscriptions: () => [{ id: 'profile-a', name: 'A', nodes: [{ name: 'node-a' }] }],
    get: (key) => ({ activeSub: 'profile-a', selected: 'node-a', customRuleSets: [{ id: 'rule-a' }], localRules: [] }[key]),
  };
  const document = toolbox.buildBackup(store, '0.8.0');
  const normalized = toolbox.validateBackupDocument(document);
  assert.strictEqual(normalized.activeSub, 'profile-a');
  assert.strictEqual(toolbox.backupSummary(document, normalized).nodes, 1);
  document.data.subscriptions.push({ id: 'profile-a' });
  assert.throws(() => toolbox.validateBackupDocument(document), /duplicate config id/);
});

console.log('\nVersioning:');

test('package.json and package-lock.json agree on the version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf-8'));
  assert.strictEqual(lock.version, pkg.version, 'package-lock.json top-level version');
  assert.strictEqual(lock.packages[''].version, pkg.version, 'package-lock.json root package version');
});

console.log('\nStore:');

const { Store } = require('../src/main/store');

test('save() is atomic: tmp file never survives, data round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.set('subscriptions', [{ id: 'a', name: '测试' }]);
  assert.ok(!fs.existsSync(path.join(dir, 'config.json.tmp')), 'tmp file left behind');
  const reloaded = new Store(dir);
  assert.deepStrictEqual(reloaded.get('subscriptions'), [{ id: 'a', name: '测试' }]);
});

test('settings merge defaults with stored values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.updateSettings({ mixedPort: 1234 });
  const s = new Store(dir).getSettings();
  assert.strictEqual(s.mixedPort, 1234);
  assert.strictEqual(s.clashApiPort, 9090); // default still present
});

test('large subscription payloads migrate to independent profile files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const legacy = {
    subscriptions: [{
      id: 'profile-a',
      name: 'Large profile',
      url: 'https://example.com/sub',
      nodes: [{ name: 'n', type: 'trojan', server: 'example.com', port: 443, password: 'p' }],
      clashRules: ['MATCH,PROXY'],
      clashRuleProviders: {},
      raw: 'raw-subscription-content',
    }],
    settings: { mixedPort: 7890 },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf-8');

  const store = new Store(dir);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.strictEqual(persisted.subscriptions[0].nodes, undefined);
  assert.strictEqual(persisted.subscriptions[0].raw, undefined);
  assert.strictEqual(persisted.subscriptions[0].dataFile, 'profile-a.json');
  const profilePath = path.join(dir, 'profiles', 'profile-a.json');
  const profileBefore = fs.readFileSync(profilePath, 'utf-8');

  store.updateSettings({ logLevel: 'debug' });
  assert.strictEqual(fs.readFileSync(profilePath, 'utf-8'), profileBefore, 'settings writes do not rewrite profile payloads');
  assert.deepStrictEqual(new Store(dir).get('subscriptions'), legacy.subscriptions);
});

test('profile payloads load on demand with a bounded cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  for (let i = 0; i < 5; i++) {
    store.upsertSubscription({
      id: 'profile-' + i,
      name: 'Profile ' + i,
      nodes: [{ name: 'node-' + i }],
      raw: 'x'.repeat(1024),
    });
  }
  const reloaded = new Store(dir);
  const summaries = reloaded.listSubscriptions();
  assert.strictEqual(reloaded._profileCache.size, 0, 'startup should not hydrate profile payloads');
  assert.ok(summaries.every((sub) => !('nodes' in sub) && sub.nodeCount === 1));
  for (const sub of summaries) reloaded.getSubscription(sub.id);
  assert.ok(reloaded._profileCache.size <= 2, 'profile LRU cache grew without a bound');
});

console.log('\nCore layout:');

test('Windows TUN lifecycle owns Dart names and removes legacy adapters', () => {
  const tun = require('../src/main/tun-adapter');
  assert.strictEqual(tun.TUN_DEVICE_NAME, 'Dart');
  assert.strictEqual(tun.TUN_DISPLAY_NAME, 'Dart Tunnel');
  const cleanup = tun.cleanupScript();
  for (const name of ['tun0', 'Meta', 'Dart', 'Dart Tunnel']) assert.ok(cleanup.includes(`'${name}'`));
  assert.ok(cleanup.includes("$connection -eq 'tun0'"));
  assert.ok(cleanup.includes("$description -match 'sing-tun'"));
  assert.ok(cleanup.includes('pnputil.exe'));
  assert.ok(tun.renameScript().includes("Rename-NetAdapter"));
});

test('system DNS diagnostics use the OS resolver path', () => {
  const toolbox = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'toolbox.js'), 'utf-8');
  const start = toolbox.indexOf('async function querySystemDns');
  const end = toolbox.indexOf('function assessDnsResults', start);
  const implementation = toolbox.slice(start, end);
  assert.ok(implementation.includes('dns.promises.lookup'));
  assert.ok(!implementation.includes('dns.promises.resolve4'));
  assert.ok(!implementation.includes('dns.promises.resolve6'));
});

test('selected cores use independent runtime folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const { SingBoxManager } = require('../src/main/singbox');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const fakeDat = Buffer.alloc(2048);
  for (let i = 0; i < fakeDat.length; i++) fakeDat[i] = (i * 31) & 0xff;
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'sing-box' + ext), 'legacy-singbox');
  fs.writeFileSync(path.join(dir, 'bin', 'mihomo' + ext), 'legacy-mihomo');
  fs.writeFileSync(path.join(dir, 'geoip.dat'), fakeDat);
  const mgr = new SingBoxManager({ runtimeDir: dir });

  assert.strictEqual(mgr.coreDir('sing-box'), path.join(dir, 'singbox'));
  assert.strictEqual(mgr.coreDir('mihomo'), path.join(dir, 'mihomo'));
  assert.ok(fs.existsSync(path.join(dir, 'singbox', 'sing-box' + ext)), 'sing-box was not migrated');
  assert.ok(fs.existsSync(path.join(dir, 'mihomo', 'mihomo' + ext)), 'mihomo was not migrated');
  assert.ok(fs.existsSync(path.join(dir, 'mihomo', 'geoip.dat')), 'mihomo GeoData was not migrated');
  assert.strictEqual(mgr.resolveBinaryPath(), path.join(dir, 'singbox', 'sing-box' + ext));
  assert.strictEqual(mgr.resolveBinaryPath('mihomo'), path.join(dir, 'mihomo', 'mihomo' + ext));
  assert.strictEqual(mgr.configPath, path.join(dir, 'singbox', 'config.json'));

  mgr.setCoreType('mihomo');
  assert.strictEqual(mgr.resolveBinaryPath(), path.join(dir, 'mihomo', 'mihomo' + ext));
  assert.strictEqual(mgr.configPath, path.join(dir, 'mihomo', 'config.yaml'));
  assert.ok(mgr._coreEnv().SAFE_PATHS.split(path.delimiter).includes(path.join(dir, 'ui')));
});

test('sing-box geodata self-heals invalid writable rule-sets from bundled files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-resources-'));
  const bundled = path.join(resources, 'singbox');
  const writable = path.join(dir, 'singbox');
  const srs = Buffer.concat([Buffer.from('SRS'), Buffer.alloc(16, 1)]);
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(writable, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'geoip-cn.srs'), srs);
  fs.writeFileSync(path.join(bundled, 'geosite-cn.srs'), srs);
  fs.writeFileSync(path.join(writable, 'geoip-cn.srs'), Buffer.from('<html>blocked</html>'));
  fs.writeFileSync(path.join(writable, 'geosite-cn.srs'), Buffer.alloc(1));

  const { SingBoxManager } = require('../src/main/singbox');
  const mgr = new SingBoxManager({ runtimeDir: dir, resourcesDir: resources });

  assert.strictEqual(mgr.ensureSingBoxGeoData(), true);
  assert.strictEqual(mgr.resolveRuleSetDir(), writable);
  assert.ok(mgr._validSrs(path.join(writable, 'geoip-cn.srs')), 'geoip-cn.srs was not restored');
  assert.ok(mgr._validSrs(path.join(writable, 'geosite-cn.srs')), 'geosite-cn.srs was not restored');
});

test('mihomo geodata validation cache survives restarts and follows core changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const { SingBoxManager } = require('../src/main/singbox');
  const mgr = new SingBoxManager({ runtimeDir: dir, coreType: 'mihomo' });
  const coreDir = mgr.ensureCoreDir('mihomo');
  const bin = path.join(coreDir, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  fs.writeFileSync(bin, 'fake-core');
  const geo = Buffer.alloc(4096);
  for (let i = 0; i < geo.length; i++) geo[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(path.join(coreDir, 'geoip.dat'), geo);
  fs.writeFileSync(path.join(coreDir, 'geosite.dat'), geo);
  const mmdb = Buffer.from(geo);
  Buffer.from('MaxMind.com').copy(mmdb, mmdb.length - 32);
  fs.writeFileSync(path.join(coreDir, 'country.mmdb'), mmdb);

  const key = mgr._mihomoGeoDataKey(coreDir, bin);
  fs.writeFileSync(
    path.join(coreDir, '.mihomo-geodata-validation.json'),
    JSON.stringify({ key, ok: true }),
    'utf-8'
  );
  assert.strictEqual(mgr.mihomoGeoDataReady(), true, 'cached validation avoids spawning the fake core');
  fs.appendFileSync(bin, '-updated');
  assert.notStrictEqual(mgr._mihomoGeoDataKey(coreDir, bin), key, 'a core update invalidates the cache key');
});

console.log(`\nDone, ${passed} tests passed.`);
