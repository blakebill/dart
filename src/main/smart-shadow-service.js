'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writeJsonAtomicSync } = require('./file-utils');
const { SmartShadowEvaluator } = require('./smart-shadow-evaluator');

const DEFAULT_OPTIONS = Object.freeze({
  batchDelayMs: 1_000,
  batchSize: 24,
  maxPending: 256,
  persistDelayMs: 60_000,
  maxFileBytes: 2 * 1024 * 1024,
  historyFile: 'smart-shadow-history.json',
});

function positiveInteger(value, fallback, min = 1) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= min ? number : fallback;
}

function normalizeOptions(value = {}) {
  return {
    batchDelayMs: positiveInteger(value.batchDelayMs, DEFAULT_OPTIONS.batchDelayMs, 0),
    batchSize: positiveInteger(value.batchSize, DEFAULT_OPTIONS.batchSize),
    maxPending: positiveInteger(value.maxPending, DEFAULT_OPTIONS.maxPending),
    persistDelayMs: positiveInteger(value.persistDelayMs, DEFAULT_OPTIONS.persistDelayMs, 0),
    maxFileBytes: positiveInteger(value.maxFileBytes, DEFAULT_OPTIONS.maxFileBytes),
    historyFile: typeof value.historyFile === 'string' && value.historyFile
      ? path.basename(value.historyFile)
      : DEFAULT_OPTIONS.historyFile,
  };
}

