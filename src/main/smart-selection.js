'use strict';

const DEFAULT_OPTIONS = Object.freeze({
  alpha: 0.3,
  failureAlpha: 0.25,
  // RTT is only one signal; real traffic + failures weigh more than a lucky 204.
  ewmaWeight: 0.62,
  jitterWeight: 0.9,
  failurePenalty: 950,
  consecutiveFailurePenalty: 280,
  explorationBonusMs: 90,
  explorationTailRatio: 0.25,
  varianceFloorMs: 15,
  selectionRiskWeight: 0.35,
  sampleHalfLifeMs: 15 * 60_000,
  failureHalfLifeMs: 8 * 60_000,
  networkChangeRetention: 0.25,
  switchThresholdMs: 25,
  switchThresholdRatio: 0.1,
  // Healthy stick needs this many consecutive rounds preferring the challenger.
  switchConfirmRounds: 2,
  minDwellMs: 120_000,
  failedDwellMs: 8_000,
  staleAfterMs: 180_000,
  maxSampleAgeMs: 900_000,
  stalePenaltyPerMinute: 10,
  cooldownBaseMs: 30_000,
  cooldownMaxMs: 300_000,
  maxNodes: 4096,
  // Default / floor for "too slow to prefer". Adaptive recompute may raise this.
  maxAcceptableDelayMs: 500,
  minAcceptableDelayMs: 400,
  maxAcceptableDelayCapMs: 2000,
  // Need this many healthy samples before adapting away from the default.
  adaptiveDelayMinSamples: 5,
  // Never prefer UI-stability "bad" when any healthier node exists.
  excludeStabilityBad: true,
  // Real traffic confirms reachability and reduces probe uncertainty, but does
  // not directly make an already-selected node cheaper.
  maxTrafficEvidence: 4,
  // Soft-fail from short-lived near-zero-byte connections (not full URL timeout).
  softFailAlpha: 0.18,
});

const SMART_MODE_OPTIONS = Object.freeze({
  balanced: Object.freeze({}),
  latency: Object.freeze({
    ewmaWeight: 0.8,
    jitterWeight: 0.65,
    explorationBonusMs: 120,
    switchThresholdMs: 12,
    switchThresholdRatio: 0.05,
    switchConfirmRounds: 1,
    minDwellMs: 45_000,
    failedDwellMs: 4_000,
    selectionRiskWeight: 0.2,
  }),
  stable: Object.freeze({
    ewmaWeight: 0.5,
    jitterWeight: 1.2,
    explorationBonusMs: 45,
    failurePenalty: 1_200,
    consecutiveFailurePenalty: 360,
    switchThresholdMs: 45,
    switchThresholdRatio: 0.18,
    switchConfirmRounds: 3,
    minDwellMs: 300_000,
    failedDwellMs: 8_000,
    selectionRiskWeight: 0.55,
  }),
});

function normalizeSmartMode(value) {
  return Object.prototype.hasOwnProperty.call(SMART_MODE_OPTIONS, value) ? value : 'balanced';
}

/** Hostnames that are connectivity checks / latency probes — ignore for soft-fail. */
const DEFAULT_IGNORE_HOSTS = Object.freeze([
  'www.gstatic.com',
  'gstatic.com',
  'connectivitycheck.gstatic.com',
  'www.google.com',
  'cp.cloudflare.com',
  'cloudflare.com',
  'speed.cloudflare.com',
  'www.msftconnecttest.com',
  'msftconnecttest.com',
  'detectportal.firefox.com',
  'captive.apple.com',
  'www.apple.com',
  'clients3.google.com',
  'generate_204',
]);

const BUILTIN_GROUP_TAGS = new Set([
  '🚀 Proxy',
  '♻️ Auto',
  '🧠 Smart',
  '🛟 Fallback',
  'GLOBAL',
  'DIRECT',
  'REJECT',
  'direct',
  'block',
  'Pass',
  'REJECT-DROP',
]);

function validDelay(value) {
  return Number.isFinite(value) && value >= 0 && value <= 120_000;
}

/** Delay still counts as a sample, but is too slow to be a Smart pick. */
function isAcceptableDelay(value, maxMs) {
  return validDelay(value) && Number(value) < maxMs;
}

/**
 * Adaptive "red line" from the current healthy delay distribution.
 * Uses ~p75 * 1.5, clamped to [min, cap]. Falls back to default when sparse.
 */
function computeAdaptiveAcceptableDelayMs(states, options, now = Date.now()) {
  const minMs = Number(options.minAcceptableDelayMs) || 400;
  const capMs = Number(options.maxAcceptableDelayCapMs) || 2000;
  const fallback = Number(options.maxAcceptableDelayMs) || 500;
  const need = Math.max(3, Number(options.adaptiveDelayMinSamples) || 5);
  const delays = [];
  for (const state of states) {
    if (!state || state.ewma == null) continue;
    if (state.consecutiveFailures > 0 || state.cooldownUntil > now) continue;
    if (state.effectiveSamples !== undefined && state.effectiveSamples < 0.5) continue;
    if (state.lastSuccess && now - state.lastSuccess > options.maxSampleAgeMs) continue;
    if (!validDelay(state.ewma)) continue;
    delays.push(Number(state.ewma));
  }
  if (delays.length < need) return fallback;
  delays.sort((a, b) => a - b);
  const p75 = delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.75))];
  const adapted = Math.round(p75 * 1.5);
  return Math.min(capMs, Math.max(minMs, adapted));
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Robust cohort scale in milliseconds. Median/MAD keeps one broken node from
 * stretching every penalty while still adapting between local and long-haul
 * subscriptions.
 */
