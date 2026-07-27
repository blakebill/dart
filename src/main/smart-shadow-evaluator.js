'use strict';

const { SmartSelectionModel, normalizeSmartMode } = require('./smart-selection');

const DEFAULT_MAX_CONTEXTS = 3;
const DEFAULT_MAX_HISTORY = 80;
const DEFAULT_MAX_NAMES = 64;
const DEFAULT_MAX_MEASUREMENTS = 32;
const DEFAULT_MIN_EVALUATIONS = 24;
const DEFAULT_CALIBRATION_INTERVAL = 8;
const DEFAULT_RECOMMENDATION_ROUNDS = 3;
const DEFAULT_CALIBRATION_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_MIN_IMPROVEMENT = 0.08;
const HISTORY_VERSION = 1;

const EVENT_KINDS = new Set([
  'traffic',
  'success',
  'softFail',
  'dialSuccess',
  'dialFailure',
]);
const SIGNALS = new Set(['tcp', 'udp', 'handshake', 'first-byte']);
const CALIBRATION_KEYS = new Set([
  'switchThresholdMs',
  'switchConfidenceZ',
  'switchThresholdRatio',
  'switchConfirmRounds',
  'routeChangeMinSamples',
  'routeChangeThresholdMs',
  'routeChangeScaleThreshold',
  'routeChangeDriftMs',
  'routeChangeConfirmSamples',
  'routeChangeBaselineAlpha',
  'routeChangeDeviationAlpha',
  'routeChangeStepCapMs',
  'routeChangeStepCapScale',
]);
const CALIBRATION_BOUNDS = Object.freeze({
  switchThresholdMs: Object.freeze({ min: 0, max: 500 }),
  switchConfidenceZ: Object.freeze({ min: 0, max: 4 }),
  switchThresholdRatio: Object.freeze({ min: 0, max: 0.75 }),
  switchConfirmRounds: Object.freeze({ min: 1, max: 8, integer: true }),
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteDelay(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 120_000
    ? number
    : null;
}

function finiteTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Date.now();
}

function boundedString(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function primitiveOptions(source) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'boolean' || typeof value === 'string') {
      result[key] = value;
    } else if (Number.isFinite(value)) {
      result[key] = Number(value);
    }
  }
  return result;
}

function calibrationPatch(source) {
  const patch = {};
  for (const key of CALIBRATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source || {}, key)) continue;
    const bounds = CALIBRATION_BOUNDS[key];
    const value = clamp(source[key], bounds.min, bounds.max);
    patch[key] = bounds.integer ? Math.round(value) : value;
  }
  return patch;
}

