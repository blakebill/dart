'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uniqueSibling, replaceFileSync } = require('./file-utils');

const PROFILE_FIELDS = ['nodes', 'policyGroups', 'clashRules', 'clashRuleProviders'];
const LEGACY_PROFILE_FIELDS = [...PROFILE_FIELDS, 'raw'];
const RULESET_FIELDS = ['rule', 'rules'];
const LEGACY_DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
// Only the active/most recently inspected profile needs to remain hydrated.
// Profiles can contain thousands of full node objects, so retaining a second
// one has a much larger cost than re-reading it on the uncommon profile switch.
const PROFILE_CACHE_LIMIT = 1;

/**
 * Minimal JSON persistence store (a zero-dependency replacement for electron-store).
 * config.json is the commit index; large payloads are staged in independent files
 * and become visible only after that index has been replaced successfully.
 */

const DEFAULT_SETTINGS = {
  mixedPort: 7890,
  clashApiPort: 9090,
  enableTun: false,
  logLevel: 'info',
  autoSetSystemProxy: true,
  autoLaunch: false,
  silentStart: false,
  notifications: true,
  enableIpv6: true,
  dnsRemote: 'https://1.1.1.1/dns-query',
  dnsLocal: 'https://223.5.5.5/dns-query',
  dnsStrategy: 'prefer_ipv4',
  language: 'zh',
  theme: 'system',
  clashMode: 'rule',
  coreType: 'sing-box',
  useBuiltinRules: false,
  ruleOverrides: {},
  ruleGroupSelections: {},
  testUrl: DEFAULT_TEST_URL,
  smartMode: 'balanced',
};

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

class Store {
  constructor(dir, name = 'config.json') {
    this.dir = dir;
    this.file = path.join(dir, name);
    this.profileDir = path.join(dir, 'profiles');
    this.ruleSetDir = path.join(dir, 'remote-rules');
    this.recoveryMarker = path.join(dir, '.payload-recovery-needed');
    this._profileCache = new Map();
    this._profileDigests = new Map();
    this._rawDigests = new Map();
    this._ruleDigests = new Map();
    this._profileStorageEnabled = true;
    this._ruleStorageEnabled = true;
    this._preserveOrphanPayloads = fs.existsSync(this.recoveryMarker);
    this.data = this._load();
    this._migrateSettingsDefaults();
    this._prepareSubscriptions();
    this._prepareCustomRuleSets();
  }

  _migrateSettingsDefaults() {
    const settings = this.data.settings;
    if (!settings) return;
    const next = { ...settings };
    let changed = false;
    if (next.testUrl === LEGACY_DEFAULT_TEST_URL) {
      next.testUrl = DEFAULT_TEST_URL;
      changed = true;
    }
    // Removed in 0.9.5: Clash delay endpoints use HEAD and cannot measure
    // per-node throughput, so retaining this setting would be misleading.
    if (hasOwn(next, 'enableSmartThroughputProbe')) {
      delete next.enableSmartThroughputProbe;
      changed = true;
    }
    if (hasOwn(next, 'testConcurrency')) {
      delete next.testConcurrency;
      changed = true;
    }
    if (hasOwn(next, 'enableClashApi')) {
      delete next.enableClashApi;
      changed = true;
    }
    if (!['dark', 'light', 'system'].includes(next.theme)) {
      next.theme = 'system';
      changed = true;
    }
    if (!changed) return;
    this.data = { ...this.data, settings: next };
    try { this._writeConfig(); } catch (_) {
      // Keep the migrated value in memory if a read-only disk prevents repair.
    }
  }

