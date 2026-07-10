'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROFILE_FIELDS = ['nodes', 'clashRules', 'clashRuleProviders', 'raw'];

/**
 * Minimal JSON persistence store (a zero-dependency replacement for electron-store).
 * Persists app data: subscription list, settings, currently selected node, etc.
 */

// Hoisted: getSettings() runs for every Clash API call, so the defaults must
// not be rebuilt each time.
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
  hardwareAcceleration: false,
  // When true, ignore the subscription's own Clash rules and use the app's
  // built-in routing (CN/private direct, rest proxied) plus the user's local
  // rules — so the user controls routing instead of the subscription.
  useBuiltinRules: false,
  // Per-policy-group outbound overrides for the subscription's own rules:
  // { [groupName]: 'direct'|'proxy'|'reject' }. Keeps the sub's matching but
  // lets the user change where each group routes. Unlisted groups -> proxy.
  ruleOverrides: {},
  // Node latency test: the URL the core fetches per node, and how many probes
  // run at once during "Test All". HTTP (not HTTPS) avoids a per-test TLS
  // handshake to the target that real browsing amortizes away (see testNodeDelay).
  testUrl: 'http://www.gstatic.com/generate_204',
  testConcurrency: 8,
};

class Store {
  constructor(dir, name = 'config.json') {
    this.dir = dir;
    this.file = path.join(dir, name);
    this.profileDir = path.join(dir, 'profiles');
    this._profileSerialized = new Map();
    this._persistedSubscriptions = null;
    this._needsProfileMigration = false;
    this._profileStorageEnabled = true;
    this.data = this._load();
    const subscriptions = Array.isArray(this.data.subscriptions) ? this.data.subscriptions : [];
    this.data.subscriptions = subscriptions;
    this._persistedSubscriptions = subscriptions.map((sub) => this._subscriptionMetadata(sub));
    if (this._needsProfileMigration) {
      try {
        this.save('subscriptions');
      } catch (_) {
        // Keep the legacy single-file format for this run if migration cannot
        // be completed. The original config remains untouched.
        this._profileStorageEnabled = false;
      }
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        if (Array.isArray(data.subscriptions)) {
          data.subscriptions = data.subscriptions.map((sub) => this._hydrateSubscription(sub));
        }
        return data;
      }
    } catch (e) {
      // Back up and reset if the file is corrupted
      try {
        fs.renameSync(this.file, this.file + '.bak');
      } catch (_) {}
    }
    return this._defaults();
  }

  _defaults() {
    return {
      subscriptions: [], // { id, name, url, nodes, userInfo, updatedAt }
      settings: { ...DEFAULT_SETTINGS },
      selected: null, // { subId, nodeName } currently selected node
      activeSub: null, // id of the subscription (profile) currently in use
      customRuleSets: [], // user-added remote rule-sets
      localRules: [], // user-added local rules (domain/ip_cidr/... -> target)
      lastRunning: false, // whether the core was running at last quit (auto-resume)
      pendingUwpLoopbackSids: null, // selected UWP loopback exemptions to apply after elevated relaunch
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
      if (Object.prototype.hasOwnProperty.call(sub, key)) payload[key] = sub[key];
    }
    return payload;
  }

  _subscriptionMetadata(sub) {
    const metadata = {};
    for (const [key, value] of Object.entries(sub || {})) {
      if (!PROFILE_FIELDS.includes(key) && key !== 'dataFile') metadata[key] = value;
    }
    metadata.dataFile = this._profileFileName(metadata.id);
    return metadata;
  }

  _readProfile(fileName) {
    const expected = path.join(this.profileDir, fileName);
    for (const file of [expected, expected + '.bak']) {
      try {
        const text = fs.readFileSync(file, 'utf-8');
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        this._profileSerialized.set(fileName, JSON.stringify(payload));
        return payload;
      } catch (_) {
        /* try the backup */
      }
    }
    return {};
  }

  _hydrateSubscription(sub) {
    if (!sub || typeof sub !== 'object') return sub;
    if (!sub.dataFile) {
      this._needsProfileMigration = true;
      return sub;
    }
    const expected = this._profileFileName(sub.id);
    if (sub.dataFile !== expected) {
      this._needsProfileMigration = true;
      return { ...sub, dataFile: undefined };
    }
    const { dataFile, ...metadata } = sub;
    return { ...metadata, ...this._readProfile(dataFile) };
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

  _syncProfiles() {
    const subscriptions = Array.isArray(this.data.subscriptions) ? this.data.subscriptions : [];
    const activeFiles = new Set();
    const metadata = [];
    for (const sub of subscriptions) {
      const meta = this._subscriptionMetadata(sub);
      const fileName = meta.dataFile;
      const payloadText = JSON.stringify(this._profilePayload(sub));
      activeFiles.add(fileName);
      metadata.push(meta);
      if (this._profileSerialized.get(fileName) !== payloadText) {
        this._writeAtomic(path.join(this.profileDir, fileName), payloadText, true);
        this._profileSerialized.set(fileName, payloadText);
      }
    }
    this._persistedSubscriptions = metadata;
    this._pendingProfileCleanup = activeFiles;
  }

  _cleanupProfiles(activeFiles) {
    if (!activeFiles) return;
    try {
      for (const name of fs.readdirSync(this.profileDir)) {
        const base = name.endsWith('.bak') ? name.slice(0, -4) : name;
        if (/^[A-Za-z0-9_-]+\.json$/.test(base) && !activeFiles.has(base)) {
          fs.unlinkSync(path.join(this.profileDir, name));
          this._profileSerialized.delete(base);
        }
      }
    } catch (_) {
      /* profile dir may not exist yet */
    }
  }

  save(changedKey = null) {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    if (!this._profileStorageEnabled) {
      this._writeAtomic(this.file, JSON.stringify(this.data, null, 2));
      return;
    }
    if (changedKey === 'subscriptions' || !this._persistedSubscriptions) this._syncProfiles();
    const persisted = { ...this.data, subscriptions: this._persistedSubscriptions || [] };
    // Atomic write: a crash/power-cut mid-write must never truncate the only
    // copy of the user's subscriptions. Write a temp file, then rename over.
    this._writeAtomic(this.file, JSON.stringify(persisted, null, 2));
    this._cleanupProfiles(this._pendingProfileCleanup);
    this._pendingProfileCleanup = null;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save(key);
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
  }

  updateSettings(patch) {
    this.data.settings = { ...this.getSettings(), ...patch };
    this.save('settings');
    return this.data.settings;
  }
}

module.exports = { Store };