function defaultVariantSpecs(baseOptions, legacyOptions = {}) {
  const defaults = calibrationPatch(baseOptions);
  const switchThresholdMs = clamp(finiteOr(baseOptions.switchThresholdMs, 35), 0, 500);
  const confidence = clamp(finiteOr(baseOptions.switchConfidenceZ, 0.9), 0, 4);
  const thresholdRatio = clamp(
    finiteOr(baseOptions.switchThresholdRatio, 0.1),
    0,
    0.75
  );
  const confirmation = Math.max(
    1,
    Math.min(8, Math.round(finiteOr(baseOptions.switchConfirmRounds, 2)))
  );
  const routeMinSamples = Math.max(
    4,
    Math.min(64, Math.round(finiteOr(baseOptions.routeChangeMinSamples, 6)))
  );
  const routeThresholdMs = clamp(
    finiteOr(baseOptions.routeChangeThresholdMs, 45),
    10,
    500
  );
  const routeScaleThreshold = clamp(
    finiteOr(baseOptions.routeChangeScaleThreshold, 5),
    2,
    16
  );
  const routeDriftMs = clamp(finiteOr(baseOptions.routeChangeDriftMs, 4), 0, 50);
  const routeConfirmation = Math.max(
    2,
    Math.min(8, Math.round(finiteOr(baseOptions.routeChangeConfirmSamples, 2)))
  );
  const routeBaselineAlpha = clamp(
    finiteOr(baseOptions.routeChangeBaselineAlpha, 0.05),
    0.005,
    0.3
  );
  const routeDeviationAlpha = clamp(
    finiteOr(baseOptions.routeChangeDeviationAlpha, 0.12),
    0.01,
    0.5
  );
  const routeStepCapMs = clamp(
    finiteOr(baseOptions.routeChangeStepCapMs, 120),
    20,
    1_000
  );
  const routeStepCapScale = clamp(
    finiteOr(baseOptions.routeChangeStepCapScale, 4),
    1,
    12
  );
  const responsive = {
    switchThresholdMs: clamp(switchThresholdMs * 0.82, 0, 500),
    switchConfidenceZ: clamp(confidence * 0.75, 0, 4),
    switchThresholdRatio: clamp(thresholdRatio * 0.8, 0, 0.75),
    switchConfirmRounds: Math.max(1, confirmation - 1),
    routeChangeMinSamples: Math.max(4, routeMinSamples - 1),
    routeChangeThresholdMs: clamp(routeThresholdMs * 0.82, 10, 500),
    routeChangeScaleThreshold: clamp(routeScaleThreshold * 0.9, 2, 16),
    routeChangeDriftMs: clamp(routeDriftMs * 0.8, 0, 50),
    routeChangeConfirmSamples: Math.max(2, routeConfirmation - 1),
    routeChangeBaselineAlpha: clamp(routeBaselineAlpha * 0.8, 0.005, 0.3),
    routeChangeDeviationAlpha: clamp(routeDeviationAlpha * 0.9, 0.01, 0.5),
    routeChangeStepCapMs: clamp(routeStepCapMs * 1.2, 20, 1_000),
    routeChangeStepCapScale: clamp(routeStepCapScale * 1.15, 1, 12),
  };
  const conservative = {
    switchThresholdMs: clamp(switchThresholdMs * 1.18, 0, 500),
    switchConfidenceZ: clamp(confidence * 1.25, 0, 4),
    switchThresholdRatio: clamp(thresholdRatio * 1.2, 0, 0.75),
    switchConfirmRounds: Math.min(8, confirmation + 1),
    routeChangeMinSamples: Math.min(64, routeMinSamples + 2),
    routeChangeThresholdMs: clamp(routeThresholdMs * 1.22, 10, 500),
    routeChangeScaleThreshold: clamp(routeScaleThreshold * 1.1, 2, 16),
    routeChangeDriftMs: clamp(routeDriftMs * 1.2, 0, 50),
    routeChangeConfirmSamples: Math.min(8, routeConfirmation + 1),
    routeChangeBaselineAlpha: clamp(routeBaselineAlpha * 1.2, 0.005, 0.3),
    routeChangeDeviationAlpha: clamp(routeDeviationAlpha * 1.1, 0.01, 0.5),
    routeChangeStepCapMs: clamp(routeStepCapMs * 0.85, 20, 1_000),
    routeChangeStepCapScale: clamp(routeStepCapScale * 0.9, 1, 12),
  };
  return [
    { name: 'current', options: {}, calibration: null },
    {
      name: 'default',
      options: defaults,
      // An empty overlay means "return to the mode's native defaults". Keeping
      // it empty also lets future app defaults take effect after an upgrade.
      calibration: {},
    },
    {
      name: 'legacy',
      options: primitiveOptions(legacyOptions),
      calibration: null,
    },
    {
      name: 'responsive',
      options: responsive,
      calibration: calibrationPatch(responsive),
    },
    {
      name: 'conservative',
      options: conservative,
      calibration: calibrationPatch(conservative),
    },
  ];
}

function sanitizeMeasurement(value, allowedNames) {
  if (!value || typeof value !== 'object') return null;
  const name = boundedString(value.name);
  if (!name || !allowedNames.has(name)) return null;
  const result = {
    name,
    delay: finiteDelay(value.delay),
    fresh: value.fresh !== false,
  };
  for (const key of ['primaryDelay', 'secondaryDelay']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result[key] = finiteDelay(value[key]);
    }
  }
  for (const key of ['primaryWeight', 'secondaryWeight']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) {
      result[key] = Math.min(1, Number(value[key]));
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'primaryFresh')) {
    result.primaryFresh = value.primaryFresh === true;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'secondaryFresh')) {
    result.secondaryFresh = value.secondaryFresh === true;
  }
  return result;
}

function sanitizeRound(value, limits) {
  if (!value || typeof value !== 'object') return null;
  const names = [];
  const allowedNames = new Set();
  for (const rawName of value.names || []) {
    const name = boundedString(rawName);
    if (!name || allowedNames.has(name)) continue;
    allowedNames.add(name);
    names.push(name);
    if (names.length >= limits.maxNames) break;
  }
  if (!names.length) return null;
  const measurements = [];
  for (const rawMeasurement of value.measurements || []) {
    const measurement = sanitizeMeasurement(rawMeasurement, allowedNames);
    if (measurement) measurements.push(measurement);
    if (measurements.length >= limits.maxMeasurements) break;
  }
  const current = boundedString(value.current);
  const productionPick = boundedString(value.productionPick);
  return {
    type: 'round',
    contextKey: boundedString(value.contextKey || 'default', 512),
    networkKey: boundedString(value.networkKey || 'unknown', 128),
    names,
    current: allowedNames.has(current) ? current : null,
    productionPick: allowedNames.has(productionPick) ? productionPick : null,
    measurements,
    now: finiteTime(value.now),
  };
}

function sanitizeEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const name = boundedString(value.name);
  const kind = boundedString(value.kind, 32);
  if (!name || !EVENT_KINDS.has(kind)) return null;
  const signal = boundedString(value.signal, 32);
  return {
    type: 'event',
    event: {
      name,
      kind,
      ...(SIGNALS.has(signal) ? { signal } : {}),
      ...(finiteDelay(value.durationMs) == null
        ? {}
        : { durationMs: finiteDelay(value.durationMs) }),
      ...(Number.isFinite(value.bytes) && value.bytes >= 0
        ? { bytes: Math.min(1e12, Number(value.bytes)) }
        : {}),
    },
    now: finiteTime(value.now),
  };
}

function metricView(metric) {
  const weight = Math.max(0, Number(metric && metric.weight) || 0);
  const rounds = Math.max(0, Number(metric && metric.rounds) || 0);
  return {
    score: weight > 0 ? metric.loss / weight : Infinity,
    evaluations: weight,
    rounds,
    switches: Math.max(0, Number(metric && metric.switches) || 0),
    switchRate: rounds > 0
      ? Math.max(0, Number(metric && metric.switches) || 0) / rounds
      : 0,
    lastPick: metric && metric.lastPick || null,
  };
}

/**
 * Runs bounded alternative Smart models locally. Shadow choices never reach
 * Clash; only a small, strongly-evidenced calibration patch may be returned to
 * the caller for future production decisions.
 */
class SmartShadowEvaluator {
  constructor(options = {}) {
    this.Model = options.Model || SmartSelectionModel;
    this.maxContexts = Math.max(
      1,
      Math.min(8, Math.floor(Number(options.maxContexts) || DEFAULT_MAX_CONTEXTS))
    );
    this.maxHistory = Math.max(
      16,
      Math.min(512, Math.floor(Number(options.maxHistory) || DEFAULT_MAX_HISTORY))
    );
    this.maxNames = Math.max(
      8,
      Math.min(512, Math.floor(Number(options.maxNames) || DEFAULT_MAX_NAMES))
    );
    this.maxMeasurements = Math.max(
      4,
      Math.min(64, Math.floor(Number(options.maxMeasurements) || DEFAULT_MAX_MEASUREMENTS))
    );
    this.minEvaluations = Math.max(
      4,
      Number(options.minEvaluations) || DEFAULT_MIN_EVALUATIONS
    );
    this.calibrationInterval = Math.max(
      1,
      Math.floor(Number(options.calibrationInterval) || DEFAULT_CALIBRATION_INTERVAL)
    );
    this.recommendationRounds = Math.max(
      1,
      Math.floor(Number(options.recommendationRounds) || DEFAULT_RECOMMENDATION_ROUNDS)
    );
    const requestedCooldown = Number(options.calibrationCooldownMs);
    this.calibrationCooldownMs = Math.max(
      0,
      Number.isFinite(requestedCooldown)
        ? requestedCooldown
        : DEFAULT_CALIBRATION_COOLDOWN_MS
    );
    this.minImprovement = clamp(
      options.minImprovement ?? DEFAULT_MIN_IMPROVEMENT,
      0.01,
      0.5
    );
    this.discount = clamp(options.discount ?? 0.985, 0.9, 1);
    this.variantFactory = typeof options.variantFactory === 'function'
      ? options.variantFactory
      : defaultVariantSpecs;
    this.contexts = new Map();
    this.activeKey = null;
    this.runtime = null;
  }

  _limits() {
    return {
      maxNames: this.maxNames,
      maxMeasurements: this.maxMeasurements,
    };
  }

  _contextKey(contextKey, mode) {
    return JSON.stringify([
      contextKey == null ? 'default' : String(contextKey),
      normalizeSmartMode(mode),
    ]);
  }