  _load() {
    const backup = this.file + '.bak';
    const corrupt = [];
    for (const candidate of [this.file, backup]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const text = fs.readFileSync(candidate, 'utf-8');
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid config index');
        if (candidate === backup) {
          // The backup is already a valid committed index. A read-only disk or
          // transient antivirus lock may prevent self-healing the primary, but
          // must not turn that valid backup into a "corrupt" file and reset the
          // whole store to defaults.
          try { this._writeAtomic(this.file, text); } catch (_) {
            this._preserveOrphanPayloads = true;
          }
        } else {
          try { this._writeAtomic(backup, text); } catch (_) {}
        }
        return data;
      } catch (_) {
        corrupt.push(candidate);
      }
    }
    if (corrupt.length) {
      this._preserveOrphanPayloads = true;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.recoveryMarker, new Date().toISOString(), 'utf-8');
      } catch (_) {}
      for (const file of corrupt) {
        try { fs.renameSync(file, uniqueSibling(file, 'corrupt')); } catch (_) {}
      }
    }
    return this._defaults();
  }

  _defaults() {
    return {
      subscriptions: [],
      settings: { ...DEFAULT_SETTINGS },
      selected: null,
      activeSub: null,
      customRuleSets: [],
      localRules: [],
      lastRunning: false,
      ownedSystemProxyServer: null,
      ownedSystemProxyRestore: null,
      pendingUwpLoopbackSids: null,
    };
  }

  _safeId(id) {
    const raw = String(id || 'item');
    return /^[A-Za-z0-9_-]{1,128}$/.test(raw)
      ? raw
      : crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  _recordId(id, prefix, index, seen) {
    let candidate = typeof id === 'string' && id ? id : `${prefix}-${index}`;
    if (seen.has(candidate)) {
      const base = `${prefix}-${index}`;
      candidate = base;
      let suffix = 2;
      while (seen.has(candidate)) candidate = `${base}-${suffix++}`;
    }
    seen.add(candidate);
    return candidate;
  }

  _profileFileName(id) {
    return this._safeId(id) + '.json';
  }

  _rawFileName(id) {
    return this._safeId(id) + '.raw';
  }

  _ruleSetFileName(id) {
    return this._safeId(id) + '.json';
  }

  _versionedFileName(id, digest, extension) {
    return `${this._safeId(id)}-${digest.slice(0, 24)}.${extension}`;
  }

  _validPayloadFile(fileName, extension) {
    if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) return false;
    const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^[A-Za-z0-9_-]{1,180}\\.${escaped}$`).test(fileName);
  }

  _profilePayload(sub) {
    const payload = {};
    for (const key of PROFILE_FIELDS) {
      if (hasOwn(sub, key)) payload[key] = sub[key];
    }
    return payload;
  }

  _ruleSetPayload(item) {
    const payload = {};
    for (const key of RULESET_FIELDS) {
      if (hasOwn(item, key)) payload[key] = item[key];
    }
    return payload;
  }

  _subscriptionMetadata(sub, payload, files = {}) {
    const metadata = {};
    for (const [key, value] of Object.entries(sub || {})) {
      if (!LEGACY_PROFILE_FIELDS.includes(key) && !['dataFile', 'rawFile', 'nodeCount'].includes(key)) {
        metadata[key] = value;
      }
    }
    metadata.dataFile = files.dataFile || this._profileFileName(metadata.id);
    if (files.rawFile) metadata.rawFile = files.rawFile;
    const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : null;
    metadata.nodeCount = nodes ? nodes.length : Math.max(0, Number(sub && sub.nodeCount) || 0);
    return metadata;
  }

  _ruleSetMetadata(item, payloadFile = null) {
    const metadata = {};
    for (const [key, value] of Object.entries(item || {})) {
      if (!RULESET_FIELDS.includes(key) && key !== 'payloadFile') metadata[key] = value;
    }
    if (payloadFile) metadata.payloadFile = payloadFile;
    return metadata;
  }

  _publicMetadata(meta, includeCount = false) {
    const { dataFile, rawFile, nodeCount, ...publicMeta } = meta || {};
    if (includeCount) publicMeta.nodeCount = Math.max(0, Number(nodeCount) || 0);
    return publicMeta;
  }

  _publicRuleSetMetadata(meta) {
    const { payloadFile, ...publicMeta } = meta || {};
    return publicMeta;
  }

  _digest(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  _rememberProfile(id, payload) {
    if (this._profileCache.has(id)) this._profileCache.delete(id);
    this._profileCache.set(id, payload);
    while (this._profileCache.size > PROFILE_CACHE_LIMIT) {
      this._profileCache.delete(this._profileCache.keys().next().value);
    }
  }

  _writeAtomic(file, text) {
    const tmp = uniqueSibling(file, 'tmp');
      fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(tmp, text, 'utf-8');
      replaceFileSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  _writeConfigData(data) {
    const text = JSON.stringify(data, null, 2);
    this._writeAtomic(this.file, text);
    // Mirror the committed index. Payload files are versioned separately, so
    // this current-state copy can recover a corrupted primary without pointing
    // at files that have already been retired.
    try { this._writeAtomic(this.file + '.bak', text); } catch (_) {}
  }

  _writeConfig() {
    this._writeConfigData(this.data);
  }

  _commitData(nextData) {
    this._writeConfigData(nextData);
    this.data = nextData;
  }

  _readJsonPayload(dir, fileName, digestMap) {
    if (!fileName) return {};
    const expected = path.join(dir, fileName);
    for (const file of [expected, expected + '.bak']) {
      try {
        const text = fs.readFileSync(file, 'utf-8');
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        if (file === expected) {
          digestMap.set(fileName, this._digest(text));
        } else {
          // A valid safety copy should become the primary again. Do not cache
          // its digest unless replacement succeeds, or a later write could
          // mistake a corrupt primary for the recovered payload.
          try {
            this._writeAtomic(expected, text);
            digestMap.set(fileName, this._digest(text));
          } catch (_) {}
        }
        return payload;
      } catch (_) {
        /* try the backup */
      }
    }
    return {};
  }

  _readProfileFile(fileName) {
    return this._readJsonPayload(this.profileDir, fileName, this._profileDigests);
  }

  _currentRawFile(meta) {
    const candidates = [];
    if (this._validPayloadFile(meta && meta.rawFile, 'raw')) candidates.push(meta.rawFile);
    candidates.push(this._rawFileName(meta && meta.id));
    return candidates.find((file) =>
      fs.existsSync(path.join(this.profileDir, file)) || fs.existsSync(path.join(this.profileDir, file + '.bak'))
    ) || null;
  }

  _readRawForMeta(meta) {
    const candidates = [];
    if (this._validPayloadFile(meta && meta.rawFile, 'raw')) candidates.push(meta.rawFile);
    const fallback = this._rawFileName(meta && meta.id);
    if (!candidates.includes(fallback)) candidates.push(fallback);
    for (const name of candidates) {
      for (const suffix of ['', '.bak']) {
        try {
          const target = path.join(this.profileDir, name);
          const text = fs.readFileSync(target + suffix, 'utf-8');
          if (!suffix) {
            this._rawDigests.set(name, this._digest(text));
          } else {
            try {
              this._writeAtomic(target, text);
              this._rawDigests.set(name, this._digest(text));
            } catch (_) {}
          }
          return text;
        } catch (_) {
          /* try the next candidate */
        }
      }
    }

    // Lazy migration for 0.8.1 and earlier profile files where raw lived inside JSON.
    const legacy = this._readProfileFile(meta && meta.dataFile);
    return hasOwn(legacy, 'raw') ? String(legacy.raw || '') : undefined;
  }

  _migrateLegacyRaw(meta, payload) {
    if (!hasOwn(payload, 'raw')) return payload;
    const raw = String(payload.raw || '');
    const slim = { ...payload };
    delete slim.raw;
    try {
      if (raw) {
        const rawFile = this._rawFileName(meta.id);
        const rawPath = path.join(this.profileDir, rawFile);
        this._writeAtomic(rawPath, raw);
        this._rawDigests.set(rawFile, this._digest(raw));
      }
      const profileText = JSON.stringify(slim);
      this._writeAtomic(path.join(this.profileDir, meta.dataFile), profileText);
      this._profileDigests.set(meta.dataFile, this._digest(profileText));
    } catch (_) {
      // The original profile still contains raw, so a failed migration loses nothing.
    }
    return slim;
  }

  _profileForMeta(meta, cache = true) {
    if (!meta) return {};
    if (this._profileCache.has(meta.id)) {
      const payload = this._profileCache.get(meta.id);
      this._rememberProfile(meta.id, payload);
      return payload;
    }
    const payload = this._migrateLegacyRaw(meta, this._readProfileFile(meta.dataFile));
    if (cache) this._rememberProfile(meta.id, payload);
    return payload;
  }

  _stageText(dir, id, extension, text, currentFile, digestMap, defaultFile) {
    const digest = this._digest(text);
    const currentPath = currentFile ? path.join(dir, currentFile) : null;
    if (currentFile && fs.existsSync(currentPath)) {
      let currentDigest = digestMap.get(currentFile);
      if (!currentDigest) {
        try {
          currentDigest = this._digest(fs.readFileSync(currentPath));
          digestMap.set(currentFile, currentDigest);
        } catch (_) {}
      }
      if (currentDigest === digest) {
        return { file: currentFile, digest, changed: false, created: false };
      }
    }

    const file = currentFile
      ? this._versionedFileName(id, digest, extension)
      : defaultFile;
    const target = path.join(dir, file);
    const created = !fs.existsSync(target);
    this._writeAtomic(target, text);
    return { file, digest, changed: file !== currentFile, created };
  }

  _discardStage(dir, stage) {
    if (!stage || !stage.changed || !stage.created) return;
    try { fs.unlinkSync(path.join(dir, stage.file)); } catch (_) {}
  }

  _retireFile(dir, oldFile, newFile) {
    if (!oldFile || oldFile === newFile) return;
    const oldPath = path.join(dir, oldFile);
    if (newFile && fs.existsSync(oldPath)) {
      try {
        fs.copyFileSync(oldPath, path.join(dir, newFile + '.bak'));
      } catch (_) {
        return; // Keep the old file as an orphan if the safety copy failed.
      }
    }
    for (const suffix of ['', '.bak']) {
      try { fs.unlinkSync(oldPath + suffix); } catch (_) {}
    }
  }

  _cleanupPayloadDir(dir, activeFiles, extensions) {
    try {
      for (const name of fs.readdirSync(dir)) {
        const base = name.endsWith('.bak') ? name.slice(0, -4) : name;
        if (!extensions.some((ext) => this._validPayloadFile(base, ext))) continue;
        if (!activeFiles.has(base)) {
          try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  _pruneDigests(digestMap, activeFiles) {
    for (const fileName of digestMap.keys()) {
      if (!activeFiles.has(fileName)) digestMap.delete(fileName);
    }
  }

  _prepareSubscriptions() {
    const records = Array.isArray(this.data.subscriptions) ? this.data.subscriptions : [];
    const metadata = [];
    const seenIds = new Set();
    let changed = false;
    try {
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record || typeof record !== 'object') continue;
        const id = this._recordId(record.id, 'legacy-profile', index, seenIds);
        const normalized = id === record.id ? record : { ...record, id };
        if (normalized !== record) changed = true;
        const external = this._validPayloadFile(normalized.dataFile, 'json') &&
          !LEGACY_PROFILE_FIELDS.some((key) => hasOwn(normalized, key));
        let payload;
        let dataFile = external ? normalized.dataFile : this._profileFileName(normalized.id);
        let rawFile = this._validPayloadFile(normalized.rawFile, 'raw') ? normalized.rawFile : null;
        if (!external) {
          payload = this._profilePayload(normalized);
          const text = JSON.stringify(payload);
          this._writeAtomic(path.join(this.profileDir, dataFile), text);
          this._profileDigests.set(dataFile, this._digest(text));
          if (hasOwn(normalized, 'raw') && String(normalized.raw || '')) {
            rawFile = this._rawFileName(normalized.id);
            const raw = String(normalized.raw);
            this._writeAtomic(path.join(this.profileDir, rawFile), raw);
            this._rawDigests.set(rawFile, this._digest(raw));
          }
          changed = true;
        } else if (!Number.isFinite(normalized.nodeCount)) {
          payload = this._profileForMeta(normalized, false);
          changed = true;
        }
        if (!rawFile) rawFile = this._currentRawFile(normalized);
        const meta = this._subscriptionMetadata(normalized, payload, { dataFile, rawFile });
        metadata.push(meta);
        if (normalized.dataFile !== meta.dataFile || normalized.rawFile !== meta.rawFile || normalized.nodeCount !== meta.nodeCount) {
          changed = true;
        }
      }
      this.data = { ...this.data, subscriptions: metadata };
      if (changed) this._writeConfig();
      const active = new Set(metadata.flatMap((meta) => [meta.dataFile, meta.rawFile].filter(Boolean)));
      if (!this._preserveOrphanPayloads) this._cleanupPayloadDir(this.profileDir, active, ['json', 'raw']);
      this._pruneDigests(this._profileDigests, active);
      this._pruneDigests(this._rawDigests, active);
    } catch (_) {
      // Keep operating with the legacy in-memory records if migration is blocked.
      this._profileStorageEnabled = false;
      this.data = { ...this.data, subscriptions: records };
    }
  }

  _prepareCustomRuleSets() {
    const records = Array.isArray(this.data.customRuleSets) ? this.data.customRuleSets : [];
    const metadata = [];
    const seenIds = new Set();
    let changed = false;
    try {
      records.forEach((record, index) => {
        if (!record || typeof record !== 'object') return;
        const id = this._recordId(record.id, 'legacy-rule', index, seenIds);
        const normalized = id === record.id ? record : { ...record, id };
        const external = this._validPayloadFile(normalized.payloadFile, 'json') &&
          !RULESET_FIELDS.some((key) => hasOwn(normalized, key));
        let payloadFile = external ? normalized.payloadFile : null;
        if (!external && normalized.kind === 'inline') {
          const payload = this._ruleSetPayload(normalized);
          payloadFile = this._ruleSetFileName(normalized.id);
          const text = JSON.stringify(payload);
          this._writeAtomic(path.join(this.ruleSetDir, payloadFile), text);
          this._ruleDigests.set(payloadFile, this._digest(text));
          changed = true;
        }
        const meta = this._ruleSetMetadata(normalized, payloadFile);
        metadata.push(meta);
        if (normalized.id !== record.id || normalized.payloadFile !== meta.payloadFile || RULESET_FIELDS.some((key) => hasOwn(record, key))) {
          changed = true;
        }
      });
      this.data = { ...this.data, customRuleSets: metadata };
      if (changed) this._writeConfig();
      const active = new Set(metadata.map((meta) => meta.payloadFile).filter(Boolean));
      if (!this._preserveOrphanPayloads) this._cleanupPayloadDir(this.ruleSetDir, active, ['json']);
      this._pruneDigests(this._ruleDigests, active);
    } catch (_) {
      this._ruleStorageEnabled = false;
      this.data = { ...this.data, customRuleSets: records };
    }
  }

  listSubscriptions() {
    if (!this._profileStorageEnabled) {
      return (this.data.subscriptions || []).map((sub) => ({
        ...this._publicMetadata(this._subscriptionMetadata(sub, this._profilePayload(sub)), true),
      }));
    }
    return (this.data.subscriptions || []).map((meta) => this._publicMetadata(meta, true));
  }

  getSubscription(id, options = {}) {
    const includeRaw = options.includeRaw === true;
    if (!this._profileStorageEnabled) {
      const sub = (this.data.subscriptions || []).find((item) => item.id === id) || null;
      if (!sub || includeRaw) return sub;
      const { raw, ...withoutRaw } = sub;
      return withoutRaw;
    }
    const meta = (this.data.subscriptions || []).find((sub) => sub.id === id);
    if (!meta) return null;
    const result = { ...this._publicMetadata(meta), ...this._profileForMeta(meta) };
    if (includeRaw) {
      const raw = this._readRawForMeta(meta);
      if (raw !== undefined) result.raw = raw;
    }
    return result;
  }

  getSubscriptions(options = {}) {
    const includeRaw = options.includeRaw === true;
    return this.listSubscriptions()
      .map((meta) => this.getSubscription(meta.id, { includeRaw }))
      .filter(Boolean);
  }

  upsertSubscription(subscription) {
    if (!subscription || !subscription.id) throw new Error('subscription id is required');
    if (!this._profileStorageEnabled) {
      const list = [...(this.data.subscriptions || [])];
      const index = list.findIndex((sub) => sub.id === subscription.id);
      if (index >= 0) list[index] = { ...list[index], ...subscription };
      else list.push(subscription);
      this._commitData({ ...this.data, subscriptions: list });
      return subscription;
    }

    const list = this.data.subscriptions || [];
    const currentMeta = list.find((sub) => sub.id === subscription.id) || null;
    const changesPayload = PROFILE_FIELDS.some((key) => hasOwn(subscription, key)) || hasOwn(subscription, 'raw');
    if (currentMeta && !changesPayload) {
      const current = this._publicMetadata(currentMeta, true);
      const meta = this._subscriptionMetadata({ ...current, ...subscription }, null, {
        dataFile: currentMeta.dataFile,
        rawFile: currentMeta.rawFile,
      });
      const nextList = [...list];
      nextList[nextList.findIndex((sub) => sub.id === subscription.id)] = meta;
      this._commitData({ ...this.data, subscriptions: nextList });
      return this._publicMetadata(meta, true);
    }
    const currentPayload = currentMeta ? this._profileForMeta(currentMeta) : {};
    const payload = { ...currentPayload, ...this._profilePayload(subscription) };
    const currentRawFile = currentMeta ? this._currentRawFile(currentMeta) : null;
    let profileStage;
    let rawStage;
    try {
      profileStage = this._stageText(
        this.profileDir,
        subscription.id,
        'json',
        JSON.stringify(payload),
        currentMeta && currentMeta.dataFile,
        this._profileDigests,
        this._profileFileName(subscription.id)
      );
      let rawFile = currentRawFile;
      let rawValue;
      if (hasOwn(subscription, 'raw')) {
        rawValue = String(subscription.raw || '');
        if (rawValue) {
          rawStage = this._stageText(
            this.profileDir,
            subscription.id,
            'raw',
            rawValue,
            currentRawFile,
            this._rawDigests,
            this._rawFileName(subscription.id)
          );
          rawFile = rawStage.file;
        } else {
          rawFile = null;
        }
      }
      const meta = this._subscriptionMetadata(subscription, payload, {
        dataFile: profileStage.file,
        rawFile,
      });
      const nextList = [...list];
      const index = nextList.findIndex((sub) => sub.id === subscription.id);
      if (index >= 0) nextList[index] = meta;
      else nextList.push(meta);
      this._commitData({ ...this.data, subscriptions: nextList });

      this._profileDigests.set(profileStage.file, profileStage.digest);
      if (rawStage) this._rawDigests.set(rawStage.file, rawStage.digest);
      this._rememberProfile(meta.id, payload);
      if (currentMeta) {
        this._retireFile(this.profileDir, currentMeta.dataFile, profileStage.file);
        if (currentMeta.dataFile !== profileStage.file) this._profileDigests.delete(currentMeta.dataFile);
      }
      this._retireFile(this.profileDir, currentRawFile, rawFile);
      if (currentRawFile && currentRawFile !== rawFile) this._rawDigests.delete(currentRawFile);
      return {
        ...this._publicMetadata(meta),
        ...payload,
        ...(rawValue !== undefined ? { raw: rawValue } : {}),
      };
    } catch (error) {
      this._discardStage(this.profileDir, profileStage);
      this._discardStage(this.profileDir, rawStage);
      throw error;
    }
  }

  removeSubscription(id) {
    const list = this.data.subscriptions || [];
    const meta = list.find((sub) => sub.id === id);
    const rawFile = meta && this._profileStorageEnabled ? this._currentRawFile(meta) : null;
    const nextList = list.filter((sub) => sub.id !== id);
    this._commitData({ ...this.data, subscriptions: nextList });
    this._profileCache.delete(id);
    if (!meta || !this._profileStorageEnabled) return;
    this._profileDigests.delete(meta.dataFile);
    this._rawDigests.delete(rawFile);
    this._retireFile(this.profileDir, meta.dataFile, null);
    this._retireFile(this.profileDir, rawFile, null);
  }

  _replaceSubscriptions(items) {
    const incoming = Array.isArray(items) ? items : [];
    if (!this._profileStorageEnabled) {
      this._commitData({ ...this.data, subscriptions: incoming });
      return;
    }

    const currentById = new Map((this.data.subscriptions || []).map((meta) => [meta.id, meta]));
    const metadata = [];
    const stages = [];
    const seen = new Set();
    try {
      for (const sub of incoming) {
        if (!sub || !sub.id || seen.has(sub.id)) throw new Error('subscription ids must be unique');
        seen.add(sub.id);
        const current = currentById.get(sub.id) || null;
        const payload = this._profilePayload(sub);
        // Register the in-flight item before its first write. If a later raw
        // stage (or metadata construction) fails, the catch block must still
        // know about and remove the profile file created moments earlier.
        const stage = { current, meta: null, payload, profileStage: null, rawStage: null };
        stages.push(stage);
        stage.profileStage = this._stageText(
          this.profileDir,
          sub.id,
          'json',
          JSON.stringify(payload),
          current && current.dataFile,
          this._profileDigests,
          this._profileFileName(sub.id)
        );
        let rawStage = null;
        let rawFile = null;
        if (hasOwn(sub, 'raw') && String(sub.raw || '')) {
          rawStage = this._stageText(
            this.profileDir,
            sub.id,
            'raw',
            String(sub.raw),
            current && this._currentRawFile(current),
            this._rawDigests,
            this._rawFileName(sub.id)
          );
          stage.rawStage = rawStage;
          rawFile = rawStage.file;
        }
        const meta = this._subscriptionMetadata(sub, payload, { dataFile: stage.profileStage.file, rawFile });
        stage.meta = meta;
        metadata.push(meta);
      }
      this._commitData({ ...this.data, subscriptions: metadata });
    } catch (error) {
      for (const stage of stages) {
        this._discardStage(this.profileDir, stage.profileStage);
        this._discardStage(this.profileDir, stage.rawStage);
      }
      throw error;
    }

    this._profileCache.clear();
    for (const stage of stages) {
      this._profileDigests.set(stage.profileStage.file, stage.profileStage.digest);
      if (stage.rawStage) this._rawDigests.set(stage.rawStage.file, stage.rawStage.digest);
      this._rememberProfile(stage.meta.id, stage.payload);
      if (stage.current) {
        this._retireFile(this.profileDir, stage.current.dataFile, stage.meta.dataFile);
        this._retireFile(this.profileDir, this._currentRawFile(stage.current), stage.meta.rawFile || null);
      }
    }
    const active = new Set(metadata.flatMap((meta) => [meta.dataFile, meta.rawFile].filter(Boolean)));
    this._cleanupPayloadDir(this.profileDir, active, ['json', 'raw']);
    this._pruneDigests(this._profileDigests, active);
    this._pruneDigests(this._rawDigests, active);
  }

  listCustomRuleSets() {
    if (!this._ruleStorageEnabled) return (this.data.customRuleSets || []).map((item) => this._publicRuleSetMetadata(item));
    return (this.data.customRuleSets || []).map((meta) => this._publicRuleSetMetadata(meta));
  }

  getCustomRuleSets() {
    if (!this._ruleStorageEnabled) return this.data.customRuleSets || [];
    return (this.data.customRuleSets || []).map((meta) => this.getCustomRuleSet(meta.id)).filter(Boolean);
  }

  getCustomRuleSet(id) {
    if (!this._ruleStorageEnabled) {
      return (this.data.customRuleSets || []).find((item) => item.id === id) || null;
    }
    const meta = (this.data.customRuleSets || []).find((item) => item.id === id);
    if (!meta) return null;
    return {
      ...this._publicRuleSetMetadata(meta),
      ...(meta.payloadFile ? this._readJsonPayload(this.ruleSetDir, meta.payloadFile, this._ruleDigests) : {}),
    };
  }

  upsertCustomRuleSet(item) {
    if (!item || !item.id) throw new Error('remote rule id is required');
    if (!this._ruleStorageEnabled) {
      const list = [...(this.data.customRuleSets || [])];
      const index = list.findIndex((entry) => entry.id === item.id);
      if (index >= 0) list[index] = { ...list[index], ...item };
      else list.push(item);
      this._commitData({ ...this.data, customRuleSets: list });
      return item;
    }

    const list = this.data.customRuleSets || [];
    const current = list.find((entry) => entry.id === item.id) || null;
    const nextItem = current ? { ...this._publicRuleSetMetadata(current), ...item } : item;
    let payloadStage = null;
    try {
      let payloadFile = null;
      let payload = {};
      if (nextItem.kind === 'inline') {
        const changesPayload = RULESET_FIELDS.some((key) => hasOwn(item, key));
        if (current && current.payloadFile && !changesPayload) {
          payloadFile = current.payloadFile;
        } else {
          const currentPayload = current && current.payloadFile
            ? this._readJsonPayload(this.ruleSetDir, current.payloadFile, this._ruleDigests)
            : {};
          payload = { ...currentPayload, ...this._ruleSetPayload(item) };
          payloadStage = this._stageText(
            this.ruleSetDir,
            nextItem.id,
            'json',
            JSON.stringify(payload),
            current && current.payloadFile,
            this._ruleDigests,
            this._ruleSetFileName(nextItem.id)
          );
          payloadFile = payloadStage.file;
        }
      }
      const meta = this._ruleSetMetadata(nextItem, payloadFile);
      const nextList = [...list];
      const index = nextList.findIndex((entry) => entry.id === item.id);
      if (index >= 0) nextList[index] = meta;
      else nextList.push(meta);
      this._commitData({ ...this.data, customRuleSets: nextList });
      if (payloadStage) this._ruleDigests.set(payloadStage.file, payloadStage.digest);
      if (current) {
        this._retireFile(this.ruleSetDir, current.payloadFile, meta.payloadFile || null);
        if (current.payloadFile !== meta.payloadFile) this._ruleDigests.delete(current.payloadFile);
      }
      return { ...this._publicRuleSetMetadata(meta), ...payload };
    } catch (error) {
      this._discardStage(this.ruleSetDir, payloadStage);
      throw error;
    }
  }

  removeCustomRuleSet(id) {
    const list = this.data.customRuleSets || [];
    const current = list.find((entry) => entry.id === id);
    this._commitData({ ...this.data, customRuleSets: list.filter((entry) => entry.id !== id) });
    if (current && this._ruleStorageEnabled) {
      this._ruleDigests.delete(current.payloadFile);
      this._retireFile(this.ruleSetDir, current.payloadFile, null);
    }
  }

  _replaceCustomRuleSets(items) {
    const incoming = Array.isArray(items) ? items : [];
    if (!this._ruleStorageEnabled) {
      this._commitData({ ...this.data, customRuleSets: incoming });
      return;
    }
    const currentById = new Map((this.data.customRuleSets || []).map((meta) => [meta.id, meta]));
    const metadata = [];
    const stages = [];
    const seen = new Set();
    try {
      for (const item of incoming) {
        if (!item || !item.id || seen.has(item.id)) throw new Error('remote rule ids must be unique');
        seen.add(item.id);
        const current = currentById.get(item.id) || null;
        // As with profiles, track the stage before writing so a failure after
        // the write cannot leave an unreachable payload behind.
        const stage = { current, meta: null, payloadStage: null };
        stages.push(stage);
        let payloadFile = null;
        if (item.kind === 'inline') {
          const payload = this._ruleSetPayload(item);
          stage.payloadStage = this._stageText(
            this.ruleSetDir,
            item.id,
            'json',
            JSON.stringify(payload),
            current && current.payloadFile,
            this._ruleDigests,
            this._ruleSetFileName(item.id)
          );
          payloadFile = stage.payloadStage.file;
        }
        const meta = this._ruleSetMetadata(item, payloadFile);
        stage.meta = meta;
        metadata.push(meta);
      }
      this._commitData({ ...this.data, customRuleSets: metadata });
    } catch (error) {
      for (const stage of stages) this._discardStage(this.ruleSetDir, stage.payloadStage);
      throw error;
    }

    for (const stage of stages) {
      if (stage.payloadStage) this._ruleDigests.set(stage.payloadStage.file, stage.payloadStage.digest);
      if (stage.current) this._retireFile(this.ruleSetDir, stage.current.payloadFile, stage.meta.payloadFile || null);
    }
    const active = new Set(metadata.map((meta) => meta.payloadFile).filter(Boolean));
    this._cleanupPayloadDir(this.ruleSetDir, active, ['json']);
    this._pruneDigests(this._ruleDigests, active);
  }

  get(key) {
    if (key === 'subscriptions') return this.getSubscriptions({ includeRaw: true });
    if (key === 'customRuleSets') return this.getCustomRuleSets();
    return this.data[key];
  }

  set(key, value) {
    if (key === 'subscriptions') {
      this._replaceSubscriptions(value);
      return;
    }
    if (key === 'customRuleSets') {
      this._replaceCustomRuleSets(value);
      return;
    }
    this._commitData({ ...this.data, [key]: value });
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
  }

  updateSettings(patch) {
    const settings = { ...this.getSettings(), ...patch };
    this._commitData({ ...this.data, settings });
    return settings;
  }
}

module.exports = { Store };
