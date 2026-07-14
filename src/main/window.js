'use strict';

const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const { state, isDev } = require('./state');

const isWin = process.platform === 'win32';

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

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Reveal once the renderer is painted, unless we're starting silently — then
  // the app lives in the tray until the user opens it (tray menu / relaunch).
  mainWindow.once('ready-to-show', () => {
    applyMica(mainWindow);
    if (!startHidden) mainWindow.show();
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
  });
  mainWindow.on('show', () => {
    try { mainWindow.webContents.setFrameRate(60); } catch (_) { /* ignore */ }
    applyMica(mainWindow);
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

module.exports = { createWindow, applyNativeThemeSource };