  _touchContext(key, details = {}) {
    let state = this.contexts.get(key);
    if (!state) {
      state = {
        contextKey: boundedString(details.contextKey || 'default', 512),
        mode: normalizeSmartMode(details.mode),
        history: [],
        recommendation: null,
        recommendationCount: 0,
        lastCalibrationAt: 0,
        appliedCalibration: {},
        anchorBase: null,
      };
    } else {
      this.contexts.delete(key);
    }
    this.contexts.set(key, state);
    while (this.contexts.size > this.maxContexts) {
      this.contexts.delete(this.contexts.keys().next().value);
    }
    return state;
  }

  _variantSpecs(base, legacyOptions) {
    const rawSpecs = this.variantFactory(base, primitiveOptions(legacyOptions));
    const specs = [];
    const seen = new Set();
    for (const rawSpec of rawSpecs || []) {
      const name = boundedString(rawSpec && rawSpec.name, 64);
      if (!name || seen.has(name) || specs.length >= 6) continue;
      seen.add(name);
      specs.push({
        name,
        options: primitiveOptions(rawSpec.options),
        calibration: rawSpec.calibration
          ? calibrationPatch(rawSpec.calibration)
          : null,
      });
    }
    if (!seen.has('current')) {
      specs.unshift({ name: 'current', options: {}, calibration: null });
    }
    return specs;
  }

  _buildRuntime(state, baseOptions, legacyOptions) {
    const base = primitiveOptions(baseOptions);
    const specs = this._variantSpecs(base, legacyOptions);
    const appliedCalibration = calibrationPatch(state.appliedCalibration);
    const models = new Map();
    const metrics = new Map();
    for (const spec of specs) {
      const variantOptions = spec.name === 'current'
        ? appliedCalibration
        : spec.options;
      models.set(spec.name, new this.Model({
        ...base,
        ...variantOptions,
        mode: state.mode,
      }));
      metrics.set(spec.name, {
        loss: 0,
        weight: 0,
        rounds: 0,
        switches: 0,
        lastPick: null,
      });
    }
    const runtime = {
      base,
      fingerprint: JSON.stringify([state.mode, base, appliedCalibration, specs]),
      specs,
      models,
      metrics,
      roundsSinceCalibration: 0,
      dirty: false,
    };
    this.runtime = runtime;
    for (const entry of state.history) this._runEntry(entry, false);
    // Replayed evidence may be used for scoring immediately, but calibration
    // cadence advances only on newly observed rounds.
    runtime.roundsSinceCalibration = 0;
    return runtime;
  }

  configure({
    contextKey,
    mode,
    baseOptions,
    legacyOptions,
  } = {}) {
    const normalizedMode = normalizeSmartMode(mode);
    const key = this._contextKey(contextKey, normalizedMode);
    const state = this._touchContext(key, {
      contextKey,
      mode: normalizedMode,
    });
    const requestedBase = primitiveOptions(baseOptions);
    if (!state.anchorBase) state.anchorBase = requestedBase;
    const base = state.anchorBase;
    const specs = this._variantSpecs(base, legacyOptions);
    const fingerprint = JSON.stringify([
      normalizedMode,
      base,
      calibrationPatch(state.appliedCalibration),
      specs,
    ]);
    if (
      this.activeKey !== key ||
      !this.runtime ||
      this.runtime.fingerprint !== fingerprint
    ) {
      this.activeKey = key;
      this._buildRuntime(state, base, legacyOptions);
    }
    return this.summary();
  }

  _activeState() {
    return this.activeKey ? this.contexts.get(this.activeKey) : null;
  }

  _append(entry) {
    const state = this._activeState();
    if (!state || !entry) return false;
    let pruned = false;
    const eventLimit = Math.max(8, Math.floor(this.maxHistory * 0.6));
    const oldestEvent = () => state.history.findIndex((item) => item.type === 'event');
    if (
      entry.type === 'event' &&
      state.history.reduce((count, item) => count + (item.type === 'event' ? 1 : 0), 0) >=
        eventLimit
    ) {
      const index = oldestEvent();
      if (index >= 0) {
        state.history.splice(index, 1);
        pruned = true;
      }
    } else if (state.history.length >= this.maxHistory) {
      // Prefer retaining probe rounds: a busy connection stream must not erase
      // all counterfactual evidence before the next replay.
      const index = oldestEvent();
      if (index >= 0) state.history.splice(index, 1);
      else state.history.shift();
      pruned = true;
    }
    state.history.push(entry);
    while (state.history.length > this.maxHistory) {
      state.history.shift();
      pruned = true;
    }
    if (pruned && this.runtime) this.runtime.dirty = true;
    return pruned;
  }

