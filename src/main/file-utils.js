'use strict';

const crypto = require('crypto');
const fs = require('fs');

function uniqueSibling(filePath, suffix) {
  return `${filePath}.${suffix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Replace a file without exposing a partially-written destination. */
function replaceFileSync(source, target) {
  try {
    fs.renameSync(source, target);
    return;
  } catch (directError) {
    // libuv normally replaces an existing target atomically. Keep the backup
    // path only for filesystems that reject that form of rename.
    if (!fs.existsSync(source) || !fs.existsSync(target)) throw directError;
  }

  const backup = uniqueSibling(target, 'backup');
  let installed = false;
  fs.renameSync(target, backup);
  try {
    fs.renameSync(source, target);
    installed = true;
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(target)) {
      try {
        fs.renameSync(backup, target);
      } catch (restoreError) {
        error.restoreError = restoreError;
      }
    }
    throw error;
  } finally {
    if (installed) {
      try { fs.unlinkSync(backup); } catch (_) {}
    }
  }
}

/** Replace a related group of files and restore every prior target on failure. */
function replaceFileBatchSync(entries) {
  const prepared = [];
  const attempted = [];
  try {
    for (const entry of entries) {
      const backup = fs.existsSync(entry.target) ? uniqueSibling(entry.target, 'batch-backup') : null;
      if (backup) fs.copyFileSync(entry.target, backup);
      prepared.push({ ...entry, backup, preserveBackup: false });
    }
    for (const entry of prepared) {
      // Include the current item before replacement: replaceFileSync can fail
      // after moving its old target aside, so the outer transaction must also
      // restore that partially attempted item, not only earlier successes.
      attempted.push(entry);
      replaceFileSync(entry.source, entry.target);
    }
  } catch (error) {
    const restoreErrors = [];
    for (const entry of attempted.reverse()) {
      try {
        if (entry.backup && fs.existsSync(entry.backup)) replaceFileSync(entry.backup, entry.target);
        else {
          try { fs.unlinkSync(entry.target); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
        }
      } catch (restoreError) {
        entry.preserveBackup = !!entry.backup && fs.existsSync(entry.backup);
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length) error.restoreErrors = restoreErrors;
    throw error;
  } finally {
    for (const entry of prepared) {
      if (entry.backup && !entry.preserveBackup) {
        try { fs.unlinkSync(entry.backup); } catch (_) {}
      }
    }
  }
}

function writeJsonAtomicSync(filePath, value) {
  const tmp = uniqueSibling(filePath, 'tmp');
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8');
    replaceFileSync(tmp, filePath);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { uniqueSibling, replaceFileSync, replaceFileBatchSync, writeJsonAtomicSync };
