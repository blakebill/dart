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
  { name: 'dashboard-light-1280x800', tab: 'dashboard', theme: 'light', width: 1280, height: 800 },
  { name: 'dashboard-dark-1280x800', tab: 'dashboard', theme: 'dark', width: 1280, height: 800 },
  { name: 'dashboard-compact-light-960x720', tab: 'dashboard', theme: 'light', width: 960, height: 720, sidebarWidth: 188, allowVerticalOverflow: true, quickColumns: 2 },
  { name: 'configs-light-1280x800', tab: 'subs', theme: 'light', width: 1280, height: 800 },
  { name: 'nodes-empty-light-1280x800', tab: 'nodes', theme: 'light', width: 1280, height: 800 },
  { name: 'groups-light-1280x800', tab: 'groups', theme: 'light', width: 1280, height: 800 },
  { name: 'rules-light-1280x800', tab: 'rules', theme: 'light', width: 1280, height: 800 },
  { name: 'rules-remote-light-1280x800', tab: 'rules', ruleView: 'remote', theme: 'light', width: 1280, height: 800 },
  { name: 'connections-light-1280x800', tab: 'conns', theme: 'light', width: 1280, height: 800 },
  { name: 'logs-light-1280x800', tab: 'logs', theme: 'light', width: 1280, height: 800 },
  { name: 'tools-light-1280x800', tab: 'tools', theme: 'light', width: 1280, height: 800 },
  { name: 'settings-dark-1280x800', tab: 'settings', theme: 'dark', width: 1280, height: 800 },
  { name: 'settings-light-1280x800', tab: 'settings', theme: 'light', width: 1280, height: 800, settingsDirty: true, sidebarCollapsed: true },
  { name: 'core-dialog-light-560x420', kind: 'core-dialog', theme: 'light', width: 560, height: 420 },
  { name: 'local-rule-text-dialog-light-580x610', kind: 'local-rule-dialog', theme: 'light', width: 580, height: 610 },
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

