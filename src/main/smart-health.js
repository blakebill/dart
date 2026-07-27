'use strict';

const HEALTH_SIGNAL_NAMES = Object.freeze([
  'tcp',
  'udp',
  'handshake',
  'firstByte',
]);
const UNAVAILABLE_SOFT_FAILS = 1.95;

function validDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= 120_000;
}

function emptyHealthSignal() {
  return {
    failureRate: 0,
    softFails: 0,
    samples: 0,
    successes: 0,
    failures: 0,
    lastSuccess: 0,
    lastFailure: 0,
    durationEwma: null,
  };
}

function emptyHealthSignals() {
  return Object.fromEntries(
    HEALTH_SIGNAL_NAMES.map((name) => [name, emptyHealthSignal()])
  );
}

function normalizeSignalName(value) {
  const normalized = String(value || '').trim().toLowerCase()
    .replace(/[_\s-]+/g, '');
  if (normalized === 'tcp') return 'tcp';
  if (normalized === 'udp') return 'udp';
  if (normalized === 'handshake') return 'handshake';
  if (normalized === 'firstbyte') return 'firstByte';
  return null;
}

/**
 * Protocol mapping for observeConnection:
 * - `signal` (preferred) or `phase`: tcp | udp | handshake | firstByte
 * - legacy `network: udp` maps to udp
 * - legacy traffic/completion feedback maps to firstByte
 * - old dial events without either field map to tcp
 */
function connectionHealthSignal(event, multiSignal = true) {
  if (!multiSignal) return 'tcp';
  const explicit = normalizeSignalName(event && (event.signal || event.phase));
  if (explicit) return explicit;
  if (normalizeSignalName(event && event.network) === 'udp') return 'udp';
  const kind = event && event.kind;
  if (kind === 'traffic' || kind === 'success' || kind === 'softFail') {
    return 'firstByte';
  }
  return 'tcp';
}

function importOneSignal(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    failureRate: Math.max(0, Math.min(1, Number(source.failureRate) || 0)),
    softFails: Math.max(0, Math.min(16, Number(source.softFails) || 0)),
    samples: Math.max(0, Math.min(1_000_000, Number(source.samples) || 0)),
    successes: Math.max(0, Math.min(1_000_000, Number(source.successes) || 0)),
    failures: Math.max(0, Math.min(1_000_000, Number(source.failures) || 0)),
    lastSuccess: Math.max(0, Number(source.lastSuccess) || 0),
    lastFailure: Math.max(0, Number(source.lastFailure) || 0),
    durationEwma: validDuration(source.durationEwma)
      ? Number(source.durationEwma)
      : null,
  };
}

function robustTail(values, tailWeight) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const maximum = sorted[sorted.length - 1];
  return median + (maximum - median) * tailWeight;
}

function healthSummary(signals) {
  const active = HEALTH_SIGNAL_NAMES
    .map((name) => signals && signals[name])
    .filter((signal) => signal && (
      signal.samples > 0 ||
      signal.failureRate > 0 ||
      signal.softFails > 0 ||
      signal.lastFailure > 0
    ));
  if (!active.length) {
    return {
      failureRate: 0,
      softFails: 0,
      unavailable: false,
      lastFailure: 0,
      lastSuccess: 0,
      successes: 0,
      samples: 0,
    };
  }
  const softFails = Math.min(
    16,
    robustTail(active.map((signal) => signal.softFails), 0.5)
  );
  const criticalUnavailable = ['tcp', 'handshake', 'firstByte'].some((name) => (
    signals &&
    signals[name] &&
    signals[name].softFails >= UNAVAILABLE_SOFT_FAILS
  ));
  const lastFailure = Math.max(...active.map((signal) => signal.lastFailure || 0));
  const recovering = lastFailure > 0
    ? active.filter((signal) => (signal.lastFailure || 0) === lastFailure)
    : [];
  return {
    failureRate: Math.min(
      1,
      robustTail(active.map((signal) => signal.failureRate), 0.4)
    ),
    softFails,
    // A UDP-only failure is useful negative evidence, but cannot prove that
    // the TCP application path is unavailable. Two independently failing
    // phases, or one critical path phase, can.
    unavailable: criticalUnavailable ||
      (
        active.filter((signal) => signal.softFails >= UNAVAILABLE_SOFT_FAILS).length >= 2 &&
        softFails >= UNAVAILABLE_SOFT_FAILS
      ),
    lastFailure,
    lastSuccess: Math.max(
      0,
      ...(recovering.length ? recovering : active)
        .map((signal) => signal.lastSuccess || 0)
    ),
    // Recovery belongs to the latest failed phase. Unrelated traffic cannot
    // clear it, and an older already-recovered phase cannot cap it forever.
    successes: recovering.length
      ? Math.min(...recovering.map((signal) => Number(signal.successes) || 0))
      : 0,
    samples: Math.min(
      1_000_000,
      active.reduce((sum, signal) => sum + (Number(signal.samples) || 0), 0)
    ),
  };
}

