'use strict';

const { DEFAULT_TEST_URL } = require('./converter');
const AUTO_BATCH_MIN = 16;
const AUTO_BATCH_CYCLES = 10;
const SMART_BATCH_MIN = 16;
const SMART_BATCH_CYCLES = 10;
const SMART_FORCE_QUICK = 24;
const SMART_EXPLORE_RATIO = 0.25;

function buildDelayApiPath(name, testUrl, timeout = 5000) {
  const url = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  const params = new URLSearchParams({ url, timeout: String(timeout) });
  return `/proxies/${encodeURIComponent(name)}/delay?${params.toString()}`;
}

function uniqueNames(input) {
  const names = [];
  const seen = new Set();
  for (const value of input || []) {
    const name = typeof value === 'string' ? value : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Keep the current winner in every background latency batch and rotate through
 * the remaining nodes over roughly ten passes. Explicit sweeps still test all.
 */
function selectAutoTestBatch(input, current, cursor = 0, force = false) {
  const names = uniqueNames(input);
  if (force || names.length <= AUTO_BATCH_MIN) {
    return { candidates: names, nextCursor: cursor };
  }

  const seen = new Set(names);
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

/**
 * Smart-oriented batching: prefer the live winner, stale/unseen nodes, and
 * uncertain high-value candidates; keep a slice of random exploration.
 * Force mode returns a small "quick pick" set so UI can switch immediately.
 */
function selectSmartTestBatch(input, current, cursor = 0, force = false, options = {}) {
  const names = uniqueNames(input);
  if (!names.length) return { candidates: [], nextCursor: cursor, refine: false };
  if (names.length <= SMART_BATCH_MIN) {
    return { candidates: names, nextCursor: cursor, refine: false };
  }

  const now = Number(options.now) || Date.now();
  const model = options.model || null;
  const forceQuick = Math.max(SMART_BATCH_MIN, Math.min(
    SMART_FORCE_QUICK,
    Number(options.forceQuick) || SMART_FORCE_QUICK,
    names.length
  ));
  const batchSize = Math.max(SMART_BATCH_MIN, Math.ceil(names.length / SMART_BATCH_CYCLES));
  const target = force
    ? Math.min(names.length, forceQuick)
    : Math.min(names.length, batchSize + (names.includes(current) ? 1 : 0));

  const ranked = names.map((name, index) => {
    const state = model && typeof model.peek === 'function' ? model.peek(name) : null;
    let priority = 0;
    if (name === current) priority += 1_000_000;
    if (!state || state.ewma === null) {
      // Never measured: explore. Known failures: deprioritize hard.
      if (state && (state.consecutiveFailures > 0 || state.cooldownUntil > now)) {
        priority -= 80_000 + state.consecutiveFailures * 15_000;
      } else {
        priority += 80_000 + 20_000;
      }
    } else {
      const age = now - (state.lastSuccess || 0);
      if (age > 180_000) priority += Math.min(40_000, age / 100);
      // Prefer low EWMA (better quality) and low sample counts (uncertain).
      priority += Math.max(0, 25_000 - state.ewma * 20);
      priority += Math.max(0, 8_000 - state.samples * 400);
      // Match UI red band: slow nodes should not dominate the measure batch.
      if (state.ewma >= 500) priority -= 60_000 + state.ewma;
      if (state.cooldownUntil > now) priority -= 50_000;
      if (state.consecutiveFailures > 0) priority -= 20_000 * state.consecutiveFailures;
      if (state.failureRate >= 0.28) priority -= 40_000;
    }
    // Stable tie-break from rotating cursor so batches move across the list.
    const rotate = (index - ((Number(cursor) || 0) % names.length) + names.length) % names.length;
    priority -= rotate;
    return { name, priority, index };
  });

  ranked.sort((a, b) => b.priority - a.priority || a.index - b.index);

  const candidates = [];
  const picked = new Set();
  const take = (name) => {
    if (!name || picked.has(name)) return;
    picked.add(name);
    candidates.push(name);
  };

  if (current && names.includes(current)) take(current);

  const exploitCount = Math.max(1, Math.floor(target * (1 - SMART_EXPLORE_RATIO)));
  for (const row of ranked) {
    if (candidates.length >= exploitCount) break;
    take(row.name);
  }

  // Exploration: walk from cursor so every node is eventually revisited.
  let nextCursor = ((Number(cursor) || 0) % names.length + names.length) % names.length;
  let visited = 0;
  while (candidates.length < target && visited < names.length) {
    take(names[nextCursor]);
    nextCursor = (nextCursor + 1) % names.length;
    visited++;
  }

  return {
    candidates,
    nextCursor,
    // Force only measured a quick subset; caller should schedule a refine pass.
    refine: force && candidates.length < names.length,
  };
}

module.exports = {
  buildDelayApiPath,
  selectAutoTestBatch,
  selectSmartTestBatch,
  AUTO_BATCH_MIN,
  SMART_BATCH_MIN,
  SMART_FORCE_QUICK,
};
