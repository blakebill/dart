'use strict';

const {
  connectionHealthSignal,
  decayHealthSignals,
  emptyHealthSignals,
  healthSummary,
  importHealthSignals,
  observeHealthSignal,
  resetHealthSignals,
  retainHealthSignals,
} = require('./smart-health');
const {
  ROUTE_CHANGE_DEFAULTS,
  emptyRouteChangeState,
  importRouteChangeState,
  observeRouteMeasurement,
} = require('./smart-route-change');

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
  // A challenger must beat the incumbent by more than their combined
  // standard error. This is a selection guard, not an exploration bonus.
  switchConfidenceZ: 0.9,
  switchUncertaintyCapMs: 180,
  switchUncertaintySpreadCap: 3,
  sampleHalfLifeMs: 15 * 60_000,
  // UI stability maturity needs a wider evidence window than live selection.
  // Standby Smart intentionally probes each node infrequently, so reusing the
  // short selection half-life can make a large profile stay "probing" forever.
  stabilitySampleHalfLifeMs: 6 * 60 * 60_000,
  failureHalfLifeMs: 8 * 60_000,
  networkChangeRetention: 0.25,
  // Keep a few small per-network histories. The active network counts toward
  // maxNetworkContexts; inactive entries are capped separately by node count.
  maxNetworkContexts: 4,
  maxNetworkContextNodes: 256,
  networkContextMaxAgeMs: 7 * 24 * 60 * 60_000,
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
  multiSignalHealth: true,
  ...ROUTE_CHANGE_DEFAULTS,
});

const CALIBRATION_OPTION_BOUNDS = Object.freeze({
  switchThresholdMs: Object.freeze({ min: 0, max: 500 }),
  switchThresholdRatio: Object.freeze({ min: 0, max: 0.75 }),
  switchConfidenceZ: Object.freeze({ min: 0, max: 4 }),
  switchConfirmRounds: Object.freeze({ min: 1, max: 8, integer: true }),
  minDwellMs: Object.freeze({ min: 0, max: 900_000 }),
  failedDwellMs: Object.freeze({ min: 0, max: 60_000 }),
  routeChangeMinSamples: Object.freeze({ min: 4, max: 64, integer: true }),
  routeChangeThresholdMs: Object.freeze({ min: 10, max: 500 }),
  routeChangeScaleThreshold: Object.freeze({ min: 2, max: 16 }),
  routeChangeDriftMs: Object.freeze({ min: 0, max: 50 }),
  routeChangeConfirmSamples: Object.freeze({ min: 2, max: 8, integer: true }),
  routeChangeBaselineAlpha: Object.freeze({ min: 0.005, max: 0.3 }),
  routeChangeDeviationAlpha: Object.freeze({ min: 0.01, max: 0.5 }),
  routeChangeStepCapMs: Object.freeze({ min: 20, max: 1_000 }),
  routeChangeStepCapScale: Object.freeze({ min: 1, max: 12 }),
});
const CALIBRATION_OPTION_KEYS = Object.freeze(Object.keys(CALIBRATION_OPTION_BOUNDS));

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
    switchConfidenceZ: 0.84,
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
    switchConfidenceZ: 1.64,
  }),
});

function normalizeSmartMode(value) {
  return Object.prototype.hasOwnProperty.call(SMART_MODE_OPTIONS, value) ? value : 'balanced';
}

