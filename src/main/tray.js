'use strict';

const { app, Tray, Menu, nativeImage, dialog } = require('electron');

const { state, sendLog, setTrayRefresher } = require('./state');
const core = require('./core-control');

// Tray icon: 32x32 rounded square with the app's blue/indigo gradient and a
// white dart (matches the app icon). Embedded as a base64 PNG so the tray
// never depends on an external asset path at runtime. Regenerate with
// `node scripts/make-icon.js`, which prints this data URL.
const TRAY_ICON_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACI0lEQVR42sXTX2vTUBgG8PeL5Ivs05zkgLSljGFERERENkT8O8SjsZRS62SLiqI39lpBaC9ExBv1K0xI2iY5ad0jJ0tnh23PyeyyAz8I5LzP81IaYjspLYAVm9tDrJPOslgnrbJO6rFOihXz8mxrtpNYW06tsbb0WVvilPl5V9ZLrCUVi7Wkz1oSJfHzTiLWlEqVNSVKpjqJWEMqHmtIlEx1EtlegrNE9qMEZ4nshwn+l9uWEO/TTO/n78z06GbJfhCjiM0XEt3PY/R+TLA/OIDu6PLI3o5RhNtMjIrV6X2faPPIvhejKLdhtkS2gCaL7DsxTsJ9kmA/XL6EeJdqc8i+FeEkxFup/QXUHV0O2TcjFCXeSKP/gCtibRbZNyIUIV6blWdfgEEeOZsjmBKvkqWFv4KDY88mmeRcH8GEeLm8XL1370dHS/S/TYxyybk2go7wNeV+cnTXvXu4RPfTGCbZ5FwdYhmxpynfS/6ZcW+PsNWIoMtWyLkyxCJiV1O+m2DZvAlyLg8xz9bjCP2v40z3Y5o5Vv48waLZIsi5NISJ7oe/C4idBKZzOuRcHMBE/8v4sPxZDNMZE+RcGMCEWkA8jWF63xQ55wcwsbUdwfRuEcQ3QsXjGyFKpjqJ+HqoVPl6iJKpTiJeDxWL10Of10OUxM87iXgtnFrjtdDntRCnzM+7sl7ilWCWxStBlVcCj1cCrJiXZ1uzncTPBYtgxeb2/AFtnrPuXLwncAAAAABJRU5ErkJggg==';

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