function computeCohortCostProfile(states, options, now = Date.now()) {
  const delays = [];
  for (const state of states || []) {
    if (!state || !validDelay(state.ewma)) continue;
    if (state.cooldownUntil > now || state.consecutiveFailures > 0) continue;
    if (state.effectiveSamples !== undefined && state.effectiveSamples < 0.5) continue;
    if (state.lastSuccess && now - state.lastSuccess > options.maxSampleAgeMs) continue;
    delays.push(Number(state.ewma));
  }
  const median = delays.length ? medianOf(delays) : 100;
  const deviations = delays.map((value) => Math.abs(value - median));
  const spread = Math.max(20, medianOf(deviations) * 1.4826 || 0);
  const configuredFailure = Math.max(1, Number(options.failurePenalty) || 950);
  const modeFactor = Math.max(0.6, Math.min(1.6, configuredFailure / 950));
  const failurePenalty = Math.max(450, Math.min(
    2_000,
    (450 + median + spread * 4) * modeFactor
  ));
  return {
    median,
    spread,
    failurePenalty,
    softFailPenalty: Math.max(120, failurePenalty * 0.24),
  };
}

// How long a failure "stains" the UI stability chip after the last fail.
const STABILITY_FAIL_HOLD_MS = 3 * 60_000;
// Consecutive successes required after a failure before green is allowed.
const STABILITY_RECOVER_SUCCESSES = 6;
const STABILITY_RECOVER_MID_SUCCESSES = 3;

/**
 * UI "quality" is stability, not speed. Delay already shows RTT; this answers
 * "how consistent has this node been under Smart history?"
 *
 * Recovery is intentionally sticky: a few lucky re-tests must not instantly
 * paint a recently-red node green (that was the main UX complaint).
 */
function stabilityFromState(state, now = Date.now()) {
  if (!state || state.samples < 1 || state.ewma == null) return { level: 'unknown' };

  const softFails = Math.max(0, Number(state.softFails) || 0);
  const failingNow = state.consecutiveFailures > 0 || softFails >= 2 || state.cooldownUntil > now;
  const urlFailure = Number(state.lastFailure) || 0;
  const connectionFailure = Number(state.lastConnectionFailure) || 0;
  const lastFailure = Math.max(urlFailure, connectionFailure);
  const sinceFailure = lastFailure ? now - lastFailure : Infinity;
  const successSinceFailure = connectionFailure > urlFailure
    ? Math.max(0, Number(state.connectionSuccesses) || 0)
    : Math.max(0, Number(state.successSinceFailure) || 0);
  const failureRate = Math.max(
    Number(state.failureRate) || 0,
    Number(state.connectionFailureRate) || 0
  );
  const recentlyFailed = lastFailure > 0 && sinceFailure < STABILITY_FAIL_HOLD_MS;

  if (failingNow) return { level: 'bad' };

  // After any failure, stay red until enough clean successes accumulate,
  // then mid, then (only after the hold window + more successes) green.
  if (recentlyFailed) {
    if (successSinceFailure < STABILITY_RECOVER_MID_SUCCESSES) return { level: 'bad' };
    if (successSinceFailure < STABILITY_RECOVER_SUCCESSES) return { level: 'mid' };
    // Even with enough successes, keep mid while still inside the hold window
    // unless the failure rate has clearly cooled down.
    if (failureRate >= 0.08) return { level: 'mid' };
  }

  if (failureRate >= 0.28) return { level: 'bad' };
  if (failureRate >= 0.12) return { level: 'mid' };

  // Prefer peak jitter (decays slowly) so a brief calm stretch cannot erase
  // a wild swing that just made the chip red.
  const ewma = state.ewma;
  const jitter = Math.max(Number(state.jitter) || 0, Number(state.peakJitter) || 0);
  const jitterRatio = ewma > 0 ? jitter / ewma : 0;
  if (state.samples < 5) return { level: 'mid' };
  if (jitterRatio > 0.4) return { level: 'bad' };
  if (jitterRatio > 0.2) return { level: 'mid' };
  if (recentlyFailed) return { level: 'mid' };
  return { level: 'good' };
}

function emptyNodeState() {
  return {
    identity: null,
    attempts: 0,
    effectiveAttempts: 0,
    samples: 0,
    effectiveSamples: 0,
    ewma: null,
    delayMean: null,
    delayM2: 0,
    jitter: 0,
    peakJitter: 0,
    failureRate: 0,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    lastSeen: 0,
    lastSuccess: 0,
    lastFailure: 0,
    successSinceFailure: 0,
    lastTraffic: 0,
    trafficBytes: 0,
    trafficEvidence: 0,
    softFails: 0,
    connectionFailureRate: 0,
    lastConnectionFailure: 0,
    connectionSuccesses: 0,
    displayDelay: null,
    lastDisplayDelay: 0,
    lastDecay: 0,
  };
}

function hostnameFromUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname;
    return host ? host.toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Resolve the outbound leaf from a Clash connection chain. */
function leafOutbound(chains, allowedNames = null) {
  if (!Array.isArray(chains) || !chains.length) return null;
  const pick = (list) => {
    for (const raw of list) {
      const name = typeof raw === 'string' ? raw : '';
      if (!name || BUILTIN_GROUP_TAGS.has(name)) continue;
      if (allowedNames && !allowedNames.has(name)) continue;
      return name;
    }
    return null;
  };
  return pick(chains) || pick([...chains].reverse());
}

/**
 * Diff successive /connections snapshots into traffic / soft-fail events.
 *
 * Denoise rules:
 * - drop explicit UDP; empty/missing network is kept (some cores omit it)
 * - prefer metadata.host, fall back to destinationIP
 * - ignore probe / captive-portal / configured testUrl hosts
 * - soft-fail only after several short deaths for the same node in a window
 */
class ConnectionFeedbackTracker {
  constructor(options = {}) {
    this.prev = new Map();
    this.softFailTimes = new Map(); // node → timestamps[]
    this.nodeNames = null;
    this.ignoreHosts = new Set(DEFAULT_IGNORE_HOSTS);
    this.softFailWindowMs = Math.max(30_000, Number(options.softFailWindowMs) || 90_000);
    this.softFailEmitThreshold = Math.max(2, Number(options.softFailEmitThreshold) || 3);
    this.minTrafficDelta = Math.max(1_000, Number(options.minTrafficDelta) || 12_000);
    this.minSuccessBytes = Math.max(1_000, Number(options.minSuccessBytes) || 30_000);
    this.softFailMaxAgeMs = Math.max(1_000, Number(options.softFailMaxAgeMs) || 4_000);
    this.softFailMaxBytes = Math.max(0, Number(options.softFailMaxBytes) || 2_048);
  }

