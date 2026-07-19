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
  staleAfterMs: 180_000,
  maxSampleAgeMs: 900_000,
  stalePenaltyPerMinute: 10,
  cooldownBaseMs: 30_000,
  cooldownMaxMs: 300_000,
  maxNodes: 4096,
});

function validDelay(value) {
  return Number.isFinite(value) && value >= 0 && value <= 120_000;
}

class SmartSelectionModel {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.options.maxNodes = Math.max(1, Math.floor(Number(this.options.maxNodes) || DEFAULT_OPTIONS.maxNodes));
    this.contextKey = null;
    this.nodes = new Map();
    this.selected = null;
    this.selectedAt = 0;
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

  _record(measurement, now) {
    const name = measurement && typeof measurement.name === 'string' ? measurement.name : '';
    if (!name) return;
    let state = this.nodes.get(name);
    if (!state) {
      state = {
        samples: 0,
        ewma: null,
        jitter: 0,
        failureRate: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastSeen: 0,
        lastSuccess: 0,
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
      }
      state.samples = Math.min(1000, state.samples + 1);
      state.failureRate *= 1 - this.options.failureAlpha;
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.lastSuccess = now;
      return;
    }

    state.failureRate += (1 - state.failureRate) * this.options.failureAlpha;
    state.consecutiveFailures = Math.min(16, state.consecutiveFailures + 1);
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

  _score(state, now) {
    if (!state || state.ewma === null || now - state.lastSuccess > this.options.maxSampleAgeMs) {
      return Infinity;
    }
    const staleMs = Math.max(0, now - state.lastSuccess - this.options.staleAfterMs);
    return state.ewma +
      state.jitter * this.options.jitterWeight +
      state.failureRate * this.options.failurePenalty +
      state.consecutiveFailures * this.options.consecutiveFailurePenalty +
      this.options.uncertaintyPenalty / Math.sqrt(Math.max(1, state.samples)) +
      staleMs / 60_000 * this.options.stalePenaltyPerMinute;
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

    if (this.selected === null) {
      this.selected = activeNames.has(current) ? current : null;
    } else if (activeNames.has(current) && current !== this.selected) {
      this.selected = current;
      this.selectedAt = now;
    }
    this._prune(activeNames, new Set([current].filter(Boolean)));

    let bestName = null;
    let bestScore = Infinity;
    for (const name of orderedNames) {
      const state = this.nodes.get(name);
      if (!state || state.cooldownUntil > now) continue;
      const score = this._score(state, now);
      if (score < bestScore) {
        bestName = name;
        bestScore = score;
      }
    }
    if (!bestName) return activeNames.has(current) ? this._select(current, now) : null;
    if (!activeNames.has(current) || current === bestName) return this._select(bestName, now);

    const currentState = this.nodes.get(current);
    const currentScore = this._score(currentState, now);
    const currentFailed = !currentState || currentState.consecutiveFailures > 0 || currentState.cooldownUntil > now;
    if (!currentFailed && this.selectedAt && now - this.selectedAt < this.options.minDwellMs) {
      return this._select(current, now);
    }
    const threshold = Math.max(
      this.options.switchThresholdMs,
      Number.isFinite(currentScore) ? currentScore * this.options.switchThresholdRatio : 0
    );
    if (!currentFailed && currentScore <= bestScore + threshold) return this._select(current, now);
    return this._select(bestName, now);
  }

  snapshot() {
    return {
      contextKey: this.contextKey,
      selected: this.selected,
      selectedAt: this.selectedAt,
      nodes: new Map([...this.nodes.entries()].map(([name, state]) => [name, { ...state }])),
    };
  }
}

module.exports = { DEFAULT_OPTIONS, SmartSelectionModel };
