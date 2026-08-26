'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const zlib = require('zlib');

const { uniqueSibling, replaceFileSync } = require('./file-utils');
const { configFingerprint, nodeFingerprint } = require('./subscription');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const HISTORY_VERSION = 1;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_FILE_BYTES = 40 * 1024 * 1024;
const MAX_HISTORY_JSON_BYTES = 96 * 1024 * 1024;
const DEFAULT_AVAILABILITY_CACHE_TTL_MS = 30_000;
const STALE_TRANSACTION_FILE_MS = 24 * 60 * 60 * 1000;

function profileFileKey(id) {
  return crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 32) + '.json.gz';
}

function countObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function profileUpdateSummary(current, next) {
  const beforeNodes = Array.isArray(current && current.nodes) ? current.nodes : [];
  const afterNodes = Array.isArray(next && next.nodes) ? next.nodes : [];
  const beforeByName = new Map(beforeNodes.map((node) => [String(node && node.name || ''), node]));
  const afterByName = new Map(afterNodes.map((node) => [String(node && node.name || ''), node]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [name, node] of afterByName) {
    if (!name || !beforeByName.has(name)) added += 1;
    else if (nodeFingerprint(node) !== nodeFingerprint(beforeByName.get(name))) changed += 1;
  }
  for (const name of beforeByName.keys()) {
    if (name && !afterByName.has(name)) removed += 1;
  }
  const beforeGroups = (current && (current.policyGroups || current.groups)) || [];
  const afterGroups = (next && (next.policyGroups || next.groups)) || [];
  const beforeRules = (current && (current.clashRules || current.rules)) || [];
  const afterRules = (next && (next.clashRules || next.rules)) || [];
  const beforeProviders = (current && (current.clashProxyProviders || current.proxyProviders)) || {};
  const afterProviders = (next && (next.clashProxyProviders || next.proxyProviders)) || {};
  return {
    configChanged: configFingerprint(current) !== configFingerprint(next),
    nodes: { before: beforeNodes.length, after: afterNodes.length, added, removed, changed },
    groups: { before: beforeGroups.length, after: afterGroups.length },
    rules: { before: beforeRules.length, after: afterRules.length },
    providers: { before: countObject(beforeProviders), after: countObject(afterProviders) },
  };
}

function profileUpdateDialogOptions(name, summary, options = {}) {
  const english = options.language === 'en';
  const nodes = summary.nodes || {};
  const groups = summary.groups || {};
  const rules = summary.rules || {};
  const providers = summary.providers || {};
  const lines = english ? [
    `Nodes: ${nodes.before || 0} → ${nodes.after || 0}  (+${nodes.added || 0} / −${nodes.removed || 0} / ${nodes.changed || 0} changed)`,
    `Policy groups: ${groups.before || 0} → ${groups.after || 0}`,
    `Rules: ${rules.before || 0} → ${rules.after || 0}`,
    `Proxy providers: ${providers.before || 0} → ${providers.after || 0}`,
  ] : [
    `节点：${nodes.before || 0} → ${nodes.after || 0}（新增 ${nodes.added || 0} / 删除 ${nodes.removed || 0} / 修改 ${nodes.changed || 0}）`,
    `策略组：${groups.before || 0} → ${groups.after || 0}`,
    `规则：${rules.before || 0} → ${rules.after || 0}`,
    `代理集合：${providers.before || 0} → ${providers.after || 0}`,
  ];
  if (options.restart) {
    lines.push(english ? 'The running core will restart after the update.' : '更新后将重新启动正在运行的内核。');
  }
  lines.push(english ? 'The previous version can be restored from the profile menu.' : '更新后可在配置菜单中恢复上一版本。');
  return {
    type: 'question',
    title: english ? 'Review Profile Update' : '确认配置更新',
    message: english ? `Update “${name || 'Profile'}”?` : `更新“${name || '配置'}”？`,
    detail: lines.join('\n'),
    buttons: english ? ['Update', 'Cancel'] : ['更新', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

class ProfileHistory {
  constructor(options = {}) {
    this.getDirectory = options.getDirectory || (() => '');
    this.log = options.log || (() => {});
    this.now = options.now || (() => Date.now());
    this.maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
    this.maxAgeMs = Math.max(60_000, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
    this.availabilityCacheTtlMs = Math.max(
      10,
      Number(options.availabilityCacheTtlMs) || DEFAULT_AVAILABILITY_CACHE_TTL_MS
    );
    this.availability = new Map();
    this.stages = new Set();
    this.retentions = new Set();
  }

  directory() {
    const base = this.getDirectory();
    return typeof base === 'string' && base ? path.join(base, 'profile-history') : '';
  }

  file(id) {
    const dir = this.directory();
    return dir && id ? path.join(dir, profileFileKey(id)) : '';
  }

  has(id) {
    const now = this.now();
    const cached = this.availability.get(id);
    if (cached && now < cached.validUntil) return cached.available;
    const file = this.file(id);
    if (!file) return false;
    try {
      const stat = fs.statSync(file);
      const available = stat.isFile() && stat.size <= MAX_HISTORY_FILE_BYTES && now - stat.mtimeMs <= this.maxAgeMs;
      this.availability.set(id, {
        available,
        checkedAt: now,
        // A positive cache entry must never survive the history file's own
        // retention deadline, even when the normal cache TTL is longer.
        validUntil: available
          ? Math.min(now + this.availabilityCacheTtlMs, stat.mtimeMs + this.maxAgeMs)
          : now + this.availabilityCacheTtlMs,
      });
      return available;
    } catch (_) {
      this.availability.set(id, {
        available: false,
        checkedAt: now,
        validUntil: now + this.availabilityCacheTtlMs,
      });
      return false;
    }
  }

  async _encode(profile) {
    const envelope = {
      version: HISTORY_VERSION,
      savedAt: this.now(),
      profile,
    };
    const compressed = await gzip(Buffer.from(JSON.stringify(envelope)), { level: zlib.constants.Z_BEST_SPEED });
    if (compressed.length > MAX_HISTORY_FILE_BYTES) throw new Error('profile history entry is too large');
    return compressed;
  }

  /**
   * Prepare a replacement without touching the authoritative history entry.
   * The previous entry is snapshotted as well, so a committed stage remains
   * reversible until finalize() closes the surrounding Store/runtime change.
   */
  async stage(profile) {
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || !profile.id) return false;
    const file = this.file(profile.id);
    if (!file) return false;
    let stagedFile = '';
    let previousFile = '';
    try {
      const compressed = await this._encode(profile);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      stagedFile = uniqueSibling(file, 'stage');
      await fs.promises.writeFile(stagedFile, compressed, { mode: 0o600 });
      try { await fs.promises.chmod(stagedFile, 0o600); } catch (_) {}
      const previousExists = fs.existsSync(file);
      if (previousExists) {
        previousFile = uniqueSibling(file, 'previous');
        try {
          await fs.promises.link(file, previousFile);
        } catch (_) {
          await fs.promises.copyFile(file, previousFile);
        }
        try { await fs.promises.chmod(previousFile, 0o600); } catch (_) {}
      }
      const transaction = {
        id: profile.id,
        file,
        stagedFile,
        previousFile,
        previousExists,
        state: 'staged',
      };
      this.stages.add(transaction);
      return transaction;
    } catch (error) {
      if (stagedFile) try { await fs.promises.unlink(stagedFile); } catch (_) {}
      if (previousFile) try { await fs.promises.unlink(previousFile); } catch (_) {}
      this.log('[gui] previous profile version could not be staged: ' + error.message);
      return false;
    }
  }

  async commit(transaction) {
    if (!this.stages.has(transaction) || transaction.state !== 'staged') return false;
    try {
      transaction.state = 'committing';
      replaceFileSync(transaction.stagedFile, transaction.file);
      transaction.stagedFile = '';
      transaction.state = 'committed';
      this.availability.delete(transaction.id);
      return this.has(transaction.id);
    } catch (error) {
      transaction.state = 'commit-failed';
      this.log('[gui] previous profile version could not be committed: ' + error.message);
      return false;
    }
  }

  async finalize(transaction) {
    if (!this.stages.has(transaction) || transaction.state !== 'committed') return false;
    let cleaned = true;
    if (transaction.previousFile) {
      try { await fs.promises.unlink(transaction.previousFile); } catch (error) {
        if (!error || error.code !== 'ENOENT') cleaned = false;
      }
      if (cleaned) transaction.previousFile = '';
    }
    // Keep failed cleanup registered so a later prune can retry. Otherwise a
    // credential-bearing previousFile would become an unmanaged orphan.
    if (!cleaned) return false;
    transaction.state = 'finalized';
    this.stages.delete(transaction);
    try { await this.prune(); } catch (_) {}
    return cleaned;
  }

  /** Restore the entry that existed at stage time, even after commit(). */
  async discard(transaction) {
    if (!this.stages.has(transaction)) return transaction && transaction.state === 'discarded';
    try {
      if (
        transaction.state === 'committed' ||
        transaction.state === 'committing' ||
        transaction.state === 'commit-failed'
      ) {
        if (transaction.previousExists) {
          if (!transaction.previousFile || !fs.existsSync(transaction.previousFile)) {
            throw new Error('previous profile history snapshot is missing');
          }
          replaceFileSync(transaction.previousFile, transaction.file);
          transaction.previousFile = '';
        } else {
          try { await fs.promises.unlink(transaction.file); } catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
          }
        }
      }
      if (transaction.stagedFile) {
        try { await fs.promises.unlink(transaction.stagedFile); } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        transaction.stagedFile = '';
      }
      if (transaction.previousFile) {
        try { await fs.promises.unlink(transaction.previousFile); } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        transaction.previousFile = '';
      }
      transaction.state = 'discarded';
      this.stages.delete(transaction);
      this.availability.delete(transaction.id);
      return true;
    } catch (error) {
      this.log('[gui] previous profile version transaction could not be discarded: ' + error.message);
      return false;
    }
  }

  async save(profile) {
    const transaction = await this.stage(profile);
    if (!transaction) return false;
    if (!await this.commit(transaction)) {
      await this.discard(transaction);
      return false;
    }
    await this.finalize(transaction);
    return true;
  }

  /**
   * Hide every finalized entry except the supplied ids. The move is reversible
   * until finalizeRetention(), which lets backup restore roll back both Store
   * and history as one logical transaction.
   */
  async stageRetention(ids) {
    const dir = this.directory();
    if (!dir) return false;
    const keep = new Set([...ids].map((id) => profileFileKey(id)));
    const moved = [];
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const names = await fs.promises.readdir(dir);
      for (const name of names) {
        if (!/^[a-f0-9]{32}\.json\.gz$/.test(name) || keep.has(name)) continue;
        const source = path.join(dir, name);
        const staged = uniqueSibling(source, 'retained');
        await fs.promises.rename(source, staged);
        moved.push({ source, staged });
      }
      this.availability.clear();
      const transaction = { moved, state: 'staged' };
      this.retentions.add(transaction);
      return transaction;
    } catch (error) {
      for (const item of moved.reverse()) {
        try { await fs.promises.rename(item.staged, item.source); } catch (_) {}
      }
      this.availability.clear();
      this.log('[gui] profile history retention could not be staged: ' + error.message);
      return false;
    }
  }

  async discardRetention(transaction) {
    if (!this.retentions.has(transaction) || transaction.state !== 'staged') return false;
    let restored = true;
    for (const item of transaction.moved.slice().reverse()) {
      try { await fs.promises.rename(item.staged, item.source); } catch (_) { restored = false; }
    }
    if (restored) {
      transaction.state = 'discarded';
      this.retentions.delete(transaction);
    }
    this.availability.clear();
    return restored;
  }

  async finalizeRetention(transaction) {
    if (!this.retentions.has(transaction) || transaction.state !== 'staged') return false;
    let removed = true;
    for (const item of transaction.moved) {
      try { await fs.promises.unlink(item.staged); } catch (error) {
        if (!error || error.code !== 'ENOENT') removed = false;
      }
    }
    if (!removed) return false;
    transaction.state = 'finalized';
    this.retentions.delete(transaction);
    this.availability.clear();
    return removed;
  }

  async load(id) {
    const file = this.file(id);
    if (!file) return null;
    try {
      const stat = await fs.promises.stat(file);
      if (this.now() - stat.mtimeMs > this.maxAgeMs || stat.size > MAX_HISTORY_FILE_BYTES) {
        try { await fs.promises.unlink(file); } catch (_) {}
        const now = this.now();
        this.availability.set(id, {
          available: false,
          checkedAt: now,
          validUntil: now + this.availabilityCacheTtlMs,
        });
        return null;
      }
      const decoded = JSON.parse((await gunzip(
        await fs.promises.readFile(file),
        { maxOutputLength: MAX_HISTORY_JSON_BYTES }
      )).toString('utf-8'));
      if (
        !decoded || decoded.version !== HISTORY_VERSION ||
        !decoded.profile || decoded.profile.id !== id
      ) throw new Error('invalid profile history entry');
      this.availability.delete(id);
      return { savedAt: Number(decoded.savedAt) || stat.mtimeMs, profile: decoded.profile };
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.log('[gui] previous profile version could not be read: ' + error.message);
        try { await fs.promises.unlink(file); } catch (_) {}
      }
      const now = this.now();
      this.availability.set(id, {
        available: false,
        checkedAt: now,
        validUntil: now + this.availabilityCacheTtlMs,
      });
      return null;
    }
  }

  async remove(id) {
    const file = this.file(id);
    if (!file) return false;
    try {
      await fs.promises.unlink(file);
      const now = this.now();
      this.availability.set(id, {
        available: false,
        checkedAt: now,
        validUntil: now + this.availabilityCacheTtlMs,
      });
      return true;
    } catch (_) {
      const now = this.now();
      this.availability.set(id, {
        available: false,
        checkedAt: now,
        validUntil: now + this.availabilityCacheTtlMs,
      });
      return false;
    }
  }

  async prune() {
    const dir = this.directory();
    if (!dir) return;
    // Retry cleanup that failed after a successful commit. The candidate is
    // already authoritative, but its credential-bearing predecessor remains
    // registered until deletion succeeds.
    for (const transaction of [...this.stages]) {
      if (transaction.state !== 'committed' || !transaction.previousFile) continue;
      try {
        await fs.promises.unlink(transaction.previousFile);
        transaction.previousFile = '';
        transaction.state = 'finalized';
        this.stages.delete(transaction);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          transaction.previousFile = '';
          transaction.state = 'finalized';
          this.stages.delete(transaction);
        }
      }
    }
    for (const transaction of [...this.retentions]) {
      if (transaction.state !== 'staged') continue;
      let removed = true;
      for (const item of transaction.moved) {
        try { await fs.promises.unlink(item.staged); } catch (error) {
          if (!error || error.code !== 'ENOENT') removed = false;
        }
      }
      if (removed) {
        transaction.state = 'finalized';
        this.retentions.delete(transaction);
      }
    }
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch (_) {
      return;
    }
    const entries = [];
    const activeFiles = new Set();
    for (const transaction of this.stages) {
      if (transaction.stagedFile) activeFiles.add(transaction.stagedFile);
      if (transaction.previousFile) activeFiles.add(transaction.previousFile);
    }
    for (const transaction of this.retentions) {
      for (const item of transaction.moved) activeFiles.add(item.staged);
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (/^[a-f0-9]{32}\.json\.gz\.(?:stage|previous|retained)-/.test(name)) {
        if (activeFiles.has(file)) continue;
        try {
          const stat = await fs.promises.stat(file);
          if (!stat.isFile() || this.now() - stat.mtimeMs > STALE_TRANSACTION_FILE_MS) {
            try { await fs.promises.unlink(file); } catch (_) {}
          }
        } catch (_) {}
        continue;
      }
      if (!/^[a-f0-9]{32}\.json\.gz$/.test(name)) continue;
      try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || this.now() - stat.mtimeMs > this.maxAgeMs) {
          try { await fs.promises.unlink(file); } catch (_) {}
          continue;
        }
        entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (_) {}
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let total = 0;
    for (const entry of entries) {
      total += entry.size;
      if (total > this.maxBytes) {
        try { await fs.promises.unlink(entry.file); } catch (_) {}
      }
    }
    // Pruning may remove another profile's cached entry. The file name is a
    // one-way digest of its id, so invalidate the tiny availability cache and
    // let the next state refresh verify the authoritative filesystem state.
    this.availability.clear();
  }
}