  _decayMetric(metric) {
    metric.loss *= this.discount;
    metric.weight *= this.discount;
    metric.switches *= this.discount;
    metric.rounds *= this.discount;
  }

  _roundOutcome(pick, measurements, switched) {
    const fresh = (measurements || []).filter((item) => item && item.fresh !== false);
    const selected = fresh.find((item) => item.name === pick);
    const successful = fresh
      .map((item) => finiteDelay(item.delay))
      .filter((delay) => delay != null);
    const switchLoss = switched ? 0.06 : 0;
    if (!selected) {
      return switched
        ? { loss: switchLoss, weight: 0.25 }
        : { loss: 0, weight: 0 };
    }
    const delay = finiteDelay(selected.delay);
    if (delay == null) return { loss: 3 + switchLoss, weight: 1 };
    const best = successful.length ? Math.min(...successful) : delay;
    const regret = Math.min(4, Math.max(0, delay - best) / Math.max(50, best));
    return { loss: regret + switchLoss, weight: 1 };
  }

  _runRound(entry) {
    if (!this.runtime) return;
    for (const spec of this.runtime.specs) {
      const model = this.runtime.models.get(spec.name);
      const metric = this.runtime.metrics.get(spec.name);
      this._decayMetric(metric);
      if (typeof model.setNetworkKey === 'function') {
        model.setNetworkKey(entry.networkKey, entry.now);
      }
      const pick = model.choose({
        contextKey: entry.contextKey,
        names: entry.names,
        current: entry.current,
        measurements: entry.measurements,
        now: entry.now,
      });
      const switched = !!(
        metric.lastPick &&
        pick &&
        metric.lastPick !== pick
      );
      const outcome = this._roundOutcome(pick, entry.measurements, switched);
      metric.loss += outcome.loss;
      metric.weight += outcome.weight;
      metric.rounds += 1;
      if (switched) metric.switches += 1;
      metric.lastPick = pick || metric.lastPick;
    }
    this.runtime.roundsSinceCalibration += 1;
  }

  _runEvent(entry) {
    if (!this.runtime) return;
    for (const spec of this.runtime.specs) {
      const model = this.runtime.models.get(spec.name);
      const metric = this.runtime.metrics.get(spec.name);
      this._decayMetric(metric);
      model.observeConnection(entry.event, entry.now);
      if (metric.lastPick !== entry.event.name) continue;
      let loss = 0;
      let weight = 0;
      if (entry.event.kind === 'dialFailure') {
        // TCP/handshake failures are direct path evidence. UDP and first-byte
        // failures can be destination/workload-specific, so they influence
        // calibration without dominating it after one event.
        loss = entry.event.signal === 'first-byte'
          ? 0.9
          : entry.event.signal === 'udp'
            ? 1.5
            : 3;
        weight = 1;
      } else if (entry.event.kind === 'softFail') {
        loss = entry.event.signal === 'first-byte' ? 0.5 : 1.25;
        weight = 1;
      } else if (
        entry.event.kind === 'dialSuccess' ||
        entry.event.kind === 'success'
      ) {
        weight = 0.5;
      }
      metric.loss += loss;
      metric.weight += weight;
    }
  }

  _runEntry(entry) {
    if (entry.type === 'round') this._runRound(entry);
    else if (entry.type === 'event') this._runEvent(entry);
  }

  _recommend(now) {
    const state = this._activeState();
    if (!state || !this.runtime) return null;
    if (this.runtime.roundsSinceCalibration < this.calibrationInterval) return null;
    this.runtime.roundsSinceCalibration = 0;
    const baseline = metricView(this.runtime.metrics.get('current'));
    if (
      !Number.isFinite(baseline.score) ||
      baseline.evaluations < this.minEvaluations
    ) {
      state.recommendation = null;
      state.recommendationCount = 0;
      return null;
    }
    let best = null;
    for (const spec of this.runtime.specs) {
      if (!spec.calibration) continue;
      const metric = metricView(this.runtime.metrics.get(spec.name));
      if (
        !Number.isFinite(metric.score) ||
        metric.evaluations < this.minEvaluations
      ) continue;
      const improvement = (baseline.score - metric.score) /
        Math.max(0.05, baseline.score);
      const switchSafe = metric.switchRate <= Math.min(
        0.65,
        baseline.switchRate + 0.15
      );
      if (
        improvement >= this.minImprovement &&
        switchSafe &&
        (!best || metric.score < best.metric.score)
      ) {
        best = { spec, metric, improvement };
      }
    }
    const name = best && best.spec.name;
    if (!name) {
      state.recommendation = null;
      state.recommendationCount = 0;
      return null;
    }
    if (state.recommendation === name) state.recommendationCount += 1;
    else {
      state.recommendation = name;
      state.recommendationCount = 1;
    }
    if (
      state.recommendationCount < this.recommendationRounds ||
      now - state.lastCalibrationAt < this.calibrationCooldownMs
    ) return null;
    state.lastCalibrationAt = now;
    state.recommendation = null;
    state.recommendationCount = 0;
    state.appliedCalibration = { ...best.spec.calibration };
    return {
      variant: name,
      patch: { ...best.spec.calibration },
      improvement: best.improvement,
      evaluations: best.metric.evaluations,
    };
  }

