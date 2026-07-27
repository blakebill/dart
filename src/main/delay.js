'use strict';

const { DEFAULT_TEST_URL } = require('./converter');
const AUTO_BATCH_MIN = 16;
const AUTO_BATCH_CYCLES = 10;
const SMART_BATCH_MIN = 16;
const SMART_BATCH_CYCLES = 10;
const SMART_FORCE_QUICK = 24;
const SMART_RECOVERY_SLOTS = 2;

function buildDelayApiPath(name, testUrl, timeout = 5000) {
  const url = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  const ms = Math.max(500, Math.min(60_000, Number(timeout) || 5000));
  const params = new URLSearchParams({ url, timeout: String(ms) });
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
 * Smart-oriented batching: prefer the live winner, then use the model's
 * confidence-bound ranking for unseen, stale, and uncertain candidates.
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
  const probePriorities = model && typeof model.probePriorities === 'function'
    ? model.probePriorities(names, now)
    : null;

  const ranked = names.map((name, index) => {
    const state = model && typeof model.peek === 'function' ? model.peek(name) : null;
    const recovering = !!(state && state.consecutiveFailures > 0 && state.cooldownUntil <= now);
    let priority = probePriorities
      ? probePriorities.get(name)
      : (!state ? Number.MAX_SAFE_INTEGER : 0);
    if (name === current) priority += 1_000_000;
    // Stable tie-break from rotating cursor so batches move across the list.
    const rotate = (index - ((Number(cursor) || 0) % names.length) + names.length) % names.length;
    priority -= rotate;
    return { name, priority, index, recovering };
  });

  ranked.sort((a, b) => b.priority - a.priority || a.index - b.index);

  const candidates = [];
  const picked = new Set();
  const pickedFamilies = new Set();
  const recoveringNames = new Set(ranked.filter((row) => row.recovering).map((row) => row.name));
  const familySource = options.familyForName;
  const familyFor = (name) => {
    if (familySource instanceof Map) return familySource.get(name) || `node:${name}`;
    if (typeof familySource === 'function') return familySource(name) || `node:${name}`;
    return `node:${name}`;
  };
  let recoveryCount = 0;
  const take = (name) => {
    if (!name || picked.has(name)) return false;
    if (!force && recoveringNames.has(name) && recoveryCount >= SMART_RECOVERY_SLOTS) return false;
    picked.add(name);
    candidates.push(name);
    if (recoveringNames.has(name)) recoveryCount++;
    pickedFamilies.add(familyFor(name));
    return true;
  };

  if (current && names.includes(current)) take(current);

  // First cover distinct physical paths. Display regions are intentionally not
  // used here: two differently named nodes can still share one endpoint, while
  // nodes in the same country can traverse completely different routes.
  for (const row of ranked) {
    if (candidates.length >= target) break;
    if (pickedFamilies.has(familyFor(row.name))) continue;
    take(row.name);
  }

  // Then fill the bounded batch with the remaining highest-value probes so a
  // large endpoint family is delayed, never starved.
  for (const row of ranked) {
    if (candidates.length >= target) break;
    take(row.name);
  }

  const normalizedCursor = ((Number(cursor) || 0) % names.length + names.length) % names.length;
  const nextCursor = (normalizedCursor + Math.max(1, target)) % names.length;

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
