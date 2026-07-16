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

test('native dialog renderers reference only declared i18n keys', () => {
  const DICT = loadDict();
  const dialogDir = path.join(__dirname, '..', 'src', 'renderer', 'dialog');
  const code = ['editors.js', 'system.js', 'toolbox.js']
    .map((file) => fs.readFileSync(path.join(dialogDir, file), 'utf-8'))
    .join('\n');
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

test('rule-set page is folded into rules and native geodata management', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  const dialogs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'dialog', 'system.js'), 'utf-8');
  assert.ok(!html.includes('data-tab="ruleset"'), 'standalone rule-set nav is still present');
  assert.ok(!html.includes('id="tab-ruleset"'), 'standalone rule-set tab is still present');
  assert.ok(!html.includes('id="crsFormat"'), 'remote rules should auto-detect format when adding');
  assert.ok(!html.includes('id="crsEditFormat"'), 'remote rules should auto-detect format when editing');
  assert.ok(!html.includes('QuantumultX'), 'unsupported remote rule format option is still present');
  assert.ok(!html.includes('Surge'), 'unsupported remote rule format option is still present');
  assert.ok(!html.includes('Loon'), 'unsupported remote rule format option is still present');
  assert.ok(html.indexOf('id="crsList"') > html.indexOf('id="lrList"'), 'remote rules should follow local rules');
  assert.ok(html.indexOf('id="crsList"') < html.indexOf('id="ruleGroupList"'), 'remote rules should be above policy groups');
  assert.ok(html.includes('id="geoManageBtn"'), 'GeoData management launcher is missing');
  assert.ok(dialogs.includes("Dialog.register('geodata'"), 'native GeoData dialog is missing');
});

console.log('\nRenderer modules:');

