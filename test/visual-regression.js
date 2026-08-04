'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPDATE = process.argv.includes('--update');
const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'renderer', 'index.html');
const DIALOG_ENTRY = path.join(ROOT, 'src', 'renderer', 'dialog.html');
const DIALOG_PRELOAD = path.join(__dirname, 'visual-dialog-preload.js');
const BASELINE_DIR = path.join(__dirname, 'visual-baselines');
const PIXEL_CHANNEL_THRESHOLD = 10;
const MAX_CHANGED_PIXEL_RATIO = 0.0015;

const SCENARIOS = [
  { name: 'dashboard-light-1280x720', tab: 'dashboard', theme: 'light', width: 1280, height: 720 },
  { name: 'dashboard-dark-1280x720', tab: 'dashboard', theme: 'dark', width: 1280, height: 720 },
  { name: 'configs-light-1280x720', tab: 'subs', theme: 'light', width: 1280, height: 720 },
  { name: 'nodes-empty-light-1280x720', tab: 'nodes', theme: 'light', width: 1280, height: 720 },
  { name: 'connections-light-1280x720', tab: 'conns', theme: 'light', width: 1280, height: 720 },
  { name: 'tools-light-1280x720', tab: 'tools', theme: 'light', width: 1280, height: 720 },
  { name: 'settings-dark-1280x720', tab: 'settings', theme: 'dark', width: 1280, height: 720 },
  { name: 'settings-light-1050x720', tab: 'settings', theme: 'light', width: 1050, height: 720 },
  { name: 'tools-light-960x720', tab: 'tools', theme: 'light', width: 960, height: 720 },
  { name: 'core-dialog-light-560x420', kind: 'core-dialog', theme: 'light', width: 560, height: 420 },
];

const requestedScenario = (process.argv.find((arg) => arg.startsWith('--scenario=')) || '').slice(11);
const SELECTED_SCENARIOS = requestedScenario
  ? SCENARIOS.filter((scenario) => scenario.name === requestedScenario)
  : SCENARIOS;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-lcd-text');
app.on('window-all-closed', () => {
  // The suite creates one isolated window per scenario.
});

function compareImages(actual, baseline) {
  const actualSize = actual.getSize();
  const baselineSize = baseline.getSize();
  if (actualSize.width !== baselineSize.width || actualSize.height !== baselineSize.height) {
    return {
      ok: false,
      message: `size changed from ${baselineSize.width}x${baselineSize.height} to ${actualSize.width}x${actualSize.height}`,
    };
  }

  const actualBitmap = actual.toBitmap();
  const baselineBitmap = baseline.toBitmap();
  let changedPixels = 0;
  const pixels = actualSize.width * actualSize.height;
  for (let offset = 0; offset < actualBitmap.length; offset += 4) {
    const blue = Math.abs(actualBitmap[offset] - baselineBitmap[offset]);
    const green = Math.abs(actualBitmap[offset + 1] - baselineBitmap[offset + 1]);
    const red = Math.abs(actualBitmap[offset + 2] - baselineBitmap[offset + 2]);
    const alpha = Math.abs(actualBitmap[offset + 3] - baselineBitmap[offset + 3]);
    if (Math.max(red, green, blue, alpha) > PIXEL_CHANNEL_THRESHOLD) changedPixels++;
  }
  const ratio = changedPixels / pixels;
  return {
    ok: ratio <= MAX_CHANGED_PIXEL_RATIO,
    message: `${changedPixels} pixels changed (${(ratio * 100).toFixed(3)}%)`,
  };
}

async function waitForFixture(window, readyToken) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const status = await window.webContents.executeJavaScript(`({
      ready: window.__visualTestReady === ${JSON.stringify(readyToken)},
      error: window.__visualTestError || ''
    })`, true);
    if (status.error) throw new Error(status.error);
    if (status.ready) {
      await window.webContents.executeJavaScript('document.fonts && document.fonts.ready', true);
      // The fixture is synchronous, but Chromium still needs a compositor turn
      // after fonts and canvas commands settle before capturePage().
      await new Promise((resolve) => setTimeout(resolve, 160));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('visual fixture did not become ready');
}

