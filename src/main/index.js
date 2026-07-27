'use strict';

const { app, crashReporter, dialog } = require('electron');
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
    const crashDumps = path.join(desired, 'CrashDumps');
    if (!fs.existsSync(crashDumps)) fs.mkdirSync(crashDumps, { recursive: true });
    if (typeof app.setPath === 'function') app.setPath('crashDumps', crashDumps);
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
const { createWindow, showMainWindow, destroyWindow } = require('./window');
const { createTray } = require('./tray');
const { stopTrafficStream } = require('./traffic');
const core = require('./core-control');
const { registerIpc } = require('./ipc');
const { notify } = require('./notify');
const proxy = require('./proxy');
const uwp = require('./uwp');
const { isWindowsAdmin } = require('./admin');
const { cleanupTunAdapters } = require('./tun-adapter');

function diagnosticDetail(value) {
  if (value && typeof value.stack === 'string') return value.stack;
  if (value && typeof value.message === 'string') return value.message;
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) {}
  }
  return String(value);
}

// Persist failures and unexpected process exits with enough bounded context to
// distinguish the GUI, renderer, Electron child, and selected core.
function recordCrash(kind, err) {
  try {
    sendLog(`[gui] ${kind}: ${diagnosticDetail(err)}`);
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
    const coreType = state.singbox && typeof state.singbox.getCoreType === 'function'
      ? state.singbox.getCoreType()
      : 'unknown';
    const memory = process.memoryUsage();
    const context = [
      `app=${typeof app.getVersion === 'function' ? app.getVersion() : 'unknown'}`,
      `electron=${process.versions.electron || 'unknown'}`,
      `core=${coreType}`,
      `uptime=${Math.round(process.uptime())}s`,
      `rss=${Math.round(memory.rss / 1024 / 1024)}MB`,
    ].join(' ');
    fs.appendFileSync(
      file,
      `[${new Date().toISOString()}] ${kind} (${context}): ${diagnosticDetail(err)}\n`
    );
  } catch (_) {
    /* disk logging is best-effort */
  }
}

// Crashpad catches native main/renderer/GPU failures that JavaScript handlers
// and Windows Event Viewer do not reliably expose for an unsigned desktop app.
// Dumps stay local under %APPDATA%\Dart\CrashDumps and are never uploaded.
try {
  if (crashReporter && typeof crashReporter.start === 'function') {
    crashReporter.start({
      productName: 'Dart Network Control',
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
      globalExtra: {
        dartVersion: typeof app.getVersion === 'function' ? app.getVersion() : 'unknown',
        platform: process.platform,
      },
    });
  }
} catch (error) {
  recordCrash('native crash reporter setup failed', error);
}

const SESSION_MARKER_NAME = 'active-session.json';
let sessionMarkerFile = null;

function beginSessionDiagnostics(coreType) {
  try {
    sessionMarkerFile = path.join(app.getPath('userData'), SESSION_MARKER_NAME);
    try {
      const previous = JSON.parse(fs.readFileSync(sessionMarkerFile, 'utf-8'));
      recordCrash('previous session ended unexpectedly', previous);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        recordCrash('previous session marker could not be read', error);
      }
    }
    const marker = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: typeof app.getVersion === 'function' ? app.getVersion() : 'unknown',
      electron: process.versions.electron || 'unknown',
      coreType: coreType || 'unknown',
    };
    // A direct synchronous write is deliberate: Windows rename cannot replace
    // the prior marker atomically. A truncated marker is harmless and will be
    // replaced at the next start.
    fs.writeFileSync(sessionMarkerFile, JSON.stringify(marker), 'utf-8');
  } catch (error) {
    recordCrash('session diagnostics setup failed', error);
  }
}

function finishSessionDiagnostics() {
  if (!sessionMarkerFile) return;
  try { fs.unlinkSync(sessionMarkerFile); } catch (error) {
    if (error.code !== 'ENOENT') recordCrash('session diagnostics cleanup failed', error);
  }
  sessionMarkerFile = null;
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
// A rejected background network/IPC promise does not imply corrupted process
// invariants. Record it for diagnosis, but do not turn a recoverable async error
// into an unexplained full-app exit.
process.on('unhandledRejection', (reason) => recordCrash('unhandled rejection', reason));

let rendererRecoveryStarted = false;
app.on('render-process-gone', (_event, webContents, details) => {
  if (app.isQuitting || (details && details.reason === 'clean-exit')) return;
  recordCrash('renderer process gone', details);
  const win = state.mainWindow;
  if (
    rendererRecoveryStarted ||
    !win ||
    !webContents ||
    win.webContents !== webContents
  ) return;
  rendererRecoveryStarted = true;
  const restoreVisible = typeof win.isVisible !== 'function' || win.isVisible();
  state.mainWindow = null;
  try {
    destroyWindow(win, 'renderer-process-gone');
  } catch (_) {}
  setTimeout(() => {
    rendererRecoveryStarted = false;
    if (app.isQuitting || state.mainWindow) return;
    try {
      createWindow(!restoreVisible);
      if (restoreVisible) {
        const zh = !state.store || (state.store.getSettings().language || 'zh') === 'zh';
        notify(
          zh ? '界面已恢复' : 'Interface restored',
          zh ? '界面进程异常退出，Dart 已自动重新载入。' : 'The renderer exited unexpectedly and was reloaded.'
        );
      }
    } catch (error) {
      recordCrash('renderer recovery failed', error);
    }
  }, 250);
});

app.on('child-process-gone', (_event, details) => {
  if (app.isQuitting || (details && details.reason === 'clean-exit')) return;
  recordCrash('Electron child process gone', details);
});

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
      onExit: (code, signal) => {
        stopTrafficStream();
        core.stopProxyGuard();
        const ownedServer = state.systemProxyServer || core.persistedSystemProxyOwnership();
        if (state.systemProxyOn || ownedServer) {
          if (ownedServer) {
            // Prefer the owned restore path so ProxyOverride is put back after a crash.
            const release = typeof core.disableOwnedSystemProxy === 'function'
              ? core.disableOwnedSystemProxy(ownedServer)
              : proxy.disableSystemProxyIfOurs(ownedServer);
            release
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
          recordCrash('core exited unexpectedly', {
            coreType: state.singbox.getCoreType(),
            coreLabel: state.singbox.coreLabel,
            code,
            signal,
          });
          cleanupTunAdapters(sendLog).catch(() => {});
          const zh = (state.store.getSettings().language || 'zh') === 'zh';
          notify(
            zh ? '内核已停止' : 'Core stopped',
            zh ? '内核意外退出，代理可能已失效。' : `${state.singbox.coreLabel} exited unexpectedly; the proxy may be down.`
          );
        }
      },
    });
    beginSessionDiagnostics(settings.coreType);
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
        finishSessionDiagnostics();
        app.quit();
      }
    } else {
      finishSessionDiagnostics();
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
      finishSessionDiagnostics();
      const ownedServer = state.systemProxyServer || core.persistedSystemProxyOwnership();
      state.systemProxyOn = false;
      state.systemProxyServer = null;
      core.stopProxyGuard();
      proxy.beginShutdown();
      if (ownedServer) proxy.disableSystemProxySyncIfOurs(ownedServer);
    } catch (_) { /* best-effort */ }
  });
}
