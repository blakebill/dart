'use strict';

const { app, dialog } = require('electron');

const { state, isDev, sendLog } = require('./state');

/** Windows administrator detection and elevated relaunch (needed for TUN). */

function isWindowsAdmin() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(true);
    require('child_process').exec('net session', { windowsHide: true }, (err) => resolve(!err));
  });
}

/** Relaunch the whole app elevated (UAC). sing-box then inherits admin for TUN. */
function relaunchElevated() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'only supported on Windows' };
  }
  const { spawnSync } = require('child_process');
  const exe = process.execPath;
  // In dev, execPath is electron.exe and we must pass the app dir as an argument.
  const argList = isDev ? `-ArgumentList '${process.cwd().replace(/'/g, "''")}' ` : '';
  const psExe = `'${exe.replace(/'/g, "''")}'`;
  const cmd = `Start-Process -FilePath ${psExe} ${argList}-Verb RunAs`;
  sendLog('[gui] relaunch elevated: ' + cmd);
  // Release the single-instance lock BEFORE launching, so the elevated copy can
  // acquire it during its startup; otherwise it detects us as the primary
  // instance and exits immediately (the "doesn't restart" bug).
  try { app.releaseSingleInstanceLock(); } catch (_) {}
  const r = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], {
    windowsHide: true,
    encoding: 'utf-8',
  });
  if (r.error || r.status !== 0) {
    const msg = r.error ? r.error.message : (r.stderr || '').trim() || 'UAC declined (exit ' + r.status + ')';
    sendLog('[gui] relaunch failed: ' + msg);
    try { app.requestSingleInstanceLock(); } catch (_) {} // we are staying; reclaim the lock
    return { ok: false, error: msg };
  }
  // Elevated instance created (post-UAC). Quit so it can take over.
  app.isQuitting = true;
  setTimeout(() => app.quit(), 200);
  return { ok: true };
}

/**
 * Show the "TUN needs admin" prompt. On accept, trigger an elevated relaunch and
 * return true; on decline (or when there's no window to anchor the dialog),
 * return false. Shared by the tun:set IPC handler and ensureAdminForTun.
 */
async function promptRestartForTun() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(state.mainWindow, {
    type: 'warning',
    buttons: ['Restart as administrator', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: 'TUN mode requires administrator rights',
    detail: 'Restart Dart Network Control as administrator to enable TUN mode?',
  });
  if (response === 0) {
    const result = relaunchElevated();
    if (!result || result.ok === false) {
      throw new Error((result && result.error) || 'failed to restart as administrator');
    }
    return true;
  }
  return false;
}

/**
 * If TUN is enabled but we are not elevated, offer to restart as administrator.
 * Returns true when the caller should abort (a relaunch was triggered); throws
 * if the user declines (or there's no window).
 */
async function ensureAdminForTun() {
  const settings = state.store.getSettings();
  if (!settings.enableTun) return false;
  if (await isWindowsAdmin()) return false;
  if (await promptRestartForTun()) return true;
  throw new Error('TUN mode requires administrator rights.');
}

module.exports = { isWindowsAdmin, relaunchElevated, promptRestartForTun, ensureAdminForTun };