// The renderer is split into classic scripts sharing the window.App namespace
// (no bundler), so nothing catches a missing file or a typoed App.* member
// until runtime. These checks stand in for that missing link step.

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const indexHtml = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf-8');
const scriptSrcs = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const dialogHtml = fs.readFileSync(path.join(rendererDir, 'dialog.html'), 'utf-8');
const dialogScriptSrcs = [...dialogHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const SHARED_STYLE_SRCS = [
  'style.css',
  'styles/surfaces.css',
  'styles/controls.css',
  'styles/lists.css',
  'styles/workspaces.css',
  'styles/tools.css',
  'styles/motion.css',
];
function stylesheetRefs(html) {
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
    .map((match) => match[1].split('?')[0]);
}
function readRendererCss() {
  return SHARED_STYLE_SRCS
    .map((src) => fs.readFileSync(path.join(rendererDir, src), 'utf-8'))
    .join('\n');
}
const mainEntry = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
const dialogEntry = fs.readFileSync(path.join(rendererDir, 'dialog', 'main.js'), 'utf-8');
function dynamicScriptRefs(code) {
  return [...code.matchAll(/['"]((?:js|dialog)\/[a-z0-9-]+\.js)['"]/gi)].map((match) => match[1]);
}
const dynamicScriptSrcs = [...dynamicScriptRefs(mainEntry), ...dynamicScriptRefs(dialogEntry)];
const allRendererScriptSrcs = [...new Set([...scriptSrcs, ...dialogScriptSrcs, ...dynamicScriptSrcs])];

test('every main and dialog script points to an existing file', () => {
  assert.ok(scriptSrcs.length > 0 && dialogScriptSrcs.length > 0, 'no script tags found');
  for (const src of allRendererScriptSrcs) {
    assert.ok(fs.existsSync(path.join(rendererDir, src)), `missing script: ${src}`);
  }
});

test('shared stylesheets exist and preserve their cascade order', () => {
  const mainStyles = stylesheetRefs(indexHtml);
  const dialogStyles = stylesheetRefs(dialogHtml);
  assert.deepStrictEqual(mainStyles, SHARED_STYLE_SRCS);
  assert.deepStrictEqual(dialogStyles.slice(0, SHARED_STYLE_SRCS.length), SHARED_STYLE_SRCS);
  assert.strictEqual(dialogStyles[dialogStyles.length - 1], 'dialog/dialog.css');
  for (const src of [...SHARED_STYLE_SRCS, 'dialog/dialog.css']) {
    assert.ok(fs.existsSync(path.join(rendererDir, src)), `missing stylesheet: ${src}`);
  }
  assert.ok(!readRendererCss().includes('@import'), 'shared CSS should load in parallel without @import');
});

test('shared CSS stays split into reviewable modules', () => {
  const lineCounts = Object.fromEntries(SHARED_STYLE_SRCS.map((src) => {
    const css = fs.readFileSync(path.join(rendererDir, src), 'utf-8');
    return [src, css.split('\n').length];
  }));
  assert.ok(lineCounts['style.css'] <= 1000, 'foundation stylesheet has grown beyond 1000 lines');
  for (const [src, lines] of Object.entries(lineCounts).filter(([src]) => src !== 'style.css')) {
    assert.ok(lines <= 600, `${src} has grown beyond 600 lines`);
  }
});

test('module load order: util.js first of the js/ modules, main.js last', () => {
  const mods = scriptSrcs.filter((s) => s.startsWith('js/'));
  assert.strictEqual(mods[0], 'js/util.js');
  assert.strictEqual(mods[mods.length - 1], 'js/main.js');
});

test('feature renderers and dialog workflows load only when requested', () => {
  const mainFeatures = [
    'js/subs.js', 'js/nodes.js', 'js/rules.js', 'js/rulesets.js', 'js/conns.js',
    'js/logs.js', 'js/settings.js', 'js/tools.js', 'js/toolbox.js',
  ];
  for (const src of mainFeatures) {
    assert.ok(dynamicScriptSrcs.includes(src), `missing lazy main module: ${src}`);
    assert.ok(!scriptSrcs.includes(src), `feature module is still eager: ${src}`);
  }
  for (const src of ['dialog/editors.js', 'dialog/system.js', 'dialog/toolbox.js']) {
    assert.ok(dynamicScriptSrcs.includes(src), `missing lazy dialog module: ${src}`);
    assert.ok(!dialogScriptSrcs.includes(src), `dialog feature module is still eager: ${src}`);
  }
  assert.ok(mainEntry.includes('App.loadScripts(TAB_MODULES[tab])'));
  assert.ok(dialogEntry.includes('await App.loadScript(module)'));
});

test('frameless window exposes Mica-safe custom desktop controls', () => {
  const windowMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf-8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const controls = fs.readFileSync(path.join(rendererDir, 'js', 'window.js'), 'utf-8');
  const css = readRendererCss();
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

test('all secondary workflows are registered in the native dialog host', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'dialog-window.js'), 'utf-8');
  const renderers = ['editors.js', 'system.js', 'toolbox.js']
    .map((file) => fs.readFileSync(path.join(rendererDir, 'dialog', file), 'utf-8'))
    .join('\n');
  const types = [
    'local-rule', 'remote-rule', 'raw-profile', 'convert', 'core', 'geodata', 'uwp',
    'route', 'diagnostics', 'config-check', 'ports', 'backup', 'dns',
  ];
  for (const type of types) {
    assert.ok(renderers.includes(`Dialog.register('${type}'`), `missing renderer for ${type}`);
    const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(new RegExp(`(?:'${escaped}'|${escaped})\\s*:`).test(host), `missing host allowlist entry for ${type}`);
  }
  assert.ok(!indexHtml.includes('class="modal hidden"'));
  assert.ok(dialogHtml.includes('class="native-dialog-window"'));
});

test('all six diagnostic tools launch through the native dialog host', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const dialogTools = fs.readFileSync(path.join(rendererDir, 'dialog', 'toolbox.js'), 'utf-8');
  const tools = [
    ['route', 'route', 'inspectRoute'],
    ['diag', 'diagnostics', 'runNetworkDiagnostics'],
    ['configCheck', 'config-check', 'checkAllConfigs'],
    ['port', 'ports', 'inspectPorts'],
    ['backup', 'backup', 'exportBackup'],
    ['dns', 'dns', 'compareDns'],
  ];
  for (const [id, type, method] of tools) {
    assert.ok(indexHtml.includes(`id="${id}Open"`), `missing ${id} launcher`);
    assert.ok(dialogTools.includes(`Dialog.register('${type}'`), `missing ${type} native dialog`);
    assert.ok(preload.includes(`${method}:`), `missing ${method} preload method`);
  }
  assert.ok(preload.includes('openDialog:'));
  assert.strictEqual((dialogTools.match(/dialog-commandbar/g) || []).length, tools.length);
});

test('conversion UI exposes both output directions without decorative emoji', () => {
  const { zh, en } = loadDict();
  const editorDialogs = fs.readFileSync(path.join(rendererDir, 'dialog', 'editors.js'), 'utf-8');
  for (const target of ['auto', 'sing-box', 'clash']) {
    assert.ok(editorDialogs.includes(`data-convert-target="${target}"`), `missing conversion target: ${target}`);
  }
  assert.ok(!/[🚀♻️🔄]/u.test(zh['convert.title']));
  assert.ok(!/[🚀♻️🔄]/u.test(en['convert.title']));
  assert.strictEqual(zh['convert.targetSingbox'], 'Sing-Box');
  assert.strictEqual(en['convert.targetSingbox'], 'Sing-Box');
  assert.ok(editorDialogs.includes('content: output'), 'save must import the converted output');
  const css = readRendererCss();
  const dialogCss = fs.readFileSync(path.join(rendererDir, 'dialog', 'dialog.css'), 'utf-8');
  assert.ok(css.includes('grid-template-columns: repeat(3, minmax(72px, auto))'));
  assert.ok(css.includes('width: auto'));
  assert.ok(dialogCss.includes('.dialog-convert-input'));
  assert.ok(dialogCss.includes('.dialog-convert-output'));
});

test('UWP list scrolls independently while its actions stay fixed', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'dialog', 'dialog.css'), 'utf-8');
  const systemDialogs = fs.readFileSync(path.join(rendererDir, 'dialog', 'system.js'), 'utf-8');
  assert.ok(systemDialogs.includes("Dialog.register('uwp'"));
  const list = css.slice(css.indexOf('.dialog-uwp-list'), css.indexOf('.dialog-tool-body'));
  assert.ok(list.includes('overflow: auto'));
  assert.ok(list.includes('flex: 1'));
  assert.ok(css.includes('.dialog-footer'));
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
    ['js/subs.js', 'escapeHtml(sub.id)'],
    ['js/dashboard.js', 'escapeHtml(s.name)'],
    ['js/nodes.js', 'escapeHtml(name)'],
    ['js/conns.js', 'escapeHtml(target)'],
    ['js/conns.js', 'escapeHtml(c.rule'],
    ['js/conns.js', 'escapeHtml(chains)'],
    ['js/rules.js', 'escapeHtml(it.payload)'],
    ['js/rules.js', 'escapeHtml(it.id)'],
    ['js/rulesets.js', 'escapeHtml(it.name)'],
    ['js/rulesets.js', 'escapeHtml(it.id)'],
    ['js/logs.js', 'escapeHtml(rest)'],
    ['dialog/system.js', 'escapeHtml(entry.name)'],
    ['dialog/toolbox.js', 'escapeHtml(check.detail'],
    ['dialog/toolbox.js', 'escapeHtml(result.source.preview)'],
    ['dialog/toolbox.js', 'escapeHtml(item.preview)'],
  ];
  for (const [file, needle] of mustEscape) {
    const code = fs.readFileSync(path.join(rendererDir, file), 'utf-8');
    assert.ok(code.includes(needle), `${file} no longer escapes: ${needle}`);
  }
});

