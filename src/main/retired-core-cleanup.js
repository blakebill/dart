'use strict';

const fs = require('fs');
const path = require('path');

const CLEANUP_MARKER = '.retired-core-cleanup-v1';
const RETIRED_DIRS = ['singbox', 'sing-box'];
const RETIRED_ROOT_FILES = ['sing-box', 'sing-box.exe', 'config.json'];
const RETIRED_LEGACY_FILE = /^(?:sing-box(?:\.exe)?|geodata-meta\.json|rp-[a-f0-9]+\.json|.+\.srs)$/i;

function removeOwnedPath(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  // Never follow a link while recursively removing an app-owned legacy folder.
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } else {
    fs.rmSync(target, { force: true });
  }
  return true;
}

/**
 * One-time removal of runtime artifacts from the retired core. This migration
 * is intentionally isolated from CoreManager and can be deleted after the
 * supported upgrade window has passed.
 */
function cleanupRetiredCoreArtifacts(runtimeDir, onLog = () => {}) {
  const marker = path.join(runtimeDir, CLEANUP_MARKER);
  if (fs.existsSync(marker)) return { completed: true, skipped: true, removed: 0 };

  const failures = [];
  const targets = [
    ...RETIRED_DIRS.map((name) => path.join(runtimeDir, name)),
    ...RETIRED_ROOT_FILES.map((name) => path.join(runtimeDir, name)),
  ];
  for (const dir of [runtimeDir, path.join(runtimeDir, 'bin')]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (RETIRED_LEGACY_FILE.test(name)) targets.push(path.join(dir, name));
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') failures.push(error);
    }
  }

  let removed = 0;
  for (const target of new Set(targets)) {
    try {
      if (removeOwnedPath(target)) removed += 1;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) {
    onLog(`[gui] retired core cleanup will retry on next start: ${failures[0].message}`);
    return { completed: false, skipped: false, removed, failures };
  }

  try {
    fs.writeFileSync(marker, '1\n', { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (error && error.code !== 'EEXIST') {
      onLog(`[gui] retired core cleanup marker was not saved; cleanup will retry: ${error.message}`);
      return { completed: false, skipped: false, removed, failures: [error] };
    }
  }
  if (removed) onLog(`[gui] removed ${removed} retired core artifact${removed === 1 ? '' : 's'}`);
  return { completed: true, skipped: false, removed };
}

module.exports = { CLEANUP_MARKER, cleanupRetiredCoreArtifacts };
