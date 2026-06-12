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

console.log(`\nDone, ${passed} tests passed.`);