  reset() {
    this.prev.clear();
    this.softFailTimes.clear();
  }

  /** Extra hosts to ignore (e.g. settings.testUrl hostname). */
  setIgnoreHosts(hosts) {
    this.ignoreHosts = new Set(DEFAULT_IGNORE_HOSTS);
    for (const host of hosts || []) {
      const n = normalizeHost(host);
      if (n) this.ignoreHosts.add(n);
    }
  }

  /** Restrict feedback to real leaf nodes from the active profile. */
  setNodeNames(names) {
    const next = new Set();
    for (const value of names || []) {
      if (typeof value === 'string' && value) next.add(value);
    }
    this.nodeNames = next.size ? next : null;
  }

  _isIgnoredHost(host) {
    const h = normalizeHost(host);
    if (!h) return true;
    if (this.ignoreHosts.has(h)) return true;
    for (const ignored of this.ignoreHosts) {
      if (ignored && (h === ignored || h.endsWith('.' + ignored))) return true;
    }
    return false;
  }

  _noteSoftFail(name, now, events) {
    const windowMs = this.softFailWindowMs;
    const times = (this.softFailTimes.get(name) || []).filter((t) => now - t < windowMs);
    times.push(now);
    if (times.length >= this.softFailEmitThreshold) {
      events.push({ name, kind: 'softFail', now, count: times.length });
      // Reset so another full streak is required for the next soft-fail event.
      this.softFailTimes.set(name, []);
      return;
    }
    this.softFailTimes.set(name, times);
  }

  ingest(connections, now = Date.now()) {
    const events = [];
    const next = new Map();
    const list = Array.isArray(connections) ? connections : [];

    for (const conn of list) {
      if (!conn || typeof conn !== 'object') continue;
      const id = typeof conn.id === 'string' ? conn.id : '';
      if (!id) continue;
      const meta = conn.metadata && typeof conn.metadata === 'object' ? conn.metadata : {};
      const network = String(meta.network || conn.network || '').toLowerCase();
      // Drop only explicit non-TCP. Empty network is common on some Clash builds.
      if (network && network !== 'tcp') continue;
      // Prefer hostname; fall back to destination IP so IP-only rows still count.
      const host = normalizeHost(meta.host) || normalizeHost(meta.destinationIP);
      if (!host || this._isIgnoredHost(host)) continue;
      const name = leafOutbound(conn.chains, this.nodeNames);
      if (!name) continue;
      const upload = Math.max(0, Number(conn.upload) || 0);
      const download = Math.max(0, Number(conn.download) || 0);
      const startMs = conn.start ? Date.parse(conn.start) || 0 : 0;
      const bytes = upload + download;
      const prev = this.prev.get(id);
      next.set(id, { name, upload, download, startMs, seenAt: now, host });

      if (prev && prev.name === name) {
        const delta = Math.max(0, bytes - (prev.upload + prev.download));
        if (delta >= this.minTrafficDelta) {
          events.push({ name, kind: 'traffic', bytes: delta, now });
        }
      } else if (!prev && bytes >= Math.max(this.minSuccessBytes, 40_000)) {
        events.push({ name, kind: 'traffic', bytes, now });
      }
    }

    for (const [id, prev] of this.prev.entries()) {
      if (next.has(id)) continue;
      const age = prev.startMs ? Math.max(0, now - prev.startMs) : (now - prev.seenAt);
      const bytes = prev.upload + prev.download;
      if (age > 0 && age < this.softFailMaxAgeMs && bytes < this.softFailMaxBytes) {
        this._noteSoftFail(prev.name, now, events);
      } else if (bytes >= this.minSuccessBytes) {
        events.push({ name: prev.name, kind: 'success', bytes, now });
      }
    }

    this.prev = next;
    return events;
  }
}

class SmartSelectionModel {
  constructor(options = {}) {
    const { mode, ...customOptions } = options;
    this.customOptions = customOptions;
    this.mode = normalizeSmartMode(mode);
    this.options = { ...DEFAULT_OPTIONS, ...SMART_MODE_OPTIONS[this.mode], ...customOptions };
    this.options.maxNodes = Math.max(1, Math.floor(Number(this.options.maxNodes) || DEFAULT_OPTIONS.maxNodes));
    this.contextKey = null;
    this.nodes = new Map();
    this.identities = new Map();
    this.selected = null;
    this.selectedAt = 0;
    this.networkKey = null;
    this.globalOutageUntil = 0;
    this.acceptableDelayMs = Number(this.options.maxAcceptableDelayMs) || DEFAULT_OPTIONS.maxAcceptableDelayMs;
    /** @type {{ name: string, count: number } | null} */
    this.pendingSwitch = null;
  }

  clear(contextKey = null) {
    this.contextKey = contextKey;
    this.nodes.clear();
    this.identities.clear();
    this.selected = null;
    this.selectedAt = 0;
    this.pendingSwitch = null;
    this.globalOutageUntil = 0;
    this.acceptableDelayMs = Number(this.options.maxAcceptableDelayMs) || DEFAULT_OPTIONS.maxAcceptableDelayMs;
  }

  setMode(mode) {
    const next = normalizeSmartMode(mode);
    if (next === this.mode) return false;
    this.mode = next;
    this.options = { ...DEFAULT_OPTIONS, ...SMART_MODE_OPTIONS[next], ...this.customOptions };
    this.options.maxNodes = Math.max(1, Math.floor(Number(this.options.maxNodes) || DEFAULT_OPTIONS.maxNodes));
    this.pendingSwitch = null;
    return true;
  }

