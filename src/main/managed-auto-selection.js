'use strict';

class ManagedAutoSelection {
  constructor(options) {
    this.options = options;
    this.timer = null;
    this.run = null;
    this.generation = 0;
    this.cursor = 0;
    this.revision = 0;
    this.selectorTail = Promise.resolve();
    this.outerSelectorTail = Promise.resolve();
  }

  enabled() {
    return !!this.options.getSettings().enableClashApi;
  }

  queueCandidate(name, revision) {
    const apply = () => {
      if (revision !== this.revision || !this.options.isRunning() || !this.enabled()) return null;
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
    return this.enabled() ? this.queueCandidate(name, ++this.revision) : null;
  }

  refresh({ force = false, generation = this.generation } = {}) {
    if (!this.options.isRunning() || !this.enabled()) return Promise.resolve(null);
    if (this.run && this.run.generation === generation) {
      if (force && !this.run.force) {
        return this.run.promise.catch(() => null).then(() => this.refresh({ force: true, generation }));
      }
      return this.run.promise;
    }

    const token = {};
    const promise = this._measureAndApply(force, generation).finally(() => {
      if (this.run && this.run.token === token) this.run = null;
    });
    this.run = { token, generation, force, promise };
    return promise;
  }

  async _measureAndApply(force, generation) {
    if (!force) {
      const outer = await this.options.clashApi(
        'GET',
        '/proxies/' + encodeURIComponent(this.options.appGroup)
      );
      if (!outer || outer.now !== this.options.autoGroup) return null;
    }
    const group = await this.options.clashApi(
      'GET',
      '/proxies/' + encodeURIComponent(this.options.autoGroup)
    );
    const names = Array.isArray(group && group.all) ? group.all.filter(Boolean) : [];
    if (!names.length) return null;
    const batch = this.options.selectBatch(names, group && group.now, this.cursor, force);
    if (!force) this.cursor = batch.nextCursor;
    const candidates = batch.candidates;
    const revision = this.revision;
    const concurrency = Math.max(1, Math.min(
      16,
      Number(this.options.getSettings().testConcurrency) || 8,
      candidates.length
    ));
    let cursor = 0;
    const measurements = new Array(candidates.length);
    const worker = async () => {
      while (cursor < candidates.length && generation === this.generation) {
        const index = cursor++;
        const name = candidates[index];
        try {
          const delay = await this.options.testDelay(name);
          measurements[index] = { name, delay };
        } catch (_) {
          measurements[index] = { name, delay: null };
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const completeMeasurements = measurements.filter(Boolean);
    let bestName;
    if (this.options.selectCandidate) {
      bestName = this.options.selectCandidate({
        names,
        current: group && group.now,
        measurements: completeMeasurements,
      });
    } else {
      let bestDelay = Infinity;
      for (const measurement of completeMeasurements) {
        if (Number.isFinite(measurement.delay) && measurement.delay >= 0 && measurement.delay < bestDelay) {
          bestDelay = measurement.delay;
          bestName = measurement.name;
        }
      }
    }
    if (!bestName || generation !== this.generation || revision !== this.revision) return null;
    if (bestName === (group && group.now)) return bestName;
    return this.queueCandidate(bestName, revision);
  }

  stop() {
    this.generation += 1;
    this.cursor = 0;
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.run = null;
  }

  start() {
    this.stop();
    if (!this.enabled()) return;
    const generation = this.generation;
    const tick = async () => {
      this.timer = null;
      try { await this.refresh({ generation }); } catch (_) {}
      if (generation !== this.generation || !this.options.isRunning() || !this.enabled()) return;
      this.timer = setTimeout(tick, this.options.intervalMs);
      if (this.timer.unref) this.timer.unref();
    };
    this.timer = setTimeout(tick, 250);
    if (this.timer.unref) this.timer.unref();
  }

  setOuterSelector(name) {
    const select = async () => {
      const result = await this.options.clashApi(
        'PUT',
        '/proxies/' + encodeURIComponent(this.options.appGroup),
        { name }
      );
      if (name === this.options.autoGroup && this.enabled()) {
        this.refresh({ force: true }).catch(() => null);
      }
      return result;
    };
    const operation = this.outerSelectorTail.then(select, select);
    this.outerSelectorTail = operation.catch(() => {});
    return operation;
  }
}

module.exports = { ManagedAutoSelection };