function importHealthSignals(value, legacy = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const signals = emptyHealthSignals();
  let hasNewState = false;
  for (const name of HEALTH_SIGNAL_NAMES) {
    if (source[name] && typeof source[name] === 'object') hasNewState = true;
    signals[name] = importOneSignal(source[name]);
  }

  const legacyFailureRate = Math.max(
    0,
    Math.min(1, Number(legacy.connectionFailureRate) || 0)
  );
  const legacySoftFails = Math.max(
    0,
    Math.min(16, Number(legacy.softFails) || 0)
  );
  const current = healthSummary(signals);
  if (
    !hasNewState ||
    legacyFailureRate > current.failureRate ||
    legacySoftFails > current.softFails
  ) {
    const target = signals.tcp;
    target.failureRate = Math.max(target.failureRate, legacyFailureRate);
    target.softFails = Math.max(target.softFails, legacySoftFails);
    target.lastFailure = Math.max(
      target.lastFailure,
      Number(legacy.lastConnectionFailure) || 0
    );
    target.successes = Math.max(
      target.successes,
      Number(legacy.connectionSuccesses) || 0
    );
    target.samples = Math.max(
      target.samples,
      target.failureRate > 0 || target.softFails > 0 ? 1 : 0
    );
    if (validDuration(legacy.dialEwma)) {
      target.durationEwma = Number(legacy.dialEwma);
    }
  }
  return signals;
}

function observeHealthSignal(signals, signalName, event, options, now) {
  const signal = signals[signalName] || (signals[signalName] = emptyHealthSignal());
  const kind = event && event.kind;
  const alpha = Math.max(0.01, Math.min(1, Number(options.failureAlpha) || 0.25));
  const softAlpha = Math.max(0.01, Math.min(1, Number(options.softFailAlpha) || 0.18));
  const ewmaAlpha = Math.max(0.01, Math.min(1, Number(options.alpha) || 0.3));
  signal.samples = Math.min(1_000_000, signal.samples + 1);

  if (kind === 'traffic' || kind === 'success' || kind === 'dialSuccess') {
    signal.successes = Math.min(1_000_000, signal.successes + 1);
    signal.failureRate *= 1 - alpha * 0.85;
    signal.softFails = Math.max(
      0,
      signal.softFails - (kind === 'dialSuccess' ? 0.75 : 1)
    );
    signal.lastSuccess = now;
    if (validDuration(event.durationMs)) {
      const duration = Number(event.durationMs);
      signal.durationEwma = validDuration(signal.durationEwma)
        ? signal.durationEwma * (1 - ewmaAlpha) + duration * ewmaAlpha
        : duration;
    }
    return signal;
  }

  signal.failures = Math.min(1_000_000, signal.failures + 1);
  signal.successes = 0;
  signal.lastFailure = now;
  if (kind === 'dialFailure') {
    signal.failureRate += (1 - signal.failureRate) * alpha;
    // TCP and handshake failures directly prove that the node path failed.
    // UDP and first-byte failures can be destination/protocol-specific, so
    // they need repetition or agreement with another phase.
    const hardPathFailure = signalName === 'tcp' || signalName === 'handshake';
    const evidence = signalName === 'firstByte' ? 1.25 : 1;
    signal.softFails = Math.min(
      16,
      hardPathFailure
        ? Math.max(3, signal.softFails + 1)
        : signal.softFails + evidence
    );
  } else if (kind === 'softFail') {
    signal.failureRate += (1 - signal.failureRate) * softAlpha;
    // Tracker-emitted first-byte soft fails already represent a denoised streak.
    const evidence = signalName === 'firstByte' ? 1.25 : 1;
    signal.softFails = Math.min(16, signal.softFails + evidence);
  }
  return signal;
}

function decayHealthSignals(signals, factor) {
  const decay = Math.max(0, Math.min(1, Number(factor) || 0));
  for (const name of HEALTH_SIGNAL_NAMES) {
    const signal = signals && signals[name];
    if (!signal) continue;
    signal.failureRate *= decay;
    signal.softFails *= decay;
  }
}

function retainHealthSignals(signals, retention) {
  const factor = Math.max(0, Math.min(1, Number(retention) || 0));
  for (const name of HEALTH_SIGNAL_NAMES) {
    const signal = signals && signals[name];
    if (!signal) continue;
    signal.failureRate *= factor;
    signal.softFails *= factor;
  }
}

function resetHealthSignals(signals) {
  for (const name of HEALTH_SIGNAL_NAMES) {
    signals[name] = emptyHealthSignal();
  }
}

module.exports = {
  HEALTH_SIGNAL_NAMES,
  connectionHealthSignal,
  decayHealthSignals,
  emptyHealthSignals,
  healthSummary,
  importHealthSignals,
  observeHealthSignal,
  resetHealthSignals,
  retainHealthSignals,
};
