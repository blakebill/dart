'use strict';

const DEFAULT_INTERVALS = Object.freeze({
  activeMs: 3_000,
  idleMs: 12_000,
  deepIdleMs: 30_000,
  deepIdleAfterMs: 2 * 60_000,
});

function normalizedIntervals(value = {}) {
  const merged = { ...DEFAULT_INTERVALS, ...(value || {}) };
  const atLeast = (candidate, fallback, minimum) => {
    const number = Number(candidate);
    return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
  };
  return {
    activeMs: atLeast(merged.activeMs, DEFAULT_INTERVALS.activeMs, 250),
    idleMs: atLeast(merged.idleMs, DEFAULT_INTERVALS.idleMs, 250),
    deepIdleMs: atLeast(merged.deepIdleMs, DEFAULT_INTERVALS.deepIdleMs, 250),
    deepIdleAfterMs: atLeast(
      merged.deepIdleAfterMs,
      DEFAULT_INTERVALS.deepIdleAfterMs,
      0
    ),
  };
}

function selectSmartFeedbackInterval(activity, eventCount = 0, intervals = DEFAULT_INTERVALS) {
  const pacing = normalizedIntervals(intervals);
  if (Number(eventCount) > 0 || (activity && activity.active)) return pacing.activeMs;
  if (activity && Number(activity.idleForMs) >= pacing.deepIdleAfterMs) {
    return pacing.deepIdleMs;
  }
  return pacing.idleMs;
}

/**
 * Lifecycle owner for advisory Smart connection sampling.
 *
 * The caller owns routing state and the harvest implementation; this class
 * owns only pacing, wake-ups and cancellation generations. A stopped sampler
 * never reschedules itself when an older async harvest eventually completes.
 */
class SmartFeedbackSampler {
  constructor({
    harvest,
    getActivity,
    shouldRun,
    onStop = () => {},
    intervals,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof harvest !== 'function') throw new TypeError('harvest is required');
    if (typeof getActivity !== 'function') throw new TypeError('getActivity is required');
    if (typeof shouldRun !== 'function') throw new TypeError('shouldRun is required');
    this.harvest = harvest;
    this.getActivity = getActivity;
    this.shouldRun = shouldRun;
    this.onStop = typeof onStop === 'function' ? onStop : () => {};
    this.intervals = normalizedIntervals(intervals);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.operation = null;
    this.generation = 0;
    this.active = false;
    this.closed = false;
  }

  schedule(generation, delayMs) {
    if (
      this.closed || !this.active || this.timer || this.operation ||
      generation !== this.generation
    ) return;
    let timer = null;
    timer = this.setTimer(
      () => {
        if (this.timer === timer) this.timer = null;
        return this.tick(generation);
      },
      Math.max(0, Number(delayMs) || 0)
    );
    this.timer = timer;
    if (this.timer.unref) this.timer.unref();
  }

  eligible() {
    try {
      return !!this.shouldRun();
    } catch (_) {
      return false;
    }
  }

  deactivate() {
    this.active = false;
    this.generation += 1;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  async tick(generation) {
    if (
      this.closed || !this.active || generation !== this.generation ||
      !this.eligible()
    ) {
      if (this.active && generation === this.generation) {
        this.deactivate();
        this.onStop();
      }
      return;
    }
    const operation = Promise.resolve().then(() => this.harvest());
    this.operation = operation;
    let eventCount = 0;
    try {
      eventCount = await operation;
    } catch (_) {
      // Connection feedback is advisory and must not affect core lifecycle.
    }
    if (this.operation === operation) this.operation = null;
    if (this.closed || !this.active) return;
    if (!this.eligible()) {
      this.deactivate();
      this.onStop();
      return;
    }
    // A stop/start may have happened while the non-cancellable request was in
    // flight. Resume the newer generation immediately without overlapping it.
    if (generation !== this.generation) {
      this.schedule(this.generation, 0);
      return;
    }
    let activity = null;
    try { activity = this.getActivity(); } catch (_) { /* use idle pacing */ }
    this.schedule(
      generation,
      selectSmartFeedbackInterval(activity, eventCount, this.intervals)
    );
  }

  start() {
    if (this.closed) return false;
    if (this.active) return false;
    this.active = true;
    const generation = ++this.generation;
    if (!this.operation) this.schedule(generation, 0);
    return true;
  }

  wake() {
    if (
      this.closed || !this.active || this.operation || !this.eligible()
    ) return false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.schedule(this.generation, 0);
    return true;
  }

  stop() {
    const wasActive = this.active || !!this.timer || !!this.operation;
    this.deactivate();
    // Do not wait for an in-flight Clash request during shutdown. Its captured
    // generation prevents it from scheduling more work when it completes. Keep
    // the promise reference so a rapid restart cannot overlap the old harvest.
    this.onStop();
    return wasActive;
  }

  close() {
    if (this.closed) return false;
    this.closed = true;
    this.stop();
    return true;
  }
}

module.exports = {
  DEFAULT_INTERVALS,
  SmartFeedbackSampler,
  selectSmartFeedbackInterval,
};
