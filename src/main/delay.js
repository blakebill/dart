'use strict';

const { DEFAULT_TEST_URL } = require('./converter');
const AUTO_BATCH_MIN = 16;
const AUTO_BATCH_CYCLES = 10;

function buildDelayApiPath(name, testUrl, timeout = 5000) {
  const url = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  const params = new URLSearchParams({ url, timeout: String(timeout) });
  return `/proxies/${encodeURIComponent(name)}/delay?${params.toString()}`;
}

/**
 * Keep the current winner in every background latency batch and rotate through
 * the remaining nodes over roughly ten passes. Explicit sweeps still test all.
 */
function selectAutoTestBatch(input, current, cursor = 0, force = false) {
  const names = [];
  const seen = new Set();
  for (const value of input || []) {
    const name = typeof value === 'string' ? value : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  if (force || names.length <= AUTO_BATCH_MIN) {
    return { candidates: names, nextCursor: cursor };
  }

  const winner = seen.has(current) ? current : null;
  const batchSize = Math.max(AUTO_BATCH_MIN, Math.ceil(names.length / AUTO_BATCH_CYCLES));
  const candidates = winner ? [winner] : [];
  const target = Math.min(names.length, batchSize + candidates.length);
  let nextCursor = ((Number(cursor) || 0) % names.length + names.length) % names.length;
  let visited = 0;
  while (candidates.length < target && visited < names.length) {
    const name = names[nextCursor];
    nextCursor = (nextCursor + 1) % names.length;
    visited++;
    if (name !== winner) candidates.push(name);
  }
  return { candidates, nextCursor };
}

module.exports = { buildDelayApiPath, selectAutoTestBatch };