test('renderer modules parse and every App.* member used is defined somewhere', () => {
  const assigned = new Set();
  const used = new Set();
  const modules = allRendererScriptSrcs.filter((src) => src.startsWith('js/') || src.startsWith('dialog/'));
  for (const src of modules) {
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
  const css = readRendererCss();
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
  const nodeList = css.slice(css.indexOf('.node-list,'), css.indexOf('.conn-list.is-empty'));
  assert.ok(nodeList.includes('border: 0'));
  assert.ok(nodeList.includes('background: transparent'));
  assert.ok(nodeList.includes('padding-top: 3px'), 'node hover effects need vertical breathing room');
  assert.ok(nodeList.includes('padding-bottom: 3px'), 'node hover effects need vertical breathing room');
  assert.ok(nodeList.includes('padding-right: 8px'), 'node cards need space before the scrollbar');
  assert.ok(nodeList.includes('scrollbar-gutter: stable'));
  assert.ok(nodes.includes("App.currentTab !== 'nodes' || nodeWindowFrame"), 'node virtualization must follow window resizing');
});

test('node, connection and log workspaces use a direct full-height canvas', () => {
  const css = readRendererCss();
  const workspace = css.slice(css.indexOf('.live-workspace.active {'), css.indexOf('h1 {'));
  assert.ok(workspace.includes('height: 100%'));
  assert.ok(workspace.includes('.live-workspace > .workspace-commandbar'));
  const connList = css.slice(css.indexOf('#tab-conns .conn-list'), css.indexOf('.conn-list.is-empty'));
  assert.ok(connList.includes('flex: 1'));
  assert.ok(connList.includes('border: 0'));
  assert.ok(connList.includes('background: transparent'));
  assert.ok(css.includes('#tab-logs .log-box'));
  assert.ok(css.includes('max-height: none'));
  for (const id of ['tab-nodes', 'tab-conns', 'tab-logs']) {
    const start = indexHtml.indexOf(`<section class="tab live-workspace" id="${id}">`);
    assert.ok(start >= 0, `${id} must use the live workspace layout`);
    const section = indexHtml.slice(start, indexHtml.indexOf('</section>', start));
    assert.ok(section.includes('workspace-commandbar'), `${id} must expose a direct command bar`);
    assert.ok(!section.includes('class="panel'), `${id} must not have an outer panel`);
  }
});

test('config, rule and tool pages use unframed canvas sections', () => {
  const css = readRendererCss();
  for (const id of ['tab-subs', 'tab-rules', 'tab-tools']) {
    const start = indexHtml.indexOf(`<section class="tab canvas-page" id="${id}">`);
    assert.ok(start >= 0, `${id} must use the canvas page layout`);
    const section = indexHtml.slice(start, indexHtml.indexOf('</section>', start));
    assert.ok(!section.includes('class="panel'), `${id} must not have an outer panel`);
  }
  assert.ok(indexHtml.includes('class="workspace-section"'));
  assert.ok(indexHtml.includes('class="tool-list"'));
  const sectionStyle = css.slice(css.indexOf('.canvas-page > .workspace-section'), css.indexOf('.cards {'));
  assert.ok(sectionStyle.includes('border-bottom: 1px solid var(--border)'));
  assert.ok(!sectionStyle.includes('background:'));
  assert.ok(!sectionStyle.includes('box-shadow:'));
  const toolStyle = css.slice(css.indexOf('.tool-list {'), css.indexOf('.setting-row {'));
  assert.ok(toolStyle.includes('border-top: 1px solid var(--border)'));
  assert.ok(!toolStyle.includes('box-shadow:'));
});

test('config activation state keeps a stable action width', () => {
  const subs = fs.readFileSync(path.join(rendererDir, 'js', 'subs.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(subs.includes('sub-activate-btn'));
  const activationStyle = css.slice(css.indexOf('.sub-activate-btn {'), css.indexOf('.node-list,'));
  assert.ok(activationStyle.includes('width: 72px'));
});

test('live log surface stays translucent without a redundant blur layer', () => {
  const css = readRendererCss();
  assert.ok(css.includes('--log-surface: rgba(22, 22, 25, 0.68)'));
  assert.ok(css.includes('--log-surface: rgba(255, 255, 255, 0.58)'));
  const logStyle = css.slice(css.indexOf('#tab-logs .log-box'), css.indexOf('.log-time'));
  assert.ok(logStyle.includes('background: var(--log-surface)'));
  assert.ok(!logStyle.includes('backdrop-filter'));
});

test('page surfaces keep an even outer inset without trailing panel space', () => {
  const css = readRendererCss();
  const content = css.slice(css.indexOf('.content {'), css.indexOf('* {', css.indexOf('.content {')));
  const tab = css.slice(css.indexOf('.tab {'), css.indexOf('.tab.active'));
  assert.ok(css.includes('--content-inset: 24px'));
  assert.ok(content.includes('padding: var(--content-inset)'));
  assert.ok(tab.includes('width: 100%'));
  assert.ok(css.includes('.tab > .panel:last-child'));
});

test('heavy renderer data is bounded and released outside its active view', () => {
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(rendererDir, 'js', 'rules.js'), 'utf-8');
  const logs = fs.readFileSync(path.join(rendererDir, 'js', 'logs.js'), 'utf-8');
  const dialogHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'dialog-window.js'), 'utf-8');
  assert.ok(main.includes('App.releaseNodes'));
  assert.ok(main.includes('App.releaseRuleCache'));
  assert.ok(nodes.includes('api.getNodes()'));
  assert.ok(nodes.includes('run.cancelled'));
  assert.ok(rules.includes('ruleItems = []'));
  assert.ok(rules.includes('generation !== ruleLoadGeneration'));
  assert.ok(logs.includes('LOG_LIMIT = 120000'));
  assert.ok(!indexHtml.includes('class="modal hidden"'), 'dialog DOM must not remain resident in the main renderer');
  assert.ok(dialogHost.includes('dialogWindow = null'));
  assert.ok(dialogHost.includes('dialogContext = null'));
  assert.ok(main.includes('TAB_MODULES'));
  assert.ok(!indexHtml.includes('<script src="js/logs.js"></script>'));
});

test('node strategies keep profile order and expose a stable sidebar readout', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(indexHtml.includes('id="miniCurrentNode"'));
  assert.ok(nodes.includes("{ name: AUTO_GROUP }, { name: FALLBACK_GROUP }, ...nodes"));
  assert.ok(!nodes.includes('const pinned = []'));
  assert.ok(css.includes('.mini-current-node'));
  assert.ok(css.includes('--node-offset'));
});

