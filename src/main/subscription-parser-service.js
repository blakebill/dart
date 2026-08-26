'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_THRESHOLD_BYTES = 128 * 1024;
const WORKER_TIMEOUT_MS = 30_000;

function shouldUseParserWorker(content, threshold = WORKER_THRESHOLD_BYTES) {
  // Format detection itself parses YAML/JSON/base64. Once input is large,
  // every supported or unknown shape belongs off the main process rather than
  // trying to predict which syntax will be expensive here.
  return typeof content === 'string' && Buffer.byteLength(content, 'utf-8') >= threshold;
}

function abortError() {
  const error = new Error('subscription parsing was cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function parseInWorker(content, options = {}) {
  const signal = options.signal || null;
  if (signal && signal.aborted) return Promise.reject(abortError());
  const WorkerType = options.WorkerType || Worker;
  const workerPath = options.workerPath || path.join(__dirname, 'subscription-worker.js');
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new WorkerType(workerPath);
    if (typeof worker.unref === 'function') worker.unref();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      Promise.resolve(typeof worker.terminate === 'function' ? worker.terminate() : null).catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('subscription parsing timed out')), options.timeoutMs || WORKER_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message) => {
      if (message && message.ok) return finish(null, message.result);
      const error = new Error(String(message && message.error && message.error.message || 'profile parsing failed'));
      if (message && message.error && message.error.name) error.name = message.error.name;
      finish(error);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error('subscription parser worker exited before returning a result (code ' + code + ')'));
    });
    try {
      worker.postMessage({ content });
    } catch (error) {
      finish(error);
    }
  });
}

async function parseSubscriptionContentAsync(content, parseSync, options = {}) {
  if (typeof parseSync !== 'function') throw new TypeError('parseSync is required');
  if (!shouldUseParserWorker(content, options.thresholdBytes)) return parseSync(content);
  return parseInWorker(content, options);
}

module.exports = {
  WORKER_THRESHOLD_BYTES,
  parseInWorker,
  parseSubscriptionContentAsync,
  shouldUseParserWorker,
};
