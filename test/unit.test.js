'use strict';

/**
 * Unit tests for pieces outside the converter: i18n dictionary parity and the
 * store's atomic persistence. Run with: node test/unit.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildDelayApiPath, selectAutoTestBatch, selectSmartTestBatch } = require('../src/main/delay');
const {
  CALIBRATION_OPTION_KEYS,
  DEFAULT_OPTIONS,
  SmartSelectionModel,
  computeCohortCostProfile,
} = require('../src/main/smart-selection');
const {
  SmartProbeSignalWeights,
  smartProbeFamily,
  buildSmartProbeFamilies,
} = require('../src/main/smart-probe-signals');
const {
  SmartShadowEvaluator,
  defaultVariantSpecs,
} = require('../src/main/smart-shadow-evaluator');
const { KernelDialFeedback } = require('../src/main/kernel-dial-feedback');
const { detectNodeRegion, normalizeSmartRegions, smartRegionMembers } = require('../src/main/node-region');
const { nodeFingerprint } = require('../src/main/subscription');
const { ManagedAutoSelection } = require('../src/main/managed-auto-selection');

let passed = 0;
const pendingTests = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(Promise.resolve(result).then(() => {
        passed++;
        console.log('  ✓ ' + name);
      }).catch((e) => {
        console.error('  ✗ ' + name + '\n    ' + e.message);
        process.exitCode = 1;
      }));
      return;
    }
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

console.log('i18n:');

test('manual latency request carries the configured URL in Clash API order', () => {
  const requestPath = buildDelayApiPath('Hong Kong / 01', 'https://example.com/ping?q=a&x=1');
  const parsed = new URL(requestPath, 'http://127.0.0.1');
  assert.strictEqual(parsed.pathname, '/proxies/Hong%20Kong%20%2F%2001/delay');
  assert.strictEqual(parsed.searchParams.get('url'), 'https://example.com/ping?q=a&x=1');
  assert.strictEqual(parsed.searchParams.get('timeout'), '5000');
  assert.ok(parsed.search.startsWith('?url='));

  const defaultRequest = new URL(buildDelayApiPath('Hong Kong / 01'), 'http://127.0.0.1');
  assert.strictEqual(defaultRequest.searchParams.get('url'), 'http://www.gstatic.com/generate_204');
});

test('background Auto checks rotate bounded batches while retaining the winner', () => {
  const names = Array.from({ length: 100 }, (_, i) => `node-${i}`);
  const first = selectAutoTestBatch(names, 'node-50', 0, false);
  const second = selectAutoTestBatch(names, 'node-50', first.nextCursor, false);
  assert.strictEqual(first.candidates.length, 17);
  assert.strictEqual(second.candidates.length, 17);
  assert.ok(first.candidates.includes('node-50'));
  assert.ok(second.candidates.includes('node-50'));
  assert.deepStrictEqual(
    first.candidates.filter((name) => name !== 'node-50'),
    names.slice(0, 16)
  );
  assert.deepStrictEqual(
    second.candidates.filter((name) => name !== 'node-50'),
    names.slice(16, 32)
  );
  assert.deepStrictEqual(selectAutoTestBatch(names, 'node-50', 32, true).candidates, names);
});

test('background Auto batches scale gradually and normalize duplicate names', () => {
  const names = Array.from({ length: 1000 }, (_, i) => `node-${i}`);
  assert.strictEqual(selectAutoTestBatch(names, 'node-500').candidates.length, 101);
  assert.deepStrictEqual(
    selectAutoTestBatch(['a', 'a', '', null, 'b'], 'a').candidates,
    ['a', 'b']
  );
});

test('Smart batches prioritize winner and unseen nodes and force-quick only a subset', () => {
  const model = new SmartSelectionModel();
  model.choose({
    contextKey: 'k',
    names: ['keep', 'fresh', 'stale'],
    current: 'keep',
    now: 1000,
    measurements: [
      { name: 'keep', delay: 80 },
      { name: 'stale', delay: 90 },
    ],
  });
  // Make "stale" old so explore wants it; "fresh" never measured.
  const snap = model.snapshot();
  snap.nodes.get('stale').lastSuccess = 1000;
  model.restore(snap, 'k');
  const names = Array.from({ length: 40 }, (_, i) => `n${i}`).concat(['keep', 'fresh', 'stale']);
  const batch = selectSmartTestBatch(names, 'keep', 0, false, { model, now: 400_000 });
  assert.ok(batch.candidates.includes('keep'));
  assert.ok(batch.candidates.length <= 20);
  assert.ok(batch.candidates.length >= 16);

  const forced = selectSmartTestBatch(names, 'keep', 0, true, { model, now: 400_000 });
  assert.ok(forced.refine);
  assert.ok(forced.candidates.length < names.length);
  assert.ok(forced.candidates.includes('keep'));
});

test('Smart batches cover endpoint families before spending duplicate route slots', () => {
  const names = Array.from({ length: 30 }, (_, index) => `node-${index}`);
  const families = new Map(names.map((name, index) => [
    name,
    index < 20 ? 'tcp:shared.example' : `tcp:unique-${index}.example`,
  ]));
  const batch = selectSmartTestBatch(names, names[0], 0, false, {
    familyForName: families,
    now: 1_000,
  });
  assert.strictEqual(batch.candidates.length, 17);
  for (const name of names.slice(20)) {
    assert.ok(batch.candidates.includes(name), `${name} was hidden behind one endpoint family`);
  }
  assert.ok(batch.candidates.includes(names[0]));
});

test('Smart probe families use real endpoints and detours instead of display regions', () => {
  const nodes = [
    { name: 'HK A', type: 'trojan', server: 'Shared.EXAMPLE.', port: 443 },
    { name: 'US B', type: 'vmess', server: 'shared.example', port: 8443 },
    { name: 'UDP C', type: 'hysteria2', server: 'shared.example', port: 443 },
    { name: 'Relay A', type: 'trojan', server: 'a.example', detour: 'Parent' },
    { name: 'Relay B', type: 'trojan', server: 'b.example', detour: 'Parent' },
    { name: 'Unknown' },
  ];
  const families = buildSmartProbeFamilies(nodes, nodes.map((node) => node.name));
  assert.strictEqual(families.get('HK A'), families.get('US B'));
  assert.notStrictEqual(families.get('HK A'), families.get('UDP C'));
  assert.strictEqual(families.get('Relay A'), families.get('Relay B'));
  assert.strictEqual(smartProbeFamily(nodes[0]), 'tcp:shared.example');
  assert.strictEqual(families.get('Unknown'), 'node:Unknown');
});

test('Smart selection smooths RTT and ignores insignificant improvements', () => {
  const model = new SmartSelectionModel({
    minDwellMs: 0,
    switchThresholdMs: 20,
    switchThresholdRatio: 0,
    switchConfirmRounds: 2,
  });
  const choose = (current, measurements, now) => model.choose({
    contextKey: 'sing-box:profile-a', names: ['a', 'b'], current, measurements, now,
  });
  assert.strictEqual(choose('a', [{ name: 'a', delay: 100 }, { name: 'b', delay: 90 }], 1000), 'a');
  // One-shot low probe (and the jitter it creates) is not enough to flip.
  assert.strictEqual(choose('a', [{ name: 'a', delay: 100 }, { name: 'b', delay: 50 }], 61_000), 'a');
  assert.strictEqual(choose('a', [{ name: 'a', delay: 100 }, { name: 'b', delay: 48 }], 121_000), 'a');
  // Stable, clearly better samples calm jitter; first winning round only pending.
  for (let i = 0; i < 6; i++) {
    model.observe({ name: 'b', delay: 42 + (i % 2) }, 200_000 + i * 500);
  }
  model.observe({ name: 'a', delay: 100 }, 204_000);
  assert.strictEqual(choose('a', [{ name: 'a', delay: 100 }, { name: 'b', delay: 42 }], 250_000), 'a');
  // Second consecutive round confirms the switch (A2).
  assert.strictEqual(choose('a', [{ name: 'a', delay: 100 }, { name: 'b', delay: 43 }], 251_000), 'b');
});

test('Smart cold start applies a clear winner without waiting through dwell', () => {
  const model = new SmartSelectionModel();
  assert.strictEqual(model.choose({
    contextKey: 'cold-start',
    names: ['default', 'clear-winner'],
    current: 'default',
    now: 1_000,
    measurements: [
      { name: 'default', delay: 180 },
      { name: 'clear-winner', delay: 40 },
    ],
  }), 'clear-winner');
});

test('Smart adaptive acceptable delay follows p75 of healthy samples', () => {
  const { computeAdaptiveAcceptableDelayMs, DEFAULT_OPTIONS } = require('../src/main/smart-selection');
  const opts = { ...DEFAULT_OPTIONS };
  // Sparse → default
  assert.strictEqual(computeAdaptiveAcceptableDelayMs([], opts, 1000), 500);
  // Cluster around 100ms → p75*1.5 stays near floor band
  const fast = Array.from({ length: 8 }, () => ({ ewma: 100, consecutiveFailures: 0, cooldownUntil: 0 }));
  const fastLine = computeAdaptiveAcceptableDelayMs(fast, opts, 1000);
  assert.ok(fastLine >= 400 && fastLine <= 500, String(fastLine));
  // Cluster around 400ms → raises ceiling for international paths
  const slow = Array.from({ length: 8 }, (_, i) => ({ ewma: 300 + i * 20, consecutiveFailures: 0, cooldownUntil: 0 }));
  const slowLine = computeAdaptiveAcceptableDelayMs(slow, opts, 1000);
  assert.ok(slowLine > 500, String(slowLine));
  assert.ok(slowLine <= 2000, String(slowLine));
});

test('Smart adaptive delay ceiling resets when the profile context changes', () => {
  const model = new SmartSelectionModel();
  const slowNames = Array.from({ length: 8 }, (_, i) => `slow-${i}`);
  model.choose({
    contextKey: 'profile-a',
    names: slowNames,
    current: slowNames[0],
    now: 1000,
    measurements: slowNames.map((name, i) => ({ name, delay: 700 + i * 20 })),
  });
  assert.ok(model.acceptableDelayMs > 500);
  model.choose({
    contextKey: 'profile-b',
    names: ['only'],
    current: 'only',
    now: 2000,
    measurements: [{ name: 'only', delay: 800 }],
  });
  assert.strictEqual(model.acceptableDelayMs, 500);
});

test('Smart keeps primary URL delay for display without changing blended scoring RTT', () => {
  const model = new SmartSelectionModel();
  model.choose({
    contextKey: 'display',
    names: ['node'],
    current: 'node',
    now: 1000,
    measurements: [{ name: 'node', delay: 220 }],
  });
  model.observeDisplayDelay('node', 80, 1100);
  assert.strictEqual(Math.round(model.peek('node').ewma), 220);
  assert.strictEqual(model.qualities(['node'], 1200).node.ewma, 80);
});

test('Smart smooths primary and secondary probe signals independently', () => {
  const model = new SmartSelectionModel({ alpha: 0.3 });
  model.choose({
    contextKey: 'dual-signals',
    names: ['a'],
    current: 'a',
    now: 1_000,
    measurements: [{
      name: 'a',
      delay: 112,
      primaryDelay: 40,
      secondaryDelay: 200,
      primaryFresh: true,
      secondaryFresh: true,
    }],
  });
  model.choose({
    contextKey: 'dual-signals',
    names: ['a'],
    current: 'a',
    now: 2_000,
    measurements: [{
      name: 'a',
      delay: 31,
      primaryDelay: 40,
      secondaryDelay: 20,
      primaryFresh: true,
      secondaryFresh: false,
    }],
  });
  assert.ok(model.peek('a').ewma > 100, 'cached secondary result was treated as a fresh signal');
});

test('Smart normalizes adaptive primary and secondary probe weights', () => {
  const weighted = new SmartSelectionModel();
  weighted.choose({
    contextKey: 'weighted-signals',
    names: ['node'],
    current: 'node',
    now: 1_000,
    measurements: [{
      name: 'node',
      delay: 190,
      primaryDelay: 100,
      secondaryDelay: 300,
      primaryFresh: true,
      secondaryFresh: true,
      primaryWeight: 9,
      secondaryWeight: 1,
    }],
  });
  assert.strictEqual(Math.round(weighted.peek('node').ewma), 120);

  const compatible = new SmartSelectionModel();
  compatible.choose({
    contextKey: 'default-signals',
    names: ['node'],
    current: 'node',
    now: 1_000,
    measurements: [{
      name: 'node',
      delay: 190,
      primaryDelay: 100,
      secondaryDelay: 300,
      primaryFresh: true,
      secondaryFresh: true,
    }],
  });
  assert.strictEqual(Math.round(compatible.peek('node').ewma), 190);
});

test('Smart probe source reliability adapts per network and recovers cautiously', () => {
  const signals = new SmartProbeSignalWeights();
  const model = {
    peek: () => ({ primaryEwma: 100, secondaryEwma: 100 }),
  };
  const failedPrimary = Array.from({ length: 4 }, (_, index) => ({
    name: `node-${index}`,
    delay: 100,
    primaryDelay: null,
    secondaryDelay: 100 + index,
    primaryFresh: true,
    secondaryFresh: true,
  }));
  const annotated = signals.annotate(failedPrimary, model, 'profile', 'wifi-a');
  const degraded = signals.weights('profile', 'wifi-a');
  assert.ok(degraded.primary < 0.5, JSON.stringify(degraded));
  assert.strictEqual(annotated[0].primaryWeight, 0);
  assert.strictEqual(annotated[0].secondaryWeight, 1);
  assert.strictEqual(annotated[0].delay, 100);

  const untouched = signals.weights('profile', 'wifi-b');
  assert.ok(Math.abs(untouched.primary - 0.55) < 1e-9);
  const healthy = failedPrimary.map((item, index) => ({
    ...item,
    primaryDelay: 100 + index,
  }));
  signals.annotate(healthy, model, 'profile', 'wifi-a');
  const recovering = signals.weights('profile', 'wifi-a');
  assert.ok(recovering.primary > degraded.primary);
  assert.ok(recovering.primary < 0.55, 'one healthy sweep restored a failed source too quickly');
});

test('Smart selection never prefers UI-red high delay when a healthy node exists', () => {
  const model = new SmartSelectionModel({ minDwellMs: 0, switchThresholdMs: 0, switchThresholdRatio: 0 });
  const pick = model.choose({
    contextKey: 'red-avoid',
    names: ['good', 'red', 'dead'],
    current: 'red',
    now: 1000,
    measurements: [
      { name: 'good', delay: 80 },
      { name: 'red', delay: 1200 },
      { name: 'dead', delay: null },
    ],
  });
  assert.strictEqual(pick, 'good');
  // Stale Clash "now" on the red node must not re-stick after we already left.
  const again = model.choose({
    contextKey: 'red-avoid',
    names: ['good', 'red', 'dead'],
    current: 'red',
    now: 2000,
    measurements: [
      { name: 'good', delay: 85 },
      { name: 'red', delay: 1500 },
    ],
  });
  assert.strictEqual(again, 'good');
});

test('Smart selection fails over, cools repeated failures, and bounds memory', () => {
  const model = new SmartSelectionModel({ minDwellMs: 600_000, failedDwellMs: 5_000, maxNodes: 2 });
  assert.strictEqual(model.choose({
    contextKey: 'mihomo:profile-a', names: ['a', 'b'], current: 'a', now: 1000,
    measurements: [{ name: 'a', delay: 50 }, { name: 'b', delay: 100 }],
  }), 'a');
  // First failure stays briefly; after failedDwellMs it can leave quickly.
  assert.strictEqual(model.choose({
    contextKey: 'mihomo:profile-a', names: ['a', 'b'], current: 'a', now: 2000,
    measurements: [{ name: 'a', delay: null }, { name: 'b', delay: 100 }],
  }), 'a');
  assert.strictEqual(model.choose({
    contextKey: 'mihomo:profile-a', names: ['a', 'b'], current: 'a', now: 7000,
    measurements: [{ name: 'a', delay: null }, { name: 'b', delay: 100 }],
  }), 'b');
  model.choose({
    contextKey: 'mihomo:profile-a', names: ['a', 'b', 'c'], current: 'b', now: 8000,
    measurements: [{ name: 'a', delay: null }, { name: 'b', delay: 100 }, { name: 'c', delay: 120 }],
  });
  const snapshot = model.snapshot();
  assert.ok(snapshot.nodes.size <= 2);
  const failed = snapshot.nodes.get('a');
  assert.ok(!failed || failed.cooldownUntil > 8000 || failed.consecutiveFailures > 0);
  const grades = model.qualities(['b', 'missing']);
  // Few successes are "probing" — UI must not traffic-light cold samples.
  assert.strictEqual(grades.b.level, 'probing');
  assert.ok(Number.isFinite(grades.b.ewma));
  assert.strictEqual(grades.missing.level, 'unknown');
  // Under the sample floor, jittery nodes stay probing (not mid/bad).
  const flaky = new SmartSelectionModel();
  flaky.choose({
    contextKey: 'stab', names: ['x'], current: 'x', now: 1000,
    measurements: [{ name: 'x', delay: 40 }, { name: 'x', delay: 200 }, { name: 'x', delay: 50 }],
  });
  assert.strictEqual(flaky.qualities(['x'], 2000).x.level, 'probing');
  // Fast average RTT with wild swings is not "stable" once enough samples land.
  const flakyConfirmed = new SmartSelectionModel();
  flakyConfirmed.choose({
    contextKey: 'stab2', names: ['x'], current: 'x', now: 1000,
    measurements: [
      { name: 'x', delay: 40 }, { name: 'x', delay: 200 }, { name: 'x', delay: 50 },
      { name: 'x', delay: 180 }, { name: 'x', delay: 45 },
    ],
  });
  assert.ok(['mid', 'bad'].includes(flakyConfirmed.qualities(['x'], 2000).x.level));
  // Steady moderate RTT can still be "stable" once enough samples land.
  const steady = new SmartSelectionModel();
  steady.choose({
    contextKey: 'steady', names: ['y'], current: 'y', now: 1000,
    measurements: [
      { name: 'y', delay: 280 }, { name: 'y', delay: 290 }, { name: 'y', delay: 275 },
      { name: 'y', delay: 285 }, { name: 'y', delay: 282 },
    ],
  });
  assert.strictEqual(steady.qualities(['y'], 2000).y.level, 'good');
  // A failed node is "unavailable"; a few lucky re-tests must not go green.
  const recovering = new SmartSelectionModel();
  recovering.choose({
    contextKey: 'rec', names: ['z'], current: 'z', now: 1000,
    measurements: [{ name: 'z', delay: 100 }, { name: 'z', delay: null }, { name: 'z', delay: null }],
  });
  assert.strictEqual(recovering.qualities(['z'], 1500).z.level, 'unavailable');
  recovering.choose({
    contextKey: 'rec', names: ['z'], current: 'z', now: 2000,
    measurements: [{ name: 'z', delay: 90 }, { name: 'z', delay: 95 }, { name: 'z', delay: 88 }],
  });
  const recoveringLevel = recovering.qualities(['z'], 2500).z.level;
  assert.ok(['probing', 'bad', 'mid', 'unavailable'].includes(recoveringLevel));
  assert.notStrictEqual(recoveringLevel, 'good');
});

test('managed Auto scheduler uses fast interval when active and idle when standby', async () => {
  let putName = null;
  const delays = [];
  const managed = new ManagedAutoSelection({
    appGroup: '🚀 Proxy',
    autoGroup: '♻️ Auto',
    clashApi: async (method, apiPath, body) => {
      if (method === 'PUT') {
        putName = body && body.name;
        return {};
      }
      return { now: 'n1', all: ['n1', 'n2'] };
    },
    activeIntervalMs: 60_000,
    idleIntervalMs: 240_000,
    isRunning: () => true,
    selectBatch: selectAutoTestBatch,
    testDelay: async (name) => {
      delays.push(name);
      return name === 'n2' ? 10 : 100;
    },
  });
  assert.strictEqual(managed.isScheduled(), false);
  managed.start({ active: false });
  assert.strictEqual(managed.isScheduled(), true);
  assert.strictEqual(managed.isActive(), false);
  assert.strictEqual(managed.intervalMs(), 240_000);
  // Standby groups still pre-warm winners so a later switch is warm.
  await managed.refresh({ force: false });
  assert.ok(delays.length >= 1);
  assert.strictEqual(putName, 'n2');
  managed.setActive(true);
  assert.strictEqual(managed.isActive(), true);
  assert.strictEqual(managed.intervalMs(), 60_000);
  managed.stop();
  assert.strictEqual(managed.isScheduled(), false);
});

test('managed Auto never treats a zero timeout as the fastest node', async () => {
  let putName = null;
  const managed = new ManagedAutoSelection({
    appGroup: '🚀 Proxy',
    autoGroup: '♻️ Auto',
    clashApi: async (method, _apiPath, body) => {
      if (method === 'PUT') {
        putName = body && body.name;
        return {};
      }
      return { now: 'timeout-node', all: ['timeout-node', 'valid-node'] };
    },
    isRunning: () => true,
    selectBatch: selectAutoTestBatch,
    testDelay: async (name) => (name === 'timeout-node' ? 0 : 42),
  });
  assert.strictEqual(await managed.refresh({ force: true }), 'valid-node');
  assert.strictEqual(putName, 'valid-node');
  managed.stop();
});

test('Smart selection isolates history by core and active profile', () => {
  const model = new SmartSelectionModel();
  model.choose({
    contextKey: 'sing-box:a', names: ['a'], current: 'a', now: 1000,
    measurements: [{ name: 'a', delay: 50 }],
  });
  assert.strictEqual(model.snapshot().nodes.size, 1);
  model.choose({
    contextKey: 'mihomo:a', names: ['b'], current: 'b', now: 2000,
    measurements: [{ name: 'b', delay: 60 }],
  });
  const snapshot = model.snapshot();
  assert.strictEqual(snapshot.contextKey, 'mihomo:a');
  assert.deepStrictEqual([...snapshot.nodes.keys()], ['b']);
});

test('connection feedback denoise ignores probes and needs a soft-fail streak', () => {
  const { ConnectionFeedbackTracker, leafOutbound } = require('../src/main/smart-selection');
  assert.strictEqual(leafOutbound(['node-a', '🧠 Smart', '🚀 Proxy']), 'node-a');

  const tracker = new ConnectionFeedbackTracker({ softFailEmitThreshold: 3 });
  tracker.setIgnoreHosts(['www.gstatic.com']);
  const t0 = 1_000_000;
  const open = (id, name, host, at, bytes = 0) => ({
    id,
    chains: [name, '🧠 Smart', '🚀 Proxy'],
    upload: 0,
    download: bytes,
    start: new Date(at).toISOString(),
    metadata: { host, network: 'tcp' },
  });
  // Probe host must never produce soft-fail events.
  tracker.ingest([open('p1', 'probe-node', 'www.gstatic.com', t0)], t0);
  let events = tracker.ingest([], t0 + 1_500);
  assert.ok(!events.some((e) => e.kind === 'softFail'));

  tracker.reset();
  // One short death is not enough.
  tracker.ingest([open('c1', 'flaky', 'cdn.example.com', t0)], t0);
  events = tracker.ingest([], t0 + 1_500);
  assert.ok(!events.some((e) => e.kind === 'softFail'));
  // Second short death still under threshold.
  tracker.ingest([open('c2', 'flaky', 'cdn.example.com', t0 + 2_000)], t0 + 2_000);
  events = tracker.ingest([], t0 + 3_500);
  assert.ok(!events.some((e) => e.kind === 'softFail'));
  // Third completes the streak → one softFail event.
  tracker.ingest([open('c3', 'flaky', 'cdn.example.com', t0 + 4_000)], t0 + 4_000);
  events = tracker.ingest([], t0 + 5_500);
  assert.ok(events.some((e) => e.kind === 'softFail' && e.name === 'flaky'));

  // Real traffic on TCP host still counts.
  tracker.reset();
  tracker.ingest([open('t1', 'real-path', 'api.example.com', t0, 0)], t0);
  events = tracker.ingest([{
    id: 't1',
    chains: ['real-path', '🧠 Smart', '🚀 Proxy'],
    upload: 5_000,
    download: 40_000,
    start: new Date(t0).toISOString(),
    metadata: { host: 'api.example.com', network: 'tcp' },
  }], t0 + 2_000);
  assert.ok(events.some((e) => e.kind === 'traffic' && e.name === 'real-path'));

  // Empty network + destinationIP still counts (cores sometimes omit network/host).
  tracker.reset();
  tracker.ingest([{
    id: 'ip1',
    chains: ['ip-node', '🧠 Smart', '🚀 Proxy'],
    upload: 0,
    download: 0,
    start: new Date(t0).toISOString(),
    metadata: { destinationIP: '1.2.3.4' },
  }], t0);
  events = tracker.ingest([{
    id: 'ip1',
    chains: ['ip-node', '🧠 Smart', '🚀 Proxy'],
    upload: 2_000,
    download: 20_000,
    start: new Date(t0).toISOString(),
    metadata: { destinationIP: '1.2.3.4' },
  }], t0 + 2_000);
  assert.ok(events.some((e) => e.kind === 'traffic' && e.name === 'ip-node'));

  // Source policy groups in the chain must not be mistaken for leaf nodes.
  tracker.reset();
  tracker.setNodeNames(['leaf-node']);
  tracker.ingest([{
    ...open('leaf1', 'Policy Group', 'api.example.com', t0),
    chains: ['Policy Group', 'leaf-node', '🧠 Smart'],
  }], t0);
  events = tracker.ingest([{
    ...open('leaf1', 'Policy Group', 'api.example.com', t0, 50_000),
    chains: ['Policy Group', 'leaf-node', '🧠 Smart'],
  }], t0 + 2_000);
  assert.ok(events.some((e) => e.kind === 'traffic' && e.name === 'leaf-node'));
  assert.ok(!events.some((e) => e.name === 'Policy Group'));
});

test('kernel dial feedback is incremental, filtered, and restart-safe', async () => {
  const feedback = new KernelDialFeedback();
  const paths = [];
  let phase = 'initial';
  const request = async (apiPath) => {
    paths.push(apiPath);
    if (phase === 'initial') {
      return {
        sequence: 4,
        events: [
          { sequence: 1, group: '🧠 Smart', outbound: 'a', success: true, durationMs: 15 },
          { sequence: 2, group: '🧠 Smart', outbound: 'a', success: false, errorClass: 'canceled' },
          { sequence: 3, group: '🧠 Smart', outbound: 'a', success: false, errorClass: 'soft-fail' },
          { sequence: 4, group: 'Other', outbound: 'a', success: false, errorClass: 'network' },
        ],
      };
    }
    if (phase === 'incremental') {
      return {
        sequence: 5,
        events: [
          { sequence: 5, outbound: 'a', success: false, errorClass: 'network' },
        ],
      };
    }
    if (new URL(apiPath, 'http://localhost').searchParams.get('since') === '5') {
      return { sequence: 1, events: [] };
    }
    return {
      sequence: 2,
      events: [{ sequence: 2, outbound: 'a', success: true, durationMs: 9 }],
    };
  };
  const options = { allowedNames: new Set(['a']), group: '🧠 Smart', now: 1_000 };
  const initial = await feedback.poll(request, options);
  assert.strictEqual(initial.supported, true);
  assert.strictEqual(initial.available, true);
  assert.deepStrictEqual(initial.events.map((event) => event.kind), ['dialSuccess', 'softFail']);
  assert.deepStrictEqual(paths, ['/dart/dial-feedback?since=0&signals=1']);

  phase = 'incremental';
  const incremental = await feedback.poll(request, { ...options, now: 2_000 });
  assert.deepStrictEqual(incremental.events.map((event) => event.kind), ['dialFailure']);
  assert.strictEqual(paths.at(-1), '/dart/dial-feedback?since=4&signals=1');

  phase = 'restart';
  const restarted = await feedback.poll(request, { ...options, now: 3_000 });
  assert.strictEqual(restarted.restarted, true);
  assert.deepStrictEqual(restarted.events.map((event) => event.kind), ['dialSuccess']);
  assert.deepStrictEqual(paths.slice(-2), [
    '/dart/dial-feedback?since=5&signals=1',
    '/dart/dial-feedback?since=0&signals=1',
  ]);
});

test('kernel dial feedback refetches when a new instance overtakes the old cursor', async () => {
  const feedback = new KernelDialFeedback();
  const paths = [];
  let instance = 'old-instance';
  const request = async (apiPath) => {
    paths.push(apiPath);
    const since = new URL(apiPath, 'http://localhost').searchParams.get('since');
    if (instance === 'old-instance') {
      return {
        instance,
        sequence: 5,
        events: [{ sequence: 5, outbound: 'a', success: true, durationMs: 20 }],
      };
    }
    if (since === '5') {
      // The new process has already passed the old cursor. Sequence rollback
      // alone cannot detect this restart and would lose its first five events.
      return {
        instance,
        sequence: 10,
        events: [{ sequence: 6, outbound: 'a', success: false, errorClass: 'network' }],
      };
    }
    return {
      instance,
      sequence: 10,
      events: [
        { sequence: 1, outbound: 'a', success: true, durationMs: 8 },
        { sequence: 10, outbound: 'a', success: false, errorClass: 'timeout' },
      ],
    };
  };
  const options = { allowedNames: new Set(['a']), now: 1_000 };
  const initial = await feedback.poll(request, options);
  assert.strictEqual(initial.restarted, false);
  assert.strictEqual(feedback.instance, 'old-instance');

  instance = 'new-instance';
  const restarted = await feedback.poll(request, { ...options, now: 2_000 });
  assert.strictEqual(restarted.restarted, true);
  assert.strictEqual(feedback.instance, 'new-instance');
  assert.deepStrictEqual(restarted.events.map((event) => event.sequence), [1, 10]);
  assert.deepStrictEqual(paths.slice(-2), [
    '/dart/dial-feedback?since=5&signals=1',
    '/dart/dial-feedback?since=0&signals=1',
  ]);
});

test('official kernels disable unsupported dial feedback until core reset', async () => {
  const feedback = new KernelDialFeedback();
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw new Error('clash api 404');
  };
  const unsupported = await feedback.poll(request);
  assert.strictEqual(unsupported.supported, false);
  assert.strictEqual(unsupported.available, false);
  assert.strictEqual((await feedback.poll(request)).supported, false);
  assert.strictEqual(calls, 1);
  feedback.reset();
  assert.strictEqual((await feedback.poll(request)).supported, false);
  assert.strictEqual(calls, 2);
});

test('kernel dial feedback keeps four stages separate and rejects unknown signals', async () => {
  const feedback = new KernelDialFeedback();
  const result = await feedback.poll(async (apiPath) => {
    const query = new URL(apiPath, 'http://localhost').searchParams;
    assert.strictEqual(query.get('signals'), '1');
    return {
      instance: 'staged-kernel',
      sequence: 5,
      events: [
        { sequence: 1, outbound: 'node', network: 'udp', success: true },
        { sequence: 2, outbound: 'node', signal: 'handshake', success: true, durationMs: 18 },
        {
          sequence: 3,
          outbound: 'node',
          signal: 'first-byte',
          success: false,
          errorClass: 'soft-fail',
        },
        { sequence: 4, outbound: 'node', signal: 'tls-secret', success: false },
        {
          sequence: 5,
          outbound: 'node',
          signal: 'tcp',
          success: false,
          errorClass: 'canceled',
        },
      ],
    };
  }, {
    allowedNames: new Set(['node']),
    now: 1_000,
  });
  assert.deepStrictEqual(
    result.events.map(({ signal, network, kind }) => ({ signal, network, kind })),
    [
      { signal: 'udp', network: 'udp', kind: 'dialSuccess' },
      { signal: 'handshake', network: 'tcp', kind: 'dialSuccess' },
      { signal: 'first-byte', network: 'tcp', kind: 'softFail' },
    ]
  );
  assert.strictEqual(feedback.sequence, 5);
});

test('Smart prefers real traffic over slightly lower URL delay', () => {
  const { SmartSelectionModel: Model } = require('../src/main/smart-selection');
  const model = new Model({
    minDwellMs: 0,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 2,
  });
  const t0 = 1_000_000;
  model.choose({
    contextKey: 'traffic',
    names: ['fast-204', 'real-path'],
    current: 'fast-204',
    now: t0,
    measurements: [
      { name: 'fast-204', delay: 40 },
      { name: 'real-path', delay: 90 },
    ],
  });
  model.observeConnection({ name: 'real-path', kind: 'traffic', bytes: 80_000 }, t0 + 1_000);
  model.observeConnection({ name: 'fast-204', kind: 'softFail' }, t0 + 1_000);
  model.observeConnection({ name: 'fast-204', kind: 'softFail' }, t0 + 1_100);
  // Soft-fail makes the stick unusable → leave immediately (no two-round wait).
  const pick = model.choose({
    contextKey: 'traffic',
    names: ['fast-204', 'real-path'],
    current: 'fast-204',
    now: t0 + 130_000,
    measurements: [
      { name: 'fast-204', delay: 42 },
      { name: 'real-path', delay: 88 },
    ],
  });
  const failedState = model.peek('fast-204');
  assert.ok(failedState.softFails > 1, String(failedState.softFails));
  assert.strictEqual(failedState.consecutiveFailures, 0, 'URL success must not own real connection failures');
  assert.strictEqual(pick, 'real-path');
});

test('kernel dial feedback fails over immediately and recovers gradually', () => {
  const options = {
    minDwellMs: 0,
    failedDwellMs: 600_000,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 3,
  };
  const model = new SmartSelectionModel(options);
  model.choose({
    contextKey: 'dial-feedback',
    names: ['a', 'b'],
    current: 'a',
    now: 1_000,
    measurements: [{ name: 'a', delay: 50 }, { name: 'b', delay: 80 }],
  });
  model.observeConnection({
    name: 'a',
    kind: 'dialSuccess',
    durationMs: 5_000,
  }, 1_100);
  assert.strictEqual(model.peek('a').dialEwma, 5_000);
  // Dial duration is retained for diagnostics/future learning, not RTT score.
  assert.strictEqual(model.choose({
    contextKey: 'dial-feedback',
    names: ['a', 'b'],
    current: 'a',
    now: 1_200,
    measurements: [],
  }), 'a');

  const snapshot = model.snapshot();
  const restored = new SmartSelectionModel(options);
  restored.restore(snapshot, 'dial-feedback');
  assert.strictEqual(restored.peek('a').dialEwma, 5_000);
  assert.strictEqual(restored.peek('a').dialSamples, 1);

  restored.observeConnection({ name: 'a', kind: 'dialFailure' }, 1_300);
  assert.ok(restored.peek('a').softFails >= 2);
  assert.strictEqual(restored.choose({
    contextKey: 'dial-feedback',
    names: ['a', 'b'],
    current: 'a',
    now: 1_301,
    measurements: [],
  }), 'b');

  const failureRate = restored.peek('a').connectionFailureRate;
  restored.observeConnection({ name: 'a', kind: 'dialSuccess', durationMs: 100 }, 1_400);
  assert.ok(restored.peek('a').softFails >= 2, 'one success recovered an explicit failure too quickly');
  restored.observeConnection({ name: 'a', kind: 'dialSuccess', durationMs: 90 }, 1_500);
  assert.ok(restored.peek('a').softFails < 2);
  assert.ok(restored.peek('a').connectionFailureRate < failureRate);
  assert.ok(restored.peek('a').dialEwma < 5_000);
});

test('Smart scheduleHint adapts to stable and failing nodes', () => {
  const { SmartSelectionModel: Model } = require('../src/main/smart-selection');
  const model = new Model({ minDwellMs: 0, switchThresholdMs: 0, switchThresholdRatio: 0, switchConfirmRounds: 1 });
  assert.strictEqual(model.scheduleHint(1000), 'normal');
  model.choose({
    contextKey: 'hint',
    names: ['a', 'b'],
    current: 'a',
    now: 1000,
    measurements: [
      { name: 'a', delay: 80 }, { name: 'a', delay: 82 }, { name: 'a', delay: 79 },
      { name: 'a', delay: 81 }, { name: 'a', delay: 80 },
      { name: 'b', delay: 200 },
    ],
  });
  assert.strictEqual(model.scheduleHint(2000), 'relaxed');
  model.observe({ name: 'a', delay: null }, 3000);
  model.observe({ name: 'a', delay: null }, 3100);
  assert.strictEqual(model.scheduleHint(3200), 'urgent');
});

test('Smart healthy switch needs two consecutive winning rounds', () => {
  const model = new SmartSelectionModel({
    minDwellMs: 0,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 2,
  });
  // Establish stick on a with only a measured first.
  assert.strictEqual(model.choose({
    contextKey: 'confirm',
    names: ['a', 'b'],
    current: 'a',
    now: 1000,
    measurements: [{ name: 'a', delay: 100 }],
  }), 'a');
  // First round b wins → stay on a (pending confirm).
  assert.strictEqual(model.choose({
    contextKey: 'confirm',
    names: ['a', 'b'],
    current: 'a',
    now: 130_000,
    measurements: [{ name: 'a', delay: 100 }, { name: 'b', delay: 40 }],
  }), 'a');
  const samplesBeforeCache = model.peek('b').samples;
  // Reusing the same cached ranking does not count as a confirming round.
  assert.strictEqual(model.choose({
    contextKey: 'confirm',
    names: ['a', 'b'],
    current: 'a',
    now: 130_500,
    measurements: [{ name: 'a', delay: 100, fresh: false }, { name: 'b', delay: 40, fresh: false }],
  }), 'a');
  assert.strictEqual(model.peek('b').samples, samplesBeforeCache);
  // Second consecutive win → switch.
  assert.strictEqual(model.choose({
    contextKey: 'confirm',
    names: ['a', 'b'],
    current: 'a',
    now: 131_000,
    measurements: [{ name: 'a', delay: 100 }, { name: 'b', delay: 40 }],
  }), 'b');
  // Failures still leave without waiting a second round.
  const fail = new SmartSelectionModel({
    minDwellMs: 600_000,
    failedDwellMs: 0,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 2,
  });
  assert.strictEqual(fail.choose({
    contextKey: 'fail',
    names: ['a', 'b'],
    current: 'a',
    now: 1000,
    measurements: [{ name: 'a', delay: 50 }, { name: 'b', delay: 80 }],
  }), 'a');
  assert.strictEqual(fail.choose({
    contextKey: 'fail',
    names: ['a', 'b'],
    current: 'a',
    now: 2000,
    measurements: [{ name: 'a', delay: null }, { name: 'b', delay: 80 }],
  }), 'b');
});

test('Smart requires a variance-aware advantage but bypasses it on explicit failure', () => {
  const options = {
    minDwellMs: 0,
    failedDwellMs: 0,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 1,
    switchConfidenceZ: 1.5,
    selectionRiskWeight: 0,
    jitterWeight: 0,
    ewmaWeight: 1,
  };
  const model = new SmartSelectionModel(options);
  model.choose({
    contextKey: 'variance-gate',
    names: ['a', 'b'],
    current: 'a',
    now: 1_000,
    measurements: [{ name: 'a', delay: 80 }, { name: 'b', delay: 95 }],
  });
  const uncertain = model.snapshot();
  Object.assign(uncertain.nodes.get('a'), {
    ewma: 80,
    delayMean: 80,
    delayM2: 0,
    samples: 20,
    effectiveSamples: 20,
    lastSuccess: 1_000,
  });
  Object.assign(uncertain.nodes.get('b'), {
    ewma: 70,
    delayMean: 70,
    delayM2: 3_600,
    samples: 4,
    effectiveSamples: 4,
    lastSuccess: 1_000,
  });
  uncertain.selected = 'a';
  uncertain.selectedAt = 1_000;
  model.restore(uncertain, 'variance-gate');

  // A nominal 10ms win is inside the challenger's combined uncertainty.
  assert.strictEqual(model.choose({
    contextKey: 'variance-gate',
    names: ['a', 'b'],
    current: 'a',
    now: 2_000,
    measurements: [],
  }), 'a');

  const decisive = new SmartSelectionModel(options);
  const decisiveSnapshot = model.snapshot();
  decisiveSnapshot.nodes.get('b').ewma = 40;
  decisiveSnapshot.nodes.get('b').delayMean = 40;
  decisive.restore(decisiveSnapshot, 'variance-gate');
  assert.strictEqual(decisive.choose({
    contextKey: 'variance-gate',
    names: ['a', 'b'],
    current: 'a',
    now: 2_000,
    measurements: [{ name: 'a', delay: 80 }, { name: 'b', delay: 40 }],
  }), 'b');

  const failed = model.snapshot();
  failed.nodes.get('a').softFails = 3;
  failed.nodes.get('a').lastConnectionFailure = 2_000;
  model.restore(failed, 'variance-gate');
  assert.strictEqual(model.choose({
    contextKey: 'variance-gate',
    names: ['a', 'b'],
    current: 'a',
    now: 2_100,
    measurements: [],
  }), 'b');
});

test('Smart does not adopt a kernel dial failover as its confirmed selection', () => {
  const model = new SmartSelectionModel({
    minDwellMs: 120_000,
    switchThresholdMs: 25,
    switchThresholdRatio: 0.1,
    switchConfirmRounds: 2,
  });
  assert.strictEqual(model.choose({
    contextKey: 'kernel-failover',
    names: ['a', 'b'],
    current: 'a',
    now: 1_000,
    measurements: [{ name: 'a', delay: 50 }, { name: 'b', delay: 90 }],
  }), 'a');
  // A type:smart core may report b for a single dial. The GUI should restore
  // its confirmed healthy pick rather than resetting dwell around b.
  assert.strictEqual(model.choose({
    contextKey: 'kernel-failover',
    names: ['a', 'b'],
    current: 'b',
    now: 2_000,
    measurements: [{ name: 'a', delay: 52 }, { name: 'b', delay: 88 }],
  }), 'a');
  assert.strictEqual(model.selected, 'a');
});

test('Smart mode changes switching posture without discarding history', () => {
  const model = new SmartSelectionModel({ mode: 'stable' });
  model.observe({ name: 'a', delay: 80 }, 1000);
  const samples = model.peek('a').samples;
  assert.strictEqual(model.mode, 'stable');
  assert.strictEqual(model.options.switchConfirmRounds, 3);
  assert.strictEqual(model.setMode('latency'), true);
  assert.strictEqual(model.mode, 'latency');
  assert.strictEqual(model.options.switchConfirmRounds, 1);
  assert.strictEqual(model.peek('a').samples, samples);
  assert.strictEqual(model.setMode('invalid'), true);
  assert.strictEqual(model.mode, 'balanced');
});

test('Smart runtime calibration is bounded, non-compounding, and survives mode/snapshot changes', () => {
  const model = new SmartSelectionModel({ mode: 'balanced' });
  model.observe({ name: 'a', delay: 80 }, 1_000);
  const samples = model.peek('a').samples;
  const base = model.getUncalibratedOptions();
  assert.strictEqual(base.switchThresholdMs, 25);
  assert.deepStrictEqual(model.baseOptions(), base);

  assert.strictEqual(model.setCalibrationOptions({
    switchThresholdMs: 31,
    switchThresholdRatio: 0.12,
    switchConfirmRounds: 4,
    routeChangeThresholdMs: 70,
    routeChangeBaselineAlpha: 0.08,
  }), true);
  assert.strictEqual(model.options.switchThresholdMs, 31);
  assert.strictEqual(model.getUncalibratedOptions().switchThresholdMs, 25);
  assert.strictEqual(model.peek('a').samples, samples);

  const calibrationBeforeReject = { ...model.calibrationOptions };
  assert.throws(
    () => model.setCalibrationOptions({ switchThresholdMs: 32, maxNodes: 1 }),
    /unsupported calibration option/
  );
  assert.deepStrictEqual(model.calibrationOptions, calibrationBeforeReject);
  assert.throws(
    () => model.setCalibrationOptions({ routeChangeMinSamples: 2 }),
    /between 4 and 64/
  );
  assert.deepStrictEqual(model.calibrationOptions, calibrationBeforeReject);

  assert.strictEqual(model.setMode('stable'), true);
  assert.strictEqual(model.options.switchThresholdMs, 31);
  assert.strictEqual(model.getUncalibratedOptions().switchThresholdMs, 45);
  assert.strictEqual(model.peek('a').samples, samples);

  const snapshot = model.snapshot();
  const restored = new SmartSelectionModel({ mode: 'stable' });
  assert.strictEqual(restored.restore(snapshot, 'calibration'), true);
  assert.strictEqual(restored.options.switchThresholdMs, 31);
  assert.strictEqual(restored.options.routeChangeThresholdMs, 70);

  // Older snapshots have no overlay field; keep the receiving model posture.
  const legacySnapshot = { ...snapshot };
  delete legacySnapshot.calibrationOptions;
  const compatible = new SmartSelectionModel({
    mode: 'stable',
    calibrationOptions: { switchThresholdMs: 37 },
  });
  assert.strictEqual(compatible.restore(legacySnapshot, 'calibration'), true);
  assert.strictEqual(compatible.options.switchThresholdMs, 37);
  assert.ok(!CALIBRATION_OPTION_KEYS.includes('routeChangeDetection'));
  assert.ok(!CALIBRATION_OPTION_KEYS.includes('multiSignalHealth'));
  assert.strictEqual(DEFAULT_OPTIONS.routeChangeDetection, true);
  assert.strictEqual(DEFAULT_OPTIONS.multiSignalHealth, true);
  assert.throws(
    () => model.setCalibrationOptions({ multiSignalHealth: false }),
    /unsupported calibration option/
  );
});

test('Smart route-change detector ignores cold start and isolated noise', () => {
  const cold = new SmartSelectionModel({ routeChangeMinSamples: 6 });
  [100, 500, 90, 450, 110].forEach((delay, index) => {
    cold.observe({ name: 'node', delay }, 1_000 + index);
  });
  assert.strictEqual(cold.peek('node').routeChange.changes, 0);

  const noisy = new SmartSelectionModel();
  let now = 2_000;
  for (let i = 0; i < 12; i++) {
    noisy.observe({ name: 'node', delay: 100 + (i % 2) }, now++);
  }
  noisy.observe({ name: 'node', delay: 600 }, now++);
  for (let i = 0; i < 40; i++) {
    noisy.observe({ name: 'node', delay: 100 + (i % 2) }, now++);
  }
  const state = noisy.peek('node');
  assert.strictEqual(state.routeChange.changes, 0);
  assert.ok(state.ewma < 110, String(state.ewma));

  const warmupOutlier = new SmartSelectionModel();
  [100, 100, 100, 100, 100, 1_000].forEach((delay, index) => {
    warmupOutlier.observe({ name: 'node', delay }, 3_000 + index);
  });
  warmupOutlier.observe({ name: 'node', delay: 250 }, 3_100);
  warmupOutlier.observe({ name: 'node', delay: 251 }, 3_101);
  assert.strictEqual(warmupOutlier.peek('node').routeChange.changes, 1);
});

test('Smart route reset needs dual-probe consensus and ignores blend-weight changes', () => {
  const observeDual = (model, primary, secondary, primaryWeight, now) => {
    const secondaryWeight = 1 - primaryWeight;
    model.observe({
      name: 'node',
      delay: primary * primaryWeight + secondary * secondaryWeight,
      primaryDelay: primary,
      secondaryDelay: secondary,
      primaryFresh: true,
      secondaryFresh: true,
      primaryWeight,
      secondaryWeight,
    }, now);
  };

  const weightOnly = new SmartSelectionModel();
  for (let i = 0; i < 12; i++) {
    observeDual(weightOnly, 100 + (i % 2), 200 + (i % 2), 0.55, 1_000 + i);
  }
  for (let i = 0; i < 4; i++) {
    observeDual(weightOnly, 100 + (i % 2), 200 + (i % 2), 0.9, 1_100 + i);
  }
  assert.strictEqual(weightOnly.peek('node').routeChange.changes, 0);
  assert.strictEqual(weightOnly.peek('node').samples, 16);

  const oneProbeSite = new SmartSelectionModel();
  for (let i = 0; i < 12; i++) {
    observeDual(oneProbeSite, 100 + (i % 2), 200 + (i % 2), 0.55, 2_000 + i);
  }
  for (let i = 0; i < 4; i++) {
    observeDual(oneProbeSite, 400 + (i % 2), 200 + (i % 2), 0.55, 2_100 + i);
  }
  assert.strictEqual(oneProbeSite.peek('node').routeChange.changes, 0);
  assert.strictEqual(oneProbeSite.peek('node').routeChange.primary.changes, 1);
  assert.strictEqual(oneProbeSite.peek('node').routeChange.secondary.changes, 0);

  const consensus = new SmartSelectionModel();
  for (let i = 0; i < 12; i++) {
    observeDual(consensus, 100 + (i % 2), 200 + (i % 2), 0.55, 3_000 + i);
  }
  observeDual(consensus, 250, 350, 0.55, 3_100);
  observeDual(consensus, 251, 351, 0.55, 3_101);
  const shifted = consensus.peek('node');
  assert.strictEqual(shifted.routeChange.changes, 1);
  assert.strictEqual(shifted.routeChange.lastDirection, 'up');
  assert.strictEqual(shifted.samples, 1);

  const delayedConsensus = new SmartSelectionModel();
  for (let i = 0; i < 12; i++) {
    observeDual(
      delayedConsensus,
      100 + (i % 2),
      200 + (i % 2),
      0.55,
      4_000 + i
    );
  }
  for (let i = 0; i < 2; i++) {
    delayedConsensus.observe({
      name: 'node',
      delay: 250,
      primaryDelay: 250 + i,
      secondaryDelay: 200,
      primaryFresh: true,
      secondaryFresh: false,
      primaryWeight: 1,
      secondaryWeight: 0,
    }, 4_100 + i);
  }
  const delayedAt = 4_101 + 3 * 60_000 + 1;
  observeDual(delayedConsensus, 250, 350, 0.55, delayedAt);
  observeDual(delayedConsensus, 251, 351, 0.55, delayedAt + 1);
  assert.strictEqual(delayedConsensus.peek('node').routeChange.changes, 1);
});

test('Smart route changes reset only the shifted node and preserve its selection', () => {
  const model = new SmartSelectionModel({
    minDwellMs: 0,
    switchConfirmRounds: 1,
  });
  model.choose({
    contextKey: 'route-change-up',
    names: ['target', 'other'],
    current: 'target',
    now: 1_000,
    measurements: [
      { name: 'target', delay: 100 },
      { name: 'other', delay: 160 },
    ],
  });
  for (let i = 0; i < 12; i++) {
    model.observe({ name: 'target', delay: 100 + (i % 2) }, 1_010 + i);
    model.observe({ name: 'other', delay: 160 + (i % 2) }, 1_010 + i);
  }
  model.observe({ name: 'target', delay: null }, 1_030);
  model.observeConnection({ name: 'target', kind: 'softFail' }, 1_031);
  model.observeDisplayDelay('target', 99, 1_032);
  const untouched = model.peek('other');

  model.observe({ name: 'target', delay: 250 }, 1_040);
  model.observe({ name: 'target', delay: 251 }, 1_041);
  const shifted = model.peek('target');
  assert.strictEqual(shifted.routeChange.changes, 1);
  assert.strictEqual(shifted.routeChange.lastDirection, 'up');
  assert.strictEqual(shifted.samples, 1);
  assert.ok(shifted.ewma >= 250, String(shifted.ewma));
  assert.strictEqual(shifted.failureRate, 0);
  assert.strictEqual(shifted.softFails, 0);
  assert.strictEqual(shifted.healthUnavailable, false);
  assert.strictEqual(shifted.displayDelay, null);
  assert.strictEqual(model.snapshot().selected, 'target');
  assert.deepStrictEqual(model.peek('other'), untouched);

  const falling = new SmartSelectionModel();
  let now = 2_000;
  for (let i = 0; i < 12; i++) {
    falling.observe({ name: 'node', delay: 300 + (i % 2) }, now++);
  }
  falling.observe({ name: 'node', delay: 100 }, now++);
  falling.observe({ name: 'node', delay: 101 }, now++);
  const down = falling.peek('node');
  assert.strictEqual(down.routeChange.changes, 1);
  assert.strictEqual(down.routeChange.lastDirection, 'down');
  assert.ok(down.ewma < 110, String(down.ewma));
});

test('Smart route-change state is bounded and cannot mutate inactive network history', () => {
  const model = new SmartSelectionModel({
    sampleHalfLifeMs: 24 * 60 * 60_000,
    failureHalfLifeMs: 24 * 60 * 60_000,
  });
  model.clear('route-network');
  model.setNetworkKey('wifi-a', 1_000);
  for (let i = 0; i < 12; i++) {
    model.observe({ name: 'node', delay: 80 + (i % 2) }, 1_000 + i);
  }
  model.setNetworkKey('wifi-b', 2_000);
  const cachedBefore = model.snapshot().networkContexts.get('wifi-a').nodes.get('node');
  model.observe({ name: 'node', delay: 300 }, 2_001);
  model.observe({ name: 'node', delay: 301 }, 2_002);
  const cachedAfter = model.snapshot().networkContexts.get('wifi-a').nodes.get('node');
  assert.deepStrictEqual(cachedAfter, cachedBefore);
  assert.strictEqual(model.peek('node').routeChange.lastDirection, 'up');

  const bounded = new SmartSelectionModel();
  for (let i = 0; i < 10_000; i++) {
    bounded.observe({ name: 'node', delay: 90 + (i % 3) }, 3_000 + i);
  }
  const detector = bounded.peek('node').routeChange;
  assert.strictEqual(Object.keys(detector).length, 13);
  const pending = [detector];
  while (pending.length) {
    const value = pending.pop();
    assert.ok(!Array.isArray(value));
    for (const child of Object.values(value || {})) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  assert.ok(detector.count <= 1_000_000);
  assert.strictEqual(bounded.snapshot().nodes.size, 1);
});

test('Smart keeps TCP, UDP, handshake, and first-byte health independent', () => {
  const model = new SmartSelectionModel();
  model.observe({ name: 'node', delay: 60 }, 1_000);
  model.observeConnection({ name: 'node', kind: 'dialSuccess', signal: 'tcp' }, 1_001);
  model.observeConnection({ name: 'node', kind: 'dialSuccess', phase: 'handshake' }, 1_002);
  model.observeConnection({ name: 'node', kind: 'success', signal: 'firstByte' }, 1_003);
  model.observeConnection({ name: 'node', kind: 'dialFailure', network: 'udp' }, 1_004);
  let state = model.peek('node');
  assert.strictEqual(state.healthSignals.tcp.failures, 0);
  assert.strictEqual(state.healthSignals.udp.failures, 1);
  assert.strictEqual(state.healthSignals.handshake.failures, 0);
  assert.strictEqual(state.healthSignals.firstByte.failures, 0);
  assert.strictEqual(state.healthUnavailable, false);
  assert.strictEqual(model.isConnectionUnavailable('node', 1_004), false);
  assert.strictEqual(model.qualities(['node'], 1_004).node.failed, false);
  assert.ok(state.connectionFailureRate < state.healthSignals.udp.failureRate);
  assert.ok(state.softFails < state.healthSignals.udp.softFails);

  model.observeConnection({ name: 'node', kind: 'softFail', phase: 'handshake' }, 1_005);
  model.observeConnection({ name: 'node', kind: 'softFail', phase: 'handshake' }, 1_006);
  state = model.peek('node');
  assert.ok(state.healthSignals.handshake.softFails > 1.99);
  assert.ok(state.healthSignals.udp.softFails > 0.99);
  assert.strictEqual(state.healthUnavailable, true);
  assert.strictEqual(model.isConnectionUnavailable('node', 1_006), true);
  model.observeConnection({ name: 'node', kind: 'dialSuccess', phase: 'handshake' }, 1_007);
  assert.strictEqual(model.peek('node').healthUnavailable, false);
  assert.strictEqual(model.isConnectionUnavailable('node', 1_007), false);
});

test('Smart first-byte failures need repetition and phase durations never mix', () => {
  const firstByte = new SmartSelectionModel();
  firstByte.observe({ name: 'node', delay: 60 }, 1_000);
  firstByte.observeConnection({
    name: 'node',
    kind: 'dialFailure',
    signal: 'first-byte',
  }, 1_001);
  assert.strictEqual(firstByte.peek('node').healthUnavailable, false);
  assert.strictEqual(firstByte.qualities(['node'], 1_001).node.failed, false);
  firstByte.observeConnection({
    name: 'node',
    kind: 'dialFailure',
    signal: 'first-byte',
  }, 1_002);
  assert.strictEqual(firstByte.peek('node').healthUnavailable, true);
  assert.strictEqual(firstByte.isConnectionUnavailable('node', 1_002), true);

  const durations = new SmartSelectionModel();
  durations.observeConnection({
    name: 'node',
    kind: 'dialSuccess',
    signal: 'tcp',
    durationMs: 100,
  }, 2_000);
  durations.observeConnection({
    name: 'node',
    kind: 'dialSuccess',
    signal: 'udp',
    durationMs: 200,
  }, 2_001);
  durations.observeConnection({
    name: 'node',
    kind: 'dialSuccess',
    signal: 'handshake',
    durationMs: 300,
  }, 2_002);
  durations.observeConnection({
    name: 'node',
    kind: 'dialSuccess',
    signal: 'first-byte',
    durationMs: 400,
  }, 2_003);
  const state = durations.peek('node');
  assert.strictEqual(state.healthSignals.tcp.durationEwma, 100);
  assert.strictEqual(state.healthSignals.udp.durationEwma, 200);
  assert.strictEqual(state.healthSignals.handshake.durationEwma, 300);
  assert.strictEqual(state.healthSignals.firstByte.durationEwma, 400);
  assert.strictEqual(state.dialEwma, 100, 'legacy TCP diagnostic must not mix phases');
  assert.strictEqual(
    state.trafficEvidence,
    0.5,
    'one detailed connection must contribute traffic evidence only once'
  );

  const recovery = new SmartSelectionModel();
  recovery.observeConnection({ name: 'node', kind: 'dialFailure', signal: 'tcp' }, 3_000);
  recovery.observeConnection({ name: 'node', kind: 'dialSuccess', signal: 'tcp' }, 3_001);
  recovery.observeConnection({ name: 'node', kind: 'dialSuccess', signal: 'tcp' }, 3_002);
  recovery.observeConnection({
    name: 'node',
    kind: 'dialFailure',
    signal: 'first-byte',
  }, 3_003);
  recovery.observeConnection({
    name: 'node',
    kind: 'dialFailure',
    signal: 'first-byte',
  }, 3_004);
  for (let i = 0; i < 6; i++) {
    recovery.observeConnection({
      name: 'node',
      kind: 'dialSuccess',
      signal: 'first-byte',
    }, 3_005 + i);
  }
  assert.ok(
    recovery.peek('node').connectionSuccesses >= 5.99,
    'an older recovered phase capped the latest phase recovery'
  );
});

test('Smart multi-signal health restores old snapshots and can shadow legacy aggregation', () => {
  const modern = new SmartSelectionModel();
  modern.observe({ name: 'node', delay: 50 }, 1_000);
  modern.observeConnection({ name: 'node', kind: 'dialFailure', signal: 'tcp' }, 1_001);
  modern.observeConnection({ name: 'node', kind: 'softFail' }, 1_002);
  assert.strictEqual(modern.peek('node').healthSignals.tcp.failures, 1);
  assert.strictEqual(modern.peek('node').healthSignals.firstByte.failures, 1);

  const snapshot = modern.snapshot();
  const roundTrip = new SmartSelectionModel();
  assert.strictEqual(roundTrip.restore(snapshot, 'health'), true);
  assert.deepStrictEqual(
    roundTrip.peek('node').healthSignals,
    modern.peek('node').healthSignals
  );

  const oldNode = { ...snapshot.nodes.get('node') };
  delete oldNode.healthSignals;
  delete oldNode.healthUnavailable;
  oldNode.connectionFailureRate = 0.5;
  oldNode.softFails = 3;
  oldNode.lastConnectionFailure = 2_000;
  const oldSnapshot = {
    ...snapshot,
    nodes: new Map([['node', oldNode]]),
  };
  const compatible = new SmartSelectionModel();
  assert.strictEqual(compatible.restore(oldSnapshot, 'health'), true);
  assert.strictEqual(compatible.peek('node').healthSignals.tcp.softFails, 3);
  assert.strictEqual(compatible.peek('node').healthUnavailable, true);

  const legacyShadow = new SmartSelectionModel({ multiSignalHealth: false });
  legacyShadow.observeConnection({
    name: 'node',
    kind: 'dialFailure',
    signal: 'udp',
  }, 3_000);
  assert.strictEqual(legacyShadow.peek('node').healthSignals.tcp.failures, 1);
  assert.strictEqual(legacyShadow.peek('node').healthSignals.udp.failures, 0);
});

test('Smart shadow replay is bounded, deterministic, and strips unrelated connection data', () => {
  const baseOptions = new SmartSelectionModel({
    minDwellMs: 0,
    switchConfirmRounds: 1,
  }).getUncalibratedOptions();
  const shadow = new SmartShadowEvaluator({
    maxContexts: 2,
    maxHistory: 16,
    maxNames: 8,
    maxMeasurements: 4,
    calibrationInterval: 100,
  });
  shadow.configure({
    contextKey: 'shadow-a',
    mode: 'balanced',
    baseOptions,
    legacyOptions: {
      routeChangeDetection: false,
      multiSignalHealth: false,
    },
  });
  for (let index = 0; index < 10; index++) {
    shadow.recordRound({
      contextKey: 'shadow-a',
      networkKey: 'network-a',
      names: ['a', 'b'],
      current: 'a',
      productionPick: 'a',
      now: 1_000 + index,
      measurements: [
        { name: 'a', delay: 80 + index % 2, endpoint: 'secret-a.example' },
        { name: 'b', delay: 110, destination: 'private-b.example' },
      ],
    });
  }
  for (let index = 0; index < 30; index++) {
    shadow.observeConnection({
      name: 'a',
      kind: 'dialSuccess',
      signal: 'tcp',
      durationMs: 10 + index,
      errorClass: 'raw private error',
      destination: 'private.example:443',
    }, 2_000 + index);
  }
  // A new round compacts the online runtime back to exactly the retained log.
  shadow.recordRound({
    contextKey: 'shadow-a',
    networkKey: 'network-a',
    names: ['a', 'b'],
    current: 'a',
    productionPick: 'a',
    now: 3_000,
    measurements: [{ name: 'a', delay: 82 }, { name: 'b', delay: 108 }],
  });

  const snapshot = shadow.snapshot();
  assert.strictEqual(snapshot.contexts.length, 1);
  assert.ok(snapshot.contexts[0].history.length <= 16);
  assert.ok(
    snapshot.contexts[0].history.filter((entry) => entry.type === 'round').length >= 10,
    'connection traffic erased the probe history'
  );
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('secret-a.example'));
  assert.ok(!serialized.includes('private-b.example'));
  assert.ok(!serialized.includes('private.example:443'));
  assert.ok(!serialized.includes('raw private error'));

  const beforeReplay = shadow.summary().variants;
  assert.deepStrictEqual(shadow.replay().variants, beforeReplay);
  const restored = new SmartShadowEvaluator({
    maxContexts: 2,
    maxHistory: 16,
    maxNames: 8,
    maxMeasurements: 4,
    calibrationInterval: 100,
  });
  assert.strictEqual(restored.restore(snapshot), true);
  restored.configure({
    contextKey: 'shadow-a',
    mode: 'balanced',
    baseOptions,
    legacyOptions: {
      routeChangeDetection: false,
      multiSignalHealth: false,
    },
  });
  assert.deepStrictEqual(restored.summary().variants, beforeReplay);

  restored.configure({ contextKey: 'shadow-b', mode: 'balanced', baseOptions });
  restored.configure({ contextKey: 'shadow-c', mode: 'balanced', baseOptions });
  assert.strictEqual(restored.snapshot().contexts.length, 2);
  assert.ok(!restored.snapshot().contexts.some((context) => context.contextKey === 'shadow-a'));
});

test('Smart shadow calibrates only after sustained counterfactual improvement', () => {
  class FakeShadowModel {
    constructor(options) {
      this.options = options;
    }
    setNetworkKey() {}
    observeConnection() {}
    choose() {
      return this.options.switchThresholdRatio <= 0.05 ? 'b' : 'a';
    }
  }
  const variantFactory = () => [
    { name: 'current', options: {}, calibration: null },
    {
      name: 'tuned',
      options: { switchThresholdRatio: 0.04 },
      calibration: { switchThresholdRatio: 0.04 },
    },
  ];
  const shadow = new SmartShadowEvaluator({
    Model: FakeShadowModel,
    variantFactory,
    minEvaluations: 4,
    calibrationInterval: 1,
    recommendationRounds: 2,
    calibrationCooldownMs: 0,
    minImprovement: 0.05,
    discount: 1,
  });
  const baseOptions = { switchThresholdRatio: 0.2 };
  shadow.configure({ contextKey: 'calibrate', mode: 'balanced', baseOptions });
  let recommendation = null;
  for (let index = 0; index < 5; index++) {
    const result = shadow.recordRound({
      contextKey: 'calibrate',
      networkKey: 'network',
      names: ['a', 'b'],
      current: 'a',
      productionPick: 'a',
      measurements: [{ name: 'a', delay: 200 }, { name: 'b', delay: 50 }],
      now: 10_000 + index,
    });
    if (index < 4) assert.strictEqual(result.calibration, null);
    recommendation = result.calibration || recommendation;
  }
  assert.ok(recommendation);
  assert.strictEqual(recommendation.variant, 'tuned');
  assert.deepStrictEqual(recommendation.patch, { switchThresholdRatio: 0.04 });

  // Reconfiguration makes the applied posture the new current baseline without
  // mutating or switching the caller's production choice.
  shadow.configure({ contextKey: 'calibrate', mode: 'balanced', baseOptions });
  assert.strictEqual(
    shadow.runtime.models.get('current').options.switchThresholdRatio,
    0.04
  );
  assert.strictEqual(shadow.summary().calibration.switchThresholdRatio, 0.04);

  const restored = new SmartShadowEvaluator({ Model: FakeShadowModel, variantFactory });
  assert.strictEqual(restored.restore(shadow.snapshot()), true);
  restored.configure({ contextKey: 'calibrate', mode: 'balanced', baseOptions });
  assert.strictEqual(
    restored.runtime.models.get('current').options.switchThresholdRatio,
    0.04
  );

  const variants = defaultVariantSpecs(new SmartSelectionModel().getUncalibratedOptions());
  const responsive = variants.find((variant) => variant.name === 'responsive');
  assert.ok(responsive.calibration.routeChangeThresholdMs > 0);
  assert.ok(responsive.calibration.routeChangeMinSamples >= 4);
  assert.ok(!Object.prototype.hasOwnProperty.call(
    responsive.calibration,
    'routeChangeDetection'
  ));
});

test('Smart region detection keeps candidate filtering deterministic and available', () => {
  const nodes = [
    { name: '🇭🇰 Hong Kong 01', server: 'hk.example.com' },
    { name: 'US02', server: 'edge.example.com' },
    { name: 'Unlabelled', server: 'edge.example.net' },
  ];
  assert.strictEqual(detectNodeRegion(nodes[0]), 'HK');
  assert.strictEqual(detectNodeRegion(nodes[1]), 'US');
  assert.strictEqual(detectNodeRegion(nodes[2]), 'ZZ');
  assert.strictEqual(detectNodeRegion({ name: 'UK-01', server: 'edge.example.uk' }), 'GB');
  assert.deepStrictEqual(normalizeSmartRegions(['us', 'US', 'ZZ', 'bad-code']), ['US', 'ZZ']);
  assert.deepStrictEqual(
    smartRegionMembers(nodes, nodes.map((node) => node.name), ['HK']),
    ['🇭🇰 Hong Kong 01']
  );
  // A stale preference after a subscription rename must not make Smart empty.
  assert.deepStrictEqual(
    smartRegionMembers(nodes, nodes.map((node) => node.name), ['JP']),
    nodes.map((node) => node.name)
  );
});

test('Smart suppresses correlated failures during a likely local outage', () => {
  const model = new SmartSelectionModel();
  const names = ['a', 'b', 'c', 'd'];
  model.choose({
    contextKey: 'outage', names, current: 'a', now: 1000,
    measurements: names.map((name, index) => ({ name, delay: 60 + index * 5 })),
  });
  model.choose({
    contextKey: 'outage', names, current: 'a', now: 2000,
    measurements: names.map((name) => ({ name, delay: null })),
  });
  for (const name of names) {
    assert.strictEqual(model.peek(name).consecutiveFailures, 0);
  }
  assert.strictEqual(model.scheduleHint(2500), 'urgent');
});

test('Smart background batches cap recovery probes', () => {
  const model = new SmartSelectionModel();
  const names = Array.from({ length: 24 }, (_, index) => `n${index}`);
  for (const name of names) model.observe({ name, delay: 80 }, 1000);
  for (const name of names.slice(0, 8)) {
    model.observe({ name, delay: null }, 2000);
    model.observe({ name, delay: null }, 2100);
  }
  const batch = selectSmartTestBatch(names, 'n20', 0, false, { model, now: 40_000 });
  const recovering = batch.candidates.filter((name) => names.slice(0, 8).includes(name));
  assert.ok(recovering.length > 0);
  assert.ok(recovering.length <= 2, recovering.join(','));
});

test('Smart bandit exploration fades as a node gains evidence', () => {
  const model = new SmartSelectionModel();
  for (let i = 0; i < 40; i++) model.observe({ name: 'mature', delay: 100 }, 1000 + i);
  model.observe({ name: 'uncertain', delay: 100 }, 2000);
  let priorities = model.probePriorities(['mature', 'uncertain'], 3000);
  assert.ok(priorities.get('uncertain') > priorities.get('mature'));
  for (let i = 0; i < 80; i++) model.observe({ name: 'uncertain', delay: 100 }, 4000 + i);
  priorities = model.probePriorities(['mature', 'uncertain'], 5000);
  assert.ok(priorities.get('mature') > priorities.get('uncertain'));
});

test('Smart node identity survives display-name changes without sharing changed endpoints', () => {
  const original = { name: 'Old name', type: 'trojan', server: 'a.example', port: 443, password: 'secret' };
  const renamed = { ...original, name: 'New name' };
  const changed = { ...renamed, server: 'b.example' };
  assert.strictEqual(nodeFingerprint(original), nodeFingerprint(renamed));
  assert.notStrictEqual(nodeFingerprint(renamed), nodeFingerprint(changed));

  const model = new SmartSelectionModel();
  const identity = nodeFingerprint(original);
  model.clear('rename');
  model.setNodeIdentities(new Map([['Old name', identity]]));
  model.choose({
    contextKey: 'rename',
    names: ['Old name'],
    current: 'Old name',
    now: 1_000,
    measurements: [{ name: 'Old name', delay: 80 }],
  });
  model.setNodeIdentities(new Map([['New name', identity]]));
  assert.strictEqual(model.peek('Old name'), null);
  assert.strictEqual(model.peek('New name').samples, 1);
  assert.strictEqual(model.snapshot().selected, 'New name');
});

test('Smart discounts old evidence and retains only a weak prior after network changes', () => {
  const model = new SmartSelectionModel({
    sampleHalfLifeMs: 60_000,
    failureHalfLifeMs: 60_000,
    networkChangeRetention: 0.25,
  });
  model.setNetworkKey('wifi-a', 1_000);
  for (let i = 0; i < 8; i++) model.observe({ name: 'node', delay: 100 }, 1_000 + i);
  const before = model.peek('node').effectiveAttempts;
  model.probePriorities(['node'], 61_007);
  const decayed = model.peek('node').effectiveAttempts;
  assert.ok(decayed < before * 0.55 && decayed > before * 0.45, String(decayed));
  model.setNetworkKey('wifi-b', 61_007);
  const retained = model.peek('node').effectiveAttempts;
  assert.ok(retained > 0 && retained < decayed * 0.3, String(retained));
  const snapshot = model.snapshot();
  snapshot.nodes.get('node').effectiveAttempts = 0;
  snapshot.nodes.get('node').effectiveSamples = 0;
  const restored = new SmartSelectionModel();
  restored.restore(snapshot, 'default');
  assert.strictEqual(restored.peek('node').effectiveAttempts, 0);
  assert.strictEqual(restored.peek('node').effectiveSamples, 0);
});

test('Smart restores bounded per-network histories and snapshots them compatibly', () => {
  const options = {
    sampleHalfLifeMs: 24 * 60 * 60_000,
    failureHalfLifeMs: 24 * 60 * 60_000,
    networkChangeRetention: 0.1,
    maxNetworkContexts: 3,
    maxNetworkContextNodes: 2,
  };
  const model = new SmartSelectionModel(options);
  model.clear('network-history');
  model.setNodeIdentities(new Map([['node', 'stable-node-identity']]));
  model.setNetworkKey('wifi-a', 1_000);
  for (let i = 0; i < 8; i++) {
    model.observe({ name: 'node', delay: 80 }, 1_000 + i);
  }
  model.choose({
    contextKey: 'network-history',
    names: ['node'],
    current: 'node',
    now: 1_100,
    measurements: [],
  });

  model.setNetworkKey('wifi-b', 2_000);
  for (let i = 0; i < 12; i++) {
    model.observe({ name: 'node', delay: 300 }, 2_000 + i);
  }
  assert.ok(model.peek('node').ewma > 250);
  model.setNetworkKey('wifi-a', 3_000);
  assert.ok(model.peek('node').ewma < 100, String(model.peek('node').ewma));

  const persisted = model.snapshot();
  assert.ok(persisted.networkContexts instanceof Map);
  const restored = new SmartSelectionModel(options);
  assert.strictEqual(restored.restore(persisted, 'network-history'), true);
  restored.setNodeIdentities(new Map([['renamed-node', 'stable-node-identity']]));
  restored.setNetworkKey('wifi-b', 4_000);
  assert.strictEqual(restored.peek('node'), null);
  assert.ok(
    restored.peek('renamed-node').ewma > 250,
    String(restored.peek('renamed-node').ewma)
  );

  // Inactive contexts and their node maps remain bounded (active is the third).
  restored.observe({ name: 'extra-a', delay: 120 }, 4_100);
  restored.observe({ name: 'extra-b', delay: 130 }, 4_101);
  restored.observe({ name: 'extra-c', delay: 140 }, 4_102);
  restored.setNetworkKey('wifi-c', 5_000);
  restored.setNetworkKey('wifi-d', 6_000);
  const bounded = restored.snapshot();
  assert.ok(bounded.networkContexts.size <= 2);
  for (const entry of bounded.networkContexts.values()) {
    assert.ok(entry.nodes.size <= 2);
  }

  // Snapshots from older versions without networkContexts still restore.
  const legacy = { ...persisted };
  delete legacy.networkContexts;
  const compatible = new SmartSelectionModel(options);
  assert.strictEqual(compatible.restore(legacy, 'network-history'), true);
  assert.ok(compatible.peek('node'));
});

test('Smart uses UCB-V only for probes and never selects an arm for uncertainty alone', () => {
  const model = new SmartSelectionModel({
    minDwellMs: 0,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 1,
  });
  for (let i = 0; i < 20; i++) model.observe({ name: 'proven', delay: 100 }, 1_000 + i);
  model.observe({ name: 'uncertain', delay: 100 }, 2_000);
  const priorities = model.probePriorities(['proven', 'uncertain'], 3_000);
  assert.ok(priorities.get('uncertain') > priorities.get('proven'));
  assert.strictEqual(model.choose({
    contextKey: 'probe-vs-select',
    names: ['proven', 'uncertain'],
    current: 'proven',
    now: 4_000,
    measurements: [],
  }), 'proven');
});

test('Smart UCB-V assigns more probe confidence to noisy equal-sample nodes', () => {
  const model = new SmartSelectionModel();
  for (let i = 0; i < 12; i++) {
    model.observe({ name: 'steady', delay: 100 }, 1_000 + i);
    model.observe({ name: 'noisy', delay: i % 2 ? 160 : 40 }, 1_000 + i);
  }
  const priorities = model.probePriorities(['steady', 'noisy'], 3_000);
  assert.ok(priorities.get('noisy') > priorities.get('steady'));
});

test('real traffic reduces probe uncertainty without directly discounting selection cost', () => {
  const options = {
    minDwellMs: 0,
    switchThresholdMs: 0,
    switchThresholdRatio: 0,
    switchConfirmRounds: 1,
  };
  const model = new SmartSelectionModel(options);
  for (let i = 0; i < 6; i++) {
    model.observe({ name: 'a', delay: 80 }, 1_000 + i);
    model.observe({ name: 'b', delay: 100 }, 1_000 + i);
  }
  const before = model.probePriorities(['a', 'b'], 2_000).get('b');
  model.observeConnection({ name: 'b', kind: 'traffic', bytes: 200_000 }, 2_100);
  const after = model.probePriorities(['a', 'b'], 2_200).get('b');
  assert.ok(after < before);
  assert.strictEqual(model.choose({
    contextKey: 'traffic-evidence',
    names: ['a', 'b'],
    current: 'a',
    now: 3_000,
    measurements: [],
  }), 'a');
});

test('Smart cohort penalties adapt robustly without an outlier dominating scale', () => {
  const options = new SmartSelectionModel().options;
  const local = computeCohortCostProfile([
    { ewma: 40, cooldownUntil: 0, consecutiveFailures: 0 },
    { ewma: 45, cooldownUntil: 0, consecutiveFailures: 0 },
    { ewma: 50, cooldownUntil: 0, consecutiveFailures: 0 },
    { ewma: 2_000, cooldownUntil: 0, consecutiveFailures: 0 },
  ], options, 1_000);
  const longHaul = computeCohortCostProfile([
    { ewma: 350, cooldownUntil: 0, consecutiveFailures: 0 },
    { ewma: 400, cooldownUntil: 0, consecutiveFailures: 0 },
    { ewma: 450, cooldownUntil: 0, consecutiveFailures: 0 },
  ], options, 1_000);
  assert.ok(local.median < 100);
  assert.ok(local.spread < 100);
  assert.ok(longHaul.failurePenalty > local.failurePenalty);
});

test('managed Auto override pin is measured even when outside the rotating batch', async () => {
  let putName = null;
  let now = 'n1';
  let override = null;
  const names = Array.from({ length: 30 }, (_, i) => `n${i + 1}`);
  const measured = [];
  const managed = new ManagedAutoSelection({
    appGroup: '🚀 Proxy',
    autoGroup: '♻️ Auto',
    clashApi: async (method, apiPath, body) => {
      if (method === 'PUT') {
        putName = body && body.name;
        now = putName;
        return {};
      }
      return { now, all: names };
    },
    activeIntervalMs: 60_000,
    idleIntervalMs: 240_000,
    isRunning: () => true,
    selectBatch: selectAutoTestBatch,
    resolveOverride: (names) => (override && names.includes(override) ? override : null),
    testDelay: async (name) => {
      measured.push(name);
      return name === 'n2' ? 10 : 100;
    },
  });
  await managed.refresh({ force: false });
  assert.strictEqual(putName, 'n2');
  assert.strictEqual(now, 'n2');
  override = 'n30';
  putName = null;
  measured.length = 0;
  await managed.refresh({ force: false });
  assert.ok(measured.includes('n30'));
  assert.strictEqual(putName, 'n30');
  assert.strictEqual(now, 'n30');
  managed.stop();
});

test('managed Smart applies a preferred node once instead of chasing kernel now', async () => {
  let puts = 0;
  const managed = new ManagedAutoSelection({
    appGroup: '🚀 Proxy',
    autoGroup: '🧠 Smart',
    authoritativePreferred: true,
    clashApi: async (method) => {
      if (method === 'PUT') {
        puts++;
        return {};
      }
      return { now: 'kernel-failover', all: ['preferred', 'kernel-failover'] };
    },
    isRunning: () => true,
    selectBatch: () => ({ candidates: ['preferred'], nextCursor: 0 }),
    testDelay: async () => 30,
    selectCandidate: () => 'preferred',
  });
  await managed.refresh();
  await managed.refresh();
  assert.strictEqual(puts, 1);
  assert.strictEqual(managed.getPreferred(), 'preferred');
  managed.stop();
});

test('managed selection discards an in-flight result after stop', async () => {
  let releaseProbe;
  let signalProbe;
  let selected = 0;
  let put = 0;
  const entered = new Promise((resolve) => { signalProbe = resolve; });
  const gate = new Promise((resolve) => { releaseProbe = resolve; });
  const managed = new ManagedAutoSelection({
    appGroup: '🚀 Proxy',
    autoGroup: '🧠 Smart',
    clashApi: async (method) => {
      if (method === 'PUT') put++;
      return { now: 'n1', all: ['n1'] };
    },
    isRunning: () => true,
    selectBatch: selectAutoTestBatch,
    testDelay: async () => {
      signalProbe();
      await gate;
      return 10;
    },
    selectCandidate: () => {
      selected++;
      return 'n1';
    },
  });
  const run = managed.refresh();
  await entered;
  managed.stop();
  releaseProbe();
  assert.strictEqual(await run, null);
  assert.strictEqual(selected, 0);
  assert.strictEqual(put, 0);
});

// i18n.js is a browser IIFE; evaluate it with a stub window to get the DICT.
function loadDict() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf-8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.i18n.DICT;
}

test('zh and en dictionaries declare exactly the same keys', () => {
  const DICT = loadDict();
  const zh = Object.keys(DICT.zh).sort();
  const en = Object.keys(DICT.en).sort();
  const missingInEn = zh.filter((k) => !en.includes(k));
  const missingInZh = en.filter((k) => !zh.includes(k));
  assert.deepStrictEqual(missingInEn, [], 'keys missing in en');
  assert.deepStrictEqual(missingInZh, [], 'keys missing in zh');
});

test('every data-i18n key used in index.html exists in the dictionary', () => {
  const DICT = loadDict();
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  const used = [...html.matchAll(/data-i18n(?:-(?:ph|aria-label|title))?="([^"]+)"/g)].map((m) => m[1]);
  const missing = used.filter((k) => !(k in DICT.zh));
  assert.deepStrictEqual([...new Set(missing)], [], 'HTML references undefined i18n keys');
});

test('native dialog renderers reference only declared i18n keys', () => {
  const DICT = loadDict();
  const dialogDir = path.join(__dirname, '..', 'src', 'renderer', 'dialog');
  const code = ['editors.js', 'system.js', 'toolbox.js']
    .map((file) => fs.readFileSync(path.join(dialogDir, file), 'utf-8'))
    .join('\n');
  const literalKeys = [...code.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]).filter((key) => !key.endsWith('.'));
  const dynamicKeys = [
    'toolbox.confidence.exact', 'toolbox.confidence.estimated',
    'toolbox.diag.coreInstalled', 'toolbox.diag.coreRunning', 'toolbox.diag.mixedPort',
    'toolbox.diag.apiPort', 'toolbox.diag.clashApi', 'toolbox.diag.systemProxy',
    'toolbox.diag.tun', 'toolbox.diag.dns', 'toolbox.diag.directIp',
    'toolbox.diag.proxyIp', 'toolbox.diag.egressCompare',
    'toolbox.dns.system', 'toolbox.dns.local', 'toolbox.dns.remote',
    'toolbox.dnsAssessment.no-anomaly', 'toolbox.dnsAssessment.suspicious-private',
    'toolbox.dnsAssessment.divergent', 'toolbox.dnsAssessment.inconclusive',
    'toolbox.portRole.mixed', 'toolbox.portRole.clash-api', 'toolbox.portRole.custom',
    'toolbox.routeSource.live', 'toolbox.routeSource.generated',
    'toolbox.status.pass', 'toolbox.status.warn', 'toolbox.status.fail',
    'toolbox.status.skip', 'toolbox.status.missing',
    'toolbox.via.system', 'toolbox.via.direct', 'toolbox.via.proxy',
  ];
  const missing = [...new Set([...literalKeys, ...dynamicKeys])].filter((key) => !(key in DICT.zh));
  assert.deepStrictEqual(missing, [], 'toolbox references undefined i18n keys');
});

test('zh labels keep config terminology', () => {
  const { zh } = loadDict();
  assert.strictEqual(zh['subs.title'], '📡 配置');
  assert.strictEqual(zh['subs.add'], '添加配置');
  assert.strictEqual(zh['subs.listTitle'], '配置列表');
  assert.strictEqual(zh['rulegroups.section'], '策略组');
  assert.strictEqual(zh['customrs.title'], '远程规则');
  assert.strictEqual(zh['settings.manageGeo'], '管理');
  assert.strictEqual(zh['customrs.targetProxy'], '代理');
  assert.strictEqual(zh['customrs.targetReject'], '拒绝');
  assert.strictEqual(zh['rulegroups.targetSource'], '选择出站');
  assert.strictEqual(zh['subs.userAgent'], '请求 UA');
  assert.strictEqual(zh['subs.userAgentAuto'], '自动（跟随内核）');
  assert.strictEqual(zh['subs.userAgentTag'], 'UA {0}');
  assert.strictEqual(zh['subs.sourceFormat'], '来源 {0}');
  assert.strictEqual(zh['subs.formatFlow'], '来源 {0} → {1}');
});

test('static HTML fallbacks keep config terminology', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  for (const stale of ['机场订阅', '添加订阅', '订阅列表', '走代理', '拦截', '路由用的', '规则集链接', '自定义规则集']) {
    assert.ok(!html.includes(stale), `stale fallback text: ${stale}`);
  }
  for (const stale of ['静默启动（', '桌面通知（', '硬件加速（', '启用 IPv6（']) {
    assert.ok(!html.includes(stale), `settings fallback still has parenthetical hint: ${stale}`);
  }
  assert.ok(html.includes('id="subUserAgent"'), 'add-config User-Agent selector is missing');
  assert.ok(html.includes('id="editUserAgent"'), 'edit-config User-Agent selector is missing');
  assert.ok(html.includes('自动（跟随内核）'), 'automatic download format does not explain core following');
});

test('config list distinguishes downloaded source format from runtime core', () => {
  const subscriptions = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'subs.js'),
    'utf-8'
  );
  const main = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'main.js'),
    'utf-8'
  );
  assert.ok(subscriptions.includes("t('subs.sourceFormat', sourceFormat)"));
  assert.ok(subscriptions.includes("t('subs.formatFlow', sourceFormat, runtimeFormat)"));
  assert.ok(subscriptions.includes('sourceIsNative'));
  assert.ok(subscriptions.includes("coreType === 'mihomo' ? 'Mihomo' : 'sing-box'"));
  assert.ok(main.includes('subscriptionTargetChanged'), 'core switches leave the displayed runtime target stale');
});

test('rule-set page is folded into rules and native geodata management', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8');
  const dialogs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'dialog', 'system.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'rules.js'), 'utf-8');
  assert.ok(!html.includes('data-tab="ruleset"'), 'standalone rule-set nav is still present');
  assert.ok(!html.includes('id="tab-ruleset"'), 'standalone rule-set tab is still present');
  assert.ok(!html.includes('id="crsFormat"'), 'remote rules should auto-detect format when adding');
  assert.ok(!html.includes('id="crsEditFormat"'), 'remote rules should auto-detect format when editing');
  assert.ok(!html.includes('QuantumultX'), 'unsupported remote rule format option is still present');
  assert.ok(!html.includes('Surge'), 'unsupported remote rule format option is still present');
  assert.ok(!html.includes('Loon'), 'unsupported remote rule format option is still present');
  assert.ok(html.indexOf('id="ruleGroupList"') < html.indexOf('id="lrList"'), 'policy groups should be the first rules section');
  assert.ok(html.indexOf('id="crsList"') > html.indexOf('id="lrList"'), 'remote rules should follow local rules');
  assert.ok(html.includes('id="geoManageBtn"'), 'GeoData management launcher is missing');
  assert.ok(dialogs.includes("Dialog.register('geodata'"), 'native GeoData dialog is missing');
  assert.ok(rules.includes('const sourceTargets = new Set(info.sourceTargets || [])'));
  assert.ok(rules.includes("if (sel.value === 'source') delete next[g]"));
});

console.log('\nRenderer modules:');

// The renderer is split into classic scripts sharing the window.App namespace
// (no bundler), so nothing catches a missing file or a typoed App.* member
// until runtime. These checks stand in for that missing link step.

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const indexHtml = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf-8');
const scriptSrcs = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const dialogHtml = fs.readFileSync(path.join(rendererDir, 'dialog.html'), 'utf-8');
const dialogScriptSrcs = [...dialogHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const SHARED_STYLE_SRCS = [
  'style.css',
  'styles/surfaces.css',
  'styles/controls.css',
  'styles/lists.css',
  'styles/workspaces.css',
  'styles/tools.css',
  'styles/motion.css',
];
function stylesheetRefs(html) {
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
    .map((match) => match[1].split('?')[0]);
}
function readRendererCss() {
  return SHARED_STYLE_SRCS
    .map((src) => fs.readFileSync(path.join(rendererDir, src), 'utf-8'))
    .join('\n');
}
const mainEntry = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
const dialogEntry = fs.readFileSync(path.join(rendererDir, 'dialog', 'main.js'), 'utf-8');
function dynamicScriptRefs(code) {
  return [...code.matchAll(/['"]((?:js|dialog)\/[a-z0-9-]+\.js)['"]/gi)].map((match) => match[1]);
}
const dynamicScriptSrcs = [...dynamicScriptRefs(mainEntry), ...dynamicScriptRefs(dialogEntry)];
const allRendererScriptSrcs = [...new Set([...scriptSrcs, ...dialogScriptSrcs, ...dynamicScriptSrcs])];

test('every main and dialog script points to an existing file', () => {
  assert.ok(scriptSrcs.length > 0 && dialogScriptSrcs.length > 0, 'no script tags found');
  for (const src of allRendererScriptSrcs) {
    assert.ok(fs.existsSync(path.join(rendererDir, src)), `missing script: ${src}`);
  }
});

test('shared stylesheets exist and preserve their cascade order', () => {
  const mainStyles = stylesheetRefs(indexHtml);
  const dialogStyles = stylesheetRefs(dialogHtml);
  assert.deepStrictEqual(mainStyles, SHARED_STYLE_SRCS);
  assert.deepStrictEqual(dialogStyles.slice(0, SHARED_STYLE_SRCS.length), SHARED_STYLE_SRCS);
  assert.strictEqual(dialogStyles[dialogStyles.length - 1], 'dialog/dialog.css');
  for (const src of [...SHARED_STYLE_SRCS, 'dialog/dialog.css']) {
    assert.ok(fs.existsSync(path.join(rendererDir, src)), `missing stylesheet: ${src}`);
  }
  assert.ok(!readRendererCss().includes('@import'), 'shared CSS should load in parallel without @import');
});

test('shared CSS stays split into reviewable modules', () => {
  const lineCounts = Object.fromEntries(SHARED_STYLE_SRCS.map((src) => {
    const css = fs.readFileSync(path.join(rendererDir, src), 'utf-8');
    return [src, css.split('\n').length];
  }));
  assert.ok(lineCounts['style.css'] <= 1000, 'foundation stylesheet has grown beyond 1000 lines');
  for (const [src, lines] of Object.entries(lineCounts).filter(([src]) => src !== 'style.css')) {
    assert.ok(lines <= 600, `${src} has grown beyond 600 lines`);
  }
});

test('module load order: util.js first of the js/ modules, main.js last', () => {
  const mods = scriptSrcs.filter((s) => s.startsWith('js/'));
  assert.strictEqual(mods[0], 'js/util.js');
  assert.strictEqual(mods[mods.length - 1], 'js/main.js');
});

test('feature renderers and dialog workflows load only when requested', () => {
  const mainFeatures = [
    'js/subs.js', 'js/nodes.js', 'js/rules.js', 'js/rulesets.js', 'js/conns.js',
    'js/logs.js', 'js/settings.js', 'js/tools.js', 'js/toolbox.js',
  ];
  for (const src of mainFeatures) {
    assert.ok(dynamicScriptSrcs.includes(src), `missing lazy main module: ${src}`);
    assert.ok(!scriptSrcs.includes(src), `feature module is still eager: ${src}`);
  }
  for (const src of ['dialog/editors.js', 'dialog/system.js', 'dialog/toolbox.js']) {
    assert.ok(dynamicScriptSrcs.includes(src), `missing lazy dialog module: ${src}`);
    assert.ok(!dialogScriptSrcs.includes(src), `dialog feature module is still eager: ${src}`);
  }
  assert.ok(mainEntry.includes('App.loadScripts(TAB_MODULES[tab])'));
  assert.ok(dialogEntry.includes('await App.loadScript(module)'));
});

test('frameless window exposes Mica-safe custom desktop controls', () => {
  const windowMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf-8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const controls = fs.readFileSync(path.join(rendererDir, 'js', 'window.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(windowMain.includes('frame: false'));
  assert.ok(windowMain.includes("titleBarStyle: 'hidden'"));
  assert.ok(windowMain.includes("backgroundMaterial: 'mica'"));
  assert.ok(windowMain.includes("return '#00000000'"));
  assert.ok(windowMain.includes("setBackgroundMaterial('mica')"));
  assert.ok(windowMain.includes('spellcheck: false'));
  for (const id of ['windowMinimize', 'windowMaximize', 'windowClose']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `missing custom control: ${id}`);
  }
  for (const method of ['minimizeWindow', 'toggleMaximizeWindow', 'isWindowMaximized', 'closeWindow']) {
    assert.ok(preload.includes(`${method}:`), `missing window API: ${method}`);
    assert.ok(controls.includes(`api.${method}`), `custom controls do not call ${method}`);
  }
  assert.ok(css.includes('-webkit-app-region: drag'));
  assert.ok(css.includes('-webkit-app-region: no-drag'));
  assert.ok(css.includes('background-color: transparent !important'));
  assert.ok(css.includes('"Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif'));
  assert.ok(css.includes('-webkit-user-drag: none'));
  assert.ok(css.includes('*::-webkit-scrollbar'));
  assert.ok(css.includes('--motion-standard: 200ms cubic-bezier(0.4, 0, 0.2, 1)'));
});

test('primary navigation follows the vertical tabs keyboard pattern', () => {
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  assert.ok(indexHtml.includes('role="tablist"'));
  assert.ok(indexHtml.includes('aria-orientation="vertical"'));
  for (const tab of ['dashboard', 'subs', 'nodes', 'rules', 'conns', 'tools', 'logs', 'settings']) {
    assert.ok(indexHtml.includes(`id="nav-${tab}"`), `missing tab id: ${tab}`);
    assert.ok(indexHtml.includes(`aria-controls="tab-${tab}"`), `missing tab target: ${tab}`);
    assert.ok(indexHtml.includes(`aria-labelledby="nav-${tab}"`), `missing panel label: ${tab}`);
  }
  assert.ok(main.includes("button.setAttribute('aria-selected', String(active))"));
  assert.ok(main.includes('button.tabIndex = active ? 0 : -1'));
  assert.ok(main.includes('element.hidden = !active'));
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.ok(main.includes(`'${key}'`));
});

test('enhanced selects expose a complete combobox keyboard model', () => {
  const select = fs.readFileSync(path.join(rendererDir, 'js', 'select.js'), 'utf-8');
  assert.ok(select.includes("document.createElement('button')"));
  assert.ok(select.includes("setAttribute('role', 'combobox')"));
  assert.ok(select.includes("setAttribute('aria-expanded', 'false')"));
  assert.ok(select.includes("setAttribute('aria-controls', menuId)"));
  assert.ok(select.includes("menu.setAttribute('role', 'listbox')"));
  assert.ok(select.includes("item.setAttribute('role', 'option')"));
  assert.ok(select.includes("root.setAttribute('aria-activedescendant'"));
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape']) {
    assert.ok(select.includes(`'${key}'`), `missing select keyboard action: ${key}`);
  }
  assert.ok(select.includes('event.stopImmediatePropagation()'));
});

test('static form controls expose labels instead of relying on placeholders alone', () => {
  const controls = [...indexHtml.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((match) => match[0]);
  for (const control of controls) {
    const id = (control.match(/id="([^"]+)"/) || [])[1];
    const position = indexHtml.indexOf(control);
    const wrapped = position >= 0 && indexHtml.lastIndexOf('<label', position) > indexHtml.lastIndexOf('</label>', position);
    const named = /aria-label|aria-labelledby|data-i18n-ph/.test(control) ||
      (id && indexHtml.includes(`for="${id}"`)) || wrapped;
    assert.ok(named, `form control lacks an accessible name: ${control}`);
  }
});

test('dialogs trap focus and announce dynamic operations without losing Mica', () => {
  const common = fs.readFileSync(path.join(rendererDir, 'dialog', 'common.js'), 'utf-8');
  const dialogMain = fs.readFileSync(path.join(rendererDir, 'dialog', 'main.js'), 'utf-8');
  const util = fs.readFileSync(path.join(rendererDir, 'js', 'util.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(dialogHtml.includes('role="dialog"'));
  assert.ok(dialogHtml.includes('aria-modal="true"'));
  assert.ok(dialogHtml.includes('aria-labelledby="dialogTitle"'));
  assert.ok(common.includes('function focusableElements('));
  assert.ok(dialogHtml.includes('class="native-dialog-window" role="dialog" aria-modal="true" aria-labelledby="dialogTitle" aria-busy="true" tabindex="-1"'));
  assert.ok(common.includes('focusInitial(dialogWindow)'));
  assert.ok(dialogMain.includes("event.key !== 'Tab'"));
  assert.ok(dialogMain.includes('document.activeElement === last'));
  assert.ok(common.includes("setAttribute('aria-busy', 'true')"));
  assert.ok(util.includes('App.setProgress = function setProgress'));
  assert.ok(indexHtml.includes('role="progressbar"'));
  assert.ok(indexHtml.includes('aria-live="polite"'));
  assert.ok(css.includes('@media (forced-colors: active)'));
  assert.ok(css.includes('@media (prefers-reduced-transparency: reduce)'));
  assert.ok(css.includes('animation: statusPulse 2.4s ease-in-out infinite'));
});

test('all secondary workflows are registered in the native dialog host', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'dialog-window.js'), 'utf-8');
  const renderers = ['editors.js', 'system.js', 'toolbox.js']
    .map((file) => fs.readFileSync(path.join(rendererDir, 'dialog', file), 'utf-8'))
    .join('\n');
  const types = [
    'local-rule', 'remote-rule', 'raw-profile', 'convert', 'core', 'geodata', 'uwp',
    'route', 'diagnostics', 'config-check', 'ports', 'backup', 'dns',
  ];
  for (const type of types) {
    assert.ok(renderers.includes(`Dialog.register('${type}'`), `missing renderer for ${type}`);
    const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(new RegExp(`(?:'${escaped}'|${escaped})\\s*:`).test(host), `missing host allowlist entry for ${type}`);
  }
  assert.ok(!indexHtml.includes('class="modal hidden"'));
  assert.ok(dialogHtml.includes('class="native-dialog-window"'));
});

test('all six diagnostic tools launch through the native dialog host', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const dialogTools = fs.readFileSync(path.join(rendererDir, 'dialog', 'toolbox.js'), 'utf-8');
  const tools = [
    ['route', 'route', 'inspectRoute'],
    ['diag', 'diagnostics', 'runNetworkDiagnostics'],
    ['configCheck', 'config-check', 'checkAllConfigs'],
    ['port', 'ports', 'inspectPorts'],
    ['backup', 'backup', 'exportBackup'],
    ['dns', 'dns', 'compareDns'],
  ];
  for (const [id, type, method] of tools) {
    assert.ok(indexHtml.includes(`id="${id}Open"`), `missing ${id} launcher`);
    assert.ok(dialogTools.includes(`Dialog.register('${type}'`), `missing ${type} native dialog`);
    assert.ok(preload.includes(`${method}:`), `missing ${method} preload method`);
  }
  assert.ok(preload.includes('openDialog:'));
  assert.strictEqual((dialogTools.match(/dialog-commandbar/g) || []).length, tools.length);
});

test('conversion UI exposes both output directions without decorative emoji', () => {
  const { zh, en } = loadDict();
  const editorDialogs = fs.readFileSync(path.join(rendererDir, 'dialog', 'editors.js'), 'utf-8');
  for (const target of ['auto', 'sing-box', 'clash']) {
    assert.ok(editorDialogs.includes(`data-convert-target="${target}"`), `missing conversion target: ${target}`);
  }
  assert.ok(!/[🚀♻️🔄]/u.test(zh['convert.title']));
  assert.ok(!/[🚀♻️🔄]/u.test(en['convert.title']));
  assert.strictEqual(zh['convert.targetSingbox'], 'Sing-Box');
  assert.strictEqual(en['convert.targetSingbox'], 'Sing-Box');
  assert.ok(editorDialogs.includes('content: output'), 'save must import the converted output');
  const css = readRendererCss();
  const dialogCss = fs.readFileSync(path.join(rendererDir, 'dialog', 'dialog.css'), 'utf-8');
  assert.ok(css.includes('grid-template-columns: repeat(3, minmax(72px, auto))'));
  assert.ok(css.includes('width: auto'));
  assert.ok(dialogCss.includes('.dialog-convert-input'));
  assert.ok(dialogCss.includes('.dialog-convert-output'));
});

test('UWP list scrolls independently while its actions stay fixed', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'dialog', 'dialog.css'), 'utf-8');
  const systemDialogs = fs.readFileSync(path.join(rendererDir, 'dialog', 'system.js'), 'utf-8');
  assert.ok(systemDialogs.includes("Dialog.register('uwp'"));
  const list = css.slice(css.indexOf('.dialog-uwp-list'), css.indexOf('.dialog-tool-body'));
  assert.ok(list.includes('overflow: auto'));
  assert.ok(list.includes('flex: 1'));
  assert.ok(css.includes('.dialog-footer'));
});

test('tray uses app-derived stopped and running icon assets', () => {
  const trayCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tray.js'), 'utf-8');
  assert.ok(trayCode.includes("nativeImage.createFromPath"));
  assert.ok(trayCode.includes('state.tray.setImage'));
  assert.ok(!trayCode.includes('TRAY_ICON_DATAURL'));
  for (const name of ['tray-stopped.png', 'tray-running.png']) {
    const png = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assets', name));
    assert.strictEqual(png.slice(1, 4).toString('ascii'), 'PNG');
    assert.strictEqual(png.readUInt32BE(16), 32);
    assert.strictEqual(png.readUInt32BE(20), 32);
  }
  assert.notDeepStrictEqual(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assets', 'tray-stopped.png')),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assets', 'tray-running.png'))
  );
});

// util.js is a browser IIFE; evaluate it with a stub window to reach App.*.
function loadRendererUtil() {
  const src = fs.readFileSync(path.join(rendererDir, 'js', 'util.js'), 'utf-8');
  const sandbox = { window: { i18n: { getLang: () => 'zh' } } };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.App;
}

test('escapeHtml neutralizes every HTML metacharacter', () => {
  const App = loadRendererUtil();
  assert.strictEqual(
    App.escapeHtml(`<img src=x onerror="alert('xss')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;'
  );
  // No raw metacharacter may survive, whatever the input.
  assert.ok(!/[<>"']/.test(App.escapeHtml('<script>"\'</script>')));
});

test('subscription renderer signature tracks metadata-only changes', () => {
  const App = loadRendererUtil();
  const subscriptions = [{
    id: 'airport-a',
    name: 'Airport A',
    updatedAt: 100,
    nodeCount: 2,
    autoUpdateMinutes: 0,
    updateViaProxy: false,
    userAgentMode: 'auto',
    userInfo: { upload: 1, download: 2, total: 10, expire: 20 },
  }];
  const before = App.subscriptionStateSignature(subscriptions, 'airport-a');
  for (const patch of [
    { autoUpdateMinutes: 60 },
    { updateViaProxy: true },
    { userAgentMode: 'clash' },
    { userInfo: { upload: 1, download: 3, total: 10, expire: 20 } },
  ]) {
    const changed = [{ ...subscriptions[0], ...patch }];
    assert.notStrictEqual(
      App.subscriptionStateSignature(changed, 'airport-a'),
      before,
      `subscription change was omitted from the renderer signature: ${Object.keys(patch)[0]}`
    );
  }
  assert.notStrictEqual(App.subscriptionStateSignature(subscriptions, 'airport-b'), before);
});

test('external-input fields stay HTML-escaped in the renderer templates', () => {
  // Tripwire: these values come from outside (airport profiles, the Clash
  // API, the OS) and are interpolated into innerHTML templates. If a refactor
  // drops the escaping, this fails before an XSS ships.
  const mustEscape = [
    ['js/subs.js', 'escapeHtml(sub.name)'],
    ['js/subs.js', 'escapeHtml(sub.id)'],
    ['js/dashboard.js', 'escapeHtml(s.name)'],
    ['js/nodes.js', 'escapeHtml(name)'],
    ['js/conns.js', 'escapeHtml(target)'],
    ['js/conns.js', 'escapeHtml(connectionLabel(c.rule))'],
    ['js/conns.js', 'escapeHtml(chains)'],
    ['js/rules.js', 'escapeHtml(it.payload)'],
    ['js/rules.js', 'escapeHtml(it.id)'],
    ['js/rulesets.js', 'escapeHtml(itemName)'],
    ['js/rulesets.js', 'escapeHtml(it.id)'],
    ['js/logs.js', 'escapeHtml(rest)'],
    ['dialog/system.js', 'escapeHtml(entry.name)'],
    ['dialog/toolbox.js', 'escapeHtml(check.detail'],
    ['dialog/toolbox.js', 'escapeHtml(result.source.preview)'],
    ['dialog/toolbox.js', 'escapeHtml(item.preview)'],
  ];
  for (const [file, needle] of mustEscape) {
    const code = fs.readFileSync(path.join(rendererDir, file), 'utf-8');
    assert.ok(code.includes(needle), `${file} no longer escapes: ${needle}`);
  }
});

test('renderer modules parse and every App.* member used is defined somewhere', () => {
  const assigned = new Set();
  const used = new Set();
  const modules = allRendererScriptSrcs.filter((src) => src.startsWith('js/') || src.startsWith('dialog/'));
  for (const src of modules) {
    const code = fs.readFileSync(path.join(rendererDir, src), 'utf-8');
    new vm.Script(code, { filename: src }); // throws on syntax errors
    for (const m of code.matchAll(/\bApp\.([\w$]+)\s*=(?!=)/g)) assigned.add(m[1]);
    for (const m of code.matchAll(/\bApp\.([\w$]+)/g)) used.add(m[1]);
    // Names pulled out via `const { x, y } = App;` count as used too.
    for (const m of code.matchAll(/const\s*\{([^}]+)\}\s*=\s*App\b/g)) {
      for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) used.add(name);
    }
  }
  const undefined_ = [...used].filter((n) => !assigned.has(n));
  assert.deepStrictEqual(undefined_, [], 'App members used but never assigned');
});

test('large live lists use bounded virtual windows', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const conns = fs.readFileSync(path.join(rendererDir, 'js', 'conns.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(rendererDir, 'js', 'rules.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(nodes.includes('VIRTUAL_NODE_ROW_HEIGHT'));
  assert.ok(nodes.includes('NODE_COLUMNS = 2'), 'node virtualization must remain two-column aware');
  assert.ok(nodes.includes('node-grid-window'));
  assert.ok(conns.includes('VIRTUAL_CONNECTION_ROW_HEIGHT'));
  assert.ok(conns.includes("window.addEventListener('resize'"), 'connection virtualization must follow window resizing');
  assert.ok(conns.includes("list.classList.add('is-empty')"));
  assert.ok(conns.includes("list.classList.remove('is-empty')"));
  assert.ok(rules.includes('VIRTUAL_RULE_ROW_HEIGHT'));
  for (const code of [nodes, conns, rules]) assert.ok(code.includes('virtual-spacer'));
  assert.ok(css.includes('.virtual-spacer'));
  assert.ok(css.includes('.conn-list.is-empty'));
  assert.ok(css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
  const nodeList = css.slice(css.indexOf('.node-list,'), css.indexOf('.conn-list.is-empty'));
  assert.ok(nodeList.includes('border: 0'));
  assert.ok(nodeList.includes('background: transparent'));
  assert.ok(nodeList.includes('padding-top: 3px'), 'node hover effects need vertical breathing room');
  assert.ok(nodeList.includes('padding-bottom: 3px'), 'node hover effects need vertical breathing room');
  assert.ok(nodeList.includes('padding-right: 8px'), 'node cards need space before the scrollbar');
  assert.ok(nodeList.includes('scrollbar-gutter: stable'));
  assert.ok(nodes.includes("App.currentTab !== 'nodes' || nodeWindowFrame"), 'node virtualization must follow window resizing');
});

test('background renderer work is bounded to visible and useful content', () => {
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const charts = fs.readFileSync(path.join(rendererDir, 'js', 'charts.js'), 'utf-8');
  const editors = fs.readFileSync(path.join(rendererDir, 'dialog', 'editors.js'), 'utf-8');
  const logs = fs.readFileSync(path.join(rendererDir, 'js', 'logs.js'), 'utf-8');
  const settings = fs.readFileSync(path.join(rendererDir, 'js', 'settings.js'), 'utf-8');
  const ipcValidation = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-validation.js'), 'utf-8');
  assert.ok(ipcValidation.includes('MAX_IPC_CONNECTIONS = 300'));
  assert.ok(main.includes('function connectionPollDelay(data)'));
  assert.ok(main.includes('data.totalConnections > shown ? 5000 : 3000'));
  assert.ok(charts.includes('function isCanvasVisible()'));
  assert.ok(charts.includes('canvas.getClientRects().length > 0'));
  assert.ok(editors.includes('RAW_FORMAT_LIMIT = 4 * 1024 * 1024'));
  assert.ok(editors.includes('JSON.stringify(JSON.parse(text), null, 2)'));
  assert.ok(!main.includes("if ($('#logAutoScroll').checked) box.scrollTop = box.scrollHeight"));
  assert.ok(logs.includes("if (drained && $('#logAutoScroll').checked)"));
  assert.ok(logs.includes('for (const entry of pendingLiveLogs) enqueueLog(entry)'));
  assert.ok(main.includes("previousTab === 'logs' && tab !== 'logs'"));
  assert.ok(main.includes("window.addEventListener('pagehide'"));
  assert.ok(main.includes('App.setLogStreaming(false)'));
  assert.ok(main.includes('App.setLogStreaming(true)'));
  assert.ok(settings.includes('function changedSettingsPatch(candidate)'));
  assert.ok(settings.includes("if (!Object.keys(patch).length)"));
});

test('idle traffic samples do not repaint unchanged charts or re-query labels', () => {
  const chartSource = fs.readFileSync(path.join(rendererDir, 'js', 'charts.js'), 'utf-8');
  const makeCanvas = () => {
    const counts = { clears: 0 };
    const context = new Proxy({}, {
      get(target, key) {
        if (key === 'clearRect') return () => { counts.clears++; };
        if ([
          'setTransform', 'beginPath', 'moveTo', 'lineTo', 'closePath',
          'fill', 'stroke', 'fillText',
        ].includes(key)) return () => {};
        return target[key];
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    });
    return {
      counts,
      clientWidth: 600,
      clientHeight: 120,
      width: 0,
      height: 0,
      offsetParent: {},
      getClientRects: () => [{}],
      getContext: () => context,
    };
  };
  const traffic = makeCanvas();
  const mini = makeCanvas();
  const elements = new Map([
    ['#trafficChart', traffic],
    ['#miniTraffic', mini],
    ['#trafficUp', { textContent: '' }],
    ['#trafficDown', { textContent: '' }],
    ['#trafficUpTotal', { textContent: '' }],
    ['#trafficDownTotal', { textContent: '' }],
    ['#miniUp', { textContent: '' }],
    ['#miniDown', { textContent: '' }],
  ]);
  let queries = 0;
  const chartApp = {
    $: (selector) => {
      queries++;
      return elements.get(selector);
    },
    fmtBytes: (value) => Number(value).toFixed(2) + ' B',
  };
  const chartWindow = {
    App: chartApp,
    devicePixelRatio: 1,
    addEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
  };
  vm.runInNewContext(chartSource, {
    window: chartWindow,
    document: {
      hidden: false,
      documentElement: { getAttribute: () => 'dark', setAttribute() {} },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { setItem() {} },
  });
  chartApp.trafficChart.draw();
  chartApp.miniChart.draw();
  const initialQueries = queries;
  for (let i = 0; i < 600; i++) {
    chartApp.trafficChart.push(0, 0);
    chartApp.miniChart.push(0, 0);
  }
  assert.strictEqual(traffic.counts.clears, 1);
  assert.strictEqual(mini.counts.clears, 1);
  assert.strictEqual(queries, initialQueries);

  // A real sample still paints, and zero samples continue painting only until
  // that point has aged out of the 60-second history.
  chartApp.trafficChart.push(1024, 0);
  const activeDraws = traffic.counts.clears;
  assert.ok(activeDraws > 1);
  for (let i = 0; i < 80; i++) chartApp.trafficChart.push(0, 0);
  const drainedDraws = traffic.counts.clears;
  chartApp.trafficChart.push(0, 0);
  assert.strictEqual(traffic.counts.clears, drainedDraws);
});

test('log streaming resumes from history without gaps or duplicate live lines', async () => {
  const logSource = fs.readFileSync(path.join(rendererDir, 'js', 'logs.js'), 'utf-8');
  const timers = [];
  const logBox = {
    children: [],
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    get firstChild() { return this.children[0] || null; },
    set textContent(_value) { this.children = []; },
    get textContent() { return this.children.map((child) => child.textContent || '').join(''); },
    scrollTop: 0,
    scrollHeight: 0,
  };
  const clearButton = { addEventListener(_name, callback) { this.click = callback; } };
  const elements = new Map([
    ['#logBox', logBox],
    ['#logAutoScroll', { checked: false }],
    ['#logClear', clearButton],
  ]);
  let liveLog = null;
  let resolveFirstHistory;
  let signalFirstHistoryRequested;
  const firstHistoryRequested = new Promise((resolve) => {
    signalFirstHistoryRequested = resolve;
  });
  let historyCalls = 0;
  const streamCalls = [];
  const api = {
    onLog(callback) {
      liveLog = callback;
      return () => {};
    },
    setLogStreaming(enabled) {
      streamCalls.push(enabled);
      return Promise.resolve(enabled);
    },
    getRecentLogs() {
      historyCalls++;
      if (historyCalls === 1) {
        return new Promise((resolve) => {
          resolveFirstHistory = resolve;
          signalFirstHistoryRequested();
        });
      }
      return Promise.resolve({
        entries: [
          { sequence: 2, line: 'history-two' },
          { sequence: 3, line: 'live-three' },
          { sequence: 4, line: 'missed-four' },
        ],
      });
    },
    clearRecentLogs: () => Promise.resolve(true),
  };
  const logApp = {
    currentTab: 'logs',
    $: (selector) => elements.get(selector),
    escapeHtml: (value) => String(value),
  };
  const context = {
    window: { App: logApp, api },
    document: {
      hidden: false,
      createElement: () => ({ innerHTML: '', textContent: '' }),
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      timers.push(callback);
      return timers.length;
    },
    cancelAnimationFrame() {},
  };
  vm.runInNewContext(logSource, context);
  const flushTimers = () => {
    while (timers.length) timers.shift()();
  };

  const firstActivation = logApp.setLogStreaming(true);
  await firstHistoryRequested;
  liveLog({ sequence: 3, line: 'live-three' });
  resolveFirstHistory({
    entries: [
      { sequence: 1, line: 'history-one' },
      { sequence: 2, line: 'history-two' },
      { sequence: 3, line: 'live-three' },
    ],
  });
  await firstActivation;
  flushTimers();
  let output = logBox.children.map((child) => child.innerHTML).join('');
  assert.strictEqual((output.match(/history-one/g) || []).length, 1);
  assert.strictEqual((output.match(/history-two/g) || []).length, 1);
  assert.strictEqual((output.match(/live-three/g) || []).length, 1);

  await logApp.setLogStreaming(false);
  liveLog({ sequence: 4, line: 'missed-four' });
  await logApp.setLogStreaming(true);
  flushTimers();
  output = logBox.children.map((child) => child.innerHTML).join('');
  assert.strictEqual((output.match(/missed-four/g) || []).length, 1);
  assert.deepStrictEqual(streamCalls, [true, false, true]);
});

test('node, connection and log workspaces use a direct full-height canvas', () => {
  const css = readRendererCss();
  const workspace = css.slice(css.indexOf('.live-workspace.active {'), css.indexOf('h1 {'));
  assert.ok(workspace.includes('height: 100%'));
  assert.ok(workspace.includes('.live-workspace > .workspace-commandbar'));
  const connList = css.slice(css.indexOf('#tab-conns .conn-list'), css.indexOf('.conn-list.is-empty'));
  assert.ok(connList.includes('flex: 1'));
  assert.ok(connList.includes('border: 0'));
  assert.ok(connList.includes('background: transparent'));
  assert.ok(css.includes('#tab-logs .log-box'));
  assert.ok(css.includes('max-height: none'));
  for (const id of ['tab-nodes', 'tab-conns', 'tab-logs']) {
    const start = indexHtml.indexOf(`<section class="tab live-workspace" id="${id}"`);
    assert.ok(start >= 0, `${id} must use the live workspace layout`);
    const section = indexHtml.slice(start, indexHtml.indexOf('</section>', start));
    assert.ok(section.includes('workspace-commandbar'), `${id} must expose a direct command bar`);
    assert.ok(!section.includes('class="panel'), `${id} must not have an outer panel`);
  }
});

test('config, rule and tool pages use unframed canvas sections', () => {
  const css = readRendererCss();
  for (const id of ['tab-subs', 'tab-rules', 'tab-tools']) {
    const start = indexHtml.indexOf(`<section class="tab canvas-page" id="${id}"`);
    assert.ok(start >= 0, `${id} must use the canvas page layout`);
    const section = indexHtml.slice(start, indexHtml.indexOf('</section>', start));
    assert.ok(!section.includes('class="panel'), `${id} must not have an outer panel`);
  }
  assert.ok(indexHtml.includes('class="workspace-section"'));
  assert.ok(indexHtml.includes('class="tool-list"'));
  const sectionStyle = css.slice(css.indexOf('.canvas-page > .workspace-section'), css.indexOf('.cards {'));
  assert.ok(sectionStyle.includes('border-bottom: 1px solid var(--border)'));
  assert.ok(!sectionStyle.includes('background:'));
  assert.ok(!sectionStyle.includes('box-shadow:'));
  const toolStyle = css.slice(css.indexOf('.tool-list {'), css.indexOf('.setting-row {'));
  assert.ok(toolStyle.includes('border-top: 1px solid var(--border)'));
  assert.ok(!toolStyle.includes('box-shadow:'));
});

test('config activation state keeps a stable action width', () => {
  const subs = fs.readFileSync(path.join(rendererDir, 'js', 'subs.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(subs.includes('sub-activate-btn'));
  const activationStyle = css.slice(css.indexOf('.sub-activate-btn {'), css.indexOf('.node-list,'));
  assert.ok(activationStyle.includes('width: 72px'));
});

test('live log surface stays translucent without a redundant blur layer', () => {
  const css = readRendererCss();
  assert.ok(css.includes('--log-surface: rgba(22, 22, 25, 0.68)'));
  assert.ok(css.includes('--log-surface: rgba(255, 255, 255, 0.58)'));
  const logStyle = css.slice(css.indexOf('#tab-logs .log-box'), css.indexOf('.log-time'));
  assert.ok(logStyle.includes('background: var(--log-surface)'));
  assert.ok(!logStyle.includes('backdrop-filter'));
});

test('page surfaces keep an even outer inset without trailing panel space', () => {
  const css = readRendererCss();
  const content = css.slice(css.indexOf('.content {'), css.indexOf('* {', css.indexOf('.content {')));
  const tab = css.slice(css.indexOf('.tab {'), css.indexOf('.tab.active'));
  assert.ok(css.includes('--content-inset: 24px'));
  assert.ok(content.includes('padding: var(--content-inset)'));
  assert.ok(tab.includes('width: 100%'));
  assert.ok(css.includes('.tab > .panel:last-child'));
});

test('heavy renderer data is bounded and released outside its active view', () => {
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(rendererDir, 'js', 'rules.js'), 'utf-8');
  const logs = fs.readFileSync(path.join(rendererDir, 'js', 'logs.js'), 'utf-8');
  const dialogHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'dialog-window.js'), 'utf-8');
  assert.ok(main.includes('App.releaseNodes'));
  assert.ok(main.includes('App.releaseRuleCache'));
  assert.ok(nodes.includes('api.getNodes()'));
  assert.ok(nodes.includes('run.cancelled'));
  assert.ok(nodes.includes('function releaseNodes({ cancelTests = true } = {})'));
  assert.ok(main.includes('App.releaseNodes({ cancelTests: false })'));
  assert.ok(rules.includes('ruleItems = []'));
  assert.ok(rules.includes('generation !== ruleLoadGeneration'));
  assert.ok(logs.includes('LOG_LIMIT = 120000'));
  assert.ok(!nodes.includes('for (const name of delays.keys())'));
  assert.ok(nodes.includes('api.applyAutoCandidate(bestName)'));
  assert.ok(!indexHtml.includes('class="modal hidden"'), 'dialog DOM must not remain resident in the main renderer');
  assert.ok(dialogHost.includes('dialogWindow = null'));
  assert.ok(dialogHost.includes('dialogContext = null'));
  assert.ok(main.includes('TAB_MODULES'));
  assert.ok(!indexHtml.includes('<script src="js/logs.js"></script>'));
});

test('node strategies keep profile order and expose a stable sidebar readout', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(indexHtml.includes('id="miniCurrentNode"'));
  assert.ok(indexHtml.includes('id="smartRegionScope"'));
  assert.ok(nodes.includes("{ name: AUTO_GROUP }, { name: SMART_GROUP }, { name: FALLBACK_GROUP }, ...nodes"));
  assert.ok(nodes.includes("App.openDialog('smart-regions')"));
  assert.ok(nodes.includes('smartScope.effective.has(region)'));
  assert.ok(!nodes.includes('const pinned = []'));
  assert.ok(css.includes('.mini-current-node'));
  assert.ok(css.includes('.smart-scope-bar'));
  assert.ok(css.includes('.node-item.smart-excluded'));
  assert.ok(css.includes('--node-offset'));
});

test('virtualized node cards remain keyboard-selectable with named row actions', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const conns = fs.readFileSync(path.join(rendererDir, 'js', 'conns.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(nodes.includes('class="node-select-btn"'));
  assert.ok(nodes.includes('aria-pressed="${String(active)}"'));
  assert.ok(nodes.includes('data-select-name'));
  assert.ok(nodes.includes("t('nodes.test') + ': ' + name"));
  assert.ok(conns.includes("t('conns.close') + ': ' + target"));
  assert.ok(css.includes('.node-select-btn:focus-visible'));
  assert.ok(indexHtml.includes('id="nodeList" class="node-list" role="list"'));
});

test('dashboard status cards expose current node latency and click actions', () => {
  const dash = fs.readFileSync(path.join(rendererDir, 'js', 'dashboard.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(indexHtml.includes('id="dashNode"'));
  assert.ok(indexHtml.includes('id="dashDelay"'));
  assert.ok(indexHtml.includes('data-dash-action="power"'));
  assert.ok(indexHtml.includes('data-dash-action="proxy"'));
  assert.ok(indexHtml.includes('data-dash-action="nodes"'));
  assert.ok(indexHtml.includes('data-dash-action="testDelay"'));
  assert.ok(dash.includes('renderDashNodeCards'));
  assert.ok(dash.includes("nodeEl.className = 'card-value'"));
  assert.ok(!css.includes('.card-value-sm'));
  assert.ok(dash.includes("action === 'testDelay'"));
  assert.ok(main.includes('App.showTab = showTab'));
  assert.ok(
    main.includes('else if (subsChanged && App.renderDashboard) App.renderDashboard()'),
    'active config changes must refresh the topbar even when runtime status is unchanged'
  );
});

test('dashboard traffic chart is compact and tracks session totals with switch toggles', () => {
  const charts = fs.readFileSync(path.join(rendererDir, 'js', 'charts.js'), 'utf-8');
  const css = readRendererCss();
  assert.ok(indexHtml.includes('id="trafficUpTotal"'));
  assert.ok(indexHtml.includes('id="trafficDownTotal"'));
  assert.ok(indexHtml.includes('role="switch"'));
  assert.ok(indexHtml.includes('id="quickProxy"'));
  assert.ok(indexHtml.includes('id="quickTun"'));
  assert.ok(!indexHtml.includes('id="quickRestart"'));
  assert.ok(!indexHtml.includes('id="quickPanel"'));
  const systemDialogs = fs.readFileSync(path.join(rendererDir, 'dialog', 'system.js'), 'utf-8');
  assert.ok(systemDialogs.includes('id="dialogCoreRestart"'));
  assert.ok(systemDialogs.includes('id="dialogCoreSource"'));
  assert.ok(systemDialogs.includes('id="dialogSmartSupport"'));
  assert.ok(systemDialogs.includes('source = $(\'#dialogCoreSource\').value'));
  assert.ok(!systemDialogs.includes('settings.coreHint'));
  assert.ok(indexHtml.includes('id="openPanelBtn"'));
  assert.ok(indexHtml.includes('data-i18n="tools.panelHint"'));
  assert.ok(!indexHtml.includes('setClashApi'));
  assert.ok(charts.includes('upTotalEl'));
  assert.ok(charts.includes('sessionUp'));
  assert.ok(css.includes('height: 120px'));
  assert.ok(css.includes('.switch-track'));
  assert.ok(css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
});

test('settings isolates Smart features before DNS and removes obsolete controls', () => {
  const settings = fs.readFileSync(path.join(rendererDir, 'js', 'settings.js'), 'utf-8');
  const conns = fs.readFileSync(path.join(rendererDir, 'js', 'conns.js'), 'utf-8');
  const languageIndex = indexHtml.indexOf('id="setLanguage"');
  const englishIndex = indexHtml.indexOf('<option value="en">English</option>', languageIndex);
  const chineseIndex = indexHtml.indexOf('<option value="zh">中文</option>', languageIndex);
  const featureIndex = indexHtml.indexOf('data-i18n="settings.featuresSection"');
  const dnsIndex = indexHtml.indexOf('data-i18n="settings.dnsSection"');
  assert.ok(languageIndex >= 0 && englishIndex > languageIndex && englishIndex < chineseIndex);
  assert.ok(featureIndex >= 0 && featureIndex < dnsIndex);
  assert.ok(indexHtml.includes('id="saveFeatures"'));
  assert.ok(settings.includes("$('#saveFeatures').addEventListener"));
  assert.ok(!indexHtml.includes('setTestConcurrency'));
  assert.ok(!settings.includes('testConcurrency'));
  assert.ok(!indexHtml.includes('setClashApi'));
  assert.ok(!settings.includes('enableClashApi'));
  assert.ok(conns.includes("direct: 'Direct'"));
  assert.ok(conns.includes("proxy: 'Proxy'"));
});

test('node cards distinguish protocol variants without exposing endpoints', () => {
  const nodes = fs.readFileSync(path.join(rendererDir, 'js', 'nodes.js'), 'utf-8');
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf-8');
  assert.ok(nodes.includes("return 'Shadowsocks 2022'"));
  assert.ok(nodes.includes("return 'VLESS Vision'"));
  assert.ok(nodes.includes("socks: 'SOCKS5'"));
  assert.ok(nodes.includes("ws: 'WebSocket'"));
  assert.ok(nodes.includes("grpc: 'gRPC'"));
  assert.ok(nodes.includes("value.replace(/^2022-blake3-/i, '')"));
  assert.ok(ipc.includes("result.variant = '2022'"));
  assert.ok(ipc.includes("result.variant = 'vision'"));
  assert.ok(ipc.includes('region: detectNodeRegion(node)'));
  assert.ok(!ipc.slice(ipc.indexOf('function nodeResult'), ipc.indexOf('/** Register every IPC handler')).includes('server:'));
  assert.ok(!ipc.slice(ipc.indexOf('function nodeResult'), ipc.indexOf('/** Register every IPC handler')).includes('port:'));
});

test('dynamic first-paint regions reserve dimensions to limit layout shift', () => {
  const css = readRendererCss();
  assert.ok(css.includes('min-width: 260px'));
  assert.ok(css.includes('#coreHint'));
  assert.ok(css.includes('#usageList'));
  assert.ok(css.includes('.card-value'));
  assert.ok(css.includes('min-height: 28px'));
});

test('light theme uses quiet system surfaces and lightweight dashboard cards', () => {
  const css = readRendererCss();
  assert.ok(css.includes('--bg: transparent'));
  assert.ok(css.includes('--sidebar: transparent'));
  assert.ok(css.includes('--surface: rgba(255, 255, 255, 0.62)'));
  assert.ok(css.includes('--raised-filter: blur(22px) saturate(1.16)'));
  assert.ok(!css.includes('--surface-filter'));
  assert.ok(css.includes('--text-faint: #6e6e6e'));
  assert.ok(css.includes('--panel-shadow:'));
  assert.ok(css.includes('.rule-proxy.geodata-status'));
});

test('language changes refresh enhanced select labels immediately', () => {
  const select = fs.readFileSync(path.join(rendererDir, 'js', 'select.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const rules = fs.readFileSync(path.join(rendererDir, 'js', 'rules.js'), 'utf-8');
  const css = readRendererCss();
  const languageFlow = main.slice(
    main.indexOf('function setLanguage(lang)'),
    main.indexOf('// ---------- Tab switching ----------')
  );
  assert.ok(select.includes('function refreshSelects('));
  assert.ok(select.includes('selectSync.get(select)'));
  assert.ok(languageFlow.includes('App.state.settings.language = lang'));
  assert.ok(languageFlow.includes('App.refreshRuleGroupLabels()'));
  assert.ok(rules.includes("source: t('rulegroups.targetSource')"));
  assert.ok(rules.includes('App.refreshSelects(list)'));
  assert.ok(languageFlow.indexOf('App.state.settings.language = lang') < languageFlow.indexOf('App.renderSettings()'));
  assert.ok(languageFlow.indexOf('App.renderSettings()') < languageFlow.indexOf('App.refreshSelects()'));
  const selectElement = { value: 'zh' };
  let mirroredLanguage = null;
  let refreshedRuleGroups = 0;
  const noop = () => {};
  const sandbox = {
    App: {
      state: { settings: { language: 'zh' }, status: {} },
      currentTab: 'dashboard',
      renderStatus: noop,
      renderSubs: noop,
      renderNodes: noop,
      renderSettings: noop,
      renderMode: noop,
      renderUsage: noop,
      renderCoreStatus: noop,
      refreshRuleGroupLabels: () => { refreshedRuleGroups++; },
      refreshSelects: () => { mirroredLanguage = selectElement.value; },
    },
    setLang: noop,
    applyI18n: noop,
    syncTopbarTitle: noop,
    $: (selector) => (selector === '#setLanguage' ? selectElement : null),
  };
  vm.runInNewContext(`${languageFlow}\nsetLanguage('en');`, sandbox);
  assert.strictEqual(sandbox.App.state.settings.language, 'en');
  assert.strictEqual(mirroredLanguage, 'en');
  assert.strictEqual(refreshedRuleGroups, 1);
  assert.ok(main.includes('{ ...previous, ...status }'), 'compact status events must preserve core version fields');
  assert.ok(css.includes('.btn.primary:hover:not(:disabled)'));
  assert.ok(css.includes('background: var(--accent-hover)'), 'primary hover must retain a contrast-safe blue background');
});

test('secondary panels use a real transient native material window', () => {
  const css = readRendererCss();
  const dialogCss = fs.readFileSync(path.join(rendererDir, 'dialog', 'dialog.css'), 'utf-8');
  const dialogMain = fs.readFileSync(path.join(rendererDir, 'dialog', 'main.js'), 'utf-8');
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'dialog-window.js'), 'utf-8');
  const menus = css.slice(css.indexOf('.ui-select-menu,\n.node-context-menu {'), css.indexOf('.ui-select-menu {', css.indexOf('.ui-select-menu,\n.node-context-menu {')));
  const contextMenu = css.slice(css.indexOf('.node-context-menu {', css.indexOf('.node-context-menu {') + 1), css.indexOf('.node-context-menu.hidden'));
  assert.ok(css.includes('--menu-surface: rgb(252, 252, 252)'));
  assert.ok(menus.includes('background: var(--menu-surface)'));
  assert.ok(menus.includes('border: 1px solid var(--menu-border)'));
  assert.ok(menus.includes('box-shadow: var(--menu-shadow)'));
  assert.ok(contextMenu.includes('z-index: 1200'));
  assert.ok(!contextMenu.includes('--surface-raised'), 'context menus must not expose content underneath');
  assert.ok(css.includes('.toast {\n  -webkit-backdrop-filter: var(--raised-filter)'));
  assert.ok(css.includes('backdrop-filter: var(--raised-filter)'));
  assert.ok(host.includes('parent,'));
  assert.ok(host.includes('modal: true'));
  assert.ok(host.includes('frame: false'));
  assert.ok(host.includes("backgroundMaterial: 'mica'"));
  assert.ok(host.includes("setBackgroundMaterial('mica')"));
  assert.ok(host.includes('pathToFileURL'));
  assert.ok(host.includes('win.loadURL(DIALOG_URL)'));
  assert.ok(host.includes('PREWARM_TTL_MS = 8_000'));
  assert.ok(host.includes('skipTaskbar: true'));
  assert.ok(host.includes("themeEffective: appearance.dark ? 'dark' : 'light'"));
  assert.ok(dialogMain.includes("applyTheme(context.theme || 'system', context.themeEffective)"));
  assert.ok(dialogCss.includes('background: transparent !important'));
  assert.ok(dialogHtml.includes('<script src="js/select.js"></script>'));
  const windowStyle = dialogCss.slice(dialogCss.indexOf('.native-dialog-window {'), dialogCss.indexOf(':root[data-theme'));
  const actionStart = dialogCss.lastIndexOf('.dialog-commandbar {');
  const actionStyle = dialogCss.slice(actionStart, dialogCss.indexOf('}', actionStart));
  assert.ok(!windowStyle.includes('linear-gradient'));
  assert.ok(actionStyle.includes('justify-content: flex-end'));
  assert.ok(actionStyle.includes('gap: 10px'));
  assert.ok(!dialogCss.includes('body.native-dialog-body > .ui-select-menu'), 'dialogs must reuse the settings dropdown style');
});

test('hidden tray windows release their renderer and recreate on demand', () => {
  const windowMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf-8');
  const trayMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tray.js'), 'utf-8');
  assert.ok(windowMain.includes('DEEP_SLEEP_DELAY_MS = 60_000'));
  assert.ok(windowMain.includes('state.mainWindow = null'));
  assert.ok(windowMain.includes('win.destroy()'));
  assert.ok(windowMain.includes('function showMainWindow()'));
  assert.ok(windowMain.includes('const rendererContents = mainWindow.webContents'));
  assert.ok(windowMain.includes("destroyWindow(win, 'deep-sleep')"));
  assert.ok(windowMain.includes("destroyReason === 'unexpected' && wasVisible && !app.isQuitting"));
  const closedHandler = windowMain.slice(
    windowMain.indexOf("mainWindow.on('closed'"),
    windowMain.indexOf("mainWindow.on('maximize'")
  );
  assert.ok(closedHandler.includes('setRecentLogStreaming(rendererContents, false)'));
  assert.ok(!closedHandler.includes('setRecentLogStreaming(mainWindow.webContents'));
  assert.ok(trayMain.includes("const { showMainWindow } = require('./window')"));
  assert.ok(trayMain.includes("click: showMainWindow"));
});

test('background failures remain diagnosable without terminating the desktop process', () => {
  const indexMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf-8');
  const coreMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'core-control.js'), 'utf-8');
  assert.ok(indexMain.includes("app.setPath('crashDumps', crashDumps)"));
  assert.ok(indexMain.includes('uploadToServer: false'));
  assert.ok(indexMain.includes("app.on('render-process-gone'"));
  assert.ok(indexMain.includes("app.on('child-process-gone'"));
  assert.ok(indexMain.includes(
    "process.on('unhandledRejection', (reason) => recordCrash('unhandled rejection', reason))"
  ));
  assert.ok(!indexMain.includes(
    "process.on('unhandledRejection', (reason) => handleFatalError"
  ));
  assert.ok(coreMain.includes('setInterval(autoUpdateTick, 60000)'));
  assert.ok(coreMain.includes("automatic update pass failed: "));
});

test('main surfaces avoid diagonal highlights and repeated backdrop filters', () => {
  const css = readRendererCss();
  const surfaces = css.slice(css.indexOf('.panel,\n.card {'), css.indexOf('.tab > .panel:last-child'));
  const card = css.slice(css.indexOf('.card {', css.indexOf('.tab > .panel:last-child')), css.indexOf('button.card {'));
  const toast = css.slice(css.indexOf('.toast {'), css.indexOf('.toast.err'));
  for (const rule of [surfaces, card, toast]) {
    assert.ok(!rule.includes('background-image: linear-gradient'));
  }
  for (const rule of [surfaces, card]) assert.ok(!rule.includes('backdrop-filter'));
  const menus = css.slice(css.indexOf('.ui-select-menu,\n.node-context-menu {'), css.indexOf('.ui-select-menu {', css.indexOf('.ui-select-menu,\n.node-context-menu {')));
  assert.ok(!menus.includes('backdrop-filter'));
});

test('controls and canvas command bars share a stable size rhythm', () => {
  const css = readRendererCss();
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  assert.ok(css.includes('--control-height: 38px'));
  assert.ok(css.includes('--control-height-compact: 32px'));
  assert.ok(css.includes('--commandbar-height: 40px'));
  const controls = css.slice(css.indexOf('.input,'), css.indexOf('.input:hover'));
  const button = css.slice(css.indexOf('.btn {'), css.indexOf('.btn:hover'));
  const nav = css.slice(css.indexOf('.nav-indicator {'), css.indexOf('.nav-item {'));
  assert.ok(controls.includes('min-height: var(--control-height)'));
  assert.ok(button.includes('min-height: var(--control-height)'));
  assert.ok(nav.includes('background: var(--accent)'));
  assert.ok(nav.includes('transform-origin: 50% 50%'));
  assert.ok(indexHtml.includes('id="navIndicator"'));
  assert.ok(main.includes('function syncNavIndicator('));
  assert.ok(main.includes('function moveNavIndicator('));
  assert.ok(main.includes('scaleY(${stretch})'));
  assert.ok(main.includes("easing: 'cubic-bezier(0.65, 0, 0.35, 1)'"));
  assert.ok(main.includes("matchMedia('(prefers-reduced-motion: reduce)')"));
  assert.ok(main.includes('navIndicatorAnimation.effect.setKeyframes(keyframes)'));
  assert.ok(main.includes('navIndicatorAnimation.effect.updateTiming(timing)'));
  assert.ok(main.includes('navIndicatorAnimation.cancel()'));
  assert.ok(!main.includes('translate3d('));
  assert.ok(!nav.includes('translate3d('));
  assert.ok(!/font-weight: (?:550|650|680|720|750);/.test(css));
});

test('node test actions fit inside the fixed virtualized card height', () => {
  const css = readRendererCss();
  const card = css.slice(css.indexOf('.node-item {'), css.indexOf('.node-item.has-test'));
  const action = css.slice(css.indexOf('.node-test-btn {'), css.indexOf('.node-test-btn:hover'));
  assert.ok(card.includes('height: 68px'));
  assert.ok(card.includes('padding: 8px 10px'));
  assert.ok(card.includes('gap: 4px'));
  assert.ok(css.includes('.node-quality'));
  assert.ok(css.includes('.node-quality.probing'));
  assert.ok(css.includes('.node-quality.unavailable'));
  assert.ok(css.includes('.node-context-menu'));
  assert.ok(css.includes('.node-tag-override'));
  assert.ok(css.includes('border-radius: 999px'));
  assert.ok(action.includes('min-height: 26px'));
  assert.ok(action.includes('padding-block: 2px'));
});

console.log('\nGitHub release helper:');

const github = require('../src/main/github');

test('compareTags orders semver, v-prefixed and date tags', () => {
  assert.ok(github.compareTags('1.12.4', '1.9.9') > 0);
  assert.ok(github.compareTags('v0.6.1', '0.6.0') > 0);
  assert.strictEqual(github.compareTags('1.2.3', 'v1.2.3'), 0);
  assert.ok(github.compareTags('20250606', '20240101') > 0);
  assert.ok(github.compareTags('1.10', '1.9.9') > 0); // numeric, not lexicographic
});

test('pickLatestTag skips prereleases and picks the newest stable', () => {
  assert.strictEqual(github.pickLatestTag(['1.12.0-beta.1', '1.11.4', 'v1.11.5-alpha', '1.11.3']), '1.11.4');
  assert.strictEqual(github.pickLatestTag(['v0.5.5', 'v0.6.0', 'v0.2.8-pre']), 'v0.6.0');
  assert.strictEqual(github.pickLatestTag([]), null);
  assert.strictEqual(github.pickLatestTag(['1.0.0-rc.1']), null); // nothing stable
  assert.strictEqual(
    github.pickLatestTag([
      'v1.13.14',
      'v1.13.14-dart.1',
      'v1.14.0-alpha.1',
      'v999-dart.1',
      'nightly',
    ]),
    'v1.13.14-dart.1'
  );
  assert.strictEqual(github.pickLatestTag(['alpha', 'v1.2.3-rc.1']), null);
});

console.log('\nCore adapters and integrity:');

const { getCoreAdapter, listCoreAdapters, normalizeCoreType } = require('../src/main/core-adapters');
const { normalizeSha256, parseSha256Sums } = require('../src/main/integrity');
const { OperationCoordinator } = require('../src/main/operation-coordinator');
const {
  addBundledComponents,
  releaseVersionFromTag,
} = require('../scripts/release-metadata');
const {
  buildCoreBundle,
  installStagedBundle,
  parseDartReleaseTag,
  selectStableDartRelease,
} = require('../scripts/download-core');

test('core adapters own paths, commands, formats and release assets', () => {
  assert.deepStrictEqual(listCoreAdapters().map((adapter) => adapter.id), ['sing-box', 'mihomo']);
  assert.strictEqual(normalizeCoreType('unknown'), 'sing-box');
  const singBox = getCoreAdapter('sing-box');
  const mihomo = getCoreAdapter('mihomo');
  assert.deepStrictEqual(singBox.checkArgs('config.json'), ['check', '-c', 'config.json']);
  assert.deepStrictEqual(mihomo.checkArgs('config.yaml', '/work'), ['-t', '-f', 'config.yaml', '-d', '/work']);
  // Runtime writes stay compact; pretty-print is opt-in for human exports.
  assert.strictEqual(singBox.serializeConfig({ log: { level: 'info' } }), '{"log":{"level":"info"}}');
  assert.ok(singBox.serializeConfig({ log: { level: 'info' } }, { pretty: true }).includes('\n'));
  assert.ok(mihomo.serializeConfig({ mode: 'rule' }).includes('mode: rule'));
  assert.strictEqual(singBox.configFormat, 'JSON');
  assert.strictEqual(singBox.repo, 'blakebill/sing-box');
  assert.strictEqual(singBox.repoFor('official'), 'SagerNet/sing-box');
  assert.strictEqual(singBox.releaseTag('1.13.14'), 'v1.13.14-dart.1');
  assert.strictEqual(singBox.releaseTag('v1.13.14-dart.2'), 'v1.13.14-dart.2');
  assert.strictEqual(singBox.releaseTag('v1.13.14-dart.2', 'official'), 'v1.13.14');
  assert.strictEqual(mihomo.configFormat, 'YAML');
  assert.strictEqual(mihomo.repoFor('official'), 'MetaCubeX/mihomo');
  assert.strictEqual(singBox.routeEntries({ route: { rules: [{}] } })[0].kind, 'sing-box');
  assert.strictEqual(mihomo.routeEntries({ rules: ['MATCH,DIRECT'] })[0].kind, 'clash');
  assert.deepStrictEqual(
    singBox.summarizeConfig({ outbounds: [{ type: 'trojan' }, { type: 'direct' }], route: { rules: [{}] } }),
    { generatedNodes: 1, generatedRules: 1, tun: false }
  );
  assert.strictEqual(
    mihomo.dnsPath({ dns: { nameserver: ['https://dns.example/dns-query'] } }, { enableTun: true }, false).server,
    'https://dns.example/dns-query'
  );
  const digest = 'a'.repeat(64);
  const asset = mihomo.releaseAsset('1.2.3', 'windows', 'amd64', {
    assets: [{
      name: 'mihomo-windows-amd64-v1.2.3.zip',
      browser_download_url: 'https://example.com/mihomo.zip',
      digest: 'sha256:' + digest,
    }],
  });
  assert.strictEqual(asset.sha256, digest);
  const officialFallback = singBox.releaseAsset('1.13.14', 'windows', 'amd64', null, 'official');
  assert.ok(officialFallback.url.includes('SagerNet/sing-box/releases/download/v1.13.14/'));
  assert.strictEqual(mihomo.modeChangeNeedsRestart('rule', 'block'), true);
  assert.strictEqual(singBox.modeChangeNeedsRestart('rule', 'block'), false);
});

test('SHA-256 metadata accepts GitHub digests and standard manifests', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.strictEqual(normalizeSha256('sha256:' + a.toUpperCase()), a);
  assert.strictEqual(normalizeSha256('sha512:' + a), null);
  const sums = parseSha256Sums(`${a}  Dart.Setup.exe\nSHA256 (core.zip) = ${b}\n`);
  assert.strictEqual(sums.get('Dart.Setup.exe'), a);
  assert.strictEqual(sums.get('core.zip'), b);
});

test('release inputs keep prerelease versions and select only stable Dart cores', () => {
  assert.strictEqual(releaseVersionFromTag('v0.9.6'), '0.9.6');
  assert.strictEqual(releaseVersionFromTag('v0.9.6-beta.1'), '0.9.6-beta.1');
  assert.throws(() => releaseVersionFromTag('release-0.9.6'), /invalid release tag/);
  assert.deepStrictEqual(parseDartReleaseTag('v1.19.29-dart.13'), {
    tag: 'v1.19.29-dart.13',
    version: '1.19.29-dart.13',
    base: '1.19.29',
    baseParts: [1, 19, 29],
    revision: 13,
  });
  assert.strictEqual(parseDartReleaseTag('v1.19.29-alpha.1'), null);

  const releases = [
    { tag_name: 'v1.19.29-dart.9', draft: false, prerelease: false },
    { tag_name: 'v1.19.29-dart.13', draft: false, prerelease: false },
    { tag_name: 'v1.19.30-dart.1', draft: true, prerelease: false },
    { tag_name: 'v1.20.0-dart.1', draft: false, prerelease: true },
    { tag_name: 'v1.99.0-alpha.1', draft: false, prerelease: false },
  ];
  assert.strictEqual(selectStableDartRelease(releases).tag_name, 'v1.19.29-dart.13');
  assert.strictEqual(
    selectStableDartRelease(releases, '1.19.29').tag_name,
    'v1.19.29-dart.13'
  );
  assert.throws(() => selectStableDartRelease(releases, '1.19.30'), /no stable Dart release/);
});

test('core bundling stages changes and restores prior installs after failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-bundle-'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(binDir, 'singbox'), { recursive: true });
  fs.mkdirSync(path.join(binDir, 'mihomo'), { recursive: true });
  fs.writeFileSync(path.join(binDir, 'singbox', 'old.txt'), 'old-singbox');
  fs.writeFileSync(path.join(binDir, 'mihomo', 'old.txt'), 'old-mihomo');
  fs.writeFileSync(path.join(binDir, 'manifest.json'), '{"old":true}');

  await assert.rejects(
    buildCoreBundle({
      binDir,
      goos: 'windows',
      arch: 'amd64',
      bundleSingBox: async (_goos, _arch, outputDir) => {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'sing-box.exe'), 'staged');
        return [];
      },
      bundleMihomo: async () => {
        throw new Error('simulated Mihomo download failure');
      },
    }),
    /simulated Mihomo download failure/
  );
  assert.strictEqual(fs.readFileSync(path.join(binDir, 'singbox', 'old.txt'), 'utf-8'), 'old-singbox');
  assert.strictEqual(fs.readFileSync(path.join(binDir, 'mihomo', 'old.txt'), 'utf-8'), 'old-mihomo');
  assert.deepStrictEqual(
    fs.readdirSync(binDir).filter((name) => name.startsWith('.core-bundle-')),
    []
  );

  const stage = fs.mkdtempSync(path.join(root, 'install-stage-'));
  fs.mkdirSync(path.join(stage, 'singbox'));
  fs.writeFileSync(path.join(stage, 'singbox', 'new.txt'), 'new');
  assert.throws(() => installStagedBundle(stage, binDir), /staged bundle is missing mihomo/);
  assert.strictEqual(fs.readFileSync(path.join(binDir, 'singbox', 'old.txt'), 'utf-8'), 'old-singbox');
  assert.strictEqual(fs.readFileSync(path.join(binDir, 'mihomo', 'old.txt'), 'utf-8'), 'old-mihomo');
});

test('operation coordinator supersedes stale work and closes atomically', () => {
  const coordinator = new OperationCoordinator();
  const first = coordinator.beginRemote('config', 'a');
  assert.doesNotThrow(() => coordinator.assertRemote('config', 'a', first));
  const second = coordinator.beginRemote('config', 'a');
  assert.throws(() => coordinator.assertRemote('config', 'a', first), /superseded/);
  assert.doesNotThrow(() => coordinator.assertRemote('config', 'a', second));
  assert.strictEqual(coordinator.beginRemote('config', 'a', { background: true }), null);
  coordinator.close();
  assert.throws(() => coordinator.assertOpen(), /shutting down/);
});

test('release SBOM includes bundled cores and immutable file hashes', () => {
  const digest = 'c'.repeat(64);
  const sbom = addBundledComponents({ components: [] }, {
    components: [{
      type: 'application',
      name: 'sing-box',
      version: '1.2.3',
      repository: 'https://github.com/blakebill/sing-box',
      license: 'GPL-3.0-or-later',
      asset: 'sing-box.zip',
      assetSha256: 'd'.repeat(64),
      binaryPath: 'singbox/sing-box.exe',
    }],
    files: [{ path: 'singbox/sing-box.exe', sha256: digest }],
  });
  assert.strictEqual(sbom.components[0].hashes[0].content, digest);
  assert.match(sbom.components[0]['bom-ref'], /^pkg:github\/blakebill\/sing-box@1\.2\.3#/);
});

test('release workflow pins actions and isolates write permission to publishing', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf-8');
  const actionRefs = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionRefs.length >= 6);
  assert.ok(actionRefs.every((ref) => /^[a-f0-9]{40}$/.test(ref)), 'every release action must use a full commit SHA');
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /build-windows:[\s\S]*?permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\s*\n\s+contents: write/);
  assert.ok(workflow.includes('Dart releases must be published from blakebill/dart'));
  assert.ok(workflow.includes('INPUT_TAG: ${{ inputs.tag }}'));
  assert.ok(workflow.includes('release-metadata.js --version-from-tag "$TAG"'));
  const versionStep = workflow.match(/- name: Sync package version to release tag([\s\S]*?)\n\s+- name:/);
  assert.ok(versionStep && !versionStep[1].includes('TAG="${{ inputs.tag }}"'));
  const coreDownloadStep = workflow.match(/- name: Download bundled cores and GeoData([\s\S]*?)\n\s+- name:/);
  assert.ok(coreDownloadStep && !coreDownloadStep[1].includes('GITHUB_TOKEN'));
  assert.ok(workflow.includes('release/SHA256SUMS.txt'));
  assert.ok(workflow.includes('release/sbom.cdx.json'));
});

console.log('\nUWP AppContainer:');

const uwp = require('../src/main/uwp');

test('familyNameToSid matches the documented Windows derivation', () => {
  // Microsoft's loopback-exemption docs publish this SID for the legacy Edge
  // AppContainer — a known-good vector for the SHA-256(UTF-16LE) derivation.
  assert.strictEqual(
    uwp.familyNameToSid('Microsoft.MicrosoftEdge_8wekyb3d8bbwe'),
    'S-1-15-2-3624051433-2125758914-1423191267-1740899205-1073925389-3782572162-737981194'
  );
  // Case-insensitive: Windows lowercases the family name before hashing.
  assert.strictEqual(
    uwp.familyNameToSid('MICROSOFT.MICROSOFTEDGE_8wekyb3d8bbwe'),
    uwp.familyNameToSid('microsoft.microsoftedge_8wekyb3d8bbwe')
  );
});

test('prettyName resolves unreadable display names from the package', () => {
  // A real, resolved display name is kept as-is.
  assert.strictEqual(uwp.prettyName({ displayName: 'Microsoft Edge' }), 'Microsoft Edge');
  // Unresolved references (ms-resource:, @{...}, empty) fall back to the
  // package name's leading segment.
  const pkg = { packageFullName: 'Microsoft.AsyncTextService_8wekyb3d8bbwe' };
  assert.strictEqual(uwp.prettyName({ displayName: 'ms-resource:AppDisplayName', ...pkg }), 'Microsoft.AsyncTextService');
  assert.strictEqual(uwp.prettyName({ displayName: '@{Microsoft.X?ms-resource://...}', ...pkg }), 'Microsoft.AsyncTextService');
  assert.strictEqual(uwp.prettyName({ displayName: '', moniker: 'microsoft.paint_8wekyb3d8bbwe' }), 'microsoft.paint');
  // Nothing usable: the SID is the last resort, never an ugly token.
  assert.strictEqual(uwp.prettyName({ displayName: 'ms-resource:x', sid: 'S-1-15-2-9' }), 'S-1-15-2-9');
  // Raw-GUID names are normalized to canonical {UPPERCASE} braces, whatever
  // the input casing or brace state.
  assert.strictEqual(
    uwp.prettyName({ displayName: '1527c705-839a-4832-9118-54d4Bd6a0c89' }),
    '{1527C705-839A-4832-9118-54D4BD6A0C89}'
  );
  assert.strictEqual(
    uwp.prettyName({ displayName: 'E2A4F912-2574-4A75-9BB0-0D023378592B' }),
    '{E2A4F912-2574-4A75-9BB0-0D023378592B}'
  );
});

test('UWP enumeration is prefetched, deduplicated and explicitly refreshable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'uwp.js'), 'utf-8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf-8');
  const main = fs.readFileSync(path.join(rendererDir, 'js', 'main.js'), 'utf-8');
  const dialog = fs.readFileSync(path.join(rendererDir, 'dialog', 'system.js'), 'utf-8');
  assert.ok(source.includes('APP_CACHE_TTL_MS = 5 * 60_000'));
  assert.ok(source.includes('if (!appEnumeration)'));
  assert.ok(source.includes('return cloneApps(await appEnumeration)'));
  assert.ok(source.includes('scheduleAppCacheExpiry(generation)'));
  assert.ok(source.includes('appCacheExpiryTimer.unref'));
  assert.ok(preload.includes('warmUwpApps:'));
  assert.ok(main.includes('api.warmUwpApps()'));
  assert.ok(dialog.includes('api.listUwpApps(force)'));
  assert.ok(dialog.includes("Dialog.bind('#dialogUwpReload', 'click', () => load(true))"));
});

console.log('\nToolbox:');

const toolbox = require('../src/main/toolbox');

test('route targets normalize URLs, domains and IP literals', () => {
  assert.deepStrictEqual(
    toolbox.normalizeTarget('https://Example.COM:8443/path?q=1'),
    { input: 'https://Example.COM:8443/path?q=1', host: 'example.com', port: 8443, ipVersion: 0 }
  );
  assert.strictEqual(toolbox.normalizeTarget('1.1.1.1').ipVersion, 4);
  assert.strictEqual(toolbox.normalizeTarget('[2001:db8::1]').ipVersion, 6);
  assert.throws(() => toolbox.normalizeTarget('bad host'), /invalid/);
});

test('CIDR and common Clash/sing-box route rules match correctly', () => {
  assert.strictEqual(toolbox.cidrContains('10.20.30.40', '10.0.0.0/8'), true);
  assert.strictEqual(toolbox.cidrContains('11.20.30.40', '10.0.0.0/8'), false);
  assert.strictEqual(toolbox.cidrContains('2001:db8::7', '2001:db8::/32'), true);
  const target = toolbox.normalizeTarget('https://api.example.com:443');
  assert.strictEqual(toolbox.matchClashRule('DOMAIN-SUFFIX,example.com,Proxy', target, []), true);
  assert.strictEqual(toolbox.matchClashRule('DST-PORT,80,Proxy', target, []), false);
  assert.strictEqual(toolbox.matchClashRule('IP-CIDR,1.1.1.0/24,Proxy', target, []), null);
  assert.strictEqual(toolbox.matchClashRule('RULE-SET,private,Proxy', target, []), null);
  assert.strictEqual(toolbox.matchSingboxRule({ domain_suffix: ['example.com'], port: [443] }, target, [], 'rule'), true);
  assert.strictEqual(toolbox.matchSingboxRule({ ip_cidr: ['1.1.1.0/24'] }, target, [], 'rule'), null);
  assert.strictEqual(toolbox.matchSingboxRule({ ip_is_private: false }, target, [], 'rule'), null);
  assert.strictEqual(toolbox.matchSingboxRule({ protocol: 'dns' }, target, [], 'rule'), null);
  assert.strictEqual(toolbox.matchSingboxRule({
    type: 'logical', mode: 'or', rules: [{ domain_suffix: ['invalid.test'] }, { domain_suffix: ['example.com'] }],
  }, target, [], 'rule'), true);
  assert.strictEqual(toolbox.matchSingboxRule({
    type: 'logical', mode: 'and', rules: [{ domain_suffix: ['example.com'] }, { port: [80] }],
  }, target, [], 'rule'), false);
});

test('port input is deduplicated and bounded', () => {
  assert.deepStrictEqual(toolbox.parsePorts('7890, 9090 7890'), [7890, 9090]);
  assert.throws(() => toolbox.parsePorts('0, 70000'), /valid ports/);
  assert.throws(() => toolbox.parsePorts(Array.from({ length: 21 }, (_, index) => index + 1)), /valid ports/);
});

test('DNS wire parser reads an A response built from its query', () => {
  const query = toolbox.buildDnsQuery('example.com', 1);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(4, 10);
  Buffer.from([93, 184, 216, 34]).copy(answer, 12);
  const response = Buffer.concat([header, query.slice(12), answer]);
  const records = toolbox.parseDnsMessage(response, query.readUInt16BE(0));
  assert.deepStrictEqual(records, [{ type: 'A', value: '93.184.216.34', ttl: 60 }]);
  assert.throws(() => toolbox.parseDnsMessage(response, (query.readUInt16BE(0) + 1) & 0xffff), /id mismatch/);
  const queryPacket = Buffer.from(response);
  queryPacket.writeUInt16BE(0x0100, 2);
  assert.throws(() => toolbox.parseDnsMessage(queryPacket), /not a response/);
});

test('DNS endpoints accept bare IPv4 and IPv6 resolver addresses', () => {
  assert.deepStrictEqual(
    { ...toolbox.dnsEndpoint('8.8.8.8'), url: null },
    { raw: '8.8.8.8', scheme: 'udp', host: '8.8.8.8', port: 53, url: null }
  );
  const ipv6 = toolbox.dnsEndpoint('2001:4860:4860::8888');
  assert.strictEqual(ipv6.scheme, 'udp');
  assert.strictEqual(ipv6.host, '2001:4860:4860::8888');
  assert.strictEqual(ipv6.port, 53);
  const ipv6Doh = toolbox.dnsEndpoint('https://2001:4860:4860::8888/dns-query');
  assert.strictEqual(ipv6Doh.scheme, 'https');
  assert.strictEqual(ipv6Doh.host, '2001:4860:4860::8888');
  assert.strictEqual(ipv6Doh.port, 443);
  assert.strictEqual(ipv6Doh.url.pathname, '/dns-query');
});

test('DNS comparison assessment flags suspicious and divergent answers', () => {
  const suspicious = toolbox.assessDnsResults([
    { id: 'system', status: 'pass', answers: ['127.0.0.1'] },
    { id: 'remote', status: 'pass', answers: ['93.184.216.34'] },
  ]);
  assert.strictEqual(suspicious.result, 'suspicious-private');
  const divergent = toolbox.assessDnsResults([
    { id: 'system', status: 'pass', answers: ['1.1.1.1'] },
    { id: 'remote', status: 'pass', answers: ['8.8.8.8'] },
  ]);
  assert.strictEqual(divergent.result, 'divergent');
  assert.strictEqual(toolbox.assessDnsResults([
    { id: 'system', status: 'pass', answers: ['1.1.1.1'] },
    { id: 'remote', status: 'pass', answers: ['1.1.1.1', '8.8.8.8'] },
  ]).result, 'no-anomaly');
});

test('config validation errors expose common line, column and object paths', () => {
  assert.deepStrictEqual(
    toolbox.extractErrorLocation('yaml: line 42 column 7: invalid value'),
    { line: 42, column: 7, path: null }
  );
  assert.strictEqual(
    toolbox.extractErrorLocation('parse config error: rules[4050] [GEOIP,CN,DIRECT]').path,
    'rules[4050]'
  );
  assert.strictEqual(
    toolbox.extractErrorLocation('decode config: route.rules[3].outbound: unknown outbound').path,
    'route.rules[3].outbound'
  );
});

test('backup validation preserves supported data and rejects duplicate config ids', () => {
  const store = {
    getSettings: () => ({ coreType: 'mihomo', mixedPort: 7890 }),
    getSubscriptions: () => [{
      id: 'profile-a',
      name: 'A',
      userAgentMode: 'sing-box',
      nodes: [{ name: 'node-a' }],
      policyGroups: [{ name: 'Source', type: 'select', members: ['node-a'] }],
    }],
    get: (key) => ({ activeSub: 'profile-a', selected: 'node-a', customRuleSets: [{ id: 'rule-a' }], localRules: [] }[key]),
  };
  const document = toolbox.buildBackup(store, '0.8.0');
  const normalized = toolbox.validateBackupDocument(document);
  assert.strictEqual(normalized.activeSub, 'profile-a');
  assert.strictEqual(normalized.subscriptions[0].userAgentMode, 'sing-box');
  assert.strictEqual(normalized.subscriptions[0].policyGroups[0].name, 'Source');
  assert.strictEqual(toolbox.backupSummary(document, normalized).nodes, 1);
  document.data.subscriptions.push({ id: 'profile-a' });
  assert.throws(() => toolbox.validateBackupDocument(document), /duplicate config id/);
  document.data.subscriptions.pop();
  document.data.customRuleSets.push({ id: 'rule-a', target: 'proxy' });
  assert.throws(() => toolbox.validateBackupDocument(document), /duplicate remote rule id/);
  document.data.customRuleSets.pop();
  document.data.localRules.push({ id: 'local-a', matchType: 'made-up', values: [] });
  assert.throws(() => toolbox.validateBackupDocument(document), /local rule type is invalid/);
  document.data.localRules.pop();
  document.data.subscriptions[0].userAgentMode = 'surge';
  assert.throws(() => toolbox.validateBackupDocument(document), /User-Agent mode is invalid/);
  document.data.subscriptions[0].userAgentMode = 'sing-box';
  document.data.subscriptions[0].policyGroups[0].members = 'node-a';
  assert.throws(() => toolbox.validateBackupDocument(document), /policy groups are invalid/);
});

console.log('\nVersioning:');

test('package.json and package-lock.json agree on the version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf-8'));
  assert.strictEqual(lock.version, pkg.version, 'package-lock.json top-level version');
  assert.strictEqual(lock.packages[''].version, pkg.version, 'package-lock.json root package version');
});

test('atomic file replacement rolls back on failure and leaves no backup', () => {
  const { replaceFileSync } = require('../src/main/file-utils');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-atomic-'));
  const dest = path.join(dir, 'target.bin');
  fs.writeFileSync(dest, 'known-good');
  assert.throws(() => replaceFileSync(path.join(dir, 'missing.bin'), dest));
  assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
  assert.deepStrictEqual(fs.readdirSync(dir), ['target.bin']);

  const source = path.join(dir, 'new.bin');
  fs.writeFileSync(source, 'updated');
  replaceFileSync(source, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'updated');
  assert.deepStrictEqual(fs.readdirSync(dir), ['target.bin']);
});

test('grouped file replacement restores every target when a later install fails', () => {
  const { replaceFileBatchSync } = require('../src/main/file-utils');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-atomic-group-'));
  const targetA = path.join(dir, 'a.dat');
  const targetB = path.join(dir, 'b.dat');
  const sourceA = path.join(dir, 'a.new');
  const sourceB = path.join(dir, 'b.new');
  fs.writeFileSync(targetA, 'old-a');
  fs.writeFileSync(targetB, 'old-b');
  fs.writeFileSync(sourceA, 'new-a');
  fs.writeFileSync(sourceB, 'new-b');

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === sourceB) throw new Error('simulated second-file failure');
    if (
      target === targetB &&
      source.startsWith(targetB + '.backup-') &&
      !source.includes('.batch-backup-')
    ) {
      throw new Error('simulated inner rollback failure');
    }
    return renameSync(source, target);
  };
  try {
    assert.throws(
      () => replaceFileBatchSync([
        { source: sourceA, target: targetA },
        { source: sourceB, target: targetB },
      ]),
      /simulated second-file failure/
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(fs.readFileSync(targetA, 'utf-8'), 'old-a');
  assert.strictEqual(fs.readFileSync(targetB, 'utf-8'), 'old-b');
  assert.ok(!fs.readdirSync(dir).some((name) => name.includes('batch-backup')));
});

test('grouped replacement preserves recovery copies when rollback also fails', () => {
  const { replaceFileBatchSync } = require('../src/main/file-utils');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-atomic-recovery-'));
  const targetA = path.join(dir, 'a.dat');
  const targetB = path.join(dir, 'b.dat');
  const sourceA = path.join(dir, 'a.new');
  const sourceB = path.join(dir, 'b.new');
  for (const [file, value] of [[targetA, 'old-a'], [targetB, 'old-b'], [sourceA, 'new-a'], [sourceB, 'new-b']]) {
    fs.writeFileSync(file, value);
  }

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === sourceB) throw new Error('simulated install failure');
    if (target === targetB && source.startsWith(targetB + '.backup-')) throw new Error('simulated inner restore failure');
    if (target === targetB && source.includes('.batch-backup-')) throw new Error('simulated batch restore failure');
    return renameSync(source, target);
  };
  let failure;
  try {
    try {
      replaceFileBatchSync([{ source: sourceA, target: targetA }, { source: sourceB, target: targetB }]);
    } catch (error) {
      failure = error;
    }
  } finally {
    fs.renameSync = renameSync;
  }
  assert.ok(failure && failure.restoreErrors && failure.restoreErrors.length);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('b.dat.batch-backup-')));
});

test('downloaded app updates must be plausible PE installers', () => {
  const { validateInstaller } = require('../src/main/update');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-update-'));
  const installer = path.join(dir, 'Dart.Setup.test.exe');
  const fd = fs.openSync(installer, 'w');
  try {
    const header = Buffer.alloc(64);
    header.write('MZ', 0, 'latin1');
    header.writeUInt32LE(128, 0x3c);
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.writeSync(fd, Buffer.from([0x50, 0x45, 0x00, 0x00]), 0, 4, 128);
    fs.ftruncateSync(fd, 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  assert.strictEqual(validateInstaller(installer, 1024 * 1024), true);
  assert.throws(() => validateInstaller(installer, 1024 * 1024 + 1), /size mismatch/);
  fs.writeFileSync(installer, '<html>blocked</html>');
  assert.throws(() => validateInstaller(installer), /unexpectedly small/);
});

console.log('\nStore:');

const { Store } = require('../src/main/store');

test('store writes are atomic: tmp files never survive and data round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.set('subscriptions', [{ id: 'a', name: 'profile-a' }]);
  assert.ok(!fs.existsSync(path.join(dir, 'config.json.tmp')), 'tmp file left behind');
  const reloaded = new Store(dir);
  assert.deepStrictEqual(reloaded.get('subscriptions'), [{ id: 'a', name: 'profile-a' }]);
});

test('store recovers a corrupt index and never deletes payloads without one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-recovery-'));
  const store = new Store(dir);
  store.upsertSubscription({ id: 'profile-a', name: 'Recover me', nodes: [{ name: 'node-a' }] });
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken primary', 'utf-8');
  const recovered = new Store(dir);
  assert.strictEqual(recovered.getSubscription('profile-a').name, 'Recover me');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')));

  const profileDir = path.join(dir, 'profiles');
  const orphan = path.join(profileDir, 'manual-recovery.json');
  fs.writeFileSync(orphan, JSON.stringify({ nodes: [{ name: 'orphan' }] }), 'utf-8');
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken again', 'utf-8');
  fs.writeFileSync(path.join(dir, 'config.json.bak'), '{broken backup', 'utf-8');
  const empty = new Store(dir);
  assert.deepStrictEqual(empty.listSubscriptions(), []);
  assert.ok(fs.existsSync(orphan), 'unrecoverable index corruption deleted orphaned profile data');
  assert.ok(fs.existsSync(path.join(dir, '.payload-recovery-needed')));
});

test('a valid backup remains usable when the corrupt primary cannot be repaired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-readonly-recovery-'));
  const primary = path.join(dir, 'config.json');
  const backup = primary + '.bak';
  fs.writeFileSync(primary, '{broken primary', 'utf-8');
  fs.writeFileSync(backup, JSON.stringify({ settings: { mixedPort: 4321 }, subscriptions: [] }), 'utf-8');

  const originalWrite = Store.prototype._writeAtomic;
  Store.prototype._writeAtomic = function failPrimaryRepair(file, text) {
    if (file === primary) throw new Error('simulated read-only primary');
    return originalWrite.call(this, file, text);
  };
  try {
    const recovered = new Store(dir);
    assert.strictEqual(recovered.getSettings().mixedPort, 4321);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(backup, 'utf-8')));
  } finally {
    Store.prototype._writeAtomic = originalWrite;
  }
});

test('store fallback mode merges metadata-only updates instead of erasing payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-fallback-'));
  const store = new Store(dir);
  store._profileStorageEnabled = false;
  store._ruleStorageEnabled = false;
  store.data.subscriptions = [{
    id: 'profile-a', name: 'Profile', nodes: [{ name: 'node-a' }], raw: 'source', updatedAt: 1,
  }];
  store.data.customRuleSets = [{
    id: 'rules-a', name: 'Rules', kind: 'inline', rules: [{ domain: ['example.com'] }], updatedAt: 1,
  }];

  store.upsertSubscription({ id: 'profile-a', autoUpdateLastAttemptAt: 2 });
  store.upsertCustomRuleSet({ id: 'rules-a', error: 'temporary failure' });

  const profile = store.getSubscription('profile-a', { includeRaw: true });
  const ruleSet = store.getCustomRuleSet('rules-a');
  assert.strictEqual(profile.nodes[0].name, 'node-a');
  assert.strictEqual(profile.raw, 'source');
  assert.strictEqual(profile.autoUpdateLastAttemptAt, 2);
  assert.strictEqual(ruleSet.rules[0].domain[0], 'example.com');
  assert.strictEqual(ruleSet.error, 'temporary failure');
});

test('legacy duplicate or missing record ids are repaired without dropping records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-ids-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    subscriptions: [
      { id: 'duplicate', name: 'A', nodes: [{ name: 'a' }] },
      { id: 'duplicate', name: 'B', nodes: [{ name: 'b' }] },
      { name: 'C', nodes: [{ name: 'c' }] },
    ],
    customRuleSets: [
      { id: 'duplicate', name: 'R1', kind: 'inline', rules: [{ domain: ['a.example'] }] },
      { id: 'duplicate', name: 'R2', kind: 'inline', rules: [{ domain: ['b.example'] }] },
    ],
  }), 'utf-8');
  const store = new Store(dir);
  const subscriptions = store.listSubscriptions();
  const ruleSets = store.listCustomRuleSets();
  assert.strictEqual(subscriptions.length, 3);
  assert.strictEqual(new Set(subscriptions.map((item) => item.id)).size, 3);
  assert.strictEqual(ruleSets.length, 2);
  assert.strictEqual(new Set(ruleSets.map((item) => item.id)).size, 2);
});

test('settings merge defaults with stored values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.updateSettings({
    mixedPort: 1234,
    testUrl: 'https://www.gstatic.com/generate_204',
    testConcurrency: 16,
    enableSmartThroughputProbe: true,
    enableClashApi: false,
  });
  const s = new Store(dir).getSettings();
  assert.strictEqual(s.mixedPort, 1234);
  assert.strictEqual(s.clashApiPort, 9090); // default still present
  assert.strictEqual(s.theme, 'system');
  assert.strictEqual(s.testUrl, 'http://www.gstatic.com/generate_204');
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.strictEqual(persisted.settings.testUrl, 'http://www.gstatic.com/generate_204');
  assert.ok(!Object.prototype.hasOwnProperty.call(persisted.settings, 'enableSmartThroughputProbe'));
  assert.ok(!Object.prototype.hasOwnProperty.call(persisted.settings, 'testConcurrency'));
  assert.ok(!Object.prototype.hasOwnProperty.call(persisted.settings, 'enableClashApi'));
});

test('theme migration defaults incomplete configs to system and preserves explicit choices', () => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-theme-'));
  const missingStore = new Store(missingDir);
  missingStore.updateSettings({ theme: 'light' });
  const missingFile = path.join(missingDir, 'config.json');
  const missingData = JSON.parse(fs.readFileSync(missingFile, 'utf-8'));
  delete missingData.settings.theme;
  fs.writeFileSync(missingFile, JSON.stringify(missingData), 'utf-8');
  const migrated = new Store(missingDir);
  assert.strictEqual(migrated.getSettings().theme, 'system');
  assert.strictEqual(JSON.parse(fs.readFileSync(missingFile, 'utf-8')).settings.theme, 'system');

  const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-theme-'));
  const explicitStore = new Store(explicitDir);
  explicitStore.updateSettings({ theme: 'dark' });
  assert.strictEqual(new Store(explicitDir).getSettings().theme, 'dark');
});

test('large subscription payloads migrate to independent profile files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const legacy = {
    subscriptions: [{
      id: 'profile-a',
      name: 'Large profile',
      url: 'https://example.com/sub',
      nodes: [{ name: 'n', type: 'trojan', server: 'example.com', port: 443, password: 'p' }],
      clashRules: ['MATCH,PROXY'],
      clashRuleProviders: {},
      raw: 'raw-subscription-content',
    }],
    settings: { mixedPort: 7890 },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf-8');

  const store = new Store(dir);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.strictEqual(persisted.subscriptions[0].nodes, undefined);
  assert.strictEqual(persisted.subscriptions[0].raw, undefined);
  assert.strictEqual(persisted.subscriptions[0].dataFile, 'profile-a.json');
  const profilePath = path.join(dir, 'profiles', 'profile-a.json');
  const profileBefore = fs.readFileSync(profilePath, 'utf-8');

  store.updateSettings({ logLevel: 'debug' });
  assert.strictEqual(fs.readFileSync(profilePath, 'utf-8'), profileBefore, 'settings writes do not rewrite profile payloads');
  assert.deepStrictEqual(new Store(dir).get('subscriptions'), legacy.subscriptions);
});

test('profile payloads load on demand with a bounded cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  for (let i = 0; i < 5; i++) {
    store.upsertSubscription({
      id: 'profile-' + i,
      name: 'Profile ' + i,
      nodes: [{ name: 'node-' + i }],
      policyGroups: [{ name: 'Group ' + i, type: 'select', members: ['node-' + i] }],
      raw: 'x'.repeat(1024),
    });
  }
  const reloaded = new Store(dir);
  const summaries = reloaded.listSubscriptions();
  assert.strictEqual(reloaded._profileCache.size, 0, 'startup should not hydrate profile payloads');
  assert.ok(summaries.every((sub) => !('nodes' in sub) && sub.nodeCount === 1));
  assert.strictEqual(reloaded.getSubscription('profile-0').policyGroups[0].name, 'Group 0');
  for (const sub of summaries) reloaded.getSubscription(sub.id);
  assert.ok(reloaded._profileCache.size <= 1, 'profile LRU cache retained more than the active payload');
});

test('repeated payload updates do not retain retired digest entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  for (let index = 0; index < 30; index++) {
    store.upsertSubscription({
      id: 'profile-a', name: 'Profile', nodes: [{ name: `node-${index}` }], raw: `raw-${index}`,
    });
    store.upsertCustomRuleSet({
      id: 'rules-a', name: 'Rules', kind: 'inline',
      rules: [{ domain_suffix: [`d${index}.example`] }],
    });
  }
  assert.strictEqual(store._profileDigests.size, 1);
  assert.strictEqual(store._rawDigests.size, 1);
  assert.strictEqual(store._ruleDigests.size, 1);
});

test('subscription metadata edits do not hydrate or rewrite profile payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({
    id: 'profile-a', name: 'Old name', nodes: [{ name: 'node-a' }], raw: 'raw-a',
  });
  const reloaded = new Store(dir);
  const summary = reloaded.listSubscriptions()[0];
  const profilePath = path.join(dir, 'profiles', reloaded.data.subscriptions[0].dataFile);
  const profileBefore = fs.readFileSync(profilePath, 'utf-8');
  reloaded._readProfileFile = () => { throw new Error('metadata edit hydrated profile'); };
  reloaded.upsertSubscription({ ...summary, name: 'New name', autoUpdateMinutes: 30 });

  assert.strictEqual(fs.readFileSync(profilePath, 'utf-8'), profileBefore);
  const finalStore = new Store(dir);
  assert.strictEqual(finalStore.getSubscription('profile-a').name, 'New name');
  assert.strictEqual(finalStore.getSubscription('profile-a').nodes[0].name, 'node-a');
  assert.strictEqual(finalStore.getSubscription('profile-a', { includeRaw: true }).raw, 'raw-a');
});

test('profile mutations remain all-or-nothing when the config index write fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({
    id: 'profile-a',
    name: 'Old',
    nodes: [{ name: 'old-node' }],
    raw: 'old-raw',
  });
  const originalWrite = store._writeConfigData;
  store._writeConfigData = () => { throw new Error('simulated index failure'); };

  assert.throws(() => store.upsertSubscription({
    id: 'profile-a',
    name: 'New',
    nodes: [{ name: 'new-node' }],
    raw: 'new-raw',
  }), /simulated index failure/);
  assert.throws(() => store.updateSettings({ mixedPort: 12345 }), /simulated index failure/);
  assert.throws(() => store.removeSubscription('profile-a'), /simulated index failure/);
  store._writeConfigData = originalWrite;

  assert.strictEqual(store.getSettings().mixedPort, 7890, 'failed settings write changed memory state');
  const reloaded = new Store(dir).getSubscription('profile-a', { includeRaw: true });
  assert.strictEqual(reloaded.name, 'Old');
  assert.strictEqual(reloaded.nodes[0].name, 'old-node');
  assert.strictEqual(reloaded.raw, 'old-raw');
});

test('bulk payload staging removes files when a later stage fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-stage-'));
  const store = new Store(dir);
  const profileDir = path.join(dir, 'profiles');
  const ruleDir = path.join(dir, 'remote-rules');
  const files = (target) => fs.existsSync(target) ? fs.readdirSync(target).sort() : [];

  const originalStageText = store._stageText;
  let stageCalls = 0;
  store._stageText = function failRawStage(...args) {
    stageCalls += 1;
    if (stageCalls === 2) throw new Error('simulated raw stage failure');
    return originalStageText.apply(this, args);
  };
  assert.throws(() => store.set('subscriptions', [{
    id: 'profile-a', name: 'Profile', nodes: [{ name: 'node-a' }], raw: 'raw-a',
  }]), /simulated raw stage failure/);
  store._stageText = originalStageText;
  assert.deepStrictEqual(files(profileDir), [], 'failed bulk profile staging left a payload file');
  assert.deepStrictEqual(store.listSubscriptions(), []);

  const originalRuleMetadata = store._ruleSetMetadata;
  store._ruleSetMetadata = () => { throw new Error('simulated rule metadata failure'); };
  assert.throws(() => store.set('customRuleSets', [{
    id: 'rules-a', name: 'Rules', kind: 'inline', rules: [{ domain: ['example.com'] }],
  }]), /simulated rule metadata failure/);
  store._ruleSetMetadata = originalRuleMetadata;
  assert.deepStrictEqual(files(ruleDir), [], 'failed bulk rule staging left a payload file');
  assert.deepStrictEqual(store.listCustomRuleSets(), []);
});

test('payload backups self-heal corrupt primaries and startup removes orphan stages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({ id: 'profile-a', name: 'Old', nodes: [{ name: 'old-node' }] });
  store.upsertSubscription({ id: 'profile-a', name: 'New', nodes: [{ name: 'new-node' }] });

  const profileDir = path.join(dir, 'profiles');
  const dataFile = store.data.subscriptions[0].dataFile;
  const profilePath = path.join(profileDir, dataFile);
  assert.ok(fs.existsSync(profilePath + '.bak'), 'updated payload has no recovery copy');
  fs.writeFileSync(profilePath, '{invalid json', 'utf-8');
  fs.writeFileSync(path.join(profileDir, 'orphan.json'), '{}', 'utf-8');

  const reloaded = new Store(dir);
  assert.ok(!fs.existsSync(path.join(profileDir, 'orphan.json')), 'startup kept an unreferenced payload');
  assert.strictEqual(reloaded.getSubscription('profile-a').nodes[0].name, 'old-node');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(profilePath, 'utf-8')));
});

test('raw subscriptions and remote rule payloads stay outside config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertSubscription({
    id: 'profile-a',
    name: 'Profile',
    nodes: [{ name: 'node-a' }],
    raw: 'RAW-CONTENT-SENTINEL',
  });
  store.set('customRuleSets', [{
    id: 'rules-a',
    name: 'Rules',
    kind: 'inline',
    rules: [{ domain_suffix: ['RULE-CONTENT-SENTINEL.example'] }],
  }]);

  const persisted = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
  const persistedBackup = fs.readFileSync(path.join(dir, 'config.json.bak'), 'utf-8');
  assert.ok(!persisted.includes('RAW-CONTENT-SENTINEL'));
  assert.ok(!persisted.includes('RULE-CONTENT-SENTINEL'));
  assert.ok(!persistedBackup.includes('RAW-CONTENT-SENTINEL'));
  assert.ok(!persistedBackup.includes('RULE-CONTENT-SENTINEL'));
  assert.strictEqual(store.getSubscription('profile-a').raw, undefined);
  assert.strictEqual(store.getSubscriptions()[0].raw, undefined);
  assert.strictEqual(store.getSubscription('profile-a', { includeRaw: true }).raw, 'RAW-CONTENT-SENTINEL');
  assert.strictEqual(store.get('subscriptions')[0].raw, 'RAW-CONTENT-SENTINEL');
  assert.strictEqual(store.get('customRuleSets')[0].rules[0].domain_suffix[0], 'RULE-CONTENT-SENTINEL.example');
  assert.ok(fs.readdirSync(path.join(dir, 'remote-rules')).some((name) => name.endsWith('.json')));
});

test('single remote rule mutations preserve peers and roll back failed commits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singbox-store-'));
  const store = new Store(dir);
  store.upsertCustomRuleSet({
    id: 'rules-a', name: 'A', kind: 'inline', target: 'proxy',
    rules: [{ domain_suffix: ['a.example'] }],
  });
  store.upsertCustomRuleSet({
    id: 'rules-b', name: 'B', kind: 'inline', target: 'direct',
    rules: [{ domain_suffix: ['b.example'] }],
  });

  const first = store.listCustomRuleSets().find((item) => item.id === 'rules-a');
  const originalReadPayload = store._readJsonPayload;
  store._readJsonPayload = () => { throw new Error('metadata edit hydrated remote rule'); };
  store.upsertCustomRuleSet({ ...first, name: 'A renamed', autoUpdateMinutes: 30 });
  store._readJsonPayload = originalReadPayload;
  assert.strictEqual(store.getCustomRuleSet('rules-a').rules[0].domain_suffix[0], 'a.example');
  assert.strictEqual(store.getCustomRuleSet('rules-b').rules[0].domain_suffix[0], 'b.example');

  const ruleDir = path.join(dir, 'remote-rules');
  const filesBeforeFailure = fs.readdirSync(ruleDir).sort();
  const originalWrite = store._writeConfigData;
  store._writeConfigData = () => { throw new Error('simulated index failure'); };
  assert.throws(() => store.upsertCustomRuleSet({
    ...store.getCustomRuleSet('rules-a'),
    rules: [{ domain_suffix: ['broken.example'] }],
  }), /simulated index failure/);
  assert.throws(() => store.removeCustomRuleSet('rules-a'), /simulated index failure/);
  store._writeConfigData = originalWrite;

  assert.deepStrictEqual(fs.readdirSync(ruleDir).sort(), filesBeforeFailure, 'failed commit left a staged payload');
  const reloaded = new Store(dir);
  assert.strictEqual(reloaded.getCustomRuleSet('rules-a').name, 'A renamed');
  assert.strictEqual(reloaded.getCustomRuleSet('rules-a').rules[0].domain_suffix[0], 'a.example');
  assert.strictEqual(reloaded.getCustomRuleSet('rules-b').rules[0].domain_suffix[0], 'b.example');

  reloaded.removeCustomRuleSet('rules-a');
  const finalStore = new Store(dir);
  assert.strictEqual(finalStore.getCustomRuleSet('rules-a'), null);
  assert.strictEqual(finalStore.getCustomRuleSet('rules-b').rules[0].domain_suffix[0], 'b.example');
});

console.log('\nCore layout:');

test('Windows proxy registry parsing requires exact field values', () => {
  const proxy = require('../src/main/proxy');
  const enabled = `\r\nHKEY_CURRENT_USER\\Software\\Example\r\n    ProxyEnable    REG_DWORD    0x1\r\n`;
  const server = `\r\nHKEY_CURRENT_USER\\Software\\Example\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n`;
  assert.strictEqual(proxy.registryDwordEnabled(enabled), true);
  assert.strictEqual(proxy.registryValue(server, 'ProxyServer'), '127.0.0.1:7890');
  assert.strictEqual(proxy.proxyServerMatches(server, '127.0.0.1:7890'), true);
  assert.strictEqual(proxy.proxyServerMatches(server, '127.0.0.1:789'), false);
  assert.strictEqual(proxy.proxyServerMatches(server, '127.0.0.1:78900'), false);
});

test('Windows TUN lifecycle owns Dart names and removes legacy adapters', () => {
  const tun = require('../src/main/tun-adapter');
  assert.strictEqual(tun.TUN_DEVICE_NAME, 'Dart');
  assert.strictEqual(tun.TUN_DISPLAY_NAME, 'Dart Tunnel');
  const cleanup = tun.cleanupScript();
  for (const name of ['tun0', 'Meta', 'Dart', 'Dart Tunnel']) assert.ok(cleanup.includes(`'${name}'`));
  assert.ok(cleanup.includes("$connection -eq 'tun0'"));
  assert.ok(cleanup.includes("$description -match 'sing-tun'"));
  assert.ok(cleanup.includes('pnputil.exe'));
  assert.ok(tun.renameScript().includes("Rename-NetAdapter"));
});

test('elevated TUN auto-start preserves silent startup', () => {
  const { buildTaskXml } = require('../src/main/auto-launch');
  const visible = buildTaskXml('C:\\Program Files\\Dart & Tools\\Dart.exe', 'PC\\Blake', false);
  const silent = buildTaskXml('C:\\Program Files\\Dart & Tools\\Dart.exe', 'PC\\Blake', true);
  assert.ok(!visible.includes('<Arguments>'));
  assert.ok(silent.includes('<Arguments>--hidden</Arguments>'));
  assert.ok(silent.includes('Dart &amp; Tools'));
});

test('system DNS diagnostics use the OS resolver path', () => {
  const toolbox = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'toolbox.js'), 'utf-8');
  const start = toolbox.indexOf('async function querySystemDns');
  const end = toolbox.indexOf('function assessDnsResults', start);
  const implementation = toolbox.slice(start, end);
  assert.ok(implementation.includes('dns.promises.lookup'));
  assert.ok(!implementation.includes('dns.promises.resolve4'));
  assert.ok(!implementation.includes('dns.promises.resolve6'));
});

test('selected cores use independent runtime folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const { CoreManager } = require('../src/main/singbox');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const fakeDat = Buffer.alloc(2048);
  for (let i = 0; i < fakeDat.length; i++) fakeDat[i] = (i * 31) & 0xff;
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'sing-box' + ext), 'legacy-singbox');
  fs.writeFileSync(path.join(dir, 'bin', 'mihomo' + ext), 'legacy-mihomo');
  fs.writeFileSync(path.join(dir, 'geoip.dat'), fakeDat);
  const mgr = new CoreManager({ runtimeDir: dir });

  assert.strictEqual(mgr.coreDir('sing-box'), path.join(dir, 'singbox'));
  assert.strictEqual(mgr.coreDir('mihomo'), path.join(dir, 'mihomo'));
  assert.ok(fs.existsSync(path.join(dir, 'singbox', 'sing-box' + ext)), 'sing-box was not migrated');
  assert.ok(fs.existsSync(path.join(dir, 'mihomo', 'mihomo' + ext)), 'mihomo was not migrated');
  assert.ok(fs.existsSync(path.join(dir, 'mihomo', 'geoip.dat')), 'mihomo GeoData was not migrated');
  assert.strictEqual(mgr.resolveBinaryPath(), path.join(dir, 'singbox', 'sing-box' + ext));
  assert.strictEqual(mgr.resolveBinaryPath('mihomo'), path.join(dir, 'mihomo', 'mihomo' + ext));
  assert.strictEqual(mgr.configPath, path.join(dir, 'singbox', 'config.json'));

  mgr.setCoreType('mihomo');
  assert.strictEqual(mgr.resolveBinaryPath(), path.join(dir, 'mihomo', 'mihomo' + ext));
  assert.strictEqual(mgr.configPath, path.join(dir, 'mihomo', 'config.yaml'));
  assert.ok(mgr._coreEnv().SAFE_PATHS.split(path.delimiter).includes(path.join(dir, 'ui')));
});

test('bundled Dart sing-box replaces a compatible official runtime override once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-resources-'));
  const { CoreManager } = require('../src/main/singbox');
  const binName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const runtimeBin = path.join(dir, 'singbox', binName);
  const bundledBin = path.join(resources, 'singbox', binName);
  fs.mkdirSync(path.dirname(runtimeBin), { recursive: true });
  fs.mkdirSync(path.dirname(bundledBin), { recursive: true });
  fs.writeFileSync(runtimeBin, 'official');
  fs.writeFileSync(bundledBin, 'dart');

  const logs = [];
  const mgr = new CoreManager({ runtimeDir: dir, resourcesDir: resources, onLog: (line) => logs.push(line) });
  let probes = 0;
  mgr._probeCoreVersion = async (bin) => {
    probes++;
    return bin === bundledBin ? '1.13.14-dart.1' : '1.13.14';
  };
  assert.strictEqual(await mgr.ensureBundledSingBoxPatch(), true);
  assert.strictEqual(await mgr.ensureBundledSingBoxPatch(), false);
  assert.strictEqual(fs.readFileSync(runtimeBin, 'utf-8'), 'dart');
  assert.strictEqual(probes, 2);
  assert.ok(logs.some((line) => line.includes('1.13.14-dart.1')));
});

test('bundled Dart sing-box never downgrades a newer runtime core', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-resources-'));
  const { CoreManager } = require('../src/main/singbox');
  const binName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const runtimeBin = path.join(dir, 'singbox', binName);
  const bundledBin = path.join(resources, 'singbox', binName);
  fs.mkdirSync(path.dirname(runtimeBin), { recursive: true });
  fs.mkdirSync(path.dirname(bundledBin), { recursive: true });
  fs.writeFileSync(runtimeBin, 'newer-official');
  fs.writeFileSync(bundledBin, 'older-dart');

  const mgr = new CoreManager({ runtimeDir: dir, resourcesDir: resources });
  mgr._probeCoreVersion = async (bin) => bin === bundledBin ? '1.13.14-dart.1' : '1.14.0';
  assert.strictEqual(await mgr.ensureBundledSingBoxPatch(), false);
  assert.strictEqual(fs.readFileSync(runtimeBin, 'utf-8'), 'newer-official');
});

test('sing-box geodata self-heals invalid writable rule-sets from bundled files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-resources-'));
  const bundled = path.join(resources, 'singbox');
  const writable = path.join(dir, 'singbox');
  const srs = Buffer.concat([Buffer.from('SRS'), Buffer.alloc(16, 1)]);
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(writable, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'geoip-cn.srs'), srs);
  fs.writeFileSync(path.join(bundled, 'geosite-cn.srs'), srs);
  fs.writeFileSync(path.join(writable, 'geoip-cn.srs'), Buffer.from('<html>blocked</html>'));
  fs.writeFileSync(path.join(writable, 'geosite-cn.srs'), Buffer.alloc(1));

  const { CoreManager } = require('../src/main/singbox');
  const mgr = new CoreManager({ runtimeDir: dir, resourcesDir: resources });

  assert.strictEqual(mgr.ensureSingBoxGeoData(), true);
  assert.strictEqual(mgr.resolveRuleSetDir(), writable);
  assert.ok(mgr._validSrs(path.join(writable, 'geoip-cn.srs')), 'geoip-cn.srs was not restored');
  assert.ok(mgr._validSrs(path.join(writable, 'geosite-cn.srs')), 'geosite-cn.srs was not restored');
});

test('mihomo geodata validation cache survives restarts and follows core changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-core-'));
  const { CoreManager } = require('../src/main/singbox');
  const mgr = new CoreManager({ runtimeDir: dir, coreType: 'mihomo' });
  const coreDir = mgr.ensureCoreDir('mihomo');
  const bin = path.join(coreDir, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  fs.writeFileSync(bin, 'fake-core');
  const geo = Buffer.alloc(4096);
  for (let i = 0; i < geo.length; i++) geo[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(path.join(coreDir, 'geoip.dat'), geo);
  fs.writeFileSync(path.join(coreDir, 'geosite.dat'), geo);
  const mmdb = Buffer.from(geo);
  Buffer.from('MaxMind.com').copy(mmdb, mmdb.length - 32);
  fs.writeFileSync(path.join(coreDir, 'country.mmdb'), mmdb);

  const key = mgr._mihomoGeoDataKey(coreDir, bin);
  fs.writeFileSync(
    path.join(coreDir, '.mihomo-geodata-validation.json'),
    JSON.stringify({ key, ok: true }),
    'utf-8'
  );
  assert.strictEqual(mgr.mihomoGeoDataReady(), true, 'cached validation avoids spawning the fake core');
  fs.appendFileSync(bin, '-updated');
  assert.notStrictEqual(mgr._mihomoGeoDataKey(coreDir, bin), key, 'a core update invalidates the cache key');
});

Promise.all(pendingTests).then(() => {
  console.log(`\nDone, ${passed} tests passed.`);
});
