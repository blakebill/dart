'use strict';

class OperationCoordinator {
  constructor() {
    this.closing = false;
    this.remoteTokens = new Map();
    this.remoteEpoch = 0;
    this.tails = new Map();
  }

  assertOpen() {
    if (!this.closing) return;
    const error = new Error('app is shutting down');
    error.code = 'DART_SHUTDOWN';
    throw error;
  }

  queue(channel, operation) {
    const apply = () => {
      this.assertOpen();
      return operation();
    };
    const previous = this.tails.get(channel) || Promise.resolve();
    const task = previous.then(apply, apply);
    this.tails.set(channel, task.catch(() => {}));
    return task;
  }

  remoteKey(scope, id) {
    return `${scope}:${id}`;
  }

  beginRemote(scope, id, { background = false } = {}) {
    const key = this.remoteKey(scope, id);
    if (background && this.remoteTokens.has(key)) return null;
    const token = Symbol(key);
    this.remoteTokens.set(key, token);
    return token;
  }

  assertRemote(scope, id, token) {
    if (!token || this.remoteTokens.get(this.remoteKey(scope, id)) !== token) {
      throw new Error('a newer update superseded this request');
    }
  }

  finishRemote(scope, id, token) {
    const key = this.remoteKey(scope, id);
    if (this.remoteTokens.get(key) === token) this.remoteTokens.delete(key);
  }

  cancelRemote(scope, id) {
    this.remoteTokens.delete(this.remoteKey(scope, id));
  }

  cancelAllRemote() {
    this.remoteEpoch += 1;
    this.remoteTokens.clear();
  }

  close() {
    this.closing = true;
    this.cancelAllRemote();
  }
}

module.exports = { OperationCoordinator };
