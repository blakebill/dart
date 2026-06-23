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
// V8 tuning for the renderer (the heaviest process):
//   --max-old-space-size=192  caps the heap; the UI doesn't need 256MB, and a
//                             tighter cap nudges V8 to GC sooner. 192 keeps
//                             margin for very large subscription / node lists.
//   --expose-gc               exposes window.gc() so the renderer can run a
//                             collection on visibilitychange:hidden, freeing
//                             heap promptly when minimized to the tray.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192 --expose-gc');

const { state, runtimeDir, resourcesBinDir, sendLog, sendStatus } = require('./state');
const { Store } = require('./store');
const { SingBoxManager } = require('./singbox');
const { createWindow } = require('./window');
const { createTray } = require('./tray');
const { stopTrafficStream } = require('./traffic');
const core = require('./core-control');
const { registerIpc } = require('./ipc');
const { notify } = require('./notify');
const proxy = require('./proxy');

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
        // Unexpected exit (not a stop/restart we triggered, not during quit):
        // alert the user — the proxy is now down, which is easy to miss when
        // the app is sitting in the tray.
        if (!state.coreStopping && !app.isQuitting) {
          const zh = (state.store.getSettings().language || 'zh') === 'zh';
          notify(
            zh ? '内核已停止' : 'Core stopped',
            zh ? '内核意外退出，代理可能已失效。' : 'sing-box exited unexpectedly; the proxy may be down.'
          );
        }
      },
    });
    registerIpc();
    const settings = state.store.getSettings();
    // Sync the OS login-item state with the saved setting.
    core.applyAutoLaunch(settings.autoLaunch, settings.silentStart);
    // Clear a system proxy left dangling by a previous exit (so the machine
    // isn't left offline during the boot -> app-start window). Runs concurrently
    // with window load; the auto-resume below awaits it so the clear can't race
    // startCore re-enabling the proxy.
    const healDone = core.healStaleSystemProxy();
    // Silent start: keep the window in the tray when the setting is on, or when
    // launched at login with --hidden (set on the login item by applyAutoLaunch).
    const startHidden = !!settings.silentStart || process.argv.includes('--hidden');
    createWindow(startHidden);
    createTray();
    core.rescheduleAutoUpdate();
    core.startGeoAutoUpdate();

    // Auto-resume: if the core was running at last quit, start it again so the
    // user does not have to click Start every time they open the app.
    if (state.store.get('lastRunning') && state.singbox.isCoreInstalled()) {
      state.mainWindow.webContents.once('did-finish-load', async () => {
        await healDone.catch(() => {}); // ensure any stale-proxy clear lands first
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

  // Windows shutdown / log-off: the OS gives only a brief window before killing
  // the app, too short for the async cleanup above. Flip the system proxy off
  // synchronously so the machine isn't left offline on next boot. (Stopping the
  // core itself isn't needed — the OS is tearing everything down regardless.)
  // Check the registry rather than the in-memory flag (which can be stale by
  // shutdown), and only clear when the proxy actually points at our local port
  // so we never wipe a proxy the user set themselves.
  app.on('session-end', () => {
    try {
      const port = (state.store && state.store.getSettings().mixedPort) || 7890;
      proxy.disableSystemProxySyncIfOurs(`127.0.0.1:${port}`);
    } catch (_) { /* best-effort */ }
  });
}
