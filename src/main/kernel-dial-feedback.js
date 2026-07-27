'use strict';

const DEFAULT_PATH = '/dart/dial-feedback';
const SIGNALS = new Set(['tcp', 'udp', 'handshake', 'first-byte']);

function finiteSequence(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeInstance(value) {
  if (typeof value === 'string') {
    const instance = value.trim();
    return instance ? instance.slice(0, 128) : null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function normalizedName(event) {
  for (const value of [event && event.outbound, event && event.node, event && event.name]) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function normalizeDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.min(120_000, number)
    : null;
}

function isUnsupportedError(error) {
  return /\b(?:404|405|501)\b/.test(String(error && error.message || error || ''));
}

/**
 * Incremental client for Dart custom-kernel dial events.
 *
 * The kernel ring is bounded and carries no destination address. Official
 * kernels simply return 404, which disables this probe until the core restarts.
 */
class KernelDialFeedback {
  constructor(options = {}) {
    this.path = String(options.path || DEFAULT_PATH);
    this.maxEvents = Math.max(1, Math.min(1_024, Math.floor(Number(options.maxEvents) || 512)));
    this.retryMs = Math.max(1_000, Number(options.retryMs) || 30_000);
    this.reset();
  }

  reset() {
    this.sequence = 0;
    this.instance = null;
    this.supported = null;
    this.retryAt = 0;
  }

  _requestPath(sequence) {
    // New Dart kernels expose detailed health phases only when requested.
    // Older custom kernels ignore the extra query parameter and keep returning
    // their legacy terminal dial events.
    const params = new URLSearchParams({
      since: String(sequence),
      signals: '1',
    });
    return `${this.path}?${params.toString()}`;
  }

  _normalizeEvents(data, previousSequence, options) {
    const restrictNames = options.allowedNames instanceof Set || Array.isArray(options.allowedNames);
    const allowedNames = options.allowedNames instanceof Set
      ? options.allowedNames
      : new Set(Array.isArray(options.allowedNames) ? options.allowedNames : []);
    const requiredGroup = typeof options.group === 'string' ? options.group : '';
    const rows = Array.isArray(data && data.events) ? data.events.slice(-this.maxEvents) : [];
    const events = [];
    for (const event of rows) {
      if (!event || typeof event !== 'object') continue;
      const sequence = finiteSequence(event.sequence);
      if (sequence == null || sequence <= previousSequence) continue;
      if (requiredGroup && event.group && event.group !== requiredGroup) continue;
      const name = normalizedName(event);
      if (!name || (restrictNames && !allowedNames.has(name))) continue;
      const success = event.success;
      if (success !== true && success !== false) continue;
      const rawSignal = String(event.signal || '').trim().toLowerCase();
      if (rawSignal && !SIGNALS.has(rawSignal)) continue;
      const rawNetwork = String(event.network || '').toLowerCase();
      const signal = rawSignal || (rawNetwork === 'udp' ? 'udp' : 'tcp');
      const errorClass = String(event.errorClass || '').trim().toLowerCase().slice(0, 64);
      // Context/user cancellation says nothing about node health.
      if (success === false && errorClass === 'canceled') continue;
      const durationMs = normalizeDuration(event.durationMs);
      events.push({
        name,
        kind: success ? 'dialSuccess' : (errorClass === 'soft-fail' ? 'softFail' : 'dialFailure'),
        ...(durationMs == null ? {} : { durationMs }),
        network: signal === 'udp' ? 'udp' : 'tcp',
        signal,
        ...(errorClass ? { errorClass } : {}),
        sequence,
      });
    }
    return events;
  }

  async _fetch(request, sequence) {
    const data = await request(this._requestPath(sequence));
    const latest = finiteSequence(data && data.sequence);
    if (latest == null) throw new Error('invalid dial feedback sequence');
    return {
      data,
      latest,
      instance: normalizeInstance(data && data.instance),
    };
  }

  /**
   * @returns {{
   *   supported: boolean|null,
   *   available: boolean,
   *   events: object[],
   *   restarted?: boolean
   * }}
   */
  async poll(request, options = {}) {
    if (typeof request !== 'function') throw new Error('dial feedback request is required');
    const now = Number(options.now) || Date.now();
    if (this.supported === false) return { supported: false, available: false, events: [] };
    if (this.retryAt > now) {
      return { supported: this.supported, available: false, events: [] };
    }

    const previousSequence = this.sequence;
    let response;
    try {
      response = await this._fetch(request, previousSequence);
    } catch (error) {
      if (isUnsupportedError(error)) {
        this.supported = false;
        this.retryAt = 0;
      } else {
        this.retryAt = now + this.retryMs;
      }
      return { supported: this.supported, available: false, events: [], error };
    }

    this.supported = true;
    this.retryAt = 0;
    let restarted = false;
    let baseSequence = previousSequence;
    const firstInstance = response.instance;
    const instanceChanged = this.instance != null &&
      firstInstance != null &&
      firstInstance !== this.instance;
    if (instanceChanged || response.latest < previousSequence) {
      // New kernels expose a per-process instance id, which also catches a
      // restart whose new sequence has already overtaken the old cursor. Older
      // kernels remain compatible through the sequence rollback check.
      restarted = true;
      baseSequence = 0;
      try {
        response = await this._fetch(request, 0);
      } catch (error) {
        this.sequence = 0;
        if (firstInstance != null) this.instance = firstInstance;
        this.retryAt = now + this.retryMs;
        return { supported: true, available: false, events: [], restarted, error };
      }
    }

    const events = this._normalizeEvents(response.data, baseSequence, options);
    this.sequence = response.latest;
    if (response.instance != null) this.instance = response.instance;
    else if (firstInstance != null) this.instance = firstInstance;
    return { supported: true, available: true, events, restarted };
  }
}

module.exports = {
  DEFAULT_PATH,
  KernelDialFeedback,
  isUnsupportedError,
};
