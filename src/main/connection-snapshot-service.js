'use strict';

const {
  MAX_IPC_CONNECTIONS,
  recentConnections,
} = require('./ipc-validation');

const DEFAULT_TTL_MS = 750;
const MAX_SMART_FEEDBACK_CONNECTIONS = 2_000;

function boundedCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, number)
    : 0;
}

function boundedText(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function connectionSortKey(value) {
  const connection = value && typeof value === 'object' ? value : {};
  const id = typeof connection.id === 'string' && connection.id.length <= 1024
    ? connection.id
    : '';
  return boundedText(connection.start, 128) + '\0' + id;
}

/** Renderer-safe, bounded projection for the most recent connections. */
function projectConnectionRows(source, limit = MAX_IPC_CONNECTIONS) {
  return recentConnections(source, limit, connectionSortKey).map((value) => {
    const connection = value && typeof value === 'object' ? value : {};
    const metadata = connection.metadata && typeof connection.metadata === 'object'
      ? connection.metadata
      : {};
    return {
      id: typeof connection.id === 'string' && connection.id.length <= 1024
        ? connection.id
        : '',
      start: boundedText(connection.start, 128),
      upload: boundedCounter(connection.upload),
      download: boundedCounter(connection.download),
      rule: boundedText(connection.rule),
      chains: Array.isArray(connection.chains)
        ? connection.chains.slice(0, 16).map((item) => boundedText(item))
        : [],
      metadata: {
        host: boundedText(metadata.host, 1024),
        destinationIP: boundedText(metadata.destinationIP, 128),
        destinationPort: boundedText(String(metadata.destinationPort || ''), 32),
        network: boundedText(metadata.network, 32),
      },
    };
  });
}

/**
 * Main-process-only projection used by ConnectionFeedbackTracker. It retains
 * only the fields the tracker reads, so Smart does not keep whole Clash
 * connection objects alive between samples.
 */
function projectFeedbackConnections(source) {
  const result = [];
  const recent = recentConnections(source, MAX_SMART_FEEDBACK_CONNECTIONS, connectionSortKey);
  for (const value of recent) {
    const connection = value && typeof value === 'object' ? value : null;
    if (!connection || typeof connection.id !== 'string' || !connection.id) continue;
    const metadata = connection.metadata && typeof connection.metadata === 'object'
      ? connection.metadata
      : {};
    result.push({
      id: boundedText(connection.id, 1024),
      start: boundedText(connection.start, 128),
      upload: boundedCounter(connection.upload),
      download: boundedCounter(connection.download),
      chains: Array.isArray(connection.chains)
        ? connection.chains.slice(0, 32).map((item) => boundedText(item))
        : [],
      network: boundedText(connection.network, 32),
      metadata: {
        host: boundedText(metadata.host, 1024),
        destinationIP: boundedText(metadata.destinationIP, 128),
        network: boundedText(metadata.network, 32),
      },
    });
  }
  return result;
}

function createSnapshot(data, fetchedAt) {
  const source = Array.isArray(data && data.connections) ? data.connections : [];
  let rows = null;
  let feedback = null;
  return {
    fetchedAt,
    totalConnections: source.length,
    up: boundedCounter(data && data.uploadTotal),
    down: boundedCounter(data && data.downloadTotal),
    rows() {
      if (!rows) rows = projectConnectionRows(source);
      return rows;
    },
    feedback() {
      if (!feedback) feedback = projectFeedbackConnections(source);
      return feedback;
    },
  };
}

/**
 * Single-flight, short-lived view over Mihomo's /connections endpoint.
 * Consumers share JSON parsing and only materialize the projection they need.
 */
class ConnectionSnapshotService {
  constructor(options = {}) {
    if (typeof options.load !== 'function') throw new Error('connection snapshot loader is required');
    this.load = options.load;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.ttlMs = Math.max(100, Math.min(5_000, Number(options.ttlMs) || DEFAULT_TTL_MS));
    this.generation = 0;
    this.cached = null;
    this.expiresAt = 0;
    this.pending = null;
    this.expiryTimer = null;
  }

  invalidate() {
    this.generation += 1;
    this.cached = null;
    this.expiresAt = 0;
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    // A read from an older generation may finish, but a new caller must never
    // join it after a connection mutation or core lifecycle transition.
    this.pending = null;
  }

  async snapshot() {
    const now = this.now();
    if (this.cached && now < this.expiresAt) return this.cached;
    if (this.pending) return this.pending;

    const generation = this.generation;
    let loaded;
    try {
      // Start immediately so callers can invalidate an already-running read;
      // Promise.resolve below still normalizes synchronous and async loaders.
      loaded = this.load();
    } catch (error) {
      return Promise.reject(error);
    }
    const request = Promise.resolve(loaded)
      .then((data) => {
        const snapshot = createSnapshot(data, this.now());
        if (generation === this.generation) {
          this.cached = snapshot;
          this.expiresAt = snapshot.fetchedAt + this.ttlMs;
          if (this.expiryTimer) this.clearTimer(this.expiryTimer);
          const expiryTimer = this.setTimer(() => {
            if (this.cached === snapshot) {
              // createSnapshot lazily closes over Mihomo's full response. Drop
              // it at TTL even when no consumer asks again, so leaving the
              // Connections page or deactivating Smart cannot retain it.
              this.cached = null;
              this.expiresAt = 0;
            }
            if (this.expiryTimer === expiryTimer) this.expiryTimer = null;
          }, this.ttlMs);
          this.expiryTimer = expiryTimer;
          if (this.expiryTimer.unref) this.expiryTimer.unref();
        }
        return snapshot;
      })
      .finally(() => {
        if (this.pending === request) this.pending = null;
      });
    this.pending = request;
    return request;
  }

  async summary() {
    const snapshot = await this.snapshot();
    return {
      totalConnections: snapshot.totalConnections,
      up: snapshot.up,
      down: snapshot.down,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async rendererRows() {
    const snapshot = await this.snapshot();
    return {
      connections: snapshot.rows(),
      totalConnections: snapshot.totalConnections,
      up: snapshot.up,
      down: snapshot.down,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async smartFeedback() {
    const snapshot = await this.snapshot();
    return snapshot.feedback();
  }
}

module.exports = {
  ConnectionSnapshotService,
  boundedCounter,
  boundedText,
  projectConnectionRows,
  projectFeedbackConnections,
};
