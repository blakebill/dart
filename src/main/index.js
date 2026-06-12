'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Main-process entry point: Electron lifecycle only.
 *
 * Everything else lives in focused modules sharing state via ./state:
 *   window.js        BrowserWindow creation, tray hide/show wiring
 *   tray.js          tray icon + menu
 *   traffic.js       Clash API /traffic stream -> renderer
 *   admin.js         Windows admin detection / elevated relaunch
 *   update.js        app release update check
 *   core-control.js  config build, core start/stop, proxy guard, Clash API
 *   ipc.js           every ipcMain handler
 */

// Memory optimizations. Hardware acceleration is opt-in (off by default): a proxy
// GUI does not need a separate GPU process, and dropping it lowers idle RAM use by
// ~100MB (CSS transitions still run). The preference must be read before the app is
// ready, so we peek at the on-disk config directly. The V8 heap is also capped.
function prefersHardwareAccel() {
  try {
    const f = path.join(app.getPath('userData'), 'config.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return !!(d.settings && d.settings.hardwareAcceleration);
  } catch (_) {
    return false;
  }
}
if (!prefersHardwareAccel()) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');

const { state, runtimeDir, resourcesBinDir, sendLog, sendStatus } = require('./state');
const { Store } = require('./store');
const { SingBoxManager } = require('./singbox');
const { createWindow } = require('./window');
const { createTray } = require('./tray');
const { stopTrafficStream } = require('./traffic');
const core = require('./core-control');
const { registerIpc } = require('./ipc');

// Safety net: a stray socket error (e.g. ECONNRESET when the proxy is torn down
// during a core update) must never crash the app with a fatal error dialog.
// Keep running — but record the full stack in userData/crash.log so real bugs
// don't vanish behind the catch-all (the in-app log only gets a one-liner).
function recordCrash(kind, err) {
  try {
    sendLog(`[gui] ${kind} (ignored): ${(err && err.message) || String(err)}`);
  } catch (_) {
    /* in-app logging is best-effort */
  }
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    // Simple rotation so the file cannot grow without bound.
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
    } catch (_) {}
    const detail = (err && err.stack) || (err && err.message) || String(err);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  } catch (_) {
    /* disk logging is best-effort */
  }
}
process.on('uncaughtException', (err) => recordCrash('uncaught exception', err));
process.on('unhandledRejection', (reason) => recordCrash('unhandled rejection', reason));

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.show();
      state.mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    state.store = new Store(app.getPath('userData'));
    state.singbox = new SingBoxManager({
      resourcesDir: resourcesBinDir,
      runtimeDir,
      onLog: sendLog,
      onExit: () => {
        stopTrafficStream();
        sendStatus();
      },
    });
    registerIpc();
    // Sync the OS login-item state with the saved setting.
    core.applyAutoLaunch(state.store.getSettings().autoLaunch);
    createWindow();
    createTray();
    core.rescheduleAutoUpdate();
    core.startGeoAutoUpdate();

    // Auto-resume: if the core was running at last quit, start it again so the
    // user does not have to click Start every time they open the app.
    if (state.store.get('lastRunning') && state.singbox.isCoreInstalled()) {
      state.mainWindow.webContents.once('did-finish-load', () => {
        core.startCore().catch((e) => sendLog('[gui] auto-resume failed: ' + e.message));
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Tray stays resident; do not quit.
  });

  app.on('before-quit', async (e) => {
    if (!app.isQuitting) {
      app.isQuitting = true;
      e.preventDefault();
      await core.cleanup();
      app.quit();
    }
  });
}
