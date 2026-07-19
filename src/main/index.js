'use strict';

const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'Dart';

function configureUserDataDir() {
  try {
    if (typeof app.setName === 'function') app.setName(APP_NAME);
    const appData = app.getPath('appData');
    const desired = path.join(appData, APP_NAME);
    const actual = fs.readdirSync(appData).find((name) => name !== APP_NAME && name.toLowerCase() === APP_NAME.toLowerCase());
    if (actual) {
      const actualPath = path.join(appData, actual);
      if (!fs.existsSync(desired)) {
        fs.renameSync(actualPath, desired);
      } else if (fs.realpathSync.native(actualPath) === fs.realpathSync.native(desired)) {
        const tmp = path.join(appData, APP_NAME + '.__rename_tmp__.' + process.pid);
        fs.renameSync(actualPath, tmp);
        fs.renameSync(tmp, desired);
      }
    }
    if (!fs.existsSync(desired)) fs.mkdirSync(desired, { recursive: true });
    if (typeof app.setPath === 'function') app.setPath('userData', desired);
  } catch (_) {
    /* fall back to Electron's default userData path */
  }
}

configureUserDataDir();

/**
 * Main-process entry point: Electron lifecycle only.
 *
 * Everything else lives in focused modules sharing state via ./state:
 *   window.js        BrowserWindow creation, tray hide/show wiring
 *   tray.js          tray icon + menu
 *   traffic.js       Clash API /traffic stream -> renderer
 *   admin.js         Windows admin detection / elevated relaunch
 *   update.js        app release update check
 *   core-adapters.js per-core capabilities, commands, assets, and config build
 *   core-control.js  config orchestration, core lifecycle, proxy guard, Clash API
 *   ipc.js           domain ipcMain registration (validation lives separately)
 */

// Windows keeps GPU on for Mica/DWM. Elsewhere disable hardware acceleration to
// cut idle RAM — there is no user toggle (it was a no-op on Windows).
if (process.platform !== 'win32') {
  app.disableHardwareAcceleration();
}
const { state, runtimeDir, resourcesBinDir, sendLog, sendStatus } = require('./state');
const { Store } = require('./store');
const { CoreManager } = require('./singbox');
const { createWindow, showMainWindow } = require('./window');
const { createTray } = require('./tray');
const { stopTrafficStream } = require('./traffic');
const core = require('./core-control');
const { registerIpc } = require('./ipc');
const { notify } = require('./notify');
const proxy = require('./proxy');
const uwp = require('./uwp');
const { isWindowsAdmin } = require('./admin');
const { cleanupTunAdapters } = require('./tun-adapter');

// Record fatal main-process failures before cleanup. Network request objects
// handle their own operational errors; reaching this boundary means process
// invariants can no longer be trusted and the app must not keep proxying.
function recordCrash(kind, err) {
  try {
    sendLog(`[gui] ${kind}: ${(err && err.message) || String(err)}`);
  } catch (_) {
    /* in-app logging is best-effort */
  }
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    // Simple rotation so the file cannot grow without bound.
    try {
      if (fs.statSync(file).size > 512 * 1024) {
        try { fs.unlinkSync(file + '.old'); } catch (_) {}
        try { fs.renameSync(file, file + '.old'); } catch (_) { fs.truncateSync(file, 0); }
      }
    } catch (_) {}
    const detail = (err && err.stack) || (err && err.message) || String(err);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  } catch (_) {
    /* disk logging is best-effort */
  }
}

let fatalExitStarted = false;
function handleFatalError(kind, error) {
  recordCrash(kind, error);
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  app.isQuitting = true;
  setImmediate(async () => {
    const hardExit = setTimeout(() => app.exit(1), 8000);
    try {
      if (state.singbox) await core.cleanup();
    } catch (cleanupError) {
      recordCrash('fatal cleanup failed', cleanupError);
      const ownedServer = state.systemProxyServer ||
        (state.store && core.persistedSystemProxyOwnership());
      if (ownedServer) proxy.disableSystemProxySyncIfOurs(ownedServer);
    } finally {
      clearTimeout(hardExit);
      app.exit(1);
    }
  });
}
process.on('uncaughtException', (error) => handleFatalError('uncaught exception', error));
process.on('unhandledRejection', (reason) => handleFatalError('unhandled rejection', reason));

