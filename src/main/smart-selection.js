'use strict';

const DEFAULT_OPTIONS = Object.freeze({
  alpha: 0.3,
  failureAlpha: 0.25,
  jitterWeight: 0.5,
  failurePenalty: 600,
  consecutiveFailurePenalty: 180,
  uncertaintyPenalty: 30,
  switchThresholdMs: 20,
  switchThresholdRatio: 0.08,
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
});

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
    if (!validDelay(state.ewma)) continue;
    delays.push(Number(state.ewma));
  }
  if (delays.length < need) return fallback;
  delays.sort((a, b) => a - b);
  const p75 = delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.75))];
  const adapted = Math.round(p75 * 1.5);
  return Math.min(capMs, Math.max(minMs, adapted));
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

  const failingNow = state.consecutiveFailures > 0 || state.cooldownUntil > now;
  const lastFailure = Number(state.lastFailure) || 0;
  const sinceFailure = lastFailure ? now - lastFailure : Infinity;
  const successSinceFailure = Math.max(0, Number(state.successSinceFailure) || 0);
  const recentlyFailed = lastFailure > 0 && sinceFailure < STABILITY_FAIL_HOLD_MS;

  if (failingNow) return { level: 'bad' };

  // After any failure, stay red until enough clean successes accumulate,
  // then mid, then (only after the hold window + more successes) green.
  if (recentlyFailed) {
    if (successSinceFailure < STABILITY_RECOVER_MID_SUCCESSES) return { level: 'bad' };
    if (successSinceFailure < STABILITY_RECOVER_SUCCESSES) return { level: 'mid' };
    // Even with enough successes, keep mid while still inside the hold window
    // unless the failure rate has clearly cooled down.
    if (state.failureRate >= 0.08) return { level: 'mid' };
  }

  if (state.failureRate >= 0.28) return { level: 'bad' };
  if (state.failureRate >= 0.12) return { level: 'mid' };

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

/** @deprecated use stabilityFromState; kept for tests that imported the old name */
function qualityFromScore(_score, ewma, failed, state = null, now = Date.now()) {
  if (state) return stabilityFromState(state, now);
  if (failed) return { level: 'bad' };
  if (!Number.isFinite(ewma)) return { level: 'unknown' };
  return stabilityFromState({
    samples: 5,
    ewma,
    jitter: 0,
    peakJitter: 0,
    failureRate: 0,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    lastFailure: 0,
    successSinceFailure: 99,
  }, now);
}

