'use strict';

const { app, dialog } = require('electron');

const { state, isDev, sendLog } = require('./state');

/** Windows administrator detection and elevated relaunch (needed for TUN). */

const ADMIN_ROLE_SCRIPT = [
  '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
  '$principal=New-Object Security.Principal.WindowsPrincipal($identity)',
  '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
].join(';');

function isWindowsAdmin() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(true);
    const { exec, execFile } = require('child_process');
    const options = {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: 'utf-8',
    };
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ADMIN_ROLE_SCRIPT], options, (error, stdout) => {
      const answer = String(stdout || '').trim();
      if (!error && /^(?:true|false)$/i.test(answer)) return resolve(/^true$/i.test(answer));
      // Very old or locked-down systems may block PowerShell. Keep the former
      // probe as a conservative fallback rather than assuming elevation.
      exec('net session', options, (fallbackError) => resolve(!fallbackError));
    });
  });
}

function isWindowsAdminSync() {
  if (process.platform !== 'win32') return true;
  const { spawnSync } = require('child_process');
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ADMIN_ROLE_SCRIPT],
      { windowsHide: true, timeout: 5000, encoding: 'utf-8' }
    );
    const answer = String(result.stdout || '').trim();
    if (result.status === 0 && /^(?:true|false)$/i.test(answer)) return /^true$/i.test(answer);
  } catch (_) {
    /* use the legacy fallback below */
  }
  try {
    return spawnSync('net', ['session'], { windowsHide: true, timeout: 5000 }).status === 0;
  } catch (_) {
    return false;
  }
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Elevated helper waits for this instance to exit before launching its replacement. */
function buildElevatedHandoffScript(exe, args, pid = process.pid) {
  const argumentList = args.length ? ` -ArgumentList @(${args.map(psLiteral).join(',')})` : '';
  return [
    `try { Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue } catch {}`,
    `Start-Process -FilePath ${psLiteral(exe)}${argumentList}`,
  ].join('; ');
}

function buildElevatedLauncherCommand(exe, args, pid = process.pid) {
  const handoff = buildElevatedHandoffScript(exe, args, pid);
  const encoded = Buffer.from(handoff, 'utf16le').toString('base64');
  return "Start-Process -FilePath 'powershell.exe' " +
    `-ArgumentList @('-NoProfile','-WindowStyle','Hidden','-EncodedCommand','${encoded}') ` +
    '-Verb RunAs -WindowStyle Hidden -ErrorAction Stop';
}

/** Relaunch the whole app elevated (UAC). Mihomo then inherits admin for TUN. */
function relaunchElevated() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'only supported on Windows' };
  }
  const { spawnSync } = require('child_process');
  const exe = process.execPath;
  // In dev, execPath is electron.exe and it needs both the app directory and the
  // --dev marker. The elevated helper waits for this PID, so the old instance can
  // keep the single-instance lock until its core/proxy/TUN cleanup has completed.
  const launchArgs = isDev ? [process.cwd(), '--dev'] : [];
  const cmd = buildElevatedLauncherCommand(exe, launchArgs);
  sendLog('[gui] requesting an elevated relaunch with clean process handoff');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], {
    windowsHide: true,
    encoding: 'utf-8',
  });
  if (r.error || r.status !== 0) {
    const msg = r.error ? r.error.message : (r.stderr || '').trim() || 'UAC declined (exit ' + r.status + ')';
    sendLog('[gui] relaunch failed: ' + msg);
    return { ok: false, error: msg };
  }
  // UAC accepted. The elevated helper is waiting for this PID; cleanly stop the
  // core and restore OS networking before releasing the lock and exiting.
  setImmediate(async () => {
    try {
      await require('./core-control').cleanup();
    } catch (error) {
      sendLog('[gui] cleanup before elevated relaunch failed: ' + error.message);
    } finally {
      app.isQuitting = true;
      app.quit();
    }
  });
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

module.exports = {
  isWindowsAdmin,
  isWindowsAdminSync,
  relaunchElevated,
  promptRestartForTun,
  ensureAdminForTun,
  buildElevatedHandoffScript,
};
