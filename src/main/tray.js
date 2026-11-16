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
  const running = state.coreManager && state.coreManager.isRunning();
  updateTrayIcon(!!running);
  // While running, the traffic stream keeps the tooltip showing live speed;
  // reset it to the plain name once stopped so it doesn't show stale numbers.
  if (!running) {
    try { state.tray.setToolTip('Dart Network Control'); } catch (_) { /* tray gone */ }
  }
  const currentMode = (state.store && state.store.getSettings().clashMode) || 'rule';
  const english = state.store && state.store.getSettings().language === 'en';
  const label = (zh, en) => english ? en : zh;
  const menu = Menu.buildFromTemplate([
    { label: 'Dart Network Control', enabled: false },
    { type: 'separator' },
    {
      label: running ? label('● 运行中', '● Running') : label('○ 已停止', '○ Stopped'),
      enabled: false,
    },
    {
      label: running ? label('停止', 'Stop') : label('启动', 'Start'),
      click: async () => {
        try {
          await core.queueConfigMutation(() => running ? core.stopCore(true) : core.startCore());
        } catch (e) {
          dialog.showErrorBox(label('操作失败', 'Operation failed'), e.message);
        }
      },
    },
    { type: 'separator' },
    {
      label: label('代理模式', 'Proxy mode'),
      submenu: ['rule', 'global', 'direct', 'block'].map((m) => ({
        label: (english
          ? { rule: 'Rule', global: 'Global', direct: 'Direct', block: 'Block' }
          : { rule: '规则', global: '全局', direct: '直连', block: '黑洞' })[m],
        type: 'radio',
        checked: currentMode === m,
        click: () => {
          core.setProxyMode(m).catch((e) => sendLog('[gui] set mode failed: ' + e.message));
        },
      })),
    },
    { type: 'separator' },
    { label: label('显示窗口', 'Show window'), click: showMainWindow },
    {
      label: label('退出', 'Quit'),
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