/**
 * Couple one profile-history replacement to a Store/runtime mutation. The
 * candidate history becomes authoritative only after apply + verify succeed;
 * any later failure restores both the prior history entry and business state.
 */
async function runProfileMutationTransaction(options) {
  const history = options && options.history;
  if (!history || typeof options.apply !== 'function' || typeof options.rollback !== 'function') {
    throw new Error('invalid profile mutation transaction');
  }
  const transaction = await history.stage(options.previous);
  if (!transaction) throw new Error('the previous profile version could not be preserved');
  let applyStarted = false;
  try {
    applyStarted = true;
    const result = await options.apply();
    if (typeof options.verify === 'function') await options.verify(result);
    if (!await history.commit(transaction)) {
      throw new Error('the previous profile version could not be committed');
    }
    await history.finalize(transaction);
    return result;
  } catch (error) {
    let recoveryError = null;
    if (!await history.discard(transaction)) {
      recoveryError = new Error('the previous profile history could not be restored');
    }
    if (applyStarted) {
      try {
        await options.rollback();
      } catch (rollbackError) {
        if (!recoveryError) recoveryError = rollbackError;
      }
    }
    if (recoveryError) error.recoveryError = recoveryError;
    throw error;
  }
}

let sharedHistory = null;
function getSharedProfileHistory(options = {}) {
  if (!sharedHistory) sharedHistory = new ProfileHistory(options);
  return sharedHistory;
}

module.exports = {
  ProfileHistory,
  getSharedProfileHistory,
  profileFileKey,
  profileUpdateDialogOptions,
  profileUpdateSummary,
  runProfileMutationTransaction,
};