class SmartSelectionModel {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.options.maxNodes = Math.max(1, Math.floor(Number(this.options.maxNodes) || DEFAULT_OPTIONS.maxNodes));
    this.contextKey = null;
    this.nodes = new Map();
    this.selected = null;
    this.selectedAt = 0;
    this.networkKey = null;
  }

  clear(contextKey = null) {
    this.contextKey = contextKey;
    this.nodes.clear();
    this.selected = null;
    this.selectedAt = 0;
  }

  _setContext(contextKey) {
    const next = String(contextKey || 'default');
    if (next !== this.contextKey) this.clear(next);
  }

  setNetworkKey(networkKey) {
    const next = networkKey == null ? null : String(networkKey);
    if (this.networkKey === next) return false;
    this.networkKey = next;
    // Interface change invalidates RTT history more than a profile switch does:
    // keep the context key but drop samples so we re-learn on the new path.
    this.nodes.clear();
    this.selected = null;
    this.selectedAt = 0;
    return true;
  }

  peek(name) {
    const state = this.nodes.get(name);
    return state ? { ...state } : null;
  }

  observe(measurement, now = Date.now()) {
    this._record(measurement, now);
  }

  _record(measurement, now) {
    const name = measurement && typeof measurement.name === 'string' ? measurement.name : '';
    if (!name) return;
    let state = this.nodes.get(name);
    if (!state) {
      state = {
        samples: 0,
        ewma: null,
        jitter: 0,
        peakJitter: 0,
        failureRate: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastSeen: 0,
        lastSuccess: 0,
        lastFailure: 0,
        successSinceFailure: 0,
      };
      this.nodes.set(name, state);
    }
    state.lastSeen = now;
    if (validDelay(measurement.delay)) {
      const delay = Number(measurement.delay);
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
    if (strict && state.ewma >= this.options.maxAcceptableDelayMs) return true;
    if (strict && this.options.excludeStabilityBad) {
      if (stabilityFromState(state, now).level === 'bad') return true;
    }
    return false;
  }

  _score(state, now, { strict = true } = {}) {
    if (this._isUnusable(state, now, { strict })) {
      return Infinity;
    }
    const staleMs = Math.max(0, now - state.lastSuccess - this.options.staleAfterMs);
    let score = state.ewma +
      state.jitter * this.options.jitterWeight +
      state.failureRate * this.options.failurePenalty +
      state.consecutiveFailures * this.options.consecutiveFailurePenalty +
      this.options.uncertaintyPenalty / Math.sqrt(Math.max(1, state.samples)) +
      staleMs / 60_000 * this.options.stalePenaltyPerMinute;
    // Soft pass: still penalize red-band latency so it loses to healthier peers.
    if (!strict && state.ewma >= this.options.maxAcceptableDelayMs) {
      score += 2_000 + (state.ewma - this.options.maxAcceptableDelayMs);
    }
    return score;
  }

  _select(name, now) {
    if (name !== this.selected) {
      this.selected = name;
      this.selectedAt = now;
    } else if (!this.selectedAt) this.selectedAt = now;
    return name;
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
    for (const measurement of measurements || []) this._record(measurement, now);
    if (!orderedNames.length) return null;

    // Recompute red-line from live distribution so international lines are not
    // all rejected by a fixed 500ms, while still excluding clear outliers.
    this.options.maxAcceptableDelayMs = computeAdaptiveAcceptableDelayMs(
      this.nodes.values(),
      this.options,
      now
    );

    if (this.selected === null) {
      if (activeNames.has(current) && !this._isUnusable(this.nodes.get(current), now, { strict: true })) {
        this._select(current, now);
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
        const score = this._score(state, now, { strict });
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
    if (!activeNames.has(current) || current === bestName) return this._select(bestName, now);

    // Evaluate stickiness against the live group "now" when it is still healthy;
    // otherwise only against our last preferred pick.
    const stickName = (!this._isUnusable(this.nodes.get(current), now, { strict: true }) && activeNames.has(current))
      ? current
      : this.selected;
    const stickState = this.nodes.get(stickName);
    const stickUnusable = this._isUnusable(stickState, now, { strict: true });
    const stickScore = this._score(stickState, now, { strict: !stickUnusable });
    const stickFailed = stickUnusable
      || !stickState
      || stickState.consecutiveFailures > 0
      || stickState.cooldownUntil > now;
    if (stickName === bestName) return this._select(bestName, now);

    const dwellMs = stickFailed ? this.options.failedDwellMs : this.options.minDwellMs;
    if (this.selectedAt && now - this.selectedAt < dwellMs) {
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
      return this._select(stickName, now);
    }
    return this._select(bestName, now);
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
      const failed = state.consecutiveFailures > 0 || state.cooldownUntil > now;
      const ewma = validDelay(state.ewma) ? Number(state.ewma) : null;
      if (failed) {
        out[name] = {
          level: 'unavailable',
          samples: state.samples,
          failed: true,
          ewma,
        };
        continue;
      }
      if (state.samples < 1 || ewma == null) {
        out[name] = { level: 'unknown', samples: state.samples, failed: false, ewma: null };
        continue;
      }
      // Honest cold-start: do not paint traffic-light grades on 1–4 lucky hits.
      if (state.samples < minSamples) {
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
    const entries = snapshot.nodes instanceof Map
      ? snapshot.nodes.entries()
      : Object.entries(snapshot.nodes || {});
    let count = 0;
    for (const [name, state] of entries) {
      if (typeof name !== 'string' || !state || typeof state !== 'object') continue;
      this.nodes.set(name, {
        samples: Math.max(0, Math.min(1000, Number(state.samples) || 0)),
        ewma: validDelay(state.ewma) ? Number(state.ewma) : null,
        jitter: Math.max(0, Number(state.jitter) || 0),
        peakJitter: Math.max(0, Number(state.peakJitter) || 0),
        failureRate: Math.min(1, Math.max(0, Number(state.failureRate) || 0)),
        consecutiveFailures: Math.min(16, Math.max(0, Number(state.consecutiveFailures) || 0)),
        cooldownUntil: Math.max(0, Number(state.cooldownUntil) || 0),
        lastSeen: Math.max(0, Number(state.lastSeen) || 0),
        lastSuccess: Math.max(0, Number(state.lastSuccess) || 0),
        lastFailure: Math.max(0, Number(state.lastFailure) || 0),
        successSinceFailure: Math.max(0, Math.min(100, Number(state.successSinceFailure) || 0)),
      });
      if (++count >= this.options.maxNodes) break;
    }
    return true;
  }

  /** JSON-safe export for persistence. */
  exportState() {
    const nodes = {};
    for (const [name, state] of this.nodes.entries()) {
      nodes[name] = { ...state };
    }
    return {
      contextKey: this.contextKey,
      networkKey: this.networkKey,
      selected: this.selected,
      selectedAt: this.selectedAt,
      nodes,
    };
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  SmartSelectionModel,
  qualityFromScore,
  stabilityFromState,
  computeAdaptiveAcceptableDelayMs,
};
