'use strict';

const { exec, execFile, execSync } = require('child_process');

/**
 * Windows system proxy settings (via the registry).
 * No-op on non-Windows platforms, to ease development on Linux/Mac.
 */

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

const REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
let proxyOperationQueue = Promise.resolve();
let shuttingDown = false;

/** Extract one value from `reg query` output without substring matching. */
function registryValue(output, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(output || '').match(new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'im'));
  return match ? match[1].trim() : null;
}

function registryDwordEnabled(output, name = 'ProxyEnable') {
  const value = registryValue(output, name);
  if (value === null) return false;
  const parsed = /^0x/i.test(value) ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  return parsed === 1;
}

function proxyServerMatches(output, server) {
  const value = registryValue(output, 'ProxyServer');
  return value !== null && value.toLowerCase() === String(server || '').trim().toLowerCase();
}

function runReg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
      encoding: 'utf-8',
    }, (error, stdout, stderr) => {
      if (error) {
        if (stderr) error.message = String(stderr).trim() || error.message;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function readRegistrySetting(name) {
  try {
    const output = await runReg(['query', REG_PATH, '/v', name]);
    const value = registryValue(output, name);
    if (value === null) throw new Error('registry query returned no ' + name);
    return { exists: true, value };
  } catch (error) {
    if (error && error.code === 1) return { exists: false, value: null };
    throw error;
  }
}

function writeRegistrySetting(name, type, value) {
  return runReg(['add', REG_PATH, '/v', name, '/t', type, '/d', String(value), '/f']);
}

async function deleteRegistrySetting(name) {
  try {
    await runReg(['delete', REG_PATH, '/v', name, '/f']);
  } catch (error) {
    if (!error || error.code !== 1) throw error;
  }
}

async function restoreProxySettings(snapshot) {
  let firstError = null;
  const attempt = async (operation) => {
    try { await operation(); } catch (error) { if (!firstError) firstError = error; }
  };
  await attempt(() => writeRegistrySetting('ProxyEnable', 'REG_DWORD', 0));
  for (const [name, type, previous] of [
    ['ProxyServer', 'REG_SZ', snapshot.server],
    ['ProxyOverride', 'REG_SZ', snapshot.override],
  ]) {
    await attempt(() => previous.exists
      ? writeRegistrySetting(name, type, previous.value)
      : deleteRegistrySetting(name));
  }
  await attempt(() => snapshot.enable.exists
    ? writeRegistrySetting('ProxyEnable', 'REG_DWORD', snapshot.enable.value)
    : deleteRegistrySetting('ProxyEnable'));
  try { await refreshSettings(); } catch (_) {}
  if (firstError) throw firstError;
}

function queueProxyOperation(operation) {
  const task = proxyOperationQueue.then(operation, operation);
  proxyOperationQueue = task.catch(() => {});
  return task;
}

/** Enable the system proxy, pointing at local host:port. */
async function enableSystemProxy(host, port) {
  if (process.platform !== 'win32' || shuttingDown) return false;
  return queueProxyOperation(async () => {
    if (shuttingDown) return false;
    const server = `${host}:${port}`;
    const private172 = Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`).join(';');
    const [enable, previousServer, override] = await Promise.all([
      readRegistrySetting('ProxyEnable'),
      readRegistrySetting('ProxyServer'),
      readRegistrySetting('ProxyOverride'),
    ]);
    const snapshot = { enable, server: previousServer, override };
    let changed = false;
    try {
      // Turn off any previous proxy while its endpoint is being replaced, so a
      // partial write can never make Windows use a half-written configuration.
      await writeRegistrySetting('ProxyEnable', 'REG_DWORD', 0);
      changed = true;
      if (shuttingDown) throw Object.assign(new Error('app is shutting down'), { code: 'DART_SHUTDOWN' });
      await writeRegistrySetting('ProxyServer', 'REG_SZ', server);
      if (shuttingDown) throw Object.assign(new Error('app is shutting down'), { code: 'DART_SHUTDOWN' });
      await writeRegistrySetting(
        'ProxyOverride',
        'REG_SZ',
        `localhost;127.*;10.*;${private172};192.168.*;169.254.*;<local>`
      );
      if (shuttingDown) throw Object.assign(new Error('app is shutting down'), { code: 'DART_SHUTDOWN' });
      await writeRegistrySetting('ProxyEnable', 'REG_DWORD', 1);
      if (shuttingDown) throw Object.assign(new Error('app is shutting down'), { code: 'DART_SHUTDOWN' });
      await refreshSettings();
      return true;
    } catch (error) {
      if (changed) {
        try { await restoreProxySettings(snapshot); } catch (restoreError) { error.restoreError = restoreError; }
      }
      if (error.code === 'DART_SHUTDOWN') return false;
      throw error;
    }
  });
}

function beginShutdown() {
  shuttingDown = true;
}

/** Disable the proxy only while the registry still points at our exact endpoint. */
async function disableSystemProxyIfOurs(server) {
  if (process.platform !== 'win32' || !server) return false;
  return queueProxyOperation(async () => {
    const enabled = await runReg(['query', REG_PATH, '/v', 'ProxyEnable']);
    if (!registryDwordEnabled(enabled)) return false;
    const current = await runReg(['query', REG_PATH, '/v', 'ProxyServer']);
    if (!proxyServerMatches(current, server)) return false;
    await writeRegistrySetting('ProxyEnable', 'REG_DWORD', 0);
    await refreshSettings();
    return true;
  });
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
    if (!proxyServerMatches(out, server)) return false; // not ours (or unset) — leave it alone
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
    const enable = await runReg(['query', REG_PATH, '/v', 'ProxyEnable']);
    if (!registryDwordEnabled(enable)) return false;
    const srv = await runReg(['query', REG_PATH, '/v', 'ProxyServer']);
    return proxyServerMatches(srv, server);
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
  disableSystemProxyIfOurs,
  beginShutdown,
  disableSystemProxySyncIfOurs,
  isSystemProxyActive,
  registryValue,
  registryDwordEnabled,
  proxyServerMatches,
};
