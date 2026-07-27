'use strict';

const DEFAULT_PRIMARY_WEIGHT = 0.55;
const DEFAULT_SECONDARY_WEIGHT = 0.45;

function validDelay(value) {
  return Number.isFinite(value) && value >= 0 && value <= 120_000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeEndpoint(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function transportFamily(node) {
  const type = String(node && node.type || '').toLowerCase();
  if (['hysteria', 'hysteria2', 'tuic', 'wireguard'].includes(type)) return 'udp';
  return 'tcp';
}

/**
 * A probe family represents a shared first-hop path, not a display region.
 * Nodes sharing a detour or physical endpoint are sampled in separate passes
 * before a bounded batch spends more slots on the same underlying route.
 */
function smartProbeFamily(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const detour = [
    node.detour,
    node['dialer-proxy'],
    node.dialer_proxy,
    node.dialerProxy,
    node['underlying-proxy'],
    node.underlyingProxy,
  ].map(normalizeEndpoint).find(Boolean);
  if (detour) return `detour:${detour}`;

  const endpoint = normalizeEndpoint(
    node.server || node.address || node.host || node.hostname
  );
  return endpoint ? `${transportFamily(node)}:${endpoint}` : '';
}

function buildSmartProbeFamilies(nodes, names = null) {
  const allowed = names ? new Set(names) : null;
  const families = new Map();
  for (const node of nodes || []) {
    const name = node && typeof node.name === 'string' ? node.name : '';
    if (!name || (allowed && !allowed.has(name)) || families.has(name)) continue;
    families.set(name, smartProbeFamily(node) || `node:${name}`);
  }
  for (const name of names || []) {
    if (typeof name === 'string' && name && !families.has(name)) {
      families.set(name, `node:${name}`);
    }
  }
  return families;
}

function emptySignalState() {
  return {
    availability: 1,
    stability: 1,
    samples: 0,
  };
}

/**
 * Learns URL-test reliability independently for every profile + network.
 * Availability drops quickly on a cohort failure, while recovery is slower so
 * one lucky response cannot immediately restore a previously broken source.
 */
class SmartProbeSignalWeights {
  constructor(options = {}) {
    this.primaryBase = clamp(options.primaryWeight ?? DEFAULT_PRIMARY_WEIGHT, 0.05, 0.95);
    this.secondaryBase = clamp(options.secondaryWeight ?? DEFAULT_SECONDARY_WEIGHT, 0.05, 0.95);
    const total = this.primaryBase + this.secondaryBase;
    this.primaryBase /= total;
    this.secondaryBase /= total;
    this.degradeAlpha = clamp(options.degradeAlpha ?? 0.4, 0.05, 1);
    this.recoveryAlpha = clamp(options.recoveryAlpha ?? 0.12, 0.01, 1);
    this.minSourceWeight = clamp(options.minSourceWeight ?? 0.12, 0, 0.4);
    this.maxContexts = Math.max(1, Math.min(32, Math.floor(Number(options.maxContexts) || 8)));
    this.contexts = new Map();
  }

  reset() {
    this.contexts.clear();
  }

  _key(contextKey, networkKey) {
    return JSON.stringify([
      contextKey == null ? 'default' : String(contextKey),
      networkKey == null ? 'unknown' : String(networkKey),
    ]);
  }

  _context(contextKey, networkKey) {
    const key = this._key(contextKey, networkKey);
    let state = this.contexts.get(key);
    if (!state) {
      state = {
        primary: emptySignalState(),
        secondary: emptySignalState(),
        lastUsed: Date.now(),
      };
    } else {
      this.contexts.delete(key);
    }
    state.lastUsed = Date.now();
    this.contexts.set(key, state);
    while (this.contexts.size > this.maxContexts) {
      this.contexts.delete(this.contexts.keys().next().value);
    }
    return state;
  }

  _updateSource(target, source, measurements, model) {
    const valueKey = source + 'Delay';
    const freshKey = source + 'Fresh';
    const ewmaKey = source + 'Ewma';
    const attempts = [];
    const innovations = [];

    for (const measurement of measurements || []) {
      if (!measurement || measurement[freshKey] !== true) continue;
      attempts.push(measurement);
      const value = measurement[valueKey];
      if (!validDelay(value) || !model || typeof model.peek !== 'function') continue;
      const previous = model.peek(measurement.name);
      const baseline = previous && previous[ewmaKey];
      if (validDelay(baseline)) {
        innovations.push(Math.abs(Number(value) - Number(baseline)) / Math.max(40, Number(baseline)));
      }
    }
    if (!attempts.length) return;

    const successes = attempts.filter((item) => validDelay(item[valueKey])).length;
    const availability = successes / attempts.length;
    const typicalInnovation = median(innovations);
    const stability = typicalInnovation == null
      ? 1
      : clamp(1 / (1 + typicalInnovation * 2), 0.15, 1);
    const nextHealth = availability * stability;
    const currentHealth = target.availability * target.stability;
    const alpha = nextHealth < currentHealth ? this.degradeAlpha : this.recoveryAlpha;
    target.availability += (availability - target.availability) * alpha;
    target.stability += (stability - target.stability) * alpha;
    target.samples = Math.min(1_000_000, target.samples + attempts.length);
  }

  update(measurements, model, contextKey, networkKey) {
    const state = this._context(contextKey, networkKey);
    this._updateSource(state.primary, 'primary', measurements, model);
    this._updateSource(state.secondary, 'secondary', measurements, model);
    return this.weights(contextKey, networkKey);
  }

  weights(contextKey, networkKey) {
    const state = this._context(contextKey, networkKey);
    const primaryHealth = clamp(state.primary.availability * state.primary.stability, 0.02, 1);
    const secondaryHealth = clamp(state.secondary.availability * state.secondary.stability, 0.02, 1);
    const primaryScore = this.primaryBase * primaryHealth;
    const secondaryScore = this.secondaryBase * secondaryHealth;
    const total = primaryScore + secondaryScore;
    let primary = total > 0 ? primaryScore / total : this.primaryBase;
    primary = clamp(primary, this.minSourceWeight, 1 - this.minSourceWeight);
    return { primary, secondary: 1 - primary };
  }

  blend(primaryDelay, secondaryDelay, weights) {
    const primaryValid = validDelay(primaryDelay);
    const secondaryValid = validDelay(secondaryDelay);
    if (!primaryValid && !secondaryValid) return null;
    if (!primaryValid) return Number(secondaryDelay);
    if (!secondaryValid) return Number(primaryDelay);
    const sourceWeights = weights || {
      primary: this.primaryBase,
      secondary: this.secondaryBase,
    };
    const primary = clamp(sourceWeights.primary, 0, 1);
    const secondary = clamp(sourceWeights.secondary, 0, 1);
    const total = primary + secondary;
    if (total <= 0) return (Number(primaryDelay) + Number(secondaryDelay)) / 2;
    return (Number(primaryDelay) * primary + Number(secondaryDelay) * secondary) / total;
  }

  /**
   * Update cohort reliability, then stamp each measurement with the weights
   * SmartSelectionModel should use for its independently maintained EWMAs.
   */
  annotate(measurements, model, contextKey, networkKey) {
    const list = Array.isArray(measurements) ? measurements : [];
    const learned = this.update(list, model, contextKey, networkKey);
    return list.map((measurement) => {
      if (!measurement || (
        !Object.prototype.hasOwnProperty.call(measurement, 'primaryDelay') &&
        !Object.prototype.hasOwnProperty.call(measurement, 'secondaryDelay')
      )) return measurement;
      let primaryWeight = validDelay(measurement.primaryDelay) ? learned.primary : 0;
      let secondaryWeight = validDelay(measurement.secondaryDelay) ? learned.secondary : 0;
      const total = primaryWeight + secondaryWeight;
      if (total > 0) {
        primaryWeight /= total;
        secondaryWeight /= total;
      }
      return {
        ...measurement,
        delay: this.blend(
          measurement.primaryDelay,
          measurement.secondaryDelay,
          { primary: primaryWeight, secondary: secondaryWeight }
        ),
        primaryWeight,
        secondaryWeight,
      };
    });
  }

  peek(contextKey, networkKey) {
    const state = this.contexts.get(this._key(contextKey, networkKey));
    if (!state) return null;
    return {
      primary: { ...state.primary },
      secondary: { ...state.secondary },
      weights: this.weights(contextKey, networkKey),
    };
  }
}

module.exports = {
  DEFAULT_PRIMARY_WEIGHT,
  DEFAULT_SECONDARY_WEIGHT,
  SmartProbeSignalWeights,
  smartProbeFamily,
  buildSmartProbeFamilies,
};
