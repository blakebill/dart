'use strict';

const path = require('path');
const { app, BrowserWindow, nativeTheme, dialog } = require('electron');

const { state, isDev, sendLog } = require('./state');

const isWin = process.platform === 'win32';
const DEEP_SLEEP_DELAY_MS = 60_000;
let deepSleepTimer = null;

function clearDeepSleepTimer() {
  if (deepSleepTimer) clearTimeout(deepSleepTimer);
  deepSleepTimer = null;
}

function scheduleDeepSleep(win) {
  clearDeepSleepTimer();
  deepSleepTimer = setTimeout(() => {
    deepSleepTimer = null;
    if (
      state.mainWindow === win &&
      !win.isDestroyed() &&
      !win.isVisible()
    ) {
      // The core, proxy and tray live in the main process. Releasing only this
      // hidden renderer recovers Chromium DOM/JS memory without interrupting
      // networking; showMainWindow() recreates it on demand.
      state.mainWindow = null;
      win.destroy();
    }
  }, DEEP_SLEEP_DELAY_MS);
  if (deepSleepTimer.unref) deepSleepTimer.unref();
}

function resolveBackground() {
  // Windows Mica needs a fully transparent window background.
  if (isWin) return '#00000000';
  const theme = (state.store && state.store.getSettings().theme) || 'dark';
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme !== 'light';
  return dark ? '#202020' : '#ffffff';
}

/** Sync DWM/Chromium dark mode so Mica tint matches the app theme. */
function applyNativeThemeSource() {
  const theme = (state.store && state.store.getSettings().theme) || 'dark';
  nativeTheme.themeSource = theme === 'light' || theme === 'system' ? theme : 'dark';
}

function applyMica(win) {
  if (!isWin || !win || win.isDestroyed()) return;
  try {
    win.setBackgroundMaterial('mica');
    win.setBackgroundColor('#00000000');
  } catch (_) {
    /* older Electron / non-W11 */
  }
}

function createWindow(startHidden = false) {
  clearDeepSleepTimer();
  applyNativeThemeSource();

  const mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: 'Dart Network Control',
    frame: false,
    titleBarStyle: 'hidden',
    ...(isWin ? { backgroundMaterial: 'mica' } : {}),
    // Start hidden and reveal on ready-to-show; this avoids a white flash and
    // lets silent start keep the window in the tray without it ever appearing.
    show: false,
    backgroundColor: resolveBackground(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Explicit: throttle animations/timers when the page is in the background
      // (default true, but pinning it documents the contract — paired with the
      // setFrameRate cycle below to crush paint cost while hidden in the tray).
      backgroundThrottling: true,
    },
  });
  state.mainWindow = mainWindow;

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((error) => {
    sendLog('[gui] failed to load the main renderer: ' + error.message);
    try { dialog.showErrorBox('Dart window failed to load', error.message); } catch (_) {}
    if (!mainWindow.isDestroyed()) mainWindow.destroy();
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Reveal once the renderer is painted, unless we're starting silently — then
  // the app lives in the tray until the user opens it (tray menu / relaunch).
  mainWindow.once('ready-to-show', () => {
    applyMica(mainWindow);
    if (!startHidden) mainWindow.show();
    else scheduleDeepSleep(mainWindow);
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Minimize to tray on close.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  // The traffic stream runs for as long as the core is up (so the tray tooltip
  // stays live while hidden), so the window doesn't start/stop it on show/hide.

  // Frame-rate gating: a hidden tray-only window paints nothing useful, so cap
  // the renderer to 1 fps while hidden and restore the default on show. This is
  // belt-and-suspenders on top of backgroundThrottling — Chromium already idles
  // background pages, but capping the frame rate makes the contract obvious and
  // catches edge cases where a stray repaint could still wake the GPU.
  mainWindow.on('hide', () => {
    try { mainWindow.webContents.setFrameRate(1); } catch (_) { /* ignore */ }
    scheduleDeepSleep(mainWindow);
  });
  mainWindow.on('show', () => {
    clearDeepSleepTimer();
    try { mainWindow.webContents.setFrameRate(60); } catch (_) { /* ignore */ }
    applyMica(mainWindow);
  });
  mainWindow.on('closed', () => {
    if (state.mainWindow === mainWindow) {
      state.mainWindow = null;
      clearDeepSleepTimer();
    }
  });

  const sendMaximized = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);
  mainWindow.on('restore', sendMaximized);

  return mainWindow;
}

function showMainWindow() {
  let win = state.mainWindow;
  if (!win || win.isDestroyed()) {
    win = createWindow(false);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.focus();
    });
    return win;
  }
  clearDeepSleepTimer();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

module.exports = { createWindow, showMainWindow, applyNativeThemeSource };
