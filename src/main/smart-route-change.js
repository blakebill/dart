'use strict';

const ROUTE_CHANGE_DEFAULTS = Object.freeze({
  routeChangeDetection: true,
  routeChangeMinSamples: 6,
  routeChangeThresholdMs: 45,
  routeChangeScaleThreshold: 5,
  routeChangeDriftMs: 4,
  routeChangeConfirmSamples: 2,
  routeChangeBaselineAlpha: 0.05,
  routeChangeDeviationAlpha: 0.12,
  routeChangeStepCapMs: 120,
  routeChangeStepCapScale: 4,
  routeChangeConsensusWindowMs: 3 * 60_000,
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, number))
    : fallback;
}

function emptyDetectorState() {
  return {
    count: 0,
    mean: null,
    deviation: 0,
    positive: 0,
    negative: 0,
    upStreak: 0,
    downStreak: 0,
    changes: 0,
    lastChangeAt: 0,
    lastDirection: null,
  };
}

function importDetectorState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const direction = source.lastDirection === 'up' || source.lastDirection === 'down'
    ? source.lastDirection
    : null;
  return {
    count: Math.max(0, Math.min(1_000_000, Math.floor(Number(source.count) || 0))),
    mean: Number.isFinite(source.mean) && source.mean >= 0 ? Number(source.mean) : null,
    deviation: Math.max(0, Math.min(120_000, Number(source.deviation) || 0)),
    positive: Math.max(0, Math.min(1_000_000, Number(source.positive) || 0)),
    negative: Math.max(0, Math.min(1_000_000, Number(source.negative) || 0)),
    upStreak: Math.max(0, Math.min(100, Math.floor(Number(source.upStreak) || 0))),
    downStreak: Math.max(0, Math.min(100, Math.floor(Number(source.downStreak) || 0))),
    changes: Math.max(0, Math.min(1_000_000, Math.floor(Number(source.changes) || 0))),
    lastChangeAt: Math.max(0, Number(source.lastChangeAt) || 0),
    lastDirection: direction,
  };
}

function emptyRouteChangeState() {
  return {
    ...emptyDetectorState(),
    primary: emptyDetectorState(),
    secondary: emptyDetectorState(),
    consensus: {
      primaryDirection: null,
      primaryAt: 0,
      secondaryDirection: null,
      secondaryAt: 0,
    },
  };
}

function importRouteChangeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const state = {
    ...importDetectorState(source),
    primary: importDetectorState(source.primary),
    secondary: importDetectorState(source.secondary),
    consensus: {
      primaryDirection:
        source.consensus && (
          source.consensus.primaryDirection === 'up' ||
          source.consensus.primaryDirection === 'down'
        )
          ? source.consensus.primaryDirection
          : null,
      primaryAt: Math.max(
        0,
        Number(source.consensus && source.consensus.primaryAt) || 0
      ),
      secondaryDirection:
        source.consensus && (
          source.consensus.secondaryDirection === 'up' ||
          source.consensus.secondaryDirection === 'down'
        )
          ? source.consensus.secondaryDirection
          : null,
      secondaryAt: Math.max(
        0,
        Number(source.consensus && source.consensus.secondaryAt) || 0
      ),
    },
  };
  return state;
}

function routeChangeOptions(options = {}) {
  return {
    enabled: options.routeChangeDetection !== false,
    minSamples: Math.round(clamp(
      options.routeChangeMinSamples,
      4,
      64,
      ROUTE_CHANGE_DEFAULTS.routeChangeMinSamples
    )),
    thresholdMs: clamp(
      options.routeChangeThresholdMs,
      10,
      500,
      ROUTE_CHANGE_DEFAULTS.routeChangeThresholdMs
    ),
    scaleThreshold: clamp(
      options.routeChangeScaleThreshold,
      2,
      16,
      ROUTE_CHANGE_DEFAULTS.routeChangeScaleThreshold
    ),
    driftMs: clamp(
      options.routeChangeDriftMs,
      0,
      50,
      ROUTE_CHANGE_DEFAULTS.routeChangeDriftMs
    ),
    confirmSamples: Math.round(clamp(
      options.routeChangeConfirmSamples,
      2,
      8,
      ROUTE_CHANGE_DEFAULTS.routeChangeConfirmSamples
    )),
    baselineAlpha: clamp(
      options.routeChangeBaselineAlpha,
      0.005,
      0.3,
      ROUTE_CHANGE_DEFAULTS.routeChangeBaselineAlpha
    ),
    deviationAlpha: clamp(
      options.routeChangeDeviationAlpha,
      0.01,
      0.5,
      ROUTE_CHANGE_DEFAULTS.routeChangeDeviationAlpha
    ),
    stepCapMs: clamp(
      options.routeChangeStepCapMs,
      20,
      1_000,
      ROUTE_CHANGE_DEFAULTS.routeChangeStepCapMs
    ),
    stepCapScale: clamp(
      options.routeChangeStepCapScale,
      1,
      12,
      ROUTE_CHANGE_DEFAULTS.routeChangeStepCapScale
    ),
    consensusWindowMs: clamp(
      options.routeChangeConsensusWindowMs,
      1_000,
      10 * 60_000,
      ROUTE_CHANGE_DEFAULTS.routeChangeConsensusWindowMs
    ),
  };
}

