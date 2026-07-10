'use strict';

const { exec, execSync } = require('child_process');

/**
 * Windows system proxy settings (via the registry).
 * No-op on non-Windows platforms, to ease development on Linux/Mac.
 */

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

const REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Enable the system proxy, pointing at local host:port. */
async function enableSystemProxy(host, port) {
  if (process.platform !== 'win32') return false;
  const server = `${host}:${port}`;
  const private172 = Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`).join(';');
  // Write the complete configuration before flipping ProxyEnable. If either
  // preparatory write fails, Windows keeps using its previous proxy state.
  await run(`reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${server}" /f`);
  await run(
    `reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "localhost;127.*;10.*;${private172};192.168.*;169.254.*;<local>" /f`
  );
  await run(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
  await refreshSettings();
  return true;
}

/** Disable the system proxy. */
async function disableSystemProxy() {
  if (process.platform !== 'win32') return false;
  await run(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`);
  await refreshSettings();
  return true;
}

/**
 * Disable the system proxy synchronously. On OS shutdown / log-off the app gets
 * only a brief window before it's killed, too short for the async path above to
 * finish — so flip ProxyEnable to 0 with a blocking reg write (skipping the
 * WinINet refresh, which doesn't matter when the session is ending anyway). The
 * persisted registry value is what keeps the next boot online.
 */
function disableSystemProxySync() {
  if (process.platform !== 'win32') return false;
  try {
    execSync(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`, {
      windowsHide: true,
      timeout: 3000,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Synchronously clear the system proxy, but only when it currently points at
 * `server` (our local port) — so we never wipe a proxy the user set themselves.
 * Reads the registry directly (sync) instead of trusting in-memory state, which
 * can be stale by the time the OS is tearing the session down. Used from the
 * shutdown / log-off handler, where the persisted ProxyEnable=0 is what keeps
 * the next boot online before the app has a chance to run.
 */
function disableSystemProxySyncIfOurs(server) {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync(`reg query "${REG_PATH}" /v ProxyServer`, {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf-8',
    });
    if (!out.includes(server)) return false; // not ours (or unset) — leave it alone
  } catch (_) {
    return false; // ProxyServer not set / query failed — nothing of ours to clear
  }
  return disableSystemProxySync();
}

/**
 * Whether the system proxy is currently enabled and points at the given server.
 * Used to detect other software overriding our setting.
 */
async function isSystemProxyActive(server) {
  if (process.platform !== 'win32') return true;
  try {
    const enable = await run(`reg query "${REG_PATH}" /v ProxyEnable`);
    if (!/0x1\b/.test(enable)) return false;
    const srv = await run(`reg query "${REG_PATH}" /v ProxyServer`);
    return srv.includes(server);
  } catch (e) {
    return false;
  }
}

/**
 * Notify the system that Internet settings have changed.
 * Editing the registry directly does not take effect immediately; we must trigger
 * WinINet's InternetSetOption to refresh. Here we call the corresponding Win32 API
 * via PowerShell.
 */
async function refreshSettings() {
  if (process.platform !== 'win32') return;
  const ps = [
    '$sig = @"',
    '[DllImport("wininet.dll", SetLastError = true)]',
    'public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
    '"@',
    'try {',
    '  $type = Add-Type -MemberDefinition $sig -Name WinINet -Namespace Win32 -PassThru -ErrorAction Stop',
    '  $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null', // INTERNET_OPTION_SETTINGS_CHANGED
    '  $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null', // INTERNET_OPTION_REFRESH
    '} catch {}',
  ].join('; ');
  try {
    await run(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`);
  } catch (e) {
    // A failed refresh does not affect the main flow.
  }
}

module.exports = {
  enableSystemProxy,
  disableSystemProxy,
  disableSystemProxySync,
  disableSystemProxySyncIfOurs,
  isSystemProxyActive,
};