function sanitizeCalibrationOptions(patch, current = {}, { strict = true } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    if (patch == null) return {};
    if (strict) throw new TypeError('calibration patch must be an object');
    return { ...current };
  }
  const next = { ...current };
  for (const [key, rawValue] of Object.entries(patch)) {
    const bounds = CALIBRATION_OPTION_BOUNDS[key];
    if (!bounds) {
      if (strict) throw new RangeError(`unsupported calibration option: ${key}`);
      continue;
    }
    if (rawValue == null) {
      delete next[key];
      continue;
    }
    if (bounds.boolean) {
      if (typeof rawValue !== 'boolean') {
        if (strict) throw new TypeError(`${key} must be boolean`);
        continue;
      }
      next[key] = rawValue;
      continue;
    }
    const value = Number(rawValue);
    if (
      !Number.isFinite(value) ||
      value < bounds.min ||
      value > bounds.max ||
      (bounds.integer && !Number.isInteger(value))
    ) {
      if (strict) {
        throw new RangeError(
          `${key} must be ${bounds.integer ? 'an integer ' : ''}between ` +
          `${bounds.min} and ${bounds.max}`
        );
      }
      continue;
    }
    next[key] = value;
  }
  return next;
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
    if (
      state.consecutiveFailures > 0 ||
      state.healthUnavailable === true ||
      state.cooldownUntil > now
    ) continue;
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
    if (
      state.cooldownUntil > now ||
      state.consecutiveFailures > 0 ||
      state.healthUnavailable === true
    ) continue;
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
function stabilityFromState(state, now = Date.now(), evidenceSamples = null) {
  const samples = evidenceSamples == null
    ? Math.max(0, Number(state && state.effectiveSamples) || 0)
    : Math.max(0, Number(evidenceSamples) || 0);
  if (!state || samples < 0.5 || state.ewma == null) return { level: 'unknown' };

  const softFails = Math.max(0, Number(state.softFails) || 0);
  const connectionUnavailable = state.healthUnavailable === true ||
    (state.healthUnavailable === undefined && softFails >= 2);
  const failingNow = state.consecutiveFailures > 0 ||
    connectionUnavailable ||
    state.cooldownUntil > now;
  const urlFailure = Number(state.lastFailure) || 0;
  // A single UDP/first-byte miss is a scoring penalty, not a sticky hard
  // failure. Only corroborated connection unavailability enters the red hold.
  const connectionFailure = connectionUnavailable
    ? Number(state.lastConnectionFailure) || 0
    : 0;
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
  if (samples < 5) return { level: 'mid' };
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
    stabilitySamples: 0,
    primaryEwma: null,
    secondaryEwma: null,
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
    healthUnavailable: false,
    connectionFailureRate: 0,
    lastConnectionFailure: 0,
    connectionSuccesses: 0,
    dialEwma: null,
    dialSamples: 0,
    lastDialSuccess: 0,
    lastDialFailure: 0,
    healthSignals: emptyHealthSignals(),
    routeChange: emptyRouteChangeState(),
    displayDelay: null,
    lastDisplayDelay: 0,
    lastDecay: 0,
  };
}

