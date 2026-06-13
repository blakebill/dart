'use strict';

const { app, Tray, Menu, nativeImage, dialog } = require('electron');

const { state, sendLog, setTrayRefresher } = require('./state');
const core = require('./core-control');

// Tray icon: a solid blue swift silhouette lifted from the app art, so it
// stays legible on light and dark system trays. 32x32 PNG, embedded as a
// base64 data URL so the tray needs no external asset at runtime. Regenerate
// with `node scripts/make-icon.js`, which prints it.
const TRAY_ICON_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAADnElEQVRYw71XTWsTURR9atGiIhZBBSsoCCJa0G6Kij/AlRUpCIqCIriqC0F0YxddqCutTTIz+Wib2CJ240JEXKk7F6I7RVeiaAUpflSsNM07nnfnzWSSJo1tpj64TDLz3txzz/0cpeouLFN9aKEsV/9nUaFZA7pdZbFzzuNxrFhaMEaBWTkcVmkUlYNnysNllcK+8JlZBoT8t4DjI8C+0MNqgnijxgB1ByUB4+pXytNXCWZPuM8AMEBQB0gANCoNQQeWZnBF5QnAxTQBaTUsYBBh5gzBtFUAiSpetKsCa1LYqHL6PZkwIIpUWLJXrUYoBbn/UbmzfeoWNtmzlYrT2K7S+gTPXKL0UnrUTayviLd5WUjhuCjKUqFL8fjbAHD1rIi577MyoVKzvTy3Us4l0MX9d7n3p5wvEPw92TfOAF9XYeg8TPiWODhF30/ysK/cBxFIiVIkSyUB4uE59+0WJQns4P8XdCXUkDxL/5viKD3D2Cw0ujhJiz/QYkSYKItr3ZMXtr6rJPeb7DH3snLvC13RLu/sicRKQxd4OO1TrH+LpdWK5wChWzI2PgpyryjXNK7Z4GxZeFA6SKhRY4X1e0MQNkY8zAj9OXzlO7YtgP4aK4WLfNmUtUo3BOFJ7ZiROuLhQgWrCy7NQTAmsZWW9NtgrK/Y97sflA4GmrM8APHE+s7BdSlIfvRXU48wLU3WuDgfFqWmVvACk15D+CMMzM0Ebe9PUG4Q6JYy7c32iwCAyesc4yATVkYdpuCQXB+oQWwIKTes9SzK7/OASDKgTF6PRIqQa6338Iu/XwoDaewNgSCujhm8yMFBylPxdz7if8NM0LCyzAAPDykdMQRhDSbMNYVDVHA/DMhy/hfJQElSNoMfKjHTFU8wVk9FwQs9Npi8rYLRoPQYsKNSiMaaqAN1a0MwuLDr6U91esSMdYcbI4BwVmij9JHiaTsv6Kqa4DehnP4mE1TzLgiH1VXMhLPsC5PS3zOmP1Qo9yvhiFA/xb3d8ft/mBNNUu+SSucy9QK6TQzkbCd0OAcMojNe6qPDp4v9VPpYLM5IOmqx2sFbtu5zwlR0qGk69coR30GfPpIuN24HVYft1mSCgyP839r8UFprMClgDRXfFnr9LveaShOUbhleq8/EUnjK5fcAKX9HpZ+psJ/SyWetNef/2D9QHByVJuPh2Byrgg8NLNXXkYl0Q3Ewakc/VGNXWmslsDaserHSu5g4WOL1Fxb+td/nVYogAAAAAElFTkSuQmCC';

function createTray() {
  // Use a simple built-in icon (placeholder) to avoid depending on external asset files.
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATAURL);
  const tray = new Tray(icon);
  state.tray = tray;
  tray.setToolTip('Dart');
  // Let other modules (sendStatus, setProxyMode) refresh the menu without
  // requiring this module, which would create a require cycle.
  setTrayRefresher(updateTrayMenu);
  updateTrayMenu();
  tray.on('double-click', () => {
    if (state.mainWindow) state.mainWindow.show();
  });
  return tray;
}

function updateTrayMenu() {
  if (!state.tray) return;
  const running = state.singbox && state.singbox.isRunning();
  const currentMode = (state.store && state.store.getSettings().clashMode) || 'rule';
  const menu = Menu.buildFromTemplate([
    { label: 'Dart', enabled: false },
    { type: 'separator' },
    {
      label: running ? '● Running' : '○ Stopped',
      enabled: false,
    },
    {
      label: running ? 'Stop' : 'Start',
      click: async () => {
        try {
          if (running) await core.stopCore(true);
          else await core.startCore();
        } catch (e) {
          dialog.showErrorBox('Operation failed', e.message);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Proxy mode',
      submenu: ['rule', 'global', 'direct', 'block'].map((m) => ({
        label: { rule: 'Rule', global: 'Global', direct: 'Direct', block: 'Block' }[m],
        type: 'radio',
        checked: currentMode === m,
        click: () => {
          core.setProxyMode(m).catch((e) => sendLog('[gui] set mode failed: ' + e.message));
        },
      })),
    },
    { type: 'separator' },
    { label: 'Show window', click: () => state.mainWindow && state.mainWindow.show() },
    {
      label: 'Quit',
      click: async () => {
        app.isQuitting = true;
        await core.cleanup();
        app.quit();
      },
    },
  ]);
  state.tray.setContextMenu(menu);
}

module.exports = { createTray, updateTrayMenu };