function shadowHash(namespace, value) {
  return crypto
    .createHash('sha256')
    .update(`${namespace}\0${String(value || '')}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Owns bounded, anonymized shadow replay work. Production routing state stays
 * with core-control; this service can only return a calibration suggestion via
 * the injected applyCalibration callback.
 */
function createSmartShadowService({
  evaluator = new SmartShadowEvaluator(),
  getHistoryDirectory = () => '',
  getActiveContextKey,
  getModelConfig,
  getScopeKey,
  resolveNodeIdentity = (name) => name,
  getNetworkIdentity = () => 'unknown',
  applyCalibration = () => false,
  log = () => {},
  options,
} = {}) {
  if (typeof getActiveContextKey !== 'function') {
    throw new TypeError('getActiveContextKey is required');
  }
  if (typeof getModelConfig !== 'function') throw new TypeError('getModelConfig is required');
  const readScopeKey = typeof getScopeKey === 'function'
    ? getScopeKey
    : () => (getModelConfig() || {}).mode;
  const limits = normalizeOptions(options);
  let loadedPath = null;
  let persistTimer = null;
  let persistFailed = false;
  let workTimer = null;
  let workImmediate = null;
  let workQueue = [];
  let flushing = false;
  let closed = false;

  function historyPath() {
    const dir = getHistoryDirectory();
    return typeof dir === 'string' && dir
      ? path.join(dir, limits.historyFile)
      : '';
  }

  function loadHistory({ allowClosed = false } = {}) {
    if (closed && !allowClosed) return false;
    const file = historyPath();
    if (!file || loadedPath === file) return false;
    loadedPath = file;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0 || stat.size > limits.maxFileBytes) return false;
      evaluator.restore(JSON.parse(fs.readFileSync(file, 'utf-8')));
      return true;
    } catch (_) {
      // Advisory history can be absent or corrupt without affecting routing.
      return false;
    }
  }

  function flushHistory({ allowClosed = false } = {}) {
    if (closed && !allowClosed) return false;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const file = historyPath();
    if (!file || loadedPath !== file) return false;
    try {
      const snapshot = evaluator.snapshot();
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf-8') > limits.maxFileBytes) {
        return false;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomicSync(file, snapshot);
      persistFailed = false;
      return true;
    } catch (error) {
      if (!persistFailed) {
        persistFailed = true;
        log('[gui] local Smart shadow history could not be saved: ' + error.message);
      }
      return false;
    }
  }

  function schedulePersist() {
    if (closed || persistTimer || !historyPath()) return;
    persistTimer = setTimeout(() => flushHistory(), limits.persistDelayMs);
    if (persistTimer.unref) persistTimer.unref();
  }

  function nodeKey(name) {
    if (typeof name !== 'string' || !name) return '';
    return shadowHash('node', resolveNodeIdentity(name) || name);
  }

  function contextKey(value) {
    // Subscription IDs and probe URLs remain outside the persisted replay.
    return shadowHash('context', value || 'default');
  }

  function networkKey() {
    return shadowHash('network', getNetworkIdentity());
  }

  function ensureContext(rawContextKey = getActiveContextKey(), { allowClosed = false } = {}) {
    if (closed && !allowClosed) return null;
    loadHistory({ allowClosed });
    const config = getModelConfig() || {};
    const summary = evaluator.configure({
      contextKey: contextKey(rawContextKey),
      mode: config.mode,
      baseOptions: config.baseOptions,
      legacyOptions: config.legacyOptions,
    });
    if (summary) applyCalibration(summary.calibration);
    return summary;
  }

  function applyResult(result) {
    const calibration = result && result.calibration;
    if (!calibration || !calibration.patch) return false;
    if (applyCalibration(calibration.patch)) {
      log(`[gui] Smart shadow calibration applied (${calibration.variant})`);
    }
    return true;
  }

  function processWork(task) {
    if (task.type === 'round') {
      const reconfigure = applyResult(evaluator.recordRound(task.value));
      schedulePersist();
      return reconfigure;
    }
    if (task.type === 'connection' && evaluator.observeConnection(task.event, task.now)) {
      schedulePersist();
    }
    return false;
  }

  function scheduleWork() {
    if (closed || workTimer || workImmediate || !workQueue.length) return;
    workTimer = setTimeout(() => {
      workTimer = null;
      flush();
    }, limits.batchDelayMs);
    if (workTimer.unref) workTimer.unref();
  }

  function enqueue(task) {
    if (closed) return false;
    if (workQueue.length >= limits.maxPending) {
      const connectionIndex = workQueue.findIndex((item) => item.type === 'connection');
      workQueue.splice(connectionIndex >= 0 ? connectionIndex : 0, 1);
    }
    workQueue.push(task);
    scheduleWork();
    return true;
  }

  function flush({ drain = false, allowClosed = false } = {}) {
    if (closed && !allowClosed) return 0;
    if (workTimer) clearTimeout(workTimer);
    workTimer = null;
    if (workImmediate) clearImmediate(workImmediate);
    workImmediate = null;
    if (flushing) return 0;
    flushing = true;
    let processed = 0;
    const limit = drain ? Infinity : limits.batchSize;
    const activeContextKey = getActiveContextKey();
    const activeScopeKey = String(readScopeKey() || 'default');
    let contextReady = false;
    try {
      while (workQueue.length && processed < limit) {
        const task = workQueue.shift();
        if (
          task && task.contextKey === activeContextKey &&
          task.scopeKey === activeScopeKey
        ) {
          try {
            if (!contextReady) {
              ensureContext(activeContextKey, { allowClosed });
              contextReady = true;
            }
            if (processWork(task)) contextReady = false;
          } catch (_) {
            // Shadow replay is advisory and cannot affect production routing.
          }
        }
        processed += 1;
      }
    } finally {
      flushing = false;
    }
    if (workQueue.length) {
      if (drain) return processed + flush({ drain: true, allowClosed });
      workImmediate = setImmediate(() => {
        workImmediate = null;
        flush();
      });
      if (workImmediate.unref) workImmediate.unref();
    }
    return processed;
  }

  function recordRound(value = {}) {
    if (closed) return false;
    const {
      contextKey: rawContextKey = getActiveContextKey(),
      names,
      current,
      measurements,
      productionPick,
      now = Date.now(),
    } = value || {};
    const scopeKey = String(readScopeKey() || 'default');
    const shadowNames = (names || []).map(nodeKey);
    const shadowMeasurements = (measurements || []).map((measurement) => ({
      name: nodeKey(measurement && measurement.name),
      delay: measurement && measurement.delay,
      fresh: !measurement || measurement.fresh !== false,
      primaryDelay: measurement && measurement.primaryDelay,
      secondaryDelay: measurement && measurement.secondaryDelay,
      primaryWeight: measurement && measurement.primaryWeight,
      secondaryWeight: measurement && measurement.secondaryWeight,
      primaryFresh: measurement && measurement.primaryFresh === true,
      secondaryFresh: measurement && measurement.secondaryFresh === true,
    }));
    return enqueue({
      type: 'round',
      contextKey: rawContextKey,
      scopeKey,
      value: {
        contextKey: contextKey(rawContextKey),
        networkKey: networkKey(),
        names: shadowNames,
        current: current ? nodeKey(current) : null,
        measurements: shadowMeasurements,
        productionPick: productionPick ? nodeKey(productionPick) : null,
        now,
      },
    });
  }

  function observeConnection(event, now = Date.now()) {
    if (closed || !event || typeof event !== 'object') return false;
    return enqueue({
      type: 'connection',
      contextKey: getActiveContextKey(),
      scopeKey: String(readScopeKey() || 'default'),
      event: {
        name: nodeKey(event.name),
        kind: event.kind,
        signal: event.signal,
        durationMs: event.durationMs,
        bytes: event.bytes,
      },
      now,
    });
  }

  function close() {
    if (closed) return false;
    // Reject late collector completions before draining the final batch.
    closed = true;
    if (workTimer) clearTimeout(workTimer);
    workTimer = null;
    if (workImmediate) clearImmediate(workImmediate);
    workImmediate = null;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    flush({ drain: true, allowClosed: true });
    flushHistory({ allowClosed: true });
    return true;
  }

  return Object.freeze({
    ensureContext,
    recordRound,
    observeConnection,
    flush,
    flushHistory,
    close,
  });
}

module.exports = {
  DEFAULT_OPTIONS,
  createSmartShadowService,
  shadowHash,
};