async function waitForCoreDialog(window) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.native-dialog-window');
      return Boolean(
        dialog && dialog.getAttribute('aria-busy') === 'false' &&
        document.querySelector('#dialogCoreFolder') &&
        document.querySelector('#dialogCoreUpdate')
      );
    })()`, true);
    if (ready) {
      await window.webContents.executeJavaScript('document.fonts && document.fonts.ready', true);
      await new Promise((resolve) => setTimeout(resolve, 160));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('core dialog fixture did not become ready');
}

async function assertLayout(window, scenario) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('main.content');
    const toolList = document.querySelector('#tab-tools:not([hidden]) .tool-list');
    const settingsControls = [...document.querySelectorAll(
      '#tab-settings:not([hidden]) .setting-row > .input, #tab-settings:not([hidden]) .setting-row > .ui-select'
    )].filter((element) => element.getBoundingClientRect().width > 0);
    const widths = settingsControls.map((element) => Math.round(element.getBoundingClientRect().width));
    const columns = toolList
      ? getComputedStyle(toolList).gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length
      : 0;
    return {
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      settingsWidths: [...new Set(widths)],
      toolColumns: columns,
      activeTab: window.App && window.App.currentTab,
      dashboardBlocks: ['.cards', '#tab-dashboard > .panel', '.dash-split', '.dashboard-insights']
        .map((selector) => {
          const element = document.querySelector(selector);
          return [selector, element ? Math.round(element.getBoundingClientRect().height) : 0];
        }),
    };
  })()`, true);

  const failures = [];
  if (metrics.activeTab !== scenario.tab) {
    failures.push(`active tab ${metrics.activeTab || 'unknown'}, expected ${scenario.tab}`);
  }
  if (metrics.contentScrollWidth > metrics.contentClientWidth + 1) {
    failures.push(`horizontal overflow ${metrics.contentScrollWidth - metrics.contentClientWidth}px`);
  }
  if (scenario.tab === 'dashboard' && scenario.width === 1280 &&
      metrics.contentScrollHeight > metrics.contentClientHeight + 1) {
    failures.push(
      `dashboard vertical overflow ${metrics.contentScrollHeight - metrics.contentClientHeight}px ` +
      `(${metrics.dashboardBlocks.map(([name, height]) => `${name}:${height}`).join(', ')})`
    );
  }
  if (scenario.tab === 'settings' && metrics.settingsWidths.length !== 1) {
    failures.push(`settings control widths differ: ${metrics.settingsWidths.join(', ')}`);
  }
  if (scenario.tab === 'tools') {
    const expected = scenario.width < 1100 ? 2 : 3;
    if (metrics.toolColumns !== expected) {
      failures.push(`tool columns ${metrics.toolColumns}, expected ${expected}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

async function assertCoreDialogLayout(window) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('#dialogContent');
    const source = document.querySelector('#dialogCoreSource + .ui-select');
    const folder = document.querySelector('#dialogCoreFolder');
    const pathRow = document.querySelector('.dialog-core-path-row');
    const feature = document.querySelector('.dialog-feature-status');
    const rows = [...document.querySelectorAll('.dialog-core-body > .setting-row')];
    const footerButtons = [...document.querySelectorAll('.dialog-footer .btn')];
    return {
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      sourceWidth: Math.round(source.getBoundingClientRect().width),
      folderWidth: Math.round(folder.getBoundingClientRect().width),
      pathBorderBottom: getComputedStyle(pathRow).borderBottomWidth,
      featureBorderTop: getComputedStyle(feature).borderTopWidth,
      featureDirection: getComputedStyle(feature).flexDirection,
      rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      footerHeights: footerButtons.map((button) => Math.round(button.getBoundingClientRect().height)),
    };
  })()`, true);
  const failures = [];
  if (metrics.contentScrollWidth > metrics.contentClientWidth + 1) failures.push('horizontal overflow');
  if (metrics.contentScrollHeight > metrics.contentClientHeight + 1) failures.push('vertical overflow');
  if (metrics.folderWidth >= metrics.sourceWidth * 0.7) {
    failures.push(`folder action too wide (${metrics.folderWidth}px vs ${metrics.sourceWidth}px)`);
  }
  if (metrics.pathBorderBottom !== '1px' || metrics.featureBorderTop !== '0px') {
    failures.push('core details do not use exactly one section divider');
  }
  if (metrics.featureDirection !== 'row') failures.push('feature status is not horizontally aligned');
  if (new Set(metrics.rowHeights).size !== 1) failures.push(`row heights differ: ${metrics.rowHeights.join(', ')}`);
  if (new Set(metrics.footerHeights).size !== 1) failures.push(`footer button heights differ: ${metrics.footerHeights.join(', ')}`);
  if (failures.length) throw new Error(failures.join('; '));
}

async function captureCoreDialogScenario(scenario) {
  const window = new BrowserWindow({
    width: scenario.width,
    height: scenario.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#f3f8fb',
    resizable: false,
    webPreferences: {
      preload: DIALOG_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(DIALOG_ENTRY, { query: { 'visual-test': '1' } });
    await waitForCoreDialog(window);
    await assertCoreDialogLayout(window);
    return await window.webContents.capturePage();
  } finally {
    window.destroy();
  }
}

async function captureScenario(scenario) {
  if (scenario.kind === 'core-dialog') return captureCoreDialogScenario(scenario);
  const readyToken = `${scenario.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const backgroundColor = scenario.theme === 'dark' ? '#202024' : '#f3f8fb';
  const window = new BrowserWindow({
    width: scenario.width,
    height: scenario.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(ENTRY, {
      query: {
        'visual-test': '1',
        tab: scenario.tab,
        theme: scenario.theme,
        lang: 'en',
        'visual-token': readyToken,
      },
    });
    await waitForFixture(window, readyToken);
    await assertLayout(window, scenario);
    return await window.webContents.capturePage();
  } finally {
    window.destroy();
  }
}

async function run() {
  if (UPDATE) fs.mkdirSync(BASELINE_DIR, { recursive: true });
  if (!SELECTED_SCENARIOS.length) throw new Error(`unknown visual scenario: ${requestedScenario}`);
  let failed = 0;
  for (const scenario of SELECTED_SCENARIOS) {
    try {
      const actual = await captureScenario(scenario);
      const baselinePath = path.join(BASELINE_DIR, `${scenario.name}.png`);
      if (UPDATE) {
        fs.writeFileSync(baselinePath, actual.toPNG());
        console.log(`  updated ${scenario.name}`);
        continue;
      }
      if (!fs.existsSync(baselinePath)) {
        throw new Error(`missing baseline; run npm run test:visual:update`);
      }
      const baseline = nativeImage.createFromPath(baselinePath);
      const comparison = compareImages(actual, baseline);
      if (!comparison.ok) {
        const actualPath = path.join(os.tmpdir(), `dart-visual-${scenario.name}-actual.png`);
        fs.writeFileSync(actualPath, actual.toPNG());
        throw new Error(`${comparison.message}; actual: ${actualPath}`);
      }
      console.log(`  ✓ ${scenario.name} (${comparison.message})`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${scenario.name}\n    ${error.message}`);
    }
  }
  return failed;
}

app.whenReady()
  .then(run)
  .then((failed) => app.exit(failed ? 1 : 0))
  .catch((error) => {
    console.error(error.stack || error);
    app.exit(1);
  })