function normalizeCapture(image, scenario) {
  const size = image.getSize();
  if (size.width === scenario.width && size.height === scenario.height) return image;
  const scaleX = size.width / scenario.width;
  const scaleY = size.height / scenario.height;
  if (!Number.isFinite(scaleX) || Math.abs(scaleX - scaleY) > 0.01) return image;
  // capturePage() returns physical pixels on Retina displays even when Chromium
  // is forced to a 1x layout. Keep baselines in logical pixels on every host.
  return image.resize({ width: scenario.width, height: scenario.height, quality: 'best' });
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

async function waitForLocalRuleDialog(window) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.native-dialog-window');
      const editor = document.querySelector('#lrTextEditor');
      return Boolean(
        dialog && dialog.getAttribute('aria-busy') === 'false' && editor &&
        !editor.classList.contains('hidden') && document.querySelector('#lrTextRules')
      );
    })()`, true);
    if (ready) {
      await window.webContents.executeJavaScript('document.fonts && document.fonts.ready', true);
      await new Promise((resolve) => setTimeout(resolve, 160));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('local rule dialog fixture did not become ready');
}

async function assertLayout(window, scenario) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('main.content');
    const toolList = document.querySelector('#tab-tools:not([hidden]) .tool-list');
    const settingsControls = [...document.querySelectorAll(
      '#tab-settings:not([hidden]) .setting-row > .input, #tab-settings:not([hidden]) .setting-row > .ui-select'
    )].filter((element) => element.getBoundingClientRect().width > 0);
    const widths = settingsControls.map((element) => Math.round(element.getBoundingClientRect().width));
    const brandText = document.querySelector('.logo-text')?.getBoundingClientRect();
    const brandVersion = document.querySelector('.app-version')?.getBoundingClientRect();
    const powerButton = document.querySelector('#powerBtn')?.getBoundingClientRect();
    const powerIcon = document.querySelector('.power-icon')?.getBoundingClientRect();
    const activePanel = document.querySelector('.tab.active')?.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const columns = toolList
      ? getComputedStyle(toolList).gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length
      : 0;
    return {
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      sidebarWidth: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
      versionNextToBrand: Boolean(brandText && brandVersion && brandVersion.width > 0 &&
        brandVersion.left >= brandText.right &&
        Math.abs((brandVersion.top + brandVersion.height / 2) - (brandText.top + brandText.height / 2)) <= 3),
      powerIconCenterOffset: powerButton && powerIcon && powerIcon.height > 0
        ? Math.abs((powerIcon.top + powerIcon.height / 2) - (powerButton.top + powerButton.height / 2))
        : 0,
      contentInsets: activePanel ? {
        top: Math.round(activePanel.top - contentRect.top),
        right: Math.round(contentRect.right - activePanel.right),
        bottom: Math.round(contentRect.bottom - activePanel.bottom),
        left: Math.round(activePanel.left - contentRect.left),
      } : null,
      settingsWidths: [...new Set(widths)],
      toolColumns: columns,
      activeTab: window.App && window.App.currentTab,
      dashboardEvents: document.querySelectorAll('#dashboardEventList .dashboard-event').length,
      dashboardQualitySummary: Boolean(document.querySelector('#qualitySummary')),
      dashboardLegacyMetrics: document.querySelectorAll('.quality-metric').length,
      dashboardActionColumns: getComputedStyle(document.querySelector('.dashboard-action-grid'))
        .gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length,
      dashboardActionHeights: [...document.querySelectorAll('.dashboard-action')]
        .map((element) => Math.round(element.getBoundingClientRect().height)),
      dashboardQualityHeights: [...document.querySelectorAll('.quality-metric')]
        .map((element) => Math.round(element.getBoundingClientRect().height)),
      dashboardCenterOffsets: [...document.querySelectorAll('.cards > .card:not(.card-route)')]
        .map((card) => {
          const children = [...card.children].filter((child) => getComputedStyle(child).display !== 'none');
          const first = children[0]?.getBoundingClientRect();
          const last = children[children.length - 1]?.getBoundingClientRect();
          const rect = card.getBoundingClientRect();
          return first && last ? Math.abs(((first.top + last.bottom) / 2) - ((rect.top + rect.bottom) / 2)) : 0;
        }),
      qualityCenterOffsets: [...document.querySelectorAll('.quality-metric')]
        .map((metric) => {
          const first = metric.firstElementChild?.getBoundingClientRect();
          const last = metric.lastElementChild?.getBoundingClientRect();
          const rect = metric.getBoundingClientRect();
          return first && last ? Math.abs(((first.top + last.bottom) / 2) - ((rect.top + rect.bottom) / 2)) : 0;
        }),
      qualityTextFits: [...document.querySelectorAll('.quality-metric')]
        .every((metric) => [...metric.children].every((element) =>
          element.scrollWidth <= element.clientWidth + 1 &&
          element.scrollHeight <= element.clientHeight + 1 &&
          element.getBoundingClientRect().top >= metric.getBoundingClientRect().top - 1 &&
          element.getBoundingClientRect().bottom <= metric.getBoundingClientRect().bottom + 1
        )),
      dashboardPanelInsets: ['.traffic-panel', '.dash-split > .panel', '.dashboard-insights > .panel']
        .map((selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
        }),
      canvasSectionInsets: (() => {
        const section = document.querySelector('.canvas-page:not([hidden]) > .workspace-section');
        if (!section) return null;
        const style = getComputedStyle(section);
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
      })(),
      settingsSavebarVisible: Boolean(document.querySelector('.settings-savebar:not(.hidden)')),
      profileVisibleActions: document.querySelectorAll('#subList .sub-item:first-child .sub-actions-primary > button[data-act]').length,
      profileMenuItems: document.querySelectorAll('#subList .sub-item:first-child .sub-overflow-menu [role="menuitem"]').length,
      profileMenuExpanded: document.querySelector('#subList .sub-item:first-child [data-menu-toggle]')?.getAttribute('aria-expanded'),
      dashboardBlocks: ['.cards', '#tab-dashboard > .panel', '.dash-split', '.dashboard-insights']
        .map((selector) => {
          const element = document.querySelector(selector);
          return [selector, element ? Math.round(element.getBoundingClientRect().height) : 0];
        }),
      expandedGroupPickerIsNearTrigger: (() => {
        const trigger = document.querySelector('.rule-group-item.is-expanded .rule-group-outbound');
        const choice = document.querySelector('.rule-group-item.is-expanded .rule-group-choice');
        if (!trigger || !choice) return null;
        const triggerRect = trigger.getBoundingClientRect();
        const choiceRect = choice.getBoundingClientRect();
        const triggerX = triggerRect.left + triggerRect.width / 2;
        return triggerX >= choiceRect.left && triggerX <= choiceRect.right &&
          choiceRect.top - triggerRect.bottom <= 70;
      })(),
      expandedGroupChoiceClickable: (() => {
        const choice = document.querySelector('.rule-group-item.is-expanded .rule-group-choice');
        if (!choice) return null;
        const rect = choice.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return choice === hit || choice.contains(hit);
      })(),
      expandedGroupDoesNotOverlapCards: (() => {
        const expanded = document.querySelector('.rule-group-item.is-expanded');
        if (!expanded) return null;
        const rect = expanded.getBoundingClientRect();
        return [...document.querySelectorAll('.rule-group-item:not(.is-expanded)')].every((card) => {
          const other = card.getBoundingClientRect();
          return rect.right <= other.left || rect.left >= other.right ||
            rect.bottom <= other.top || rect.top >= other.bottom;
        });
      })(),
      ruleManagementView: document.querySelector('#ruleManagerTabs')
        ? (!document.querySelector('#localRuleManager')?.hidden ? 'local'
          : !document.querySelector('#remoteRuleManager')?.hidden ? 'remote' : '')
        : '',
    };
  })()`, true);

  const failures = [];
  if (metrics.activeTab !== scenario.tab) {
    failures.push(`active tab ${metrics.activeTab || 'unknown'}, expected ${scenario.tab}`);
  }
  const expectedSidebarWidth = scenario.sidebarCollapsed ? 64 : (scenario.sidebarWidth || 208);
  if (metrics.sidebarWidth !== expectedSidebarWidth) {
    failures.push(`sidebar width ${metrics.sidebarWidth}px, expected ${expectedSidebarWidth}px`);
  }
  if (!scenario.sidebarCollapsed && !metrics.versionNextToBrand) {
    failures.push('version is not aligned next to the Dart brand');
  }
  if (scenario.sidebarCollapsed && metrics.powerIconCenterOffset > 0.5) {
    failures.push(`collapsed power icon is vertically offset by ${metrics.powerIconCenterOffset}px`);
  }
  if (metrics.contentScrollWidth > metrics.contentClientWidth + 1) {
    failures.push(`horizontal overflow ${metrics.contentScrollWidth - metrics.contentClientWidth}px`);
  }
  if (scenario.tab === 'dashboard' && !scenario.allowVerticalOverflow &&
      metrics.contentScrollHeight > metrics.contentClientHeight + 1) {
    failures.push(
      `dashboard vertical overflow ${metrics.contentScrollHeight - metrics.contentClientHeight}px ` +
      `(${metrics.dashboardBlocks.map(([name, height]) => `${name}:${height}`).join(', ')})`
    );
  }
  if (scenario.tab === 'dashboard' &&
      (metrics.dashboardEvents > 6 || metrics.dashboardQualitySummary || metrics.dashboardLegacyMetrics !== 4)) {
    failures.push('dashboard density contract changed');
  }
  if (scenario.tab === 'dashboard' && !metrics.qualityTextFits) {
    failures.push('network quality text is clipped');
  }
  if (scenario.quickColumns && metrics.dashboardActionColumns !== scenario.quickColumns) {
    failures.push(`dashboard quick actions use ${metrics.dashboardActionColumns} columns, expected ${scenario.quickColumns}`);
  }
  if (scenario.name === 'dashboard-light-1280x800') {
    const { top, right, left } = metrics.contentInsets || {};
    if (top !== 24 || left !== 24 || right < 24) {
      failures.push(`dashboard outer insets differ (${top},${right},${left}px)`);
    }
    const actionHeights = [...new Set(metrics.dashboardActionHeights)];
    const qualityHeights = [...new Set(metrics.dashboardQualityHeights)];
    if (actionHeights.length !== 1 || qualityHeights.length !== 1 || actionHeights[0] !== qualityHeights[0]) {
      failures.push(
        `dashboard four-cell heights differ ` +
        `(actions:${metrics.dashboardActionHeights.join(',')}; quality:${metrics.dashboardQualityHeights.join(',')})`
      );
    }
    if (metrics.dashboardCenterOffsets.some((offset) => offset > 1) ||
        metrics.qualityCenterOffsets.some((offset) => offset > 1)) {
      failures.push(
        `dashboard content is not vertically centered ` +
        `(cards:${metrics.dashboardCenterOffsets.join(',')}; quality:${metrics.qualityCenterOffsets.join(',')})`
      );
    }
    const expectedPanelInsets = [
      '15px,18px,15px,18px',
      '14px,16px,14px,16px',
      '11px,12px,11px,12px',
    ];
    if (metrics.dashboardPanelInsets.some((insets, index) => insets.join(',') !== expectedPanelInsets[index])) {
      failures.push(`dashboard panel insets differ: ${JSON.stringify(metrics.dashboardPanelInsets)}`);
    }
  }
  if (scenario.name === 'configs-light-1280x800') {
    const { top, right, left } = metrics.contentInsets || {};
    if (top !== 24 || left !== 24 || right < 24) {
      failures.push(`profile outer insets differ (${top},${right},${left}px)`);
    }
  }
  if (scenario.tab === 'subs' && metrics.canvasSectionInsets &&
      metrics.canvasSectionInsets.join(',') !== '17px,18px,17px,18px') {
    failures.push(`profile panel insets changed: ${metrics.canvasSectionInsets.join(',')}`);
  }
  if (scenario.tab === 'subs' &&
      (metrics.profileVisibleActions !== 2 || metrics.profileMenuItems !== 3 || metrics.profileMenuExpanded !== 'true')) {
    failures.push(
      `profile action menu contract changed ` +
      `(visible:${metrics.profileVisibleActions}, items:${metrics.profileMenuItems}, expanded:${metrics.profileMenuExpanded})`
    );
  }
  if (scenario.tab === 'settings' && metrics.settingsSavebarVisible !== Boolean(scenario.settingsDirty)) {
    failures.push(scenario.settingsDirty
      ? 'dirty settings do not show the save bar'
      : 'clean settings unexpectedly show the save bar');
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
  if (scenario.tab === 'groups' && (
    !metrics.expandedGroupPickerIsNearTrigger ||
    !metrics.expandedGroupChoiceClickable ||
    !metrics.expandedGroupDoesNotOverlapCards
  )) {
    failures.push('expanded policy-group picker is clipped or covered');
  }
  if (scenario.tab === 'rules' && metrics.ruleManagementView !== (scenario.ruleView || 'local')) {
    failures.push('unified rule management tabs are not initialized');
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
    return normalizeCapture(await window.webContents.capturePage(), scenario);
  } finally {
    window.destroy();
  }
}