async function applyPendingUwpLoopback() {
  const pending = state.store.get('pendingUwpLoopbackSids');
  if (!Array.isArray(pending)) return;
  if (process.platform !== 'win32') {
    state.store.set('pendingUwpLoopbackSids', null);
    return;
  }
  if (!(await isWindowsAdmin())) {
    sendLog('[gui] pending UWP loopback changes require administrator rights');
    return;
  }
  try {
    await uwp.setExemptions(pending);
    state.store.set('pendingUwpLoopbackSids', null);
    sendLog(`[gui] applied ${pending.length} pending UWP loopback exemption(s)`);
    const zh = (state.store.getSettings().language || 'zh') === 'zh';
    notify(
      zh ? 'UWP 回环豁免已应用' : 'UWP loopback applied',
      zh ? '已使用管理员权限应用所选 UWP 应用。' : 'The selected UWP apps were applied with administrator rights.'
    );
  } catch (e) {
    sendLog('[gui] pending UWP loopback apply failed: ' + e.message);
  }
}

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let revealWhenReady = false;
  app.on('second-instance', () => {
    if (!state.store || (typeof app.isReady === 'function' && !app.isReady())) {
      revealWhenReady = true;
      return;
    }
    showMainWindow();
  });

  app.whenReady().then(() => {
    state.store = new Store(app.getPath('userData'));
    const settings = state.store.getSettings();
    state.singbox = new CoreManager({
      resourcesDir: resourcesBinDir,
      runtimeDir,
      coreType: settings.coreType,
      onLog: sendLog,
      onExit: () => {
        stopTrafficStream();
        core.stopProxyGuard();
        if (state.systemProxyOn) {
          const ownedServer = state.systemProxyServer || core.persistedSystemProxyOwnership();
          if (ownedServer) {
            proxy.disableSystemProxyIfOurs(ownedServer)
              .then(() => {
                try { core.forgetSystemProxyOwnership(ownedServer); } catch (error) {
                  sendLog('[gui] failed to clear persisted system proxy ownership: ' + error.message);
                }
                // A new core may have started while the registry operation was
                // queued. Do not clear the ownership state of that newer run.
                if (!state.singbox.isRunning() && state.systemProxyServer === ownedServer) {
                  state.systemProxyOn = false;
                  state.systemProxyServer = null;
                }
              })
              .catch((e) => {
                // Keep ownership so a later Stop/Quit can retry instead of
                // forgetting a dead proxy that may still be active in Windows.
                sendLog('[gui] failed to clear system proxy after core exit: ' + e.message);
              })
              .finally(sendStatus);
          } else {
            sendLog('[gui] system proxy ownership endpoint is missing; left the current OS proxy unchanged');
            state.systemProxyOn = false;
            state.systemProxyServer = null;
            sendStatus();
          }
        } else {
          sendStatus();
        }
        // Unexpected exit (not a stop/restart we triggered, not during quit):
        // alert the user — the proxy is now down, which is easy to miss when
        // the app is sitting in the tray.
        if (!state.coreStopping && !app.isQuitting) {
          cleanupTunAdapters(sendLog).catch(() => {});
          const zh = (state.store.getSettings().language || 'zh') === 'zh';
          notify(
            zh ? '内核已停止' : 'Core stopped',
            zh ? '内核意外退出，代理可能已失效。' : `${state.singbox.coreLabel} exited unexpectedly; the proxy may be down.`
          );
        }
      },
    });
    registerIpc();
    // Sync the OS login-item state with the saved setting.
    try {
      core.applyAutoLaunch(settings.autoLaunch, settings.silentStart);
    } catch (error) {
      sendLog('[gui] failed to synchronize auto-launch at startup: ' + error.message);
    }
    // Clear a system proxy left dangling by a previous exit (so the machine
    // isn't left offline during the boot -> app-start window). Runs concurrently
    // with window load; the auto-resume below awaits it so the clear can't race
    // startCore re-enabling the proxy.
    const healDone = core.healStaleSystemProxy();
    // Silent start: keep the window in the tray when the setting is on, or when
    // launched at login with --hidden (set on the login item by applyAutoLaunch).
    const startHidden = !revealWhenReady && (!!settings.silentStart || process.argv.includes('--hidden'));
    createWindow(startHidden);
    createTray();
    core.rescheduleAutoUpdate();
    core.startGeoAutoUpdate();
    applyPendingUwpLoopback().catch((e) => sendLog('[gui] pending UWP loopback apply failed: ' + e.message));

    // Auto-resume: if the core was running at last quit, start it again so the
    // user does not have to click Start every time they open the app.
    if (state.store.get('lastRunning') && state.singbox.isCoreInstalled()) {
      // Core recovery is a main-process responsibility: a renderer load error
      // must not leave a tray-started app silently offline.
      healDone
        .catch(() => {}) // ensure any stale-proxy clear lands first
        .then(() => core.startCore())
        .catch((e) => sendLog('[gui] auto-resume failed: ' + e.message));
    }

    app.on('activate', () => {
      showMainWindow();
    });
  }).catch((error) => {
    recordCrash('startup failed', error);
    try {
      dialog.showErrorBox('Dart failed to start', (error && error.message) || String(error));
    } catch (_) {}
    app.isQuitting = true;
    app.quit();
  });

  app.on('window-all-closed', () => {
    // Tray stays resident; do not quit.
  });

  app.on('before-quit', async (e) => {
    if (!app.isQuitting) {
      app.isQuitting = true;
      e.preventDefault();
      try {
        await core.cleanup();
      } catch (error) {
        recordCrash('shutdown cleanup failed', error);
      } finally {
        app.quit();
      }
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
      const ownedServer = state.systemProxyServer || core.persistedSystemProxyOwnership();
      state.systemProxyOn = false;
      state.systemProxyServer = null;
      core.stopProxyGuard();
      proxy.beginShutdown();
      if (ownedServer) proxy.disableSystemProxySyncIfOurs(ownedServer);
    } catch (_) { /* best-effort */ }
  });
}