function rebaseRouteChange(state, value, direction, now) {
  const changes = Math.min(1_000_000, (Number(state.changes) || 0) + 1);
  Object.assign(state, emptyDetectorState(), {
    count: 1,
    mean: value,
    changes,
    lastChangeAt: Math.max(0, Number(now) || 0),
    lastDirection: direction,
  });
}

/**
 * Two-sided Page-Hinkley/CUSUM route-shift detector.
 *
 * It uses a capped innovation and requires consecutive directional evidence,
 * so one isolated latency spike cannot reset a mature node. State is constant
 * size and belongs to one node in one active network context.
 */
function observeRouteChange(state, value, options = {}, now = Date.now()) {
  if (!state || typeof state !== 'object' || !Number.isFinite(value) || value < 0) {
    return { changed: false, direction: null };
  }
  const config = routeChangeOptions(options);
  const sample = Number(value);
  if (!config.enabled) return { changed: false, direction: null };

  if (!Number.isFinite(state.mean) || state.count <= 0) {
    Object.assign(state, emptyDetectorState(), {
      count: 1,
      mean: sample,
      changes: Math.max(0, Number(state.changes) || 0),
      lastChangeAt: Math.max(0, Number(state.lastChangeAt) || 0),
      lastDirection: state.lastDirection || null,
    });
    return { changed: false, direction: null };
  }

  const previousMean = Number(state.mean);
  const residual = sample - previousMean;
  const absoluteResidual = Math.abs(residual);
  const previousCount = Math.max(1, Number(state.count) || 1);

  if (previousCount < config.minSamples) {
    const nextCount = previousCount + 1;
    const warmupScale = Math.max(5, Number(state.deviation) || 0);
    const innovationCap = Math.max(
      config.thresholdMs,
      Math.min(config.stepCapMs, warmupScale * config.stepCapScale)
    );
    const boundedResidual = Math.max(
      -innovationCap,
      Math.min(innovationCap, residual)
    );
    state.mean = previousMean + boundedResidual / nextCount;
    state.deviation += (
      Math.min(absoluteResidual, innovationCap) - state.deviation
    ) / nextCount;
    state.count = Math.min(1_000_000, nextCount);
    state.positive = 0;
    state.negative = 0;
    state.upStreak = 0;
    state.downStreak = 0;
    return { changed: false, direction: null };
  }

  const scale = Math.max(5, Number(state.deviation) || 0);
  const threshold = Math.max(config.thresholdMs, scale * config.scaleThreshold);
  const allowance = Math.max(config.driftMs, scale * 0.25);
  const stepCap = Math.max(
    config.thresholdMs,
    Math.min(config.stepCapMs, scale * config.stepCapScale)
  );
  const positiveStep = Math.min(stepCap, Math.max(0, residual));
  const negativeStep = Math.min(stepCap, Math.max(0, -residual));
  state.positive = Math.max(0, state.positive + positiveStep - allowance);
  state.negative = Math.max(0, state.negative + negativeStep - allowance);

  const directionalFloor = Math.max(
    allowance,
    threshold * 0.75,
    scale * 3
  );
  if (residual > directionalFloor) {
    state.upStreak = Math.min(100, state.upStreak + 1);
    state.downStreak = 0;
  } else if (residual < -directionalFloor) {
    state.downStreak = Math.min(100, state.downStreak + 1);
    state.upStreak = 0;
  } else {
    state.upStreak = 0;
    state.downStreak = 0;
  }

  const upward = state.positive > threshold &&
    state.upStreak >= config.confirmSamples;
  const downward = state.negative > threshold &&
    state.downStreak >= config.confirmSamples;
  if (upward || downward) {
    const direction = upward ? 'up' : 'down';
    rebaseRouteChange(state, sample, direction, now);
    return { changed: true, direction };
  }

  // Freeze the baseline while a sample itself is plausible shift evidence.
  // If it is an isolated spike, the next normal sample clears the directional
  // streak without pulling the mean away and creating a false reverse shift.
  if (absoluteResidual <= threshold) {
    state.mean = previousMean + residual * config.baselineAlpha;
    const deviationSample = Math.min(
      absoluteResidual,
      Math.max(config.thresholdMs, scale * 3)
    );
    state.deviation += (deviationSample - state.deviation) * config.deviationAlpha;
  }
  state.deviation = Math.max(0, Math.min(120_000, state.deviation));
  state.count = Math.min(1_000_000, previousCount + 1);
  return { changed: false, direction: null };
}

