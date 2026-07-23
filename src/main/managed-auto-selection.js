'use strict';

const MANAGED_TEST_CONCURRENCY = 8;
const OVERRIDE_TEST_CONCURRENCY = 4;

class ManagedAutoSelection {
  constructor(options) {
    this.options = options;
    this.timer = null;
    this.run = null;
    this.generation = 0;
    this.cursor = 0;
    this.revision = 0;
    this.active = false;
    this.selectorTail = Promise.resolve();
    this.outerSelectorTail = Promise.resolve();
  }

  /** Active outer group uses the fast interval; standby groups use the idle one. */
  intervalMs() {
    if (typeof this.options.getIntervalMs === 'function') {
      return this.options.getIntervalMs({ active: this.active });
    }
    if (this.active) {
      return Math.max(1_000, Number(this.options.activeIntervalMs || this.options.intervalMs) || 60_000);
    }
    return Math.max(1_000, Number(this.options.idleIntervalMs) || 4 * 60_000);
  }

  /**
   * Mark whether this managed group is the live outer selector. Promoting a
   * standby group to active reschedules the next tick promptly so the user
   * does not wait out a multi-minute idle delay.
   */
  setActive(active) {
    const next = !!active;
    const promoted = next && !this.active;
    this.active = next;
    if (promoted && this.timer) this.scheduleNext(250);
  }

  isActive() {
    return this.active;
  }

  queueCandidate(name, revision) {
    const apply = () => {
      if (revision !== this.revision || !this.options.isRunning()) return null;
      return this.options.clashApi(
        'PUT',
        '/proxies/' + encodeURIComponent(this.options.autoGroup),
        { name }
      ).then(() => name);
    };
    const operation = this.selectorTail.then(apply, apply);
    this.selectorTail = operation.catch(() => {});
    return operation;
  }

  applyMeasuredCandidate(name) {
    if (!this.options.isRunning()) throw new Error('core not running');
    return this.queueCandidate(name, ++this.revision);
  }

  refresh({ force = false, generation = this.generation, refine = false } = {}) {
    if (!this.options.isRunning()) return Promise.resolve(null);
    if (this.run && this.run.generation === generation) {
      if (force && !this.run.force) {
        return this.run.promise.catch(() => null).then(() => this.refresh({ force: true, generation }));
      }
      return this.run.promise;
    }

    const token = {};
    const promise = this._measureAndApply(force, generation, refine).finally(() => {
      if (this.run && this.run.token === token) this.run = null;
    });
    this.run = { token, generation, force, promise };
    return promise;
  }

