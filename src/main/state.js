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
  // Installed by ipc.js; cleanup invokes it before stopping the core so active
  // installer/core downloads cannot keep writing while Electron exits.
  cancelPendingUpdates: null,
  // Whether this app currently owns the OS proxy setting.
  systemProxyOn: false,
  // Exact endpoint written to ProxyServer. Settings can change before a stop,
  // so ownership checks must not reconstruct this from the latest port.
  systemProxyServer: null,
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

function sendToMain(channel, payload) {
  const win = state.mainWindow;
  if (
    !win ||
    (typeof win.isDestroyed === 'function' && win.isDestroyed()) ||
    !win.webContents ||
    (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed())
  ) return false;
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch (_) {
    return false;
  }
}

const RECENT_LOG_LIMIT = 120000;
const RECENT_LOG_LINE_LIMIT = 16 * 1024;
// Cap history handed to the renderer so opening the Logs tab stays light.
const RECENT_LOG_HISTORY_ENTRIES = 800;
let recentLogs = [];
let recentLogStart = 0;
let recentLogChars = 0;
let logSequence = 0;

function sendLog(line) {
  line = String(line === undefined || line === null ? '' : line);
  if (line.length > RECENT_LOG_LINE_LIMIT) line = line.slice(0, RECENT_LOG_LINE_LIMIT);
  const entry = { sequence: ++logSequence, line };
  recentLogs.push(entry);
  recentLogChars += line.length + 1;
  while (recentLogChars > RECENT_LOG_LIMIT && recentLogStart < recentLogs.length - 1) {
    recentLogChars -= recentLogs[recentLogStart++].line.length + 1;
  }
  if (recentLogStart > 1000 && recentLogStart * 2 > recentLogs.length) {
    recentLogs = recentLogs.slice(recentLogStart);
    recentLogStart = 0;
  }
  sendToMain('singbox:log', entry);
}

function getRecentLogs() {
  const start = Math.max(recentLogStart, recentLogs.length - RECENT_LOG_HISTORY_ENTRIES);
  return {
    sequence: logSequence,
    entries: recentLogs.slice(start),
  };
}

function clearRecentLogs() {
  recentLogs = [];
  recentLogStart = 0;
  recentLogChars = 0;
}

// The tray module registers its menu refresher here, so core-control can
// refresh the tray without requiring tray.js (which requires core-control —
// a require cycle CommonJS would resolve with partially-built exports).
let trayRefresher = null;
function setTrayRefresher(fn) {
  trayRefresher = fn;
}
function refreshTray() {
  try {
    if (trayRefresher) trayRefresher();
  } catch (_) {
    /* Tray teardown must not make a completed core operation fail. */
  }
}

function sendStatus() {
  sendToMain('singbox:status', {
    running: state.singbox.isRunning(),
    systemProxy: state.systemProxyOn,
    coreInstalled: state.singbox.isCoreInstalled(),
    coreType: state.singbox.getCoreType(),
    coreName: state.singbox.coreLabel,
  });
  refreshTray();
}

/** Full core/proxy status, including the (cached) core path + version. */
async function coreStatusInfo() {
  const manager = state.singbox;
  let probedType = manager.getCoreType();
  let coreVersion = await manager.getCoreVersion(probedType);
  // A version probe can take several seconds for a broken executable. If the
  // user switched cores meanwhile, probe the new target once so path, name and
  // version never come from different runtimes.
  if (manager.getCoreType() !== probedType) {
    probedType = manager.getCoreType();
    coreVersion = await manager.getCoreVersion(probedType);
  }
  const coreType = manager.getCoreType();
  if (coreType !== probedType) coreVersion = null;
  return {
    running: manager.isRunning(),
    systemProxy: state.systemProxyOn,
    coreType,
    coreName: manager.coreLabelFor(coreType),
    coreInstalled: manager.isCoreInstalled(coreType),
    corePath: manager.resolveBinaryPath(coreType),
    coreVersion,
  };
}

module.exports = {
  state,
  isDev,
  runtimeDir,
  resourcesBinDir,
  sendToMain,
  sendLog,
  getRecentLogs,
  clearRecentLogs,
  sendStatus,
  coreStatusInfo,
  setTrayRefresher,
  refreshTray,
};
