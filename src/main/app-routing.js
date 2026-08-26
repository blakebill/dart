'use strict';

const { execFile } = require('child_process');
const path = require('path');

const PROCESS_CACHE_MS = 5_000;
const MAX_PROCESS_ROWS = 400;
const MAX_PROCESS_OUTPUT = 512 * 1024;
let cached = { expires: 0, rows: [] };
let pending = null;

function boundedProcessName(value) {
  const name = path.win32.basename(String(value || '').trim()).slice(0, 260);
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) return '';
  return name;
}

function normalizeProcessRows(value) {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    let executable = boundedProcessName(row.executable || row.Executable || row.path || row.Path);
    const processName = boundedProcessName(row.name || row.Name);
    if (!executable && processName) executable = /\.exe$/i.test(processName) ? processName : processName + '.exe';
    if (!executable || seen.has(executable.toLowerCase())) continue;
    seen.add(executable.toLowerCase());
    normalized.push({
      name: processName.replace(/\.exe$/i, '') || executable.replace(/\.exe$/i, ''),
      executable,
    });
    if (normalized.length >= MAX_PROCESS_ROWS) break;
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function powershellProcesses(execute = execFile) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$rows=Get-Process | ForEach-Object {',
    '  $p=$_.Path',
    '  $exe=if($p){[IO.Path]::GetFileName($p)}else{$_.ProcessName+".exe"}',
    '  [PSCustomObject]@{name=$_.ProcessName;executable=$exe}',
    '}',
    '$rows | Sort-Object executable -Unique | ConvertTo-Json -Compress',
  ].join(';');
  return new Promise((resolve, reject) => {
    execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 5_000, maxBuffer: MAX_PROCESS_OUTPUT, encoding: 'utf-8' },
      (error, stdout) => {
        if (error) return reject(new Error('unable to list running applications'));
        try {
          resolve(normalizeProcessRows(stdout.trim() ? JSON.parse(stdout) : []));
        } catch (_) {
          reject(new Error('invalid running application list'));
        }
      }
    );
  });
}

function listRunningApplications(options = {}) {
  const now = Date.now();
  if (!options.force && cached.expires > now) return Promise.resolve(cached.rows);
  if (pending) return pending;
  pending = powershellProcesses(options.execute).then((rows) => {
    cached = { expires: Date.now() + PROCESS_CACHE_MS, rows };
    return rows;
  }).finally(() => {
    pending = null;
  });
  return pending;
}

function clearProcessCache() {
  cached = { expires: 0, rows: [] };
}

module.exports = {
  clearProcessCache,
  listRunningApplications,
  normalizeProcessRows,
  powershellProcesses,
};
