'use strict';

const path = require('path');
const { app, Tray, Menu, nativeImage, dialog } = require('electron');

const { state, sendLog, setTrayRefresher } = require('./state');
const core = require('./core-control');
const { showMainWindow } = require('./window');

const TRAY_ASSET_DIR = path.join(__dirname, 'assets');
let trayImages = null;
let trayRunning = null;

function loadTrayImages() {
  if (!trayImages) {
    trayImages = {
      stopped: nativeImage.createFromPath(path.join(TRAY_ASSET_DIR, 'tray-stopped.png')),
      running: nativeImage.createFromPath(path.join(TRAY_ASSET_DIR, 'tray-running.png')),
    };
  }
  return trayImages;
}

function updateTrayIcon(running) {
  if (!state.tray || trayRunning === running) return;
  const images = loadTrayImages();
  state.tray.setImage(running ? images.running : images.stopped);
  trayRunning = running;
}

function createTray() {
  const tray = new Tray(loadTrayImages().stopped);
  state.tray = tray;
  trayRunning = false;
  tray.setToolTip('Dart Network Control');
  // Let other modules (sendStatus, setProxyMode) refresh the menu without
  // requiring this module, which would create a require cycle.
  setTrayRefresher(updateTrayMenu);
  updateTrayMenu();
  tray.on('double-click', showMainWindow);
  return tray;
}

function updateTrayMenu() {
  if (!state.tray) return;
  const running = state.singbox && state.singbox.isRunning();
  updateTrayIcon(!!running);
  // While running, the traffic stream keeps the tooltip showing live speed;
  // reset it to the plain name once stopped so it doesn't show stale numbers.
  if (!running) {
    try { state.tray.setToolTip('Dart Network Control'); } catch (_) { /* tray gone */ }
  }
  const currentMode = (state.store && state.store.getSettings().clashMode) || 'rule';
  const menu = Menu.buildFromTemplate([
    { label: 'Dart Network Control', enabled: false },
    { type: 'separator' },
    {
      label: running ? '● Running' : '○ Stopped',
      enabled: false,
    },
    {
      label: running ? 'Stop' : 'Start',
      click: async () => {
        try {
          await core.queueConfigMutation(() => running ? core.stopCore(true) : core.startCore());
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
    { label: 'Show window', click: showMainWindow },
    {
      label: 'Quit',
      click: async () => {
        app.isQuitting = true;
        try {
          await core.cleanup();
        } catch (error) {
          sendLog('[gui] shutdown cleanup failed: ' + error.message);
        } finally {
          app.quit();
        }
      },
    },
  ]);
  state.tray.setContextMenu(menu);
}

module.exports = { createTray };