test('dashboard status cards expose current node latency and click actions', () => {
  const dash = fs.readFileSync(path.join(rendererDir, 'js', 'dashboard.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const css = readRendererCss();
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
  const css = readRendererCss();
  assert.ok(indexHtml.includes('id="trafficUpTotal"'));
  assert.ok(indexHtml.includes('id="trafficDownTotal"'));
  assert.ok(indexHtml.includes('role="switch"'));
  assert.ok(indexHtml.includes('id="quickProxy"'));
  assert.ok(indexHtml.includes('id="quickTun"'));
  assert.ok(!indexHtml.includes('id="quickRestart"'));
  assert.ok(!indexHtml.includes('id="quickPanel"'));
  const systemDialogs = fs.readFileSync(path.join(rendererDir, 'dialog', 'system.js'), 'utf-8');
  assert.ok(systemDialogs.includes('id="dialogCoreRestart"'));
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
  const css = readRendererCss();
  assert.ok(css.includes('min-width: 260px'));
  assert.ok(css.includes('#coreHint'));
  assert.ok(css.includes('#usageList'));
  assert.ok(css.includes('.card-value'));
  assert.ok(css.includes('min-height: 28px'));
});

test('light theme uses quiet system surfaces and lightweight dashboard cards', () => {
  const css = readRendererCss();
  assert.ok(css.includes('--bg: transparent'));
  assert.ok(css.includes('--sidebar: transparent'));
  assert.ok(css.includes('--surface: rgba(255, 255, 255, 0.62)'));
  assert.ok(css.includes('--raised-filter: blur(22px) saturate(1.16)'));
  assert.ok(!css.includes('--surface-filter'));
  assert.ok(css.includes('--text-faint: #6e6e6e'));
  assert.ok(css.includes('--panel-shadow:'));
  assert.ok(css.includes('.rule-proxy.geodata-status'));
});

test('language changes refresh enhanced select labels immediately', () => {
  const select = fs.readFileSync(path.join(rendererDir, 'js', 'select.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const css = readRendererCss();
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

test('secondary panels use a real transient native material window', () => {
  const css = readRendererCss();
  const dialogCss = fs.readFileSync(path.join(rendererDir, 'dialog', 'dialog.css'), 'utf-8');
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'dialog-window.js'), 'utf-8');
  const dropdown = css.slice(css.indexOf('.ui-select-menu {'), css.indexOf('.ui-select-opt {'));
  assert.ok(css.includes('--menu-surface: rgba(250, 251, 252, 0.96)'));
  assert.ok(dropdown.includes('background: var(--menu-surface)'));
  assert.ok(css.includes('.ui-select-menu,\n.toast {'));
  assert.ok(css.includes('backdrop-filter: var(--raised-filter)'));
  assert.ok(host.includes('parent,'));
  assert.ok(host.includes('modal: true'));
  assert.ok(host.includes('frame: false'));
  assert.ok(host.includes("backgroundMaterial: 'mica'"));
  assert.ok(host.includes("setBackgroundMaterial('mica')"));
  assert.ok(host.includes('pathToFileURL'));
  assert.ok(host.includes('win.loadURL(DIALOG_URL)'));
  assert.ok(host.includes('PREWARM_TTL_MS = 8_000'));
  assert.ok(host.includes('skipTaskbar: true'));
  assert.ok(dialogCss.includes('background: transparent !important'));
  assert.ok(dialogHtml.includes('<script src="js/select.js"></script>'));
  const windowStyle = dialogCss.slice(dialogCss.indexOf('.native-dialog-window {'), dialogCss.indexOf(':root[data-theme'));
  const actionStart = dialogCss.lastIndexOf('.dialog-commandbar {');
  const actionStyle = dialogCss.slice(actionStart, dialogCss.indexOf('}', actionStart));
  assert.ok(!windowStyle.includes('linear-gradient'));
  assert.ok(actionStyle.includes('justify-content: flex-end'));
  assert.ok(actionStyle.includes('gap: 10px'));
  assert.ok(!dialogCss.includes('body.native-dialog-body > .ui-select-menu'), 'dialogs must reuse the settings dropdown style');
});

test('hidden tray windows release their renderer and recreate on demand', () => {
  const windowMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf-8');
  const trayMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tray.js'), 'utf-8');
  assert.ok(windowMain.includes('DEEP_SLEEP_DELAY_MS = 60_000'));
  assert.ok(windowMain.includes('state.mainWindow = null'));
  assert.ok(windowMain.includes('win.destroy()'));
  assert.ok(windowMain.includes('function showMainWindow()'));
  assert.ok(trayMain.includes("const { showMainWindow } = require('./window')"));
  assert.ok(trayMain.includes("click: showMainWindow"));
});

test('main surfaces avoid diagonal highlights and repeated backdrop filters', () => {
  const css = readRendererCss();
  const surfaces = css.slice(css.indexOf('.panel,\n.card {'), css.indexOf('.tab > .panel:last-child'));
  const card = css.slice(css.indexOf('.card {', css.indexOf('.tab > .panel:last-child')), css.indexOf('button.card {'));
  const toast = css.slice(css.indexOf('.toast {'), css.indexOf('.toast.err'));
  for (const rule of [surfaces, card, toast]) {
    assert.ok(!rule.includes('background-image: linear-gradient'));
  }
  for (const rule of [surfaces, card]) assert.ok(!rule.includes('backdrop-filter'));
  assert.ok(css.includes('.ui-select-menu,\n.toast {'));
});

test('controls and canvas command bars share a stable size rhythm', () => {
  const css = readRendererCss();
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  assert.ok(css.includes('--control-height: 38px'));
  assert.ok(css.includes('--control-height-compact: 32px'));
  assert.ok(css.includes('--commandbar-height: 40px'));
  const controls = css.slice(css.indexOf('.input,'), css.indexOf('.input:hover'));
  const button = css.slice(css.indexOf('.btn {'), css.indexOf('.btn:hover'));
  const nav = css.slice(css.indexOf('.nav-indicator {'), css.indexOf('.nav-item {'));
  assert.ok(controls.includes('min-height: var(--control-height)'));
  assert.ok(button.includes('min-height: var(--control-height)'));
  assert.ok(nav.includes('background: var(--accent)'));
  assert.ok(nav.includes('transform-origin: 50% 50%'));
  assert.ok(indexHtml.includes('id="navIndicator"'));
  assert.ok(main.includes('function syncNavIndicator('));
  assert.ok(main.includes('function moveNavIndicator('));
  assert.ok(main.includes('scaleY(${stretch})'));
  assert.ok(main.includes("easing: 'cubic-bezier(0.65, 0, 0.35, 1)'"));
  assert.ok(main.includes("matchMedia('(prefers-reduced-motion: reduce)')"));
  assert.ok(main.includes('navIndicatorAnimation.effect.setKeyframes(keyframes)'));
  assert.ok(main.includes('navIndicatorAnimation.effect.updateTiming(timing)'));
  assert.ok(main.includes('navIndicatorAnimation.cancel()'));
  assert.ok(!main.includes('translate3d('));
  assert.ok(!nav.includes('translate3d('));
  assert.ok(!/font-weight: (?:550|650|680|720|750);/.test(css));
});

test('node test actions fit inside the fixed virtualized card height', () => {
  const css = readRendererCss();
  const card = css.slice(css.indexOf('.node-item {'), css.indexOf('.node-item:first-child'));
  const action = css.slice(css.indexOf('.node-test-btn {'), css.indexOf('.node-test-btn:hover'));
  assert.ok(card.includes('height: 68px'));
  assert.ok(card.includes('padding: 8px 10px'));
  assert.ok(card.includes('gap: 4px'));
  assert.ok(action.includes('min-height: 26px'));
  assert.ok(action.includes('padding-block: 2px'));
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

test('UWP enumeration is prefetched, deduplicated and explicitly refreshable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'uwp.js'), 'utf-8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const dialog = fs.readFileSync(path.join(rendererDir, 'dialog', 'system.js'), 'utf-8');
  assert.ok(source.includes('APP_CACHE_TTL_MS = 5 * 60_000'));
  assert.ok(source.includes('if (!appEnumeration)'));
  assert.ok(source.includes('return cloneApps(await appEnumeration)'));
  assert.ok(preload.includes('warmUwpApps:'));
  assert.ok(main.includes('api.warmUwpApps()'));
  assert.ok(dialog.includes('api.listUwpApps(force)'));
  assert.ok(dialog.includes("Dialog.bind('#dialogUwpReload', 'click', () => load(true))"));
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
  assert.strictEqual(toolbox.matchClashRule('IP-CIDR,1.1.1.0/24,Proxy', target, []), null);
  assert.strictEqual(toolbox.matchClashRule('RULE-SET,private,Proxy', target, []), null);
  assert.strictEqual(toolbox.matchSingboxRule({ domain_suffix: ['example.com'], port: [443] }, target, [], 'rule'), true);
  assert.strictEqual(toolbox.matchSingboxRule({ ip_cidr: ['1.1.1.0/24'] }, target, [], 'rule'), null);
  assert.strictEqual(toolbox.matchSingboxRule({ ip_is_private: false }, target, [], 'rule'), null);
  assert.strictEqual(toolbox.matchSingboxRule({ protocol: 'dns' }, target, [], 'rule'), null);
  assert.strictEqual(toolbox.matchSingboxRule({
    type: 'logical', mode: 'or', rules: [{ domain_suffix: ['invalid.test'] }, { domain_suffix: ['example.com'] }],
  }, target, [], 'rule'), true);
  assert.strictEqual(toolbox.matchSingboxRule({
    type: 'logical', mode: 'and', rules: [{ domain_suffix: ['example.com'] }, { port: [80] }],
  }, target, [], 'rule'), false);
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
  const response = Buffer.concat([header, query.slice(12), answer]);
  const records = toolbox.parseDnsMessage(response, query.readUInt16BE(0));
  assert.deepStrictEqual(records, [{ type: 'A', value: '93.184.216.34', ttl: 60 }]);
  assert.throws(() => toolbox.parseDnsMessage(response, (query.readUInt16BE(0) + 1) & 0xffff), /id mismatch/);
  const queryPacket = Buffer.from(response);
  queryPacket.writeUInt16BE(0x0100, 2);
  assert.throws(() => toolbox.parseDnsMessage(queryPacket), /not a response/);
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
  const ipv6Doh = toolbox.dnsEndpoint('https://2001:4860:4860::8888/dns-query');
  assert.strictEqual(ipv6Doh.scheme, 'https');
  assert.strictEqual(ipv6Doh.host, '2001:4860:4860::8888');
  assert.strictEqual(ipv6Doh.port, 443);
  assert.strictEqual(ipv6Doh.url.pathname, '/dns-query');
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
  document.data.subscriptions.pop();
  document.data.customRuleSets.push({ id: 'rule-a', target: 'proxy' });
  assert.throws(() => toolbox.validateBackupDocument(document), /duplicate remote rule id/);
  document.data.customRuleSets.pop();
  document.data.localRules.push({ id: 'local-a', matchType: 'made-up', values: [] });
  assert.throws(() => toolbox.validateBackupDocument(document), /local rule type is invalid/);
});

console.log('\nVersioning:');

test('package.json and package-lock.json agree on the version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf-8'));
  assert.strictEqual(lock.version, pkg.version, 'package-lock.json top-level version');
  assert.strictEqual(lock.packages[''].version, pkg.version, 'package-lock.json root package version');
});

test('atomic file replacement rolls back on failure and leaves no backup', () => {
  const { replaceFileSync } = require('../src/main/file-utils');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-atomic-'));
  const dest = path.join(dir, 'target.bin');
  fs.writeFileSync(dest, 'known-good');
  assert.throws(() => replaceFileSync(path.join(dir, 'missing.bin'), dest));
  assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
  assert.deepStrictEqual(fs.readdirSync(dir), ['target.bin']);

  const source = path.join(dir, 'new.bin');
  fs.writeFileSync(source, 'updated');
  replaceFileSync(source, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'updated');
  assert.deepStrictEqual(fs.readdirSync(dir), ['target.bin']);
});

test('grouped file replacement restores every target when a later install fails', () => {
  const { replaceFileBatchSync } = require('../src/main/file-utils');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-atomic-group-'));
  const targetA = path.join(dir, 'a.dat');
  const targetB = path.join(dir, 'b.dat');
  const sourceA = path.join(dir, 'a.new');
  const sourceB = path.join(dir, 'b.new');
  fs.writeFileSync(targetA, 'old-a');
  fs.writeFileSync(targetB, 'old-b');
  fs.writeFileSync(sourceA, 'new-a');
  fs.writeFileSync(sourceB, 'new-b');

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === sourceB) throw new Error('simulated second-file failure');
    if (
      target === targetB &&
      source.startsWith(targetB + '.backup-') &&
      !source.includes('.batch-backup-')
    ) {
      throw new Error('simulated inner rollback failure');
    }
    return renameSync(source, target);
  };
  try {
    assert.throws(
      () => replaceFileBatchSync([
        { source: sourceA, target: targetA },
        { source: sourceB, target: targetB },
      ]),
      /simulated second-file failure/
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(fs.readFileSync(targetA, 'utf-8'), 'old-a');
  assert.strictEqual(fs.readFileSync(targetB, 'utf-8'), 'old-b');
  assert.ok(!fs.readdirSync(dir).some((name) => name.includes('batch-backup')));
});

test('grouped replacement preserves recovery copies when rollback also fails', () => {
  const { replaceFileBatchSync } = require('../src/main/file-utils');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-atomic-recovery-'));
  const targetA = path.join(dir, 'a.dat');
  const targetB = path.join(dir, 'b.dat');
  const sourceA = path.join(dir, 'a.new');
  const sourceB = path.join(dir, 'b.new');
  for (const [file, value] of [[targetA, 'old-a'], [targetB, 'old-b'], [sourceA, 'new-a'], [sourceB, 'new-b']]) {
    fs.writeFileSync(file, value);
  }

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === sourceB) throw new Error('simulated install failure');
    if (target === targetB && source.startsWith(targetB + '.backup-')) throw new Error('simulated inner restore failure');
    if (target === targetB && source.includes('.batch-backup-')) throw new Error('simulated batch restore failure');
    return renameSync(source, target);
  };
  let failure;
  try {
    try {
      replaceFileBatchSync([{ source: sourceA, target: targetA }, { source: sourceB, target: targetB }]);
    } catch (error) {
      failure = error;
    }
  } finally {
    fs.renameSync = renameSync;
  }
  assert.ok(failure && failure.restoreErrors && failure.restoreErrors.length);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('b.dat.batch-backup-')));
});

