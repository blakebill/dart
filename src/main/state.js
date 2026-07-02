'use strict';

const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * Shared main-process state and the helpers every module needs.
 *
 * The mutable references (mainWindow, tray, store, singbox, systemProxyOn)
 * live on the exported `state` object and are assigned during boot in
 * index.js. Modules must read them at call time (state.store.get(...)),
 * never destructure them at load time.
 */

const isDev = process.argv.includes('--dev');

const state = {
  isDev,
  // Assigned during boot:
  mainWindow: null,
  tray: null,
  store: null,
  singbox: null,
  // Whether this app currently owns the OS proxy setting.
  systemProxyOn: false,
  // Per-run Clash API secret: without it, ANY local process (or a web page via
  // DNS-rebinding) could drive the core on 127.0.0.1 — switch nodes, read the
  // connection log, kill the proxy. Rotated on every app start.
  clashApiSecret: crypto.randomBytes(16).toString('hex'),
};

// Runtime directory: under the user data dir for easy read/write.
const runtimeDir = path.join(app.getPath('userData'), 'runtime');
// Directory of the bundled core after packaging: resources/bin
const resourcesBinDir = isDev
  ? path.join(__dirname, '..', '..', 'bin')
  : path.join(process.resourcesPath, 'bin');

function sendLog(line) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('singbox:log', line);
  }
}

// The tray module registers its menu refresher here, so core-control can
// refresh the tray without requiring tray.js (which requires core-control —
// a require cycle CommonJS would resolve with partially-built exports).
let trayRefresher = null;
function setTrayRefresher(fn) {
  trayRefresher = fn;
}
function refreshTray() {
  if (trayRefresher) trayRefresher();
}

function sendStatus() {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('singbox:status', {
      running: state.singbox.isRunning(),
      systemProxy: state.systemProxyOn,
      coreInstalled: state.singbox.isCoreInstalled(),
      coreType: state.singbox.getCoreType(),
      coreName: state.singbox.coreLabel,
    });
  }
  refreshTray();
}

/** Full core/proxy status, including the (cached) core path + version. */
async function coreStatusInfo() {
  return {
    running: state.singbox.isRunning(),
    systemProxy: state.systemProxyOn,
    coreType: state.singbox.getCoreType(),
    coreName: state.singbox.coreLabel,
    coreInstalled: state.singbox.isCoreInstalled(),
    corePath: state.singbox.resolveBinaryPath(),
    coreVersion: await state.singbox.getCoreVersion(),
  };
}

module.exports = {
  state,
  isDev,
  runtimeDir,
  resourcesBinDir,
  sendLog,
  sendStatus,
  coreStatusInfo,
  setTrayRefresher,
  refreshTray,
};
