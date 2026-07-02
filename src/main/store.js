'use strict';

const fs = require('fs');
const path = require('path');

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
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf-8'));
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

  save() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    // Atomic write: a crash/power-cut mid-write must never truncate the only
    // copy of the user's subscriptions. Write a temp file, then rename over.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
  }

  updateSettings(patch) {
    this.data.settings = { ...this.getSettings(), ...patch };
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store };