test('downloaded app updates must be plausible PE installers', () => {
  const { validateInstaller } = require('../src/main/update');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-update-'));
  const installer = path.join(dir, 'Dart.Setup.test.exe');
  const fd = fs.openSync(installer, 'w');
  try {
    const header = Buffer.alloc(64);
    header.write('MZ', 0, 'latin1');
    header.writeUInt32LE(128, 0x3c);
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.writeSync(fd, Buffer.from([0x50, 0x45, 0x00, 0x00]), 0, 4, 128);
    fs.ftruncateSync(fd, 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  assert.strictEqual(validateInstaller(installer, 1024 * 1024), true);
  assert.throws(() => validateInstaller(installer, 1024 * 1024 + 1), /size mismatch/);
  fs.writeFileSync(installer, '<html>blocked</html>');
  assert.throws(() => validateInstaller(installer), /unexpectedly small/);
});

console.log('\nStore:');

const { Store } = require('../src/main/store');

test('store writes are atomic: tmp files never survive and data round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.set('subscriptions', [{ id: 'a', name: '测试' }]);
  assert.ok(!fs.existsSync(path.join(dir, 'config.json.tmp')), 'tmp file left behind');
  const reloaded = new Store(dir);
  assert.deepStrictEqual(reloaded.get('subscriptions'), [{ id: 'a', name: '测试' }]);
});

test('store recovers a corrupt index and never deletes payloads without one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-recovery-'));
  const store = new Store(dir);
  store.upsertSubscription({ id: 'profile-a', name: 'Recover me', nodes: [{ name: 'node-a' }] });
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken primary', 'utf-8');
  const recovered = new Store(dir);
  assert.strictEqual(recovered.getSubscription('profile-a').name, 'Recover me');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')));

  const profileDir = path.join(dir, 'profiles');
  const orphan = path.join(profileDir, 'manual-recovery.json');
  fs.writeFileSync(orphan, JSON.stringify({ nodes: [{ name: 'orphan' }] }), 'utf-8');
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken again', 'utf-8');
  fs.writeFileSync(path.join(dir, 'config.json.bak'), '{broken backup', 'utf-8');
  const empty = new Store(dir);
  assert.deepStrictEqual(empty.listSubscriptions(), []);
  assert.ok(fs.existsSync(orphan), 'unrecoverable index corruption deleted orphaned profile data');
  assert.ok(fs.existsSync(path.join(dir, '.payload-recovery-needed')));
});

