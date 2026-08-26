'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writeJsonAtomicSync } = require('./file-utils');

const FORMAT_VERSION = 1;

function pairs(value) {
  return Array.isArray(value)
    ? value.filter((entry) => Array.isArray(entry) && entry.length === 2)
    : [];
}

function encodeSnapshot(snapshot) {
  const networkContexts = snapshot.networkContexts instanceof Map
    ? snapshot.networkContexts
    : new Map(Object.entries(snapshot.networkContexts || {}));
  return {
    networkKey: snapshot.networkKey,
    selected: snapshot.selected,
    selectedAt: snapshot.selectedAt,
    calibrationOptions: snapshot.calibrationOptions || {},
    identities: [...(snapshot.identities instanceof Map ? snapshot.identities : new Map()).entries()],
    nodes: [...(snapshot.nodes instanceof Map ? snapshot.nodes : new Map()).entries()],
    networkContexts: [...networkContexts.entries()].map(([key, entry]) => [key, {
      savedAt: entry && entry.savedAt,
      selected: entry && entry.selected,
      nodes: [...(entry && entry.nodes instanceof Map ? entry.nodes : new Map()).entries()],
    }]),
  };
}

function decodeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    ...value,
    identities: new Map(pairs(value.identities)),
    nodes: new Map(pairs(value.nodes)),
    networkContexts: new Map(pairs(value.networkContexts).map(([key, entry]) => [key, {
      savedAt: entry && entry.savedAt,
      selected: entry && entry.selected,
      nodes: new Map(pairs(entry && entry.nodes)),
    }])),
  };
}

class SmartModelStore {
  constructor(model, options = {}) {
    if (!model || typeof model.snapshot !== 'function' || typeof model.restore !== 'function') {
      throw new TypeError('Smart model snapshot/restore support is required');
    }
    this.model = model;
    this.getDirectory = typeof options.getDirectory === 'function' ? options.getDirectory : () => '';
    this.fileName = path.basename(options.fileName || 'smart-model-state.json');
    this.persistDelayMs = Math.max(0, Number(options.persistDelayMs) || 60_000);
    this.maxFileBytes = Math.max(64 * 1024, Number(options.maxFileBytes) || 4 * 1024 * 1024);
    this.maxContexts = Math.max(1, Number(options.maxContexts) || 8);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.contexts = new Map();
    this.currentKey = null;
    this.loadedFile = null;
    this.timer = null;
    this.closed = false;
    this.persistFailed = false;
  }

  filePath() {
    const dir = this.getDirectory();
    return typeof dir === 'string' && dir ? path.join(dir, this.fileName) : '';
  }

  load() {
    const file = this.filePath();
    if (!file || this.loadedFile === file) return;
    this.loadedFile = file;
    this.contexts.clear();
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxFileBytes) return;
      const document = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!document || document.version !== FORMAT_VERSION || !Array.isArray(document.contexts)) return;
      for (const item of document.contexts.slice(-this.maxContexts)) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || item[0].length > 128) continue;
        const decoded = decodeSnapshot(item[1] && item[1].snapshot);
        if (decoded) this.contexts.set(item[0], {
          savedAt: Math.max(0, Number(item[1].savedAt) || 0),
          snapshot: decoded,
        });
      }
    } catch (_) {
      // Missing/corrupt advisory history falls back to a cold model.
    }
  }

  captureCurrent() {
    if (!this.currentKey) return;
    this.contexts.delete(this.currentKey);
    this.contexts.set(this.currentKey, { savedAt: Date.now(), snapshot: this.model.snapshot() });
    while (this.contexts.size > this.maxContexts) this.contexts.delete(this.contexts.keys().next().value);
  }

  switchContext(storageKey, modelContextKey = storageKey) {
    if (this.closed) return false;
    const key = String(storageKey || '').slice(0, 128);
    const contextKey = String(modelContextKey || '').slice(0, 2048);
    this.load();
    if (this.currentKey === key) return false;
    this.captureCurrent();
    this.currentKey = key;
    const saved = this.contexts.get(key);
    if (saved) this.model.restore(saved.snapshot, contextKey);
    else this.model.clear(contextKey || null);
    this.touch();
    return !!saved;
  }

  touch() {
    if (this.closed || this.timer || !this.filePath()) return;
    this.timer = setTimeout(() => this.flush(), this.persistDelayMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush(options = {}) {
    if (this.closed && !options.allowClosed) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const file = this.filePath();
    if (!file) return false;
    this.captureCurrent();
    const serialize = () => ({
      version: FORMAT_VERSION,
      contexts: [...this.contexts.entries()].map(([key, entry]) => [key, {
        savedAt: entry.savedAt,
        snapshot: encodeSnapshot(entry.snapshot),
      }]),
    });
    let document = serialize();
    while (Buffer.byteLength(JSON.stringify(document), 'utf-8') > this.maxFileBytes && this.contexts.size > 1) {
      const oldest = [...this.contexts.keys()].find((key) => key !== this.currentKey);
      if (!oldest) break;
      this.contexts.delete(oldest);
      document = serialize();
    }
    if (Buffer.byteLength(JSON.stringify(document), 'utf-8') > this.maxFileBytes) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomicSync(file, document);
      this.persistFailed = false;
      return true;
    } catch (error) {
      if (!this.persistFailed) {
        this.persistFailed = true;
        this.log('[gui] Smart model state could not be saved: ' + error.message);
      }
      return false;
    }
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function contextStorageKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

module.exports = { SmartModelStore, contextStorageKey, encodeSnapshot, decodeSnapshot };