  _setContext(contextKey) {
    const next = String(contextKey || 'default');
    if (next !== this.contextKey) this.clear(next);
  }

  /**
   * Update display-name aliases without throwing away history when a provider
   * renames a node. Public APIs remain name-based for Clash and the renderer.
   */
  setNodeIdentities(entries) {
    const next = entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries || {}));
    const previousByIdentity = new Map();
    const selectedIdentity = this.selected
      ? ((this.nodes.get(this.selected) || {}).identity || this.identities.get(this.selected))
      : null;
    const pendingIdentity = this.pendingSwitch && this.pendingSwitch.name
      ? ((this.nodes.get(this.pendingSwitch.name) || {}).identity ||
        this.identities.get(this.pendingSwitch.name))
      : null;
    let migratedSelected = null;
    let migratedPending = null;
    for (const [name, state] of this.nodes) {
      const identity = state.identity || this.identities.get(name);
      if (identity && !previousByIdentity.has(identity)) previousByIdentity.set(identity, state);
    }
    const migrated = new Map();
    for (const [name, rawIdentity] of next) {
      if (typeof name !== 'string' || !name) continue;
      const identity = typeof rawIdentity === 'string' && rawIdentity ? rawIdentity : name;
      const direct = this.nodes.get(name);
      const state = direct && (!direct.identity || direct.identity === identity)
        ? direct
        : previousByIdentity.get(identity);
      if (state) {
        state.identity = identity;
        migrated.set(name, state);
      }
      if (identity === selectedIdentity) migratedSelected = name;
      if (identity === pendingIdentity) migratedPending = name;
      next.set(name, identity);
    }
    this.nodes = migrated;
    this.identities = next;
    if (selectedIdentity) this.selected = migratedSelected;
    if (this.pendingSwitch && pendingIdentity) {
      this.pendingSwitch = migratedPending
        ? { ...this.pendingSwitch, name: migratedPending }
        : null;
    }
  }

  _decayState(state, now) {
    if (!state) return;
    const previous = Number(state.lastDecay) || Number(state.lastSeen) || now;
    const elapsed = Math.max(0, now - previous);
    state.lastDecay = Math.max(previous, now);
    if (!elapsed) return;
    const sampleHalfLife = Math.max(60_000, Number(this.options.sampleHalfLifeMs) || 900_000);
    const failureHalfLife = Math.max(60_000, Number(this.options.failureHalfLifeMs) || 480_000);
    const sampleFactor = 2 ** (-elapsed / sampleHalfLife);
    const failureFactor = 2 ** (-elapsed / failureHalfLife);
    state.effectiveAttempts *= sampleFactor;
    state.effectiveSamples *= sampleFactor;
    state.delayM2 *= sampleFactor;
    state.trafficEvidence *= sampleFactor;
    state.failureRate *= failureFactor;
    state.connectionFailureRate *= failureFactor;
    state.softFails *= failureFactor;
  }

  setNetworkKey(networkKey, now = Date.now()) {
    const next = networkKey == null ? null : String(networkKey);
    if (this.networkKey === next) return false;
    const first = this.networkKey == null;
    this.networkKey = next;
    if (first) return true;
    // Keep a weak prior across interfaces, but make every node uncertain again.
    const retention = Math.max(0, Math.min(1, Number(this.options.networkChangeRetention) || 0.25));
    for (const state of this.nodes.values()) {
      this._decayState(state, now);
      state.effectiveAttempts *= retention;
      state.effectiveSamples *= retention;
      state.delayM2 *= retention;
      state.trafficEvidence *= retention;
      state.failureRate *= retention;
      state.connectionFailureRate *= retention;
      state.softFails *= retention;
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.lastDecay = now;
    }
    this.selectedAt = 0;
    this.pendingSwitch = null;
    this.globalOutageUntil = 0;
    this.acceptableDelayMs = Number(this.options.maxAcceptableDelayMs) || DEFAULT_OPTIONS.maxAcceptableDelayMs;
    return true;
  }

  peek(name) {
    const state = this.nodes.get(name);
    return state ? { ...state } : null;
  }

  _ensure(name, now) {
    let state = this.nodes.get(name);
    if (!state) {
      state = emptyNodeState();
      state.identity = this.identities.get(name) || name;
      this.nodes.set(name, state);
    }
    this._decayState(state, now);
    state.lastSeen = now;
    return state;
  }

  observe(measurement, now = Date.now()) {
    this._record(measurement, now);
  }

  /** Latest primary-URL RTT for the UI; it does not influence Smart scoring. */
  observeDisplayDelay(name, delay, now = Date.now()) {
    if (typeof name !== 'string' || !name) return;
    const state = this._ensure(name, now);
    state.displayDelay = validDelay(delay) ? Number(delay) : null;
    state.lastDisplayDelay = state.displayDelay == null ? 0 : now;
  }

  /**
   * Real-path feedback from Clash /connections diffs (not URL delay).
   * @param {{ name: string, kind: 'traffic'|'success'|'softFail', bytes?: number }} event
   */
  observeConnection(event, now = Date.now()) {
    const name = event && typeof event.name === 'string' ? event.name : '';
    if (!name) return;
    const kind = event && event.kind;
    const state = this._ensure(name, now);

    if (kind === 'traffic' || kind === 'success') {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      state.lastTraffic = now;
      state.trafficBytes = Math.min(1e12, (Number(state.trafficBytes) || 0) + bytes);
      const evidence = kind === 'traffic'
        ? Math.max(0.25, Math.min(1, Math.log2(1 + bytes / 12_000) / 4))
        : 0.5;
      state.trafficEvidence = Math.min(
        Math.max(0, Number(this.options.maxTrafficEvidence) || 4),
        (Number(state.trafficEvidence) || 0) + evidence
      );
      // Keep real-path health independent from URL-test health. A successful
      // 204 must not clear an application connection failure, and vice versa.
      state.connectionFailureRate *= 1 - this.options.failureAlpha * 0.85;
      state.softFails = Math.max(0, (Number(state.softFails) || 0) - 1);
      if (state.lastConnectionFailure) {
        state.connectionSuccesses = Math.min(100, (Number(state.connectionSuccesses) || 0) + 1);
      }
      return;
    }

    if (kind === 'softFail') {
      // Tracker already required a streak; each emitted event is meaningful.
      state.softFails = Math.min(100, (Number(state.softFails) || 0) + 1);
      state.connectionFailureRate +=
        (1 - state.connectionFailureRate) * this.options.softFailAlpha;
      state.lastConnectionFailure = now;
      state.connectionSuccesses = 0;
    }
  }

  /**
   * Hint for managed scheduler cadence.
   * @returns {'urgent'|'normal'|'relaxed'}
   */
  scheduleHint(now = Date.now()) {
    if (this.globalOutageUntil > now) return 'urgent';
    const selected = this.selected ? this.nodes.get(this.selected) : null;
    if (selected) this._decayState(selected, now);
    if (selected) {
      if (
        selected.consecutiveFailures > 0 ||
        selected.cooldownUntil > now ||
        selected.failureRate >= 0.2 ||
        selected.connectionFailureRate >= 0.2 ||
        (Number(selected.softFails) || 0) >= 2
      ) {
        return 'urgent';
      }
      if (
        selected.samples >= 5 &&
        selected.failureRate < 0.05 &&
        selected.connectionFailureRate < 0.05 &&
        (Number(selected.softFails) || 0) === 0 &&
        selected.ewma != null
      ) {
        return 'relaxed';
      }
    }
    let scored = 0;
    let mature = 0;
    let bad = 0;
    for (const state of this.nodes.values()) {
      this._decayState(state, now);
      if (state.ewma == null) continue;
      scored++;
      if (state.samples >= 3) mature++;
      if (
        state.consecutiveFailures > 0 ||
        state.softFails >= 2 ||
        state.failureRate >= 0.25 ||
        state.connectionFailureRate >= 0.25 ||
        state.cooldownUntil > now
      ) {
        bad++;
      }
    }
    if (scored >= 3 && bad / scored >= 0.4) return 'urgent';
    if (scored >= 5 && mature >= 5 && bad === 0) return 'relaxed';
    return 'normal';
  }

  _record(measurement, now) {
    const name = measurement && typeof measurement.name === 'string' ? measurement.name : '';
    if (!name || measurement.fresh === false) return;
    const state = this._ensure(name, now);
    state.attempts = Math.min(1_000_000, (Number(state.attempts) || 0) + 1);
    state.effectiveAttempts = Math.min(
      1_000_000,
      Math.max(0, Number(state.effectiveAttempts) || 0) + 1
    );
    if (validDelay(measurement.delay)) {
      const delay = Number(measurement.delay);
      const effectiveSamples = Math.max(0, Number(state.effectiveSamples) || 0);
      if (state.delayMean === null || !Number.isFinite(state.delayMean) || effectiveSamples < 0.001) {
        state.delayMean = delay;
        state.delayM2 = 0;
        state.effectiveSamples = 1;
      } else {
        const nextSamples = effectiveSamples + 1;
        const delta = delay - state.delayMean;
        state.delayMean += delta / nextSamples;
        state.delayM2 += delta * (delay - state.delayMean);
        state.effectiveSamples = Math.min(1000, nextSamples);
      }
      if (state.ewma === null) {
        state.ewma = delay;
      } else {
        const difference = Math.abs(delay - state.ewma);
        state.jitter = state.jitter * (1 - this.options.alpha) + difference * this.options.alpha;
        state.ewma = state.ewma * (1 - this.options.alpha) + delay * this.options.alpha;
        // Peak jitter decays slowly so UI stability stays sticky after spikes.
        state.peakJitter = Math.max(state.jitter, (Number(state.peakJitter) || 0) * 0.92);
      }
      state.samples = Math.min(1000, state.samples + 1);
      state.failureRate *= 1 - this.options.failureAlpha;
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.lastSuccess = now;
      if (state.lastFailure) {
        state.successSinceFailure = Math.min(100, (Number(state.successSinceFailure) || 0) + 1);
      }
      return;
    }

    state.failureRate += (1 - state.failureRate) * this.options.failureAlpha;
    state.consecutiveFailures = Math.min(16, state.consecutiveFailures + 1);
    state.lastFailure = now;
    state.successSinceFailure = 0;
    if (state.consecutiveFailures >= 2) {
      const exponent = Math.min(8, state.consecutiveFailures - 2);
      state.cooldownUntil = now + Math.min(
        this.options.cooldownMaxMs,
        this.options.cooldownBaseMs * (2 ** exponent)
      );
    }
  }

  /**
   * Do not punish individual nodes when a previously healthy cohort fails in
   * the same fresh sweep. This usually means the local network or test target
   * is unavailable, not that every proxy failed at once.
   */
  _suppressCorrelatedFailures(measurements, now) {
    const list = Array.isArray(measurements) ? measurements : [];
    const fresh = list.filter((item) => item && item.fresh !== false);
    const failed = fresh.filter((item) => !validDelay(item.delay));
    const succeeded = fresh.length - failed.length;
    let knownHealthyFailures = 0;
    for (const item of failed) {
      const state = this.nodes.get(item.name);
      if (
        state && state.lastSuccess > 0 &&
        now - state.lastSuccess <= this.options.maxSampleAgeMs &&
        state.consecutiveFailures === 0
      ) knownHealthyFailures++;
    }
    const correlated = fresh.length >= 4 &&
      failed.length / fresh.length >= 0.75 &&
      succeeded <= 1 &&
      knownHealthyFailures >= 2;
    if (correlated) this.globalOutageUntil = now + 20_000;
    else if (succeeded >= 2) this.globalOutageUntil = 0;
    if (!correlated && this.globalOutageUntil <= now) return list;
    return list.map((item) => (
      item && item.fresh !== false && !validDelay(item.delay)
        ? { ...item, fresh: false, suppressed: 'global-outage' }
        : item
    ));
  }

  _prune(activeNames, protectedNames) {
    for (const name of this.nodes.keys()) {
      if (!activeNames.has(name)) this.nodes.delete(name);
    }
    const overflow = this.nodes.size - this.options.maxNodes;
    if (overflow <= 0) return;
    const oldest = [...this.nodes.entries()]
      .filter(([name]) => !protectedNames.has(name))
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      .slice(0, overflow);
    for (const [name] of oldest) this.nodes.delete(name);
  }

  _isUnusable(state, now, { strict = true } = {}) {
    if (!state || state.ewma === null) return true;
    if (now - state.lastSuccess > this.options.maxSampleAgeMs) return true;
    if (state.cooldownUntil > now) return true;
    if (state.consecutiveFailures > 0) return true;
    if (state.softFails >= 2) return true;
    if (strict && state.ewma >= this.acceptableDelayMs) return true;
    if (strict && this.options.excludeStabilityBad) {
      if (stabilityFromState(state, now).level === 'bad') return true;
    }
    return false;
  }

  _delayVariance(state, profile = null) {
    const samples = Math.max(0, Number(state && state.effectiveSamples) || 0);
    const measured = samples > 0.001
      ? Math.max(0, Number(state.delayM2) || 0) / samples
      : 0;
    const floor = Math.max(
      Number(this.options.varianceFloorMs) || 15,
      profile ? Math.min(60, profile.spread * 0.5) : 0
    );
    return Math.max(floor * floor, measured, (Number(state && state.jitter) || 0) ** 2);
  }

  _baseCost(state, now, profile, { strict = true } = {}) {
    if (this._isUnusable(state, now, { strict })) {
      return Infinity;
    }
    const staleMs = Math.max(0, now - state.lastSuccess - this.options.staleAfterMs);
    const ewmaWeight = Number(this.options.ewmaWeight);
    const weight = Number.isFinite(ewmaWeight) ? ewmaWeight : 0.62;
    // Keep costs in millisecond-equivalent units while centering the ranking on
    // the live cohort. This makes mode weights portable across 30ms and 600ms
    // subscriptions without changing their ordering.
    const ewmaTerm = profile.median + (state.ewma - profile.median) * weight;
    let score = ewmaTerm +
      Math.min(state.jitter, profile.spread * 4) * this.options.jitterWeight +
      state.failureRate * profile.failurePenalty +
      state.connectionFailureRate * profile.failurePenalty +
      state.consecutiveFailures * this.options.consecutiveFailurePenalty +
      (Number(state.softFails) || 0) * profile.softFailPenalty +
      staleMs / 60_000 * this.options.stalePenaltyPerMinute;

    // Soft pass: still penalize red-band latency so it loses to healthier peers.
    if (!strict && state.ewma >= this.acceptableDelayMs) {
      score += 2_000 + (state.ewma - this.acceptableDelayMs);
    }
    return score;
  }

  _selectionCost(state, now, profile, { strict = true } = {}) {
    const base = this._baseCost(state, now, profile, { strict });
    if (!Number.isFinite(base)) return base;
    const samples = Math.max(0.25, Number(state.effectiveSamples) || 0);
    const standardError = Math.sqrt(this._delayVariance(state, profile) / samples);
    const riskWeight = Math.max(0, Number(this.options.selectionRiskWeight) || 0);
    return base + Math.min(profile.spread * 3, standardError) * riskWeight;
  }

  _probePriority(state, totalAttempts, now) {
    if (!state) return Number.MAX_SAFE_INTEGER;
    if (state.cooldownUntil > now) return -Number.MAX_SAFE_INTEGER;
    this._decayState(state, now);
    const attempts = Math.max(
      0.05,
      (Number(state.effectiveAttempts) || 0) + (Number(state.trafficEvidence) || 0)
    );
    const scale = Math.max(1, Number(this.options.explorationBonusMs) || 90);
    const logTerm = Math.log(Math.max(2, totalAttempts + 2));
    const normalizedVariance = Math.min(9, this._delayVariance(state) / (scale * scale));
    const tailRatio = Math.max(0, Number(this.options.explorationTailRatio) || 0.25);
    const uncertainty = Math.min(
      scale * 4,
      scale * Math.sqrt(2 * (1 + normalizedVariance) * logTerm / attempts) +
        scale * tailRatio * logTerm / attempts
    );
    const age = now - (state.lastSuccess || state.lastSeen || 0);
    const stale = Math.min(scale, Math.max(0, age - this.options.staleAfterMs) / 60_000 * 10);
    const recovery = state.consecutiveFailures > 0 && state.cooldownUntil <= now ? scale : 0;
    const risk = state.consecutiveFailures * scale + state.failureRate * scale * 2;
    return uncertainty + stale + recovery - risk;
  }

  /** Ranking signals for bounded background probes, calculated in one pass. */
  probePriorities(names, now = Date.now()) {
    let totalAttempts = 0;
    for (const candidate of this.nodes.values()) {
      this._decayState(candidate, now);
      totalAttempts += Math.max(
        0,
        (Number(candidate.effectiveAttempts) || 0) + (Number(candidate.trafficEvidence) || 0)
      );
    }
    const priorities = new Map();
    for (const name of names || []) {
      priorities.set(name, this._probePriority(this.nodes.get(name), totalAttempts, now));
    }
    return priorities;
  }

  _select(name, now) {
    if (name !== this.selected) {
      this.selected = name;
      this.selectedAt = now;
      this.pendingSwitch = null;
    } else if (!this.selectedAt) this.selectedAt = now;
    return name;
  }

  /**
   * Healthy switches need consecutive rounds agreeing on the challenger (A2).
   * Failures still leave immediately (no confirm).
   */
  _confirmSwitch(bestName, stickName, stickFailed, advance = true) {
    if (stickFailed || !bestName || bestName === stickName) {
      this.pendingSwitch = null;
      return bestName;
    }
    if (!advance) return stickName;
    const need = Math.max(1, Math.floor(Number(this.options.switchConfirmRounds) || 2));
    if (need <= 1) {
      this.pendingSwitch = null;
      return bestName;
    }
    if (this.pendingSwitch && this.pendingSwitch.name === bestName) {
      this.pendingSwitch.count += 1;
    } else {
      this.pendingSwitch = { name: bestName, count: 1 };
    }
    if (this.pendingSwitch.count >= need) {
      this.pendingSwitch = null;
      return bestName;
    }
    return stickName;
  }

  choose({ contextKey, names, current, measurements, now = Date.now() }) {
    this._setContext(contextKey);
    const orderedNames = [];
    const activeNames = new Set();
    for (const value of names || []) {
      const name = typeof value === 'string' ? value : '';
      if (name && !activeNames.has(name)) {
        activeNames.add(name);
        orderedNames.push(name);
      }
    }
    const acceptedMeasurements = this._suppressCorrelatedFailures(measurements, now);
    const freshNames = new Set();
    for (const measurement of acceptedMeasurements) {
      if (measurement && measurement.fresh !== false && measurement.name) freshNames.add(measurement.name);
      this._record(measurement, now);
    }
    if (!orderedNames.length) return null;
    for (const state of this.nodes.values()) this._decayState(state, now);

    // Recompute red-line from live distribution so international lines are not
    // all rejected by a fixed 500ms, while still excluding clear outliers.
    this.acceptableDelayMs = computeAdaptiveAcceptableDelayMs(
      this.nodes.values(),
      this.options,
      now
    );
    const costProfile = computeCohortCostProfile(
      [...activeNames].map((name) => this.nodes.get(name)),
      this.options,
      now
    );

    const coldStart = this.selected === null;
    if (coldStart) {
      if (activeNames.has(current) && !this._isUnusable(this.nodes.get(current), now, { strict: true })) {
        this.selected = current;
        this.selectedAt = 0;
      }
    } else if (activeNames.has(current) && current !== this.selected) {
      // Clash "now" can lag on a red/failed pin after we already preferred better.
      // Do not re-stick selection to an unusable current — that restarts dwell.
      const curState = this.nodes.get(current);
      if (!this._isUnusable(curState, now, { strict: true })) {
        this.selected = current;
        this.selectedAt = now;
      }
    }
    this._prune(activeNames, new Set([current, this.selected].filter(Boolean)));

    const pickBest = (strict) => {
      let bestName = null;
      let bestScore = Infinity;
      for (const name of orderedNames) {
        const state = this.nodes.get(name);
        if (!state || state.cooldownUntil > now) continue;
        const score = this._selectionCost(state, now, costProfile, { strict });
        if (score < bestScore) {
          bestName = name;
          bestScore = score;
        }
      }
      return { bestName, bestScore };
    };

    // Prefer healthy (non-red) members. Only if none exist, fall back softly.
    let { bestName, bestScore } = pickBest(true);
    if (!bestName) ({ bestName, bestScore } = pickBest(false));
    if (!bestName) return activeNames.has(current) ? this._select(current, now) : null;
    if (!activeNames.has(current) || current === bestName) {
      this.pendingSwitch = null;
      return this._select(bestName, now);
    }

    // Evaluate stickiness against the live group "now" when it is still healthy;
    // otherwise only against our last preferred pick.
    const stickName = (!this._isUnusable(this.nodes.get(current), now, { strict: true }) && activeNames.has(current))
      ? current
      : this.selected;
    const stickState = this.nodes.get(stickName);
    const stickUnusable = this._isUnusable(stickState, now, { strict: true });
    const stickScore = this._selectionCost(stickState, now, costProfile, { strict: !stickUnusable });
    const stickFailed = stickUnusable
      || !stickState
      || stickState.consecutiveFailures > 0
      || stickState.cooldownUntil > now;
    if (stickName === bestName) {
      this.pendingSwitch = null;
      return this._select(bestName, now);
    }

    const dwellMs = stickFailed ? this.options.failedDwellMs : this.options.minDwellMs;
    if (!coldStart && this.selectedAt && now - this.selectedAt < dwellMs) {
      // Failures / red nodes leave only a short settle window, not the full dwell.
      if (!stickFailed && activeNames.has(stickName)) return this._select(stickName, now);
      if (stickFailed && now - this.selectedAt < this.options.failedDwellMs && activeNames.has(stickName)) {
        return this._select(stickName, now);
      }
    }
    const threshold = stickFailed
      ? 0
      : Math.max(
        this.options.switchThresholdMs,
        Number.isFinite(stickScore) ? stickScore * this.options.switchThresholdRatio : 0
      );
    if (!stickFailed && stickScore <= bestScore + threshold && activeNames.has(stickName)) {
      this.pendingSwitch = null;
      return this._select(stickName, now);
    }
    if (coldStart) return this._select(bestName, now);
    const confirmed = this._confirmSwitch(bestName, stickName, stickFailed, freshNames.has(bestName));
    return this._select(confirmed, now);
  }

  /**
   * Compact stability map for the UI (not raw RTT — that is the delay badge).
   *
   * Levels for display:
   * - unknown: no history
   * - probing: measured but too few samples to grade (UI should not color)
   * - good | mid | bad: confirmed stability after enough samples
   * - unavailable: failing / cooldown (explicitly not a speed grade)
   *
   * `ewma` is included so the UI can surface background Smart probes as delay
   * without requiring a manual "test" click.
   *
   * @param {string[]} names
   * @param {number} [now]
   */
  qualities(names, now = Date.now()) {
    const out = {};
    const minSamples = 5;
    for (const value of names || []) {
      const name = typeof value === 'string' ? value : '';
      if (!name) continue;
      const state = this.nodes.get(name);
      if (!state) {
        out[name] = { level: 'unknown', samples: 0, failed: false, ewma: null };
        continue;
      }
      const failed = state.consecutiveFailures > 0 || state.softFails >= 2 || state.cooldownUntil > now;
      const displayFresh = state.lastDisplayDelay > 0 &&
        now - state.lastDisplayDelay <= this.options.maxSampleAgeMs;
      const ewma = displayFresh && validDelay(state.displayDelay)
        ? Number(state.displayDelay)
        : (validDelay(state.ewma) ? Number(state.ewma) : null);
      if (failed) {
        out[name] = {
          level: 'unavailable',
          samples: state.samples,
          failed: true,
          ewma,
        };
        continue;
      }
      const effectiveSamples = Math.max(0, Number(state.effectiveSamples) || state.samples || 0);
      if (effectiveSamples < 0.5 || ewma == null) {
        out[name] = {
          level: 'unknown',
          samples: state.samples,
          failed: false,
          ewma: null,
        };
        continue;
      }
      // Honest cold-start: do not paint traffic-light grades on 1–4 lucky hits.
      if (effectiveSamples < minSamples) {
        out[name] = {
          level: 'probing',
          samples: state.samples,
          failed: false,
          ewma,
        };
        continue;
      }
      const quality = stabilityFromState(state, now);
      out[name] = {
        level: quality.level,
        samples: state.samples,
        failed: false,
        ewma,
      };
    }
    return out;
  }

  snapshot() {
    return {
      contextKey: this.contextKey,
      networkKey: this.networkKey,
      selected: this.selected,
      selectedAt: this.selectedAt,
      pendingSwitch: this.pendingSwitch ? { ...this.pendingSwitch } : null,
      identities: new Map(this.identities),
      nodes: new Map([...this.nodes.entries()].map(([name, state]) => [name, { ...state }])),
    };
  }

  /** Restore a previously snapshotted model (bounded, best-effort). */
  restore(snapshot, contextKey = null) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const key = contextKey != null ? String(contextKey) : snapshot.contextKey;
    this.clear(key || null);
    this.networkKey = snapshot.networkKey == null ? null : String(snapshot.networkKey);
    this.selected = typeof snapshot.selected === 'string' ? snapshot.selected : null;
    this.selectedAt = Number(snapshot.selectedAt) || 0;
    this.pendingSwitch = null;
    this.identities = snapshot.identities instanceof Map
      ? new Map(snapshot.identities)
      : new Map(Object.entries(snapshot.identities || {}));
    const entries = snapshot.nodes instanceof Map
      ? snapshot.nodes.entries()
      : Object.entries(snapshot.nodes || {});
    let count = 0;
    for (const [name, state] of entries) {
      if (typeof name !== 'string' || !state || typeof state !== 'object') continue;
      const attempts = Math.max(0, Math.min(
        1_000_000,
        Number(state.attempts) || Number(state.samples) || 0
      ));
      const samples = Math.max(0, Math.min(1000, Number(state.samples) || 0));
      const effectiveAttempts = state.effectiveAttempts === undefined
        ? attempts
        : Math.max(0, Math.min(1_000_000, Number(state.effectiveAttempts) || 0));
      const effectiveSamples = state.effectiveSamples === undefined
        ? samples
        : Math.max(0, Math.min(1000, Number(state.effectiveSamples) || 0));
      this.nodes.set(name, {
        identity: typeof state.identity === 'string'
          ? state.identity
          : this.identities.get(name) || name,
        attempts,
        effectiveAttempts,
        samples,
        effectiveSamples,
        ewma: validDelay(state.ewma) ? Number(state.ewma) : null,
        delayMean: validDelay(state.delayMean)
          ? Number(state.delayMean)
          : validDelay(state.ewma) ? Number(state.ewma) : null,
        delayM2: Math.max(0, Number(state.delayM2) || (
          (Number(state.jitter) || 0) ** 2 * (Number(state.samples) || 0)
        )),
        jitter: Math.max(0, Number(state.jitter) || 0),
        peakJitter: Math.max(0, Number(state.peakJitter) || 0),
        failureRate: Math.min(1, Math.max(0, Number(state.failureRate) || 0)),
        consecutiveFailures: Math.min(16, Math.max(0, Number(state.consecutiveFailures) || 0)),
        cooldownUntil: Math.max(0, Number(state.cooldownUntil) || 0),
        lastSeen: Math.max(0, Number(state.lastSeen) || 0),
        lastSuccess: Math.max(0, Number(state.lastSuccess) || 0),
        lastFailure: Math.max(0, Number(state.lastFailure) || 0),
        successSinceFailure: Math.max(0, Math.min(100, Number(state.successSinceFailure) || 0)),
        lastTraffic: Math.max(0, Number(state.lastTraffic) || 0),
        trafficBytes: Math.max(0, Number(state.trafficBytes) || 0),
        trafficEvidence: Math.max(0, Math.min(
          Number(this.options.maxTrafficEvidence) || 4,
          Number(state.trafficEvidence) || 0
        )),
        softFails: Math.max(0, Math.min(100, Number(state.softFails) || 0)),
        connectionFailureRate: Math.min(1, Math.max(0, Number(state.connectionFailureRate) || 0)),
        lastConnectionFailure: Math.max(0, Number(state.lastConnectionFailure) || 0),
        connectionSuccesses: Math.min(100, Math.max(0, Number(state.connectionSuccesses) || 0)),
        displayDelay: validDelay(state.displayDelay) ? Number(state.displayDelay) : null,
        lastDisplayDelay: Math.max(0, Number(state.lastDisplayDelay) || 0),
        lastDecay: Math.max(0, Number(state.lastDecay) || Number(state.lastSeen) || 0),
      });
      if (++count >= this.options.maxNodes) break;
    }
    return true;
  }

}

module.exports = {
  DEFAULT_OPTIONS,
  SMART_MODE_OPTIONS,
  DEFAULT_IGNORE_HOSTS,
  SmartSelectionModel,
  ConnectionFeedbackTracker,
  leafOutbound,
  hostnameFromUrl,
  stabilityFromState,
  computeAdaptiveAcceptableDelayMs,
  computeCohortCostProfile,
  normalizeSmartMode,
};