function validDelay(value) {
  return Number.isFinite(value) && value >= 0 && value <= 120_000;
}

function componentIsFresh(measurement, key) {
  if (Object.prototype.hasOwnProperty.call(measurement, key)) {
    return measurement[key] === true;
  }
  return measurement.fresh !== false;
}

function expireConsensus(consensus, now, windowMs) {
  for (const source of ['primary', 'secondary']) {
    const atKey = `${source}At`;
    const directionKey = `${source}Direction`;
    const at = Math.max(0, Number(consensus[atKey]) || 0);
    if (!at || now < at || now - at > windowMs) {
      consensus[atKey] = 0;
      consensus[directionKey] = null;
    }
  }
}

function noteConsensusEvidence(state, source, result, now, config) {
  if (!result.changed) return { changed: false, direction: null };
  const other = source === 'primary' ? 'secondary' : 'primary';
  const directionKey = `${source}Direction`;
  const atKey = `${source}At`;
  const otherDirectionKey = `${other}Direction`;
  const otherAtKey = `${other}At`;
  state.consensus[directionKey] = result.direction;
  state.consensus[atKey] = now;
  const otherAt = Math.max(0, Number(state.consensus[otherAtKey]) || 0);
  const otherDetector = state[other];
  const recentConsensus =
    state.consensus[otherDirectionKey] === result.direction &&
    otherAt > 0 &&
    now >= otherAt &&
    now - otherAt <= config.consensusWindowMs;
  // A rotating batch can delay the second probe source beyond the immediate
  // window. Accept it only if the first source was freshly observed again,
  // remained in its new regime, and changed recently enough to be related.
  const stableRegimeConsensus =
    otherDetector &&
    otherDetector.lastDirection === result.direction &&
    otherDetector.count >= 2 &&
    otherDetector.lastChangeAt > 0 &&
    now >= otherDetector.lastChangeAt &&
    now - otherDetector.lastChangeAt <= config.consensusWindowMs * 4;
  if (!recentConsensus && !stableRegimeConsensus) {
    return { changed: false, direction: null };
  }

  const changes = Math.min(1_000_000, (Number(state.changes) || 0) + 1);
  Object.assign(state, {
    count: 0,
    mean: null,
    deviation: 0,
    positive: 0,
    negative: 0,
    upStreak: 0,
    downStreak: 0,
    changes,
    lastChangeAt: now,
    lastDirection: result.direction,
  });
  state.consensus.primaryDirection = null;
  state.consensus.primaryAt = 0;
  state.consensus.secondaryDirection = null;
  state.consensus.secondaryAt = 0;
  return { changed: true, direction: result.direction };
}

/**
 * Route evidence for dual-URL measurements.
 *
 * Raw primary and secondary RTTs are tracked independently. A node reset needs
 * both probe sources to report the same sustained direction within a bounded
 * window, so changing blend weights or one probe site's incident cannot erase
 * node history. Legacy single-delay callers retain the original detector.
 */
function observeRouteMeasurement(state, measurement, options = {}, now = Date.now()) {
  if (!state || !measurement || typeof measurement !== 'object') {
    return { changed: false, direction: null };
  }
  const hasComponents =
    Object.prototype.hasOwnProperty.call(measurement, 'primaryDelay') ||
    Object.prototype.hasOwnProperty.call(measurement, 'secondaryDelay');
  if (!hasComponents) {
    return validDelay(measurement.delay)
      ? observeRouteChange(state, Number(measurement.delay), options, now)
      : { changed: false, direction: null };
  }

  if (!state.primary || !state.secondary || !state.consensus) {
    const imported = importRouteChangeState(state);
    Object.assign(state, imported);
  }
  const config = routeChangeOptions(options);
  if (!config.enabled) return { changed: false, direction: null };
  expireConsensus(state.consensus, now, config.consensusWindowMs);

  const observations = [];
  if (
    componentIsFresh(measurement, 'primaryFresh') &&
    validDelay(measurement.primaryDelay)
  ) {
    observations.push([
      'primary',
      observeRouteChange(
        state.primary,
        Number(measurement.primaryDelay),
        options,
        now
      ),
    ]);
  }
  if (
    componentIsFresh(measurement, 'secondaryFresh') &&
    validDelay(measurement.secondaryDelay)
  ) {
    observations.push([
      'secondary',
      observeRouteChange(
        state.secondary,
        Number(measurement.secondaryDelay),
        options,
        now
      ),
    ]);
  }
  for (const [source, result] of observations) {
    const consensus = noteConsensusEvidence(state, source, result, now, config);
    if (consensus.changed) return consensus;
  }
  return { changed: false, direction: null };
}

module.exports = {
  ROUTE_CHANGE_DEFAULTS,
  emptyRouteChangeState,
  importRouteChangeState,
  observeRouteChange,
  observeRouteMeasurement,
  routeChangeOptions,
};