  recordRound(value) {
    const state = this._activeState();
    if (!this.runtime || !state) return { calibration: null };
    const entry = sanitizeRound(value, this._limits());
    if (!entry) return { calibration: null };
    entry.contextKey = state.contextKey;
    this._append(entry);
    if (this.runtime.dirty) {
      const roundsSinceCalibration = this.runtime.roundsSinceCalibration;
      const legacyOptions = this._legacyOptions();
      this._buildRuntime(state, this.runtime.base, legacyOptions);
      this.runtime.roundsSinceCalibration = roundsSinceCalibration + 1;
    } else {
      this._runRound(entry);
    }
    return {
      calibration: this._recommend(entry.now),
      summary: this.summary(),
    };
  }

  observeConnection(value, now = Date.now()) {
    if (!this.runtime || !this._activeState()) return false;
    const entry = sanitizeEvent({ ...value, now });
    if (!entry) return false;
    this._append(entry);
    if (!this.runtime.dirty) this._runEvent(entry);
    return true;
  }

  replay() {
    const state = this._activeState();
    if (!state || !this.runtime) return this.summary();
    this._buildRuntime(state, this.runtime.base, this._legacyOptions());
    return this.summary();
  }

  _legacyOptions() {
    const spec = this.runtime && this.runtime.specs.find((item) => item.name === 'legacy');
    return spec ? spec.options : {};
  }

  summary() {
    const variants = {};
    if (this.runtime) {
      for (const spec of this.runtime.specs) {
        variants[spec.name] = metricView(this.runtime.metrics.get(spec.name));
      }
    }
    const state = this._activeState();
    return {
      contextKey: state ? state.contextKey : null,
      mode: state ? state.mode : null,
      historySize: state ? state.history.length : 0,
      calibration: state ? { ...state.appliedCalibration } : {},
      variants,
    };
  }

  snapshot() {
    return {
      version: HISTORY_VERSION,
      contexts: [...this.contexts.entries()].map(([key, state]) => ({
        key,
        contextKey: state.contextKey,
        mode: state.mode,
        history: state.history.slice(-this.maxHistory),
        lastCalibrationAt: state.lastCalibrationAt,
        calibration: { ...state.appliedCalibration },
      })),
    };
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (
      Object.prototype.hasOwnProperty.call(snapshot, 'version') &&
      Number(snapshot.version) !== HISTORY_VERSION
    ) return false;
    const rows = Array.isArray(snapshot.contexts) ? snapshot.contexts.slice(-this.maxContexts) : [];
    const restored = new Map();
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const contextKey = boundedString(raw.contextKey || 'default', 512);
      const mode = normalizeSmartMode(raw.mode);
      const key = this._contextKey(contextKey, mode);
      const history = [];
      for (const entry of Array.isArray(raw.history) ? raw.history.slice(-this.maxHistory) : []) {
        const clean = entry && entry.type === 'round'
          ? sanitizeRound(entry, this._limits())
          : entry && entry.type === 'event'
            ? sanitizeEvent({ ...(entry.event || {}), now: entry.now })
            : null;
        if (clean) history.push(clean);
      }
      restored.set(key, {
        contextKey,
        mode,
        history,
        recommendation: null,
        recommendationCount: 0,
        lastCalibrationAt: Math.min(
          Date.now(),
          Math.max(0, Number(raw.lastCalibrationAt) || 0)
        ),
        appliedCalibration: calibrationPatch(raw.calibration),
        anchorBase: null,
      });
    }
    this.contexts = restored;
    this.activeKey = null;
    this.runtime = null;
    return true;
  }
}

module.exports = {
  CALIBRATION_KEYS,
  SmartShadowEvaluator,
  defaultVariantSpecs,
};
