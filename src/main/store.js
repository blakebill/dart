'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROFILE_FIELDS = ['nodes', 'clashRules', 'clashRuleProviders', 'raw'];
const PROFILE_CACHE_LIMIT = 3;

/**
 * Minimal JSON persistence store (a zero-dependency replacement for electron-store).
 * Large profile payloads live in independent files and are loaded on demand.
 */

const DEFAULT_SETTINGS = {
  mixedPort: 7890,
  clashApiPort: 9090,
  enableTun: false,
  enableClashApi: true,
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
  theme: 'dark',
  clashMode: 'rule',
  coreType: 'sing-box',
  useBuiltinRules: false,
  ruleOverrides: {},
  testUrl: 'http://www.gstatic.com/generate_204',
  testConcurrency: 8,
};

class Store {
  constructor(dir, name = 'config.json') {
    this.dir = dir;
    this.file = path.join(dir, name);
    this.profileDir = path.join(dir, 'profiles');
    this._profileCache = new Map();
    this._profileDigests = new Map();
    this._profileStorageEnabled = true;
    this.data = this._load();
    this._prepareSubscriptions();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : this._defaults();
      }
    } catch (_) {
      try { fs.renameSync(this.file, this.file + '.bak'); } catch (_) {}
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
      pendingUwpLoopbackSids: null,
    };
  }

  _profileFileName(id) {
    const raw = String(id || 'profile');
    const safe = /^[A-Za-z0-9_-]{1,128}$/.test(raw)
      ? raw
      : crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return safe + '.json';
  }

  _profilePayload(sub) {
    const payload = {};
    for (const key of PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(sub || {}, key)) payload[key] = sub[key];
    }
    return payload;
  }

  _subscriptionMetadata(sub, payload) {
    const metadata = {};
    for (const [key, value] of Object.entries(sub || {})) {
      if (!PROFILE_FIELDS.includes(key) && key !== 'dataFile' && key !== 'nodeCount') metadata[key] = value;
    }
    metadata.dataFile = this._profileFileName(metadata.id);
    const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : null;
    metadata.nodeCount = nodes ? nodes.length : Math.max(0, Number(sub && sub.nodeCount) || 0);
    return metadata;
  }

  _publicMetadata(meta, includeCount = false) {
    const { dataFile, nodeCount, ...publicMeta } = meta || {};
    if (includeCount) publicMeta.nodeCount = Math.max(0, Number(nodeCount) || 0);
    return publicMeta;
  }

  _digest(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  _readProfileFile(fileName) {
    const expected = path.join(this.profileDir, fileName);
    for (const file of [expected, expected + '.bak']) {
      try {
        const text = fs.readFileSync(file, 'utf-8');
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        this._profileDigests.set(fileName, this._digest(text));
        return payload;
      } catch (_) {
        /* try the backup */
      }
    }
    return {};
  }

  _rememberProfile(id, payload) {
    if (this._profileCache.has(id)) this._profileCache.delete(id);
    this._profileCache.set(id, payload);
    while (this._profileCache.size > PROFILE_CACHE_LIMIT) {
      this._profileCache.delete(this._profileCache.keys().next().value);
    }
  }

  _profileForMeta(meta, cache = true) {
    if (!meta) return {};
    if (this._profileCache.has(meta.id)) {
      const payload = this._profileCache.get(meta.id);
      this._rememberProfile(meta.id, payload);
      return payload;
    }
    const payload = this._readProfileFile(meta.dataFile);
    if (cache) this._rememberProfile(meta.id, payload);
    return payload;
  }

  _writeAtomic(file, text, keepBackup = false) {
    const tmp = file + `.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(tmp, text, 'utf-8');
      if (keepBackup && fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  _writeProfile(meta, payload) {
    const text = JSON.stringify(payload);
    const digest = this._digest(text);
    if (this._profileDigests.get(meta.dataFile) !== digest) {
      this._writeAtomic(path.join(this.profileDir, meta.dataFile), text, true);
      this._profileDigests.set(meta.dataFile, digest);
    }
    this._rememberProfile(meta.id, payload);
  }

  _writeConfig() {
    this._writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  _prepareSubscriptions() {
    const records = Array.isArray(this.data.subscriptions) ? this.data.subscriptions : [];
    const metadata = [];
    let changed = false;
    try {
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const expected = this._profileFileName(record.id);
        let payload;
        if (record.dataFile === expected && !PROFILE_FIELDS.some((key) => key in record)) {
          if (!Number.isFinite(record.nodeCount)) {
            payload = this._readProfileFile(expected);
            changed = true;
          }
        } else {
          payload = this._profilePayload(record);
          changed = true;
        }
        const meta = this._subscriptionMetadata(record, payload);
        metadata.push(meta);
        if (payload) this._writeProfile(meta, payload);
        if (record.dataFile !== meta.dataFile || record.nodeCount !== meta.nodeCount) changed = true;
      }
      this.data.subscriptions = metadata;
      if (changed) this._writeConfig();
    } catch (_) {
      // Keep operating in memory if the profile directory cannot be migrated.
      this._profileStorageEnabled = false;
      this.data.subscriptions = records;
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

  getSubscription(id) {
    if (!this._profileStorageEnabled) {
      return (this.data.subscriptions || []).find((sub) => sub.id === id) || null;
    }
    const meta = (this.data.subscriptions || []).find((sub) => sub.id === id);
    if (!meta) return null;
    return { ...this._publicMetadata(meta), ...this._profileForMeta(meta) };
  }

  getSubscriptions() {
    return this.listSubscriptions().map((meta) => this.getSubscription(meta.id)).filter(Boolean);
  }

  upsertSubscription(subscription) {
    if (!subscription || !subscription.id) throw new Error('subscription id is required');
    if (!this._profileStorageEnabled) {
      const list = this.data.subscriptions || [];
      const index = list.findIndex((sub) => sub.id === subscription.id);
      if (index >= 0) list[index] = subscription;
      else list.push(subscription);
      this.data.subscriptions = list;
      this._writeConfig();
      return subscription;
    }
    const currentMeta = (this.data.subscriptions || []).find((sub) => sub.id === subscription.id);
    const currentPayload = currentMeta ? this._profileForMeta(currentMeta) : {};
    const incomingPayload = this._profilePayload(subscription);
    const payload = { ...currentPayload, ...incomingPayload };
    const meta = this._subscriptionMetadata(subscription, payload);
    this._writeProfile(meta, payload);
    const list = this.data.subscriptions || [];
    const index = list.findIndex((sub) => sub.id === subscription.id);
    if (index >= 0) list[index] = meta;
    else list.push(meta);
    this.data.subscriptions = list;
    this._writeConfig();
    return { ...this._publicMetadata(meta), ...payload };
  }

  removeSubscription(id) {
    const list = this.data.subscriptions || [];
    const meta = list.find((sub) => sub.id === id);
    this.data.subscriptions = list.filter((sub) => sub.id !== id);
    this._profileCache.delete(id);
    if (meta && meta.dataFile) {
      for (const suffix of ['', '.bak']) {
        try { fs.unlinkSync(path.join(this.profileDir, meta.dataFile + suffix)); } catch (_) {}
      }
      this._profileDigests.delete(meta.dataFile);
    }
    this._writeConfig();
  }

  _replaceSubscriptions(items) {
    const incoming = Array.isArray(items) ? items : [];
    const activeFiles = new Set();
    const metadata = [];
    for (const sub of incoming) {
      const payload = this._profilePayload(sub);
      const meta = this._subscriptionMetadata(sub, payload);
      metadata.push(meta);
      activeFiles.add(meta.dataFile);
      this._writeProfile(meta, payload);
    }
    this.data.subscriptions = metadata;
    try {
      for (const name of fs.readdirSync(this.profileDir)) {
        const base = name.endsWith('.bak') ? name.slice(0, -4) : name;
        if (/^[A-Za-z0-9_-]+\.json$/.test(base) && !activeFiles.has(base)) {
          fs.unlinkSync(path.join(this.profileDir, name));
          this._profileDigests.delete(base);
        }
      }
    } catch (_) {}
    this._writeConfig();
  }

  save(changedKey = null) {
    if (changedKey === 'subscriptions') {
      this._replaceSubscriptions(this.getSubscriptions());
      return;
    }
    this._writeConfig();
  }

  get(key) {
    if (key === 'subscriptions') return this.getSubscriptions();
    return this.data[key];
  }

  set(key, value) {
    if (key === 'subscriptions') {
      this._replaceSubscriptions(value);
      return;
    }
    this.data[key] = value;
    this._writeConfig();
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
  }

  updateSettings(patch) {
    this.data.settings = { ...this.getSettings(), ...patch };
    this._writeConfig();
    return this.data.settings;
  }
}

module.exports = { Store };
