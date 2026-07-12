'use strict';

const { execFile } = require('child_process');

const TUN_DEVICE_NAME = 'Dart';
const TUN_DISPLAY_NAME = 'Dart Tunnel';
const LEGACY_TUN_NAMES = ['tun0', 'Meta', TUN_DEVICE_NAME, TUN_DISPLAY_NAME];
const VIRTUAL_ADAPTER_PATTERN = 'sing-tun|wintun|mihomo|clash|meta|tun';
let adapterQueue = Promise.resolve();

function runPowerShell(script, timeout = 12000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function queueAdapterOperation(operation) {
  const task = adapterQueue.then(operation, operation);
  adapterQueue = task.catch(() => {});
  return task;
}

function cleanupScript() {
  const names = LEGACY_TUN_NAMES.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$ownedNames = @(${names})`,
    `$pattern = '${VIRTUAL_ADAPTER_PATTERN}'`,
    '$adapters = @(Get-CimInstance Win32_NetworkAdapter -ErrorAction SilentlyContinue | Where-Object {',
    '  $connection = [string]$_.NetConnectionID',
    '  $description = [string]$_.Name',
    '  if (-not $_.PNPDeviceID -or $ownedNames -notcontains $connection) { return $false }',
    "  if ($connection -eq 'tun0') { return $description -match 'sing-tun' }",
    "  if ($connection -eq 'Meta') { return $description -match 'mihomo|clash|meta' }",
    '  return $description -match $pattern',
    '})',
    '$failed = @()',
    'foreach ($adapter in $adapters) {',
    '  & "$env:SystemRoot\\System32\\pnputil.exe" /remove-device "$($adapter.PNPDeviceID)" | Out-Null',
    '  if ($LASTEXITCODE -ne 0) { $failed += $adapter.NetConnectionID }',
    '}',
    'if ($failed.Count -gt 0) { throw "could not remove: $($failed -join ", ")" }',
    'Write-Output $adapters.Count',
  ].join('\n');
}

function renameScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$pattern = '${VIRTUAL_ADAPTER_PATTERN}'`,
    'for ($attempt = 0; $attempt -lt 12; $attempt++) {',
    `  $display = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq '${TUN_DISPLAY_NAME}' -and $_.InterfaceDescription -match $pattern } | Select-Object -First 1`,
    '  if ($display) { exit 0 }',
    `  $adapter = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq '${TUN_DEVICE_NAME}' -and $_.InterfaceDescription -match $pattern } | Select-Object -First 1`,
    '  if ($adapter) {',
    `    Rename-NetAdapter -InputObject $adapter -NewName '${TUN_DISPLAY_NAME}' -Confirm:$false`,
    '    exit 0',
    '  }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    'exit 3',
  ].join('\n');
}

async function cleanupTunAdapters(log = () => {}) {
  if (process.platform !== 'win32') return true;
  return queueAdapterOperation(async () => {
    try {
      const removed = Number(await runPowerShell(cleanupScript())) || 0;
      if (removed) log(`[gui] removed ${removed} stale Dart/legacy TUN adapter(s)`);
      return true;
    } catch (error) {
      log('[gui] stale TUN adapter cleanup failed (non-fatal): ' + error.message);
      return false;
    }
  });
}

async function syncTunDisplayName(log = () => {}) {
  if (process.platform !== 'win32') return true;
  return queueAdapterOperation(async () => {
    try {
      await runPowerShell(renameScript(), 6000);
      log(`[gui] Windows TUN connection renamed to ${TUN_DISPLAY_NAME}`);
      return true;
    } catch (error) {
      log(`[gui] could not rename the Windows TUN connection to ${TUN_DISPLAY_NAME} (non-fatal): ${error.message}`);
      return false;
    }
  });
}

module.exports = {
  TUN_DEVICE_NAME,
  TUN_DISPLAY_NAME,
  cleanupScript,
  renameScript,
  cleanupTunAdapters,
  syncTunDisplayName,
};
