'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const { state, isDev } = require('./state');

// The window background must match the resolved theme to avoid a flash before
// the renderer paints. For 'system', ask the OS.
function resolveBackground() {
  const { nativeTheme } = require('electron');
  const theme = (state.store && state.store.getSettings().theme) || 'dark';
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme !== 'light';
  return dark ? '#0d1017' : '#f4f6fa';
}

function createWindow(startHidden = false) {
  const mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: 'Dart',
    // Start hidden and reveal on ready-to-show; this avoids a white flash and
    // lets silent start keep the window in the tray without it ever appearing.
    show: false,
    backgroundColor: resolveBackground(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit: throttle animations/timers when the page is in the background
      // (default true, but pinning it documents the contract — paired with the
      // setFrameRate cycle below to crush paint cost while hidden in the tray).
      backgroundThrottling: true,
    },
  });
  state.mainWindow = mainWindow;

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Reveal once the renderer is painted, unless we're starting silently — then
  // the app lives in the tray until the user opens it (tray menu / relaunch).
  mainWindow.once('ready-to-show', () => {
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
  // catches edge cases where a stray repaint could still wake the GPU. The
  // renderer separately runs a GC on visibilitychange:hidden (see main.js).
  mainWindow.on('hide', () => {
    try { mainWindow.webContents.setFrameRate(1); } catch (_) { /* ignore */ }
  });
  mainWindow.on('show', () => {
    try { mainWindow.webContents.setFrameRate(60); } catch (_) { /* ignore */ }
  });

  return mainWindow;
}

module.exports = { createWindow };