async function captureLocalRuleDialogScenario(scenario) {
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
      additionalArguments: ['--visual-local-rule-dialog'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(DIALOG_ENTRY, { query: { 'visual-test': '1' } });
    await waitForLocalRuleDialog(window);
    const metrics = await window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('#dialogContent');
      const textarea = document.querySelector('#lrTextRules');
      return {
        horizontalOverflow: content.scrollWidth - content.clientWidth,
        verticalOverflow: content.scrollHeight - content.clientHeight,
        textareaHeight: Math.round(textarea.getBoundingClientRect().height),
        textVisible: !document.querySelector('#lrTextEditor').classList.contains('hidden'),
        structuredHidden: document.querySelector('#lrStructuredEditor').classList.contains('hidden'),
      };
    })()`, true);
    if (metrics.horizontalOverflow > 1 || metrics.verticalOverflow > 1) throw new Error('local rule dialog overflows');
    if (metrics.textareaHeight < 200 || !metrics.textVisible || !metrics.structuredHidden) {
      throw new Error('local rule text editor is not laid out correctly');
    }
    return normalizeCapture(await window.webContents.capturePage(), scenario);
  } finally {
    window.destroy();
  }
}

async function captureScenario(scenario) {
  if (scenario.kind === 'core-dialog') return captureCoreDialogScenario(scenario);
  if (scenario.kind === 'local-rule-dialog') return captureLocalRuleDialogScenario(scenario);
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
        lang: scenario.lang || 'en',
        'settings-dirty': scenario.settingsDirty ? '1' : '0',
        'rule-view': scenario.ruleView || 'local',
        'sidebar-collapsed': scenario.sidebarCollapsed ? '1' : '0',
        'visual-token': readyToken,
      },
    });
    await waitForFixture(window, readyToken);
    await assertLayout(window, scenario);
    return normalizeCapture(await window.webContents.capturePage(), scenario);
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