function cloneNodeState(state) {
  const source = state && typeof state === 'object' ? state : emptyNodeState();
  return {
    ...source,
    healthSignals: importHealthSignals(source.healthSignals, source),
    routeChange: importRouteChangeState(source.routeChange),
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
    const { mode, calibrationOptions, ...customOptions } = options;
    this.customOptions = customOptions;
    this.calibrationOptions = sanitizeCalibrationOptions(calibrationOptions, {});
    this.mode = normalizeSmartMode(mode);
    this.options = {
      ...DEFAULT_OPTIONS,
      ...SMART_MODE_OPTIONS[this.mode],
      ...customOptions,
      ...this.calibrationOptions,
    };
    this._normalizeOptionBounds();
    this.contextKey = null;
    this.nodes = new Map();
    this.identities = new Map();
    this.networkContexts = new Map();
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
    this.networkContexts.clear();
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
    this.options = {
      ...DEFAULT_OPTIONS,
      ...SMART_MODE_OPTIONS[next],
      ...this.customOptions,
      ...this.calibrationOptions,
    };
    this._normalizeOptionBounds();
    this._trimNetworkContexts();
    this.pendingSwitch = null;
    return true;
  }

  /**
   * Stable anchor for calibration/shadow comparison. This deliberately omits
   * the runtime calibration overlay so callers never calibrate an already
   * calibrated value.
   */
  getUncalibratedOptions() {
    return {
      ...DEFAULT_OPTIONS,
      ...SMART_MODE_OPTIONS[this.mode],
      ...this.customOptions,
    };
  }

  baseOptions() {
    return this.getUncalibratedOptions();
  }

  /**
   * Apply bounded runtime posture calibration without clearing observations.
   * Unknown or out-of-range fields are rejected atomically.
   */
  setCalibrationOptions(patch) {
    const next = sanitizeCalibrationOptions(patch, this.calibrationOptions);
    const changed = CALIBRATION_OPTION_KEYS.some(
      (key) => next[key] !== this.calibrationOptions[key]
    );
    if (!changed) return false;
    this.calibrationOptions = next;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...SMART_MODE_OPTIONS[this.mode],
      ...this.customOptions,
      ...this.calibrationOptions,
    };
    this._normalizeOptionBounds();
    this._trimNetworkContexts();
    // A half-completed confirmation belongs to the previous posture.
    this.pendingSwitch = null;
    return true;
  }

  _normalizeOptionBounds() {
    this.options.maxNodes = Math.max(
      1,
      Math.floor(Number(this.options.maxNodes) || DEFAULT_OPTIONS.maxNodes)
    );
    this.options.maxNetworkContexts = Math.max(
      1,
      Math.floor(
        Number(this.options.maxNetworkContexts) || DEFAULT_OPTIONS.maxNetworkContexts
      )
    );
    this.options.maxNetworkContextNodes = Math.max(
      1,
      Math.min(
        this.options.maxNodes,
        Math.floor(
          Number(this.options.maxNetworkContextNodes) ||
            DEFAULT_OPTIONS.maxNetworkContextNodes
        )
      )
    );
  }

  _networkHistoryLimit() {
    return Math.max(0, this.options.maxNetworkContexts - 1);
  }

  _trimNetworkContexts() {
    const limit = this._networkHistoryLimit();
    while (this.networkContexts.size > limit) {
      this.networkContexts.delete(this.networkContexts.keys().next().value);
    }
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
    const stabilitySampleHalfLife = Math.max(
      60_000,
      Number(this.options.stabilitySampleHalfLifeMs) || 21_600_000
    );
    const failureHalfLife = Math.max(60_000, Number(this.options.failureHalfLifeMs) || 480_000);
    const sampleFactor = 2 ** (-elapsed / sampleHalfLife);
    const stabilitySampleFactor = 2 ** (-elapsed / stabilitySampleHalfLife);
    const failureFactor = 2 ** (-elapsed / failureHalfLife);
    state.effectiveAttempts *= sampleFactor;
    state.effectiveSamples *= sampleFactor;
    state.stabilitySamples = Math.max(0, Number(state.stabilitySamples) || 0) * stabilitySampleFactor;
    state.delayM2 *= sampleFactor;
    state.trafficEvidence *= sampleFactor;
    state.failureRate *= failureFactor;
    if (!state.healthSignals) {
      state.healthSignals = importHealthSignals(null, state);
    }
    decayHealthSignals(state.healthSignals, failureFactor);
    this._syncConnectionHealth(state);
  }

  _connectionHealth(state) {
    if (!state) {
      return {
        failureRate: 0,
        softFails: 0,
        lastFailure: 0,
        lastSuccess: 0,
        successes: 0,
        samples: 0,
      };
    }
    if (!state.healthSignals) {
      state.healthSignals = importHealthSignals(null, state);
    }
    return healthSummary(state.healthSignals);
  }

  _syncConnectionHealth(state) {
    const summary = this._connectionHealth(state);
    state.connectionFailureRate = summary.failureRate;
    state.softFails = summary.softFails;
    state.healthUnavailable = summary.unavailable;
    state.lastConnectionFailure = summary.lastFailure;
    state.connectionSuccesses = Math.min(100, summary.successes);
    return summary;
  }

  _captureNetworkContext(now) {
    const limit = this.options.maxNetworkContextNodes;
    const entries = [...this.nodes.entries()]
      .sort((a, b) => {
        if (a[0] === this.selected) return -1;
        if (b[0] === this.selected) return 1;
        return (Number(b[1].lastSeen) || 0) - (Number(a[1].lastSeen) || 0);
      })
      .slice(0, limit)
      .map(([name, state]) => [name, cloneNodeState(state)]);
    return {
      savedAt: Math.max(0, Number(now) || 0),
      selected: typeof this.selected === 'string' ? this.selected : null,
      nodes: new Map(entries),
    };
  }

  _saveNetworkContext(networkKey, now) {
    if (networkKey == null || this._networkHistoryLimit() <= 0) return;
    const key = String(networkKey);
    this.networkContexts.delete(key);
    this.networkContexts.set(key, this._captureNetworkContext(now));
    this._trimNetworkContexts();
  }

  _networkContextExpired(entry, now) {
    const savedAt = Math.max(0, Number(entry && entry.savedAt) || 0);
    const maxAge = Math.max(
      60_000,
      Number(this.options.networkContextMaxAgeMs) ||
        DEFAULT_OPTIONS.networkContextMaxAgeMs
    );
    return savedAt > 0 && now >= savedAt && now - savedAt > maxAge;
  }

  _restoreNetworkContext(networkKey, now) {
    if (networkKey == null) return false;
    const key = String(networkKey);
    const entry = this.networkContexts.get(key);
    if (!entry) return false;
    this.networkContexts.delete(key);
    if (this._networkContextExpired(entry, now)) return false;

    const stored = entry.nodes instanceof Map ? entry.nodes : new Map();
    const byIdentity = new Map();
    for (const [name, state] of stored) {
      if (!state || typeof state !== 'object') continue;
      const identity = state.identity || name;
      if (!byIdentity.has(identity)) byIdentity.set(identity, state);
    }
    const restored = new Map();
    let restoredSelected = null;
    const selectedState = entry.selected ? stored.get(entry.selected) : null;
    const selectedIdentity = selectedState
      ? (selectedState.identity || entry.selected)
      : null;

    if (this.identities.size) {
      for (const [name, identity] of this.identities) {
        const direct = stored.get(name);
        const state = direct && (!direct.identity || direct.identity === identity)
          ? direct
          : byIdentity.get(identity);
        if (!state) continue;
        const clone = { ...cloneNodeState(state), identity };
        this._decayState(clone, now);
        restored.set(name, clone);
        if (selectedIdentity && identity === selectedIdentity) restoredSelected = name;
        if (restored.size >= this.options.maxNodes) break;
      }
    } else {
      for (const [name, state] of stored) {
        if (typeof name !== 'string' || !state || typeof state !== 'object') continue;
        const clone = cloneNodeState(state);
        this._decayState(clone, now);
        restored.set(name, clone);
        if (name === entry.selected) restoredSelected = name;
        if (restored.size >= this.options.maxNodes) break;
      }
    }

    this.nodes = restored;
    this.selected = restoredSelected;
    this.selectedAt = 0;
    this.pendingSwitch = null;
    this.globalOutageUntil = 0;
    this.acceptableDelayMs =
      Number(this.options.maxAcceptableDelayMs) || DEFAULT_OPTIONS.maxAcceptableDelayMs;
    return true;
  }

  _retainWeakNetworkPrior(now) {
    // Keep a weak prior for a network not seen before, but make every node
    // uncertain again. A known network restores its own decayed history above.
    const retention = Math.max(
      0,
      Math.min(1, Number(this.options.networkChangeRetention) || 0.25)
    );
    for (const state of this.nodes.values()) {
      this._decayState(state, now);
      state.effectiveAttempts *= retention;
      state.effectiveSamples *= retention;
      state.stabilitySamples *= retention;
      state.delayM2 *= retention;
      state.trafficEvidence *= retention;
      state.failureRate *= retention;
      if (!state.healthSignals) {
        state.healthSignals = importHealthSignals(null, state);
      }
      retainHealthSignals(state.healthSignals, retention);
      this._syncConnectionHealth(state);
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.lastDecay = now;
    }
  }

  setNetworkKey(networkKey, now = Date.now()) {
    const next = networkKey == null ? null : String(networkKey);
    if (this.networkKey === next) return false;
    const previous = this.networkKey;
    const first = previous == null;
    if (!first) this._saveNetworkContext(previous, now);
    this.networkKey = next;
    if (this._restoreNetworkContext(next, now)) return true;
    if (first) return true;
    this._retainWeakNetworkPrior(now);
    this.selectedAt = 0;
    this.pendingSwitch = null;
    this.globalOutageUntil = 0;
    this.acceptableDelayMs = Number(this.options.maxAcceptableDelayMs) || DEFAULT_OPTIONS.maxAcceptableDelayMs;
    return true;
  }

  peek(name) {
    const state = this.nodes.get(name);
    return state ? cloneNodeState(state) : null;
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

  isConnectionUnavailable(name, now = Date.now()) {
    if (typeof name !== 'string' || !name) return false;
    const state = this.nodes.get(name);
    if (!state) return false;
    this._decayState(state, now);
    return this._syncConnectionHealth(state).unavailable === true;
  }

  /**
   * Real-path feedback from Clash /connections diffs (not URL delay).
   * @param {{
   *   name: string,
   *   kind: 'traffic'|'success'|'softFail'|'dialSuccess'|'dialFailure',
   *   bytes?: number,
   *   durationMs?: number,
   *   signal?: 'tcp'|'udp'|'handshake'|'firstByte'|'first-byte',
   *   phase?: 'tcp'|'udp'|'handshake'|'firstByte'|'first-byte',
   *   network?: 'tcp'|'udp'
   * }} event
   */
  observeConnection(event, now = Date.now()) {
    const name = event && typeof event.name === 'string' ? event.name : '';
    if (!name) return;
    const kind = event && event.kind;
    const state = this._ensure(name, now);
    const signalName = connectionHealthSignal(
      event,
      this.options.multiSignalHealth !== false
    );
    if (!state.healthSignals) {
      state.healthSignals = importHealthSignals(null, state);
    }

    if (kind === 'traffic' || kind === 'success' || kind === 'dialSuccess') {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      if (kind === 'dialSuccess' && signalName === 'tcp') {
        // Legacy aggregate retained for diagnostics/snapshot compatibility.
        // Selection never scores this field; per-phase timing stays in
        // healthSignals[*].durationEwma and is not mixed across stages.
        state.lastDialSuccess = now;
        if (validDelay(event.durationMs)) {
          const duration = Number(event.durationMs);
          state.dialEwma = validDelay(state.dialEwma)
            ? state.dialEwma * (1 - this.options.alpha) + duration * this.options.alpha
            : duration;
          state.dialSamples = Math.min(1000, (Number(state.dialSamples) || 0) + 1);
        }
      }
      // Detailed kernels can publish TCP, handshake, and first-byte success for
      // one connection. Only actual payload/first-byte completion is traffic
      // evidence; transport-stage successes still update their own health EWMA.
      const isTrafficEvidence =
        kind === 'traffic' ||
        kind === 'success' ||
        (kind === 'dialSuccess' && signalName === 'firstByte');
      if (isTrafficEvidence) {
        state.lastTraffic = now;
        state.trafficBytes = Math.min(1e12, (Number(state.trafficBytes) || 0) + bytes);
        const evidence = kind === 'traffic'
          ? Math.max(0.25, Math.min(1, Math.log2(1 + bytes / 12_000) / 4))
          : 0.5;
        state.trafficEvidence = Math.min(
          Math.max(0, Number(this.options.maxTrafficEvidence) || 4),
          (Number(state.trafficEvidence) || 0) + evidence
        );
      }
      observeHealthSignal(state.healthSignals, signalName, event, this.options, now);
      this._syncConnectionHealth(state);
      return;
    }

    if (kind === 'dialFailure') {
      // TCP/handshake are hard path failures. UDP and first-byte remain
      // protocol/target-specific evidence until repeated or corroborated.
      observeHealthSignal(state.healthSignals, signalName, event, this.options, now);
      if (signalName === 'tcp') state.lastDialFailure = now;
      this._syncConnectionHealth(state);
      return;
    }

    if (kind === 'softFail') {
      // Tracker already required a streak; each emitted event is meaningful.
      observeHealthSignal(state.healthSignals, signalName, event, this.options, now);
      this._syncConnectionHealth(state);
    }
  }

  _resetNodeRouteStats(state, measurement, now) {
    state.effectiveAttempts = 0;
    state.samples = 0;
    state.effectiveSamples = 0;
    state.stabilitySamples = 0;
    state.primaryEwma = null;
    state.secondaryEwma = null;
    state.ewma = null;
    state.delayMean = null;
    state.delayM2 = 0;
    state.jitter = 0;
    state.peakJitter = 0;
    state.failureRate = 0;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.lastSuccess = 0;
    state.lastFailure = 0;
    state.successSinceFailure = 0;
    state.lastTraffic = 0;
    state.trafficEvidence = 0;
    state.dialEwma = null;
    state.dialSamples = 0;
    state.lastDialSuccess = 0;
    state.lastDialFailure = 0;
    state.displayDelay = validDelay(measurement && measurement.primaryDelay)
      ? Number(measurement.primaryDelay)
      : null;
    state.lastDisplayDelay = state.displayDelay == null ? 0 : now;
    if (!state.healthSignals) state.healthSignals = emptyHealthSignals();
    resetHealthSignals(state.healthSignals);
    this._syncConnectionHealth(state);
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
        selected.healthUnavailable === true
      ) {
        return 'urgent';
      }
      if (
        selected.effectiveSamples >= 4.5 &&
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
      if (state.effectiveSamples >= 2.5) mature++;
      if (
        state.consecutiveFailures > 0 ||
        state.healthUnavailable === true ||
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
    if (!state.routeChange) state.routeChange = emptyRouteChangeState();
    const routeChange = observeRouteMeasurement(
      state.routeChange,
      measurement,
      this.options,
      now
    );
    if (routeChange.changed) this._resetNodeRouteStats(state, measurement, now);
    state.attempts = Math.min(1_000_000, (Number(state.attempts) || 0) + 1);
    state.effectiveAttempts = Math.min(
      1_000_000,
      Math.max(0, Number(state.effectiveAttempts) || 0) + 1
    );
    let recordedDelay = measurement.delay;
    const hasComponents = Object.prototype.hasOwnProperty.call(measurement, 'primaryDelay') ||
      Object.prototype.hasOwnProperty.call(measurement, 'secondaryDelay');
    if (hasComponents) {
      const updateSignal = (key, value, fresh) => {
        if (!validDelay(value)) return;
        if (routeChange.changed && fresh !== true) return;
        const delay = Number(value);
        if (state[key] == null || !Number.isFinite(state[key])) state[key] = delay;
        else if (fresh) state[key] = state[key] * (1 - this.options.alpha) + delay * this.options.alpha;
      };
      updateSignal('primaryEwma', measurement.primaryDelay, measurement.primaryFresh === true);
      updateSignal('secondaryEwma', measurement.secondaryDelay, measurement.secondaryFresh === true);
      const primary = validDelay(state.primaryEwma) ? state.primaryEwma : null;
      const secondary = validDelay(state.secondaryEwma) ? state.secondaryEwma : null;
      const requestedPrimaryWeight = Number(measurement.primaryWeight);
      const requestedSecondaryWeight = Number(measurement.secondaryWeight);
      let primaryWeight = Number.isFinite(requestedPrimaryWeight) && requestedPrimaryWeight >= 0
        ? requestedPrimaryWeight
        : 0.55;
      let secondaryWeight = Number.isFinite(requestedSecondaryWeight) && requestedSecondaryWeight >= 0
        ? requestedSecondaryWeight
        : 0.45;
      const totalWeight = primaryWeight + secondaryWeight;
      if (totalWeight <= 0) {
        primaryWeight = 0.55;
        secondaryWeight = 0.45;
      } else {
        primaryWeight /= totalWeight;
        secondaryWeight /= totalWeight;
      }
      recordedDelay = primary != null && secondary != null
        ? primary * primaryWeight + secondary * secondaryWeight
        : (primary != null ? primary : secondary);
    }
    if (validDelay(recordedDelay)) {
      const delay = Number(recordedDelay);
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
      state.stabilitySamples = Math.min(
        1000,
        Math.max(0, Number(state.stabilitySamples) || 0) + 1
      );
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
    if (
      state.healthUnavailable === true ||
      (state.healthUnavailable === undefined && state.softFails >= 2)
    ) return true;
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

  _switchUncertaintyMargin(challenger, incumbent, profile) {
    if (!challenger || !incumbent) return 0;
    const confidence = Math.max(0, Number(this.options.switchConfidenceZ) || 0);
    if (!confidence) return 0;
    const standardError = (state) => {
      const samples = Math.max(0.25, Number(state.effectiveSamples) || 0);
      // Cohort spread calibrates absolute costs, but does not prove that an
      // individual node is noisy. Keep this gate tied to node evidence.
      return Math.sqrt(this._delayVariance(state) / samples);
    };
    const challengerError = standardError(challenger);
    const incumbentError = standardError(incumbent);
    const combined = confidence * Math.hypot(challengerError, incumbentError);
    const configuredAbsoluteCap = Number(this.options.switchUncertaintyCapMs);
    const configuredSpreadCap = Number(this.options.switchUncertaintySpreadCap);
    const absoluteCap = Math.max(0, Number.isFinite(configuredAbsoluteCap)
      ? configuredAbsoluteCap
      : DEFAULT_OPTIONS.switchUncertaintyCapMs);
    const spreadCap = Math.max(0, Number.isFinite(configuredSpreadCap)
      ? configuredSpreadCap
      : DEFAULT_OPTIONS.switchUncertaintySpreadCap);
    return Math.min(absoluteCap, profile.spread * spreadCap, combined);
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

    // The model's confirmed pick is authoritative. A kernel Smart group may
    // temporarily expose a different `now` while failing over a single dial;
    // treating that as a user choice lets the kernel and GUI continually
    // re-select each other. Explicit user overrides travel through the managed
    // pin path instead.
    const stickName = activeNames.has(this.selected) ? this.selected : current;
    const stickState = this.nodes.get(stickName);
    const stickHealth = this._connectionHealth(stickState);
    const stickUnusable = this._isUnusable(stickState, now, { strict: true });
    const stickScore = this._selectionCost(stickState, now, costProfile, { strict: !stickUnusable });
    const stickFailed = stickUnusable
      || !stickState
      || stickState.consecutiveFailures > 0
      || stickState.cooldownUntil > now;
    const explicitDialFailure = !!(
      stickState &&
      (
        stickState.healthUnavailable === true ||
        (stickState.healthUnavailable === undefined && stickState.softFails >= 2)
      ) &&
      stickHealth.lastFailure > stickHealth.lastSuccess
    );
    if (stickName === bestName) {
      this.pendingSwitch = null;
      return this._select(bestName, now);
    }

    const dwellMs = stickFailed
      ? (explicitDialFailure ? 0 : this.options.failedDwellMs)
      : this.options.minDwellMs;
    if (!coldStart && this.selectedAt && now - this.selectedAt < dwellMs) {
      // Failures / red nodes leave only a short settle window, not the full dwell.
      if (!stickFailed && activeNames.has(stickName)) return this._select(stickName, now);
      if (stickFailed && now - this.selectedAt < dwellMs && activeNames.has(stickName)) {
        return this._select(stickName, now);
      }
    }
    const threshold = stickFailed
      ? 0
      : Math.max(
        this.options.switchThresholdMs,
        Number.isFinite(stickScore) ? stickScore * this.options.switchThresholdRatio : 0
      ) + this._switchUncertaintyMargin(
        this.nodes.get(bestName),
        stickState,
        costProfile
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
    // Stability evidence decays on a wider window than selection evidence.
    // This lets standby Smart mature large profiles without making old RTT
    // samples influential in live routing decisions.
    const minSamples = 4.5;
    for (const value of names || []) {
      const name = typeof value === 'string' ? value : '';
      if (!name) continue;
      const state = this.nodes.get(name);
      if (!state) {
        out[name] = {
          level: 'unknown',
          samples: 0,
          effectiveSamples: 0,
          failed: false,
          ewma: null,
        };
        continue;
      }
      const failed = state.consecutiveFailures > 0 ||
        state.healthUnavailable === true ||
        (state.healthUnavailable === undefined && state.softFails >= 2) ||
        state.cooldownUntil > now;
      const displayFresh = state.lastDisplayDelay > 0 &&
        now - state.lastDisplayDelay <= this.options.maxSampleAgeMs;
      const ewma = displayFresh && validDelay(state.displayDelay)
        ? Number(state.displayDelay)
        : (validDelay(state.ewma) ? Number(state.ewma) : null);
      const effectiveSamples = Math.max(0, Number(state.effectiveSamples) || 0);
      const stabilitySamples = state.stabilitySamples === undefined
        ? effectiveSamples
        : Math.max(0, Number(state.stabilitySamples) || 0);
      if (failed) {
        out[name] = {
          level: 'unavailable',
          samples: Math.round(effectiveSamples * 10) / 10,
          effectiveSamples,
          failed: true,
          ewma,
        };
        continue;
      }
      if (stabilitySamples < 0.5 || ewma == null) {
        out[name] = {
          level: 'unknown',
          samples: Math.round(effectiveSamples * 10) / 10,
          effectiveSamples,
          failed: false,
          ewma: null,
        };
        continue;
      }
      // Honest cold-start: do not paint traffic-light grades on 1–4 lucky hits.
      if (stabilitySamples < minSamples) {
        out[name] = {
          level: 'probing',
          samples: Math.round(effectiveSamples * 10) / 10,
          effectiveSamples,
          failed: false,
          ewma,
        };
        continue;
      }
      const quality = stabilityFromState(state, now, stabilitySamples);
      out[name] = {
        level: quality.level,
        samples: Math.round(effectiveSamples * 10) / 10,
        effectiveSamples,
        failed: false,
        ewma,
      };
    }
    return out;
  }

  _importNodeMap(source, limit) {
    const entries = source instanceof Map
      ? source.entries()
      : Object.entries(source || {});
    const imported = new Map();
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
      const stabilitySamples = state.stabilitySamples === undefined
        ? samples
        : Math.max(0, Math.min(1000, Number(state.stabilitySamples) || 0));
      const healthSignals = importHealthSignals(state.healthSignals, state);
      const importedHealth = healthSummary(healthSignals);
      imported.set(name, {
        identity: typeof state.identity === 'string'
          ? state.identity
          : this.identities.get(name) || name,
        attempts,
        effectiveAttempts,
        samples,
        effectiveSamples,
        stabilitySamples,
        primaryEwma: validDelay(state.primaryEwma) ? Number(state.primaryEwma) : null,
        secondaryEwma: validDelay(state.secondaryEwma) ? Number(state.secondaryEwma) : null,
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
        softFails: importedHealth.softFails,
        healthUnavailable: importedHealth.unavailable,
        connectionFailureRate: importedHealth.failureRate,
        lastConnectionFailure: importedHealth.lastFailure,
        connectionSuccesses: Math.min(100, importedHealth.successes),
        dialEwma: validDelay(state.dialEwma) ? Number(state.dialEwma) : null,
        dialSamples: Math.min(1000, Math.max(0, Number(state.dialSamples) || 0)),
        lastDialSuccess: Math.max(0, Number(state.lastDialSuccess) || 0),
        lastDialFailure: Math.max(0, Number(state.lastDialFailure) || 0),
        healthSignals,
        routeChange: importRouteChangeState(state.routeChange),
        displayDelay: validDelay(state.displayDelay) ? Number(state.displayDelay) : null,
        lastDisplayDelay: Math.max(0, Number(state.lastDisplayDelay) || 0),
        lastDecay: Math.max(0, Number(state.lastDecay) || Number(state.lastSeen) || 0),
      });
      if (imported.size >= limit) break;
    }
    return imported;
  }

  snapshot() {
    return {
      contextKey: this.contextKey,
      networkKey: this.networkKey,
      selected: this.selected,
      selectedAt: this.selectedAt,
      pendingSwitch: this.pendingSwitch ? { ...this.pendingSwitch } : null,
      calibrationOptions: { ...this.calibrationOptions },
      identities: new Map(this.identities),
      nodes: new Map(
        [...this.nodes.entries()].map(([name, state]) => [name, cloneNodeState(state)])
      ),
      networkContexts: new Map([...this.networkContexts.entries()].map(([key, entry]) => [
        key,
        {
          savedAt: entry.savedAt,
          selected: entry.selected,
          nodes: new Map(
            [...entry.nodes.entries()].map(([name, state]) => [
              name,
              cloneNodeState(state),
            ])
          ),
        },
      ])),
    };
  }

  /** Restore a previously snapshotted model (bounded, best-effort). */
  restore(snapshot, contextKey = null) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(snapshot, 'calibrationOptions')) {
      this.calibrationOptions = sanitizeCalibrationOptions(
        snapshot.calibrationOptions,
        {},
        { strict: false }
      );
      this.options = {
        ...DEFAULT_OPTIONS,
        ...SMART_MODE_OPTIONS[this.mode],
        ...this.customOptions,
        ...this.calibrationOptions,
      };
      this._normalizeOptionBounds();
    }
    const key = contextKey != null ? String(contextKey) : snapshot.contextKey;
    this.clear(key || null);
    this.networkKey = snapshot.networkKey == null ? null : String(snapshot.networkKey);
    this.selected = typeof snapshot.selected === 'string' ? snapshot.selected : null;
    this.selectedAt = Number(snapshot.selectedAt) || 0;
    this.pendingSwitch = null;
    this.identities = snapshot.identities instanceof Map
      ? new Map(snapshot.identities)
      : new Map(Object.entries(snapshot.identities || {}));
    this.nodes = this._importNodeMap(snapshot.nodes, this.options.maxNodes);

    const contextEntries = snapshot.networkContexts instanceof Map
      ? snapshot.networkContexts.entries()
      : Object.entries(snapshot.networkContexts || {});
    for (const [networkKey, entry] of contextEntries) {
      if (
        typeof networkKey !== 'string' ||
        !entry ||
        typeof entry !== 'object' ||
        networkKey === this.networkKey
      ) continue;
      this.networkContexts.set(networkKey, {
        savedAt: Math.max(0, Number(entry.savedAt) || 0),
        selected: typeof entry.selected === 'string' ? entry.selected : null,
        nodes: this._importNodeMap(
          entry.nodes,
          this.options.maxNetworkContextNodes
        ),
      });
      this._trimNetworkContexts();
    }
    return true;
  }

}

module.exports = {
  DEFAULT_OPTIONS,
  SMART_MODE_OPTIONS,
  CALIBRATION_OPTION_BOUNDS,
  CALIBRATION_OPTION_KEYS,
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