  async _measureAndApply(force, generation, refine = false) {
    const group = await this.options.clashApi(
      'GET',
      '/proxies/' + encodeURIComponent(this.options.autoGroup)
    );
    const names = Array.isArray(group && group.all) ? group.all.filter(Boolean) : [];
    if (!names.length) return null;
    // Optional real-path feedback (e.g. Clash /connections) before URL delay.
    if (typeof this.options.harvestFeedback === 'function') {
      try { await this.options.harvestFeedback(); } catch (_) { /* advisory */ }
    }
    const overridePinned = typeof this.options.resolveOverride === 'function'
      ? this.options.resolveOverride(names)
      : null;
    const batch = this.options.selectBatch(names, group && group.now, this.cursor, force && !refine, {
      model: this.options.selectionModel || null,
      now: Date.now(),
    });
    if (!force || refine) this.cursor = batch.nextCursor;
    const candidates = Array.isArray(batch.candidates) ? batch.candidates.slice() : [];
    if (overridePinned && !candidates.includes(overridePinned)) candidates.unshift(overridePinned);
    const revision = this.revision;
    // Override: still probe for history, but keep concurrency modest.
    const baseConcurrency = Math.max(1, Math.min(MANAGED_TEST_CONCURRENCY, candidates.length));
    const concurrency = overridePinned
      ? Math.max(1, Math.min(OVERRIDE_TEST_CONCURRENCY, baseConcurrency))
      : baseConcurrency;
    let cursor = 0;
    const measurements = new Array(candidates.length);
    const worker = async () => {
      while (cursor < candidates.length && generation === this.generation) {
        const index = cursor++;
        const name = candidates[index];
        try {
          const result = await this.options.testDelay(name, { force, refine, generation });
          measurements[index] = result && typeof result === 'object'
            ? { name, delay: result.delay, fresh: result.fresh !== false }
            : { name, delay: result, fresh: true };
        } catch (error) {
          measurements[index] = { name, delay: null, fresh: !(error && error.fresh === false) };
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (generation !== this.generation || revision !== this.revision) return null;
    // Second harvest after probes so short-lived sockets from delay tests also count.
    if (typeof this.options.harvestFeedback === 'function') {
      try { await this.options.harvestFeedback(); } catch (_) { /* advisory */ }
    }
    const completeMeasurements = measurements.filter(Boolean);
    if (typeof this.options.afterMeasure === 'function') {
      try {
        await this.options.afterMeasure({
          names,
          candidates,
          current: group && group.now,
          measurements: completeMeasurements,
          force,
          refine,
          generation,
        });
      } catch (_) { /* advisory */ }
    }
    if (generation !== this.generation || revision !== this.revision) return null;
    let bestName;
    if (this.options.selectCandidate) {
      bestName = this.options.selectCandidate({
        names,
        current: group && group.now,
        measurements: completeMeasurements,
      });
    } else {
      // Classic Auto: lowest delay among this batch's successful probes.
      let bestDelay = Infinity;
      for (const measurement of completeMeasurements) {
        if (Number.isFinite(measurement.delay) && measurement.delay >= 0 && measurement.delay < bestDelay) {
          bestDelay = measurement.delay;
          bestName = measurement.name;
        }
      }
    }
    // User force-override wins over algorithm picks (still measured above).
    if (overridePinned) bestName = overridePinned;
    if (!bestName || generation !== this.generation || revision !== this.revision) {
      // Still schedule a refine pass after a quick force sweep.
      if (force && !refine && batch.refine && generation === this.generation) {
        this.scheduleNext(400);
      }
      return null;
    }
    let applied = bestName;
    // Push preferred member whenever it differs from Clash "now" so UI badges
    // and actual group selection stay aligned (including Dart type:smart).
    // Kernel Smart may still failover per-dial; preferred "now" is GUI's call.
    if (bestName !== (group && group.now)) {
      applied = await this.queueCandidate(bestName, revision);
    }
    // Force two-phase: after a quick pick, keep probing the rest in the background.
    if (force && !refine && batch.refine && generation === this.generation) {
      queueMicrotask(() => {
        if (generation !== this.generation) return;
        this.refresh({ force: false, generation, refine: true }).catch(() => null);
      });
    }
    return applied;
  }

  isScheduled() {
    return !!this.timer || !!(this.run);
  }

  scheduleNext(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    const wait = Math.max(0, Number(delayMs) || this.intervalMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      this._tick(generation);
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  async _tick(generation) {
    if (generation !== this.generation) return;
    try { await this.refresh({ generation }); } catch (_) {}
    if (generation !== this.generation || !this.options.isRunning()) return;
    this.scheduleNext(this.intervalMs());
  }

  stop() {
    this.generation += 1;
    this.cursor = 0;
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.run = null;
  }

  start({ active = this.active, initialDelayMs = 250 } = {}) {
    this.stop();
    this.active = !!active;
    this.scheduleNext(initialDelayMs);
  }

  setOuterSelector(name) {
    // Only perform the Clash API PUT here. Callers decide active/idle cadence
    // for Auto vs Smart after the outer selection changes.
    const select = async () => this.options.clashApi(
      'PUT',
      '/proxies/' + encodeURIComponent(this.options.appGroup),
      { name }
    );
    const operation = this.outerSelectorTail.then(select, select);
    this.outerSelectorTail = operation.catch(() => {});
    return operation;
  }
}

module.exports = { ManagedAutoSelection };