test('a valid backup remains usable when the corrupt primary cannot be repaired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-readonly-recovery-'));
  const primary = path.join(dir, 'config.json');
  const backup = primary + '.bak';
  fs.writeFileSync(primary, '{broken primary', 'utf-8');
  fs.writeFileSync(backup, JSON.stringify({ settings: { mixedPort: 4321 }, subscriptions: [] }), 'utf-8');

  const originalWrite = Store.prototype._writeAtomic;
  Store.prototype._writeAtomic = function failPrimaryRepair(file, text) {
    if (file === primary) throw new Error('simulated read-only primary');
    return originalWrite.call(this, file, text);
  };
  try {
    const recovered = new Store(dir);
    assert.strictEqual(recovered.getSettings().mixedPort, 4321);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(backup, 'utf-8')));
  } finally {
    Store.prototype._writeAtomic = originalWrite;
  }
});

test('store fallback mode merges metadata-only updates instead of erasing payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-fallback-'));
  const store = new Store(dir);
  store._profileStorageEnabled = false;
  store._ruleStorageEnabled = false;
  store.data.subscriptions = [{
    id: 'profile-a', name: 'Profile', nodes: [{ name: 'node-a' }], raw: 'source', updatedAt: 1,
  }];
  store.data.customRuleSets = [{
    id: 'rules-a', name: 'Rules', kind: 'inline', rules: [{ domain: ['example.com'] }], updatedAt: 1,
  }];

  store.upsertSubscription({ id: 'profile-a', autoUpdateLastAttemptAt: 2 });
  store.upsertCustomRuleSet({ id: 'rules-a', error: 'temporary failure' });

  const profile = store.getSubscription('profile-a', { includeRaw: true });
  const ruleSet = store.getCustomRuleSet('rules-a');
  assert.strictEqual(profile.nodes[0].name, 'node-a');
  assert.strictEqual(profile.raw, 'source');
  assert.strictEqual(profile.autoUpdateLastAttemptAt, 2);
  assert.strictEqual(ruleSet.rules[0].domain[0], 'example.com');
  assert.strictEqual(ruleSet.error, 'temporary failure');
});

