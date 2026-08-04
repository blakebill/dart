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

function registrySettingEnabled(setting) {
  if (!setting || !setting.exists) return false;
  const value = String(setting.value || '').trim();
  const parsed = /^0x/i.test(value) ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  return parsed === 1;
}

function registrySettingsEqual(left, right) {
  return !!left && !!right &&
    left.exists === right.exists &&
    (!left.exists || String(left.value).trim().toLowerCase() === String(right.value).trim().toLowerCase());
}

function registrySetting(output, name) {
  const value = registryValue(output, name);
  return value === null
    ? { exists: false, value: null }
    : { exists: true, value };
}

function proxyRegistrySnapshot(output) {
  return {
    enable: registrySetting(output, 'ProxyEnable'),
    server: registrySetting(output, 'ProxyServer'),
    override: registrySetting(output, 'ProxyOverride'),
  };
}

function isInterruptedProxyApply(current, restore) {
  return !!(
    current &&
    restore &&
    !registrySettingEnabled(current.enable) &&
    registrySettingsEqual(current.server, restore.server) &&
    registrySettingsEqual(current.override, restore.override)
  );
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

async function readProxyRegistrySnapshot() {
  try {
    // Query the Internet Settings key once. The guard runs twice a minute, so
    // one process instead of separate ProxyEnable/ProxyServer queries removes
    // a steady stream of short-lived reg.exe processes.
    return proxyRegistrySnapshot(await runReg(['query', REG_PATH]));
  } catch (error) {
    if (error && error.code === 1) return proxyRegistrySnapshot('');
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

/**
 * Enable the system proxy, pointing at local host:port.
 * On success returns `{ ok: true, restore }` where `restore` is the prior
 * registry snapshot (ProxyEnable / ProxyServer / ProxyOverride) so callers can
 * put the user's bypass list back when Dart releases ownership.
 */
async function enableSystemProxy(host, port, options = {}) {
  if (process.platform !== 'win32' || shuttingDown) return false;
  return queueProxyOperation(async () => {
    if (shuttingDown) return false;
    const server = `${host}:${port}`;
    const private172 = Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`).join(';');
    const snapshot = await readProxyRegistrySnapshot();
    let changed = false;
    try {
      // The caller persists both ownership and this restore snapshot before the
      // first registry write. A hard crash anywhere below can then be repaired
      // on the next launch, including the brief ProxyEnable=0 transition.
      if (typeof options.beforeApply === 'function') await options.beforeApply(snapshot);
      // Turn off any previous proxy while its endpoint is being replaced, so a
      // partial write can never make Windows use a half-written configuration.
      changed = true;
      await writeRegistrySetting('ProxyEnable', 'REG_DWORD', 0);
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
      return { ok: true, restore: snapshot };
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

/**
 * Disable (or fully restore) the proxy only while the registry still points at
 * our exact endpoint. When `options.restore` is the snapshot taken before Dart
 * overwrote ProxyOverride / ProxyServer, the user's prior bypass list and
 * enable state are put back instead of only flipping ProxyEnable to 0.
 */
async function disableSystemProxyIfOurs(server, options = {}) {
  if (process.platform !== 'win32' || !server) return false;
  return queueProxyOperation(async () => {
    let current;
    try {
      current = await readProxyRegistrySnapshot();
    } catch (_) {
      return false;
    }
    const owned = current.server.exists &&
      String(current.server.value).trim().toLowerCase() === String(server).trim().toLowerCase();
    // If the process died immediately after disabling ProxyEnable, ProxyServer
    // and ProxyOverride still equal the saved pre-Dart snapshot. Treat only that
    // exact state as interrupted ownership; an unrelated proxy remains untouched.
    const interrupted = !!(
      options.restoreInterrupted &&
      isInterruptedProxyApply(current, options.restore)
    );
    if (!owned && !interrupted) return false;
    if (options.restore) {
      await restoreProxySettings(options.restore);
      return true;
    }
    if (!registrySettingEnabled(current.enable)) return false;
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
    const current = await readProxyRegistrySnapshot();
    return registrySettingEnabled(current.enable) &&
      current.server.exists &&
      String(current.server.value).trim().toLowerCase() === String(server || '').trim().toLowerCase();
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
  restoreProxySettings,
  beginShutdown,
  disableSystemProxySyncIfOurs,
  isSystemProxyActive,
  registryValue,
  registryDwordEnabled,
  registrySettingEnabled,
  registrySettingsEqual,
  proxyRegistrySnapshot,
  isInterruptedProxyApply,
  proxyServerMatches,
};