test('legacy duplicate or missing record ids are repaired without dropping records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-ids-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    subscriptions: [
      { id: 'duplicate', name: 'A', nodes: [{ name: 'a' }] },
      { id: 'duplicate', name: 'B', nodes: [{ name: 'b' }] },
      { name: 'C', nodes: [{ name: 'c' }] },
    ],
    customRuleSets: [
      { id: 'duplicate', name: 'R1', kind: 'inline', rules: [{ domain: ['a.example'] }] },
      { id: 'duplicate', name: 'R2', kind: 'inline', rules: [{ domain: ['b.example'] }] },
    ],
  }), 'utf-8');
  const store = new Store(dir);
  const subscriptions = store.listSubscriptions();
  const ruleSets = store.listCustomRuleSets();
  assert.strictEqual(subscriptions.length, 3);
  assert.strictEqual(new Set(subscriptions.map((item) => item.id)).size, 3);
  assert.strictEqual(ruleSets.length, 2);
  assert.strictEqual(new Set(ruleSets.map((item) => item.id)).size, 2);
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

test('repeated payload updates do not retain retired digest entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  for (let index = 0; index < 30; index++) {
    store.upsertSubscription({
      id: 'profile-a', name: 'Profile', nodes: [{ name: `node-${index}` }], raw: `raw-${index}`,
    });
    store.upsertCustomRuleSet({
      id: 'rules-a', name: 'Rules', kind: 'inline',
      rules: [{ domain_suffix: [`d${index}.example`] }],
    });
  }
  assert.strictEqual(store._profileDigests.size, 1);
  assert.strictEqual(store._rawDigests.size, 1);
  assert.strictEqual(store._ruleDigests.size, 1);
});

test('subscription metadata edits do not hydrate or rewrite profile payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({
    id: 'profile-a', name: 'Old name', nodes: [{ name: 'node-a' }], raw: 'raw-a',
  });
  const reloaded = new Store(dir);
  const summary = reloaded.listSubscriptions()[0];
  const profilePath = path.join(dir, 'profiles', reloaded.data.subscriptions[0].dataFile);
  const profileBefore = fs.readFileSync(profilePath, 'utf-8');
  reloaded._readProfileFile = () => { throw new Error('metadata edit hydrated profile'); };
  reloaded.upsertSubscription({ ...summary, name: 'New name', autoUpdateMinutes: 30 });

  assert.strictEqual(fs.readFileSync(profilePath, 'utf-8'), profileBefore);
  const finalStore = new Store(dir);
  assert.strictEqual(finalStore.getSubscription('profile-a').name, 'New name');
  assert.strictEqual(finalStore.getSubscription('profile-a').nodes[0].name, 'node-a');
  assert.strictEqual(finalStore.getSubscription('profile-a', { includeRaw: true }).raw, 'raw-a');
});

test('profile mutations remain all-or-nothing when the config index write fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({
    id: 'profile-a',
    name: 'Old',
    nodes: [{ name: 'old-node' }],
    raw: 'old-raw',
  });
  const originalWrite = store._writeConfigData;
  store._writeConfigData = () => { throw new Error('simulated index failure'); };

  assert.throws(() => store.upsertSubscription({
    id: 'profile-a',
    name: 'New',
    nodes: [{ name: 'new-node' }],
    raw: 'new-raw',
  }), /simulated index failure/);
  assert.throws(() => store.updateSettings({ mixedPort: 12345 }), /simulated index failure/);
  assert.throws(() => store.removeSubscription('profile-a'), /simulated index failure/);
  store._writeConfigData = originalWrite;

  assert.strictEqual(store.getSettings().mixedPort, 7890, 'failed settings write changed memory state');
  const reloaded = new Store(dir).getSubscription('profile-a', { includeRaw: true });
  assert.strictEqual(reloaded.name, 'Old');
  assert.strictEqual(reloaded.nodes[0].name, 'old-node');
  assert.strictEqual(reloaded.raw, 'old-raw');
});

test('bulk payload staging removes files when a later stage fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-stage-'));
  const store = new Store(dir);
  const profileDir = path.join(dir, 'profiles');
  const ruleDir = path.join(dir, 'remote-rules');
  const files = (target) => fs.existsSync(target) ? fs.readdirSync(target).sort() : [];

  const originalStageText = store._stageText;
  let stageCalls = 0;
  store._stageText = function failRawStage(...args) {
    stageCalls += 1;
    if (stageCalls === 2) throw new Error('simulated raw stage failure');
    return originalStageText.apply(this, args);
  };
  assert.throws(() => store.set('subscriptions', [{
    id: 'profile-a', name: 'Profile', nodes: [{ name: 'node-a' }], raw: 'raw-a',
  }]), /simulated raw stage failure/);
  store._stageText = originalStageText;
  assert.deepStrictEqual(files(profileDir), [], 'failed bulk profile staging left a payload file');
  assert.deepStrictEqual(store.listSubscriptions(), []);

  const originalRuleMetadata = store._ruleSetMetadata;
  store._ruleSetMetadata = () => { throw new Error('simulated rule metadata failure'); };
  assert.throws(() => store.set('customRuleSets', [{
    id: 'rules-a', name: 'Rules', kind: 'inline', rules: [{ domain: ['example.com'] }],
  }]), /simulated rule metadata failure/);
  store._ruleSetMetadata = originalRuleMetadata;
  assert.deepStrictEqual(files(ruleDir), [], 'failed bulk rule staging left a payload file');
  assert.deepStrictEqual(store.listCustomRuleSets(), []);
});

test('payload backups self-heal corrupt primaries and startup removes orphan stages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({ id: 'profile-a', name: 'Old', nodes: [{ name: 'old-node' }] });
  store.upsertSubscription({ id: 'profile-a', name: 'New', nodes: [{ name: 'new-node' }] });

  const profileDir = path.join(dir, 'profiles');
  const dataFile = store.data.subscriptions[0].dataFile;
  const profilePath = path.join(profileDir, dataFile);
  assert.ok(fs.existsSync(profilePath + '.bak'), 'updated payload has no recovery copy');
  fs.writeFileSync(profilePath, '{invalid json', 'utf-8');
  fs.writeFileSync(path.join(profileDir, 'orphan.json'), '{}', 'utf-8');

  const reloaded = new Store(dir);
  assert.ok(!fs.existsSync(path.join(profileDir, 'orphan.json')), 'startup kept an unreferenced payload');
  assert.strictEqual(reloaded.getSubscription('profile-a').nodes[0].name, 'old-node');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(profilePath, 'utf-8')));
});

test('raw subscriptions and remote rule payloads stay outside config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({
    id: 'profile-a',
    name: 'Profile',
    nodes: [{ name: 'node-a' }],
    raw: 'RAW-CONTENT-SENTINEL',
  });
  store.set('customRuleSets', [{
    id: 'rules-a',
    name: 'Rules',
    kind: 'inline',
    rules: [{ domain_suffix: ['RULE-CONTENT-SENTINEL.example'] }],
  }]);

  const persisted = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
  const persistedBackup = fs.readFileSync(path.join(dir, 'config.json.bak'), 'utf-8');
  assert.ok(!persisted.includes('RAW-CONTENT-SENTINEL'));
  assert.ok(!persisted.includes('RULE-CONTENT-SENTINEL'));
  assert.ok(!persistedBackup.includes('RAW-CONTENT-SENTINEL'));
  assert.ok(!persistedBackup.includes('RULE-CONTENT-SENTINEL'));
  assert.strictEqual(store.getSubscription('profile-a').raw, undefined);
  assert.strictEqual(store.getSubscriptions()[0].raw, undefined);
  assert.strictEqual(store.getSubscription('profile-a', { includeRaw: true }).raw, 'RAW-CONTENT-SENTINEL');
  assert.strictEqual(store.get('subscriptions')[0].raw, 'RAW-CONTENT-SENTINEL');
  assert.strictEqual(store.get('customRuleSets')[0].rules[0].domain_suffix[0], 'RULE-CONTENT-SENTINEL.example');
  assert.ok(fs.readdirSync(path.join(dir, 'remote-rules')).some((name) => name.endsWith('.json')));
});

test('single remote rule mutations preserve peers and roll back failed commits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertCustomRuleSet({
    id: 'rules-a', name: 'A', kind: 'inline', target: 'proxy',
    rules: [{ domain_suffix: ['a.example'] }],
  });
  store.upsertCustomRuleSet({
    id: 'rules-b', name: 'B', kind: 'inline', target: 'direct',
    rules: [{ domain_suffix: ['b.example'] }],
  });

  const first = store.listCustomRuleSets().find((item) => item.id === 'rules-a');
  const originalReadPayload = store._readJsonPayload;
  store._readJsonPayload = () => { throw new Error('metadata edit hydrated remote rule'); };
  store.upsertCustomRuleSet({ ...first, name: 'A renamed', autoUpdateMinutes: 30 });
  store._readJsonPayload = originalReadPayload;
  assert.strictEqual(store.getCustomRuleSet('rules-a').rules[0].domain_suffix[0], 'a.example');
  assert.strictEqual(store.getCustomRuleSet('rules-b').rules[0].domain_suffix[0], 'b.example');

  const ruleDir = path.join(dir, 'remote-rules');
  const filesBeforeFailure = fs.readdirSync(ruleDir).sort();
  const originalWrite = store._writeConfigData;
  store._writeConfigData = () => { throw new Error('simulated index failure'); };
  assert.throws(() => store.upsertCustomRuleSet({
    ...store.getCustomRuleSet('rules-a'),
    rules: [{ domain_suffix: ['broken.example'] }],
  }), /simulated index failure/);
  assert.throws(() => store.removeCustomRuleSet('rules-a'), /simulated index failure/);
  store._writeConfigData = originalWrite;

  assert.deepStrictEqual(fs.readdirSync(ruleDir).sort(), filesBeforeFailure, 'failed commit left a staged payload');
  const reloaded = new Store(dir);
  assert.strictEqual(reloaded.getCustomRuleSet('rules-a').name, 'A renamed');
  assert.strictEqual(reloaded.getCustomRuleSet('rules-a').rules[0].domain_suffix[0], 'a.example');
  assert.strictEqual(reloaded.getCustomRuleSet('rules-b').rules[0].domain_suffix[0], 'b.example');

  reloaded.removeCustomRuleSet('rules-a');
  const finalStore = new Store(dir);
  assert.strictEqual(finalStore.getCustomRuleSet('rules-a'), null);
  assert.strictEqual(finalStore.getCustomRuleSet('rules-b').rules[0].domain_suffix[0], 'b.example');
});

console.log('\nCore layout:');

test('Windows proxy registry parsing requires exact field values', () => {
  const proxy = require('../src/main/proxy');
  const enabled = `\r\nHKEY_CURRENT_USER\\Software\\Example\r\n    ProxyEnable    REG_DWORD    0x1\r\n`;
  const server = `\r\nHKEY_CURRENT_USER\\Software\\Example\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n`;
  assert.strictEqual(proxy.registryDwordEnabled(enabled), true);
  assert.strictEqual(proxy.registryValue(server, 'ProxyServer'), '127.0.0.1:7890');
  assert.strictEqual(proxy.proxyServerMatches(server, '127.0.0.1:7890'), true);
  assert.strictEqual(proxy.proxyServerMatches(server, '127.0.0.1:789'), false);
  assert.strictEqual(proxy.proxyServerMatches(server, '127.0.0.1:78900'), false);
});

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
