'use strict';

/**
 * Apply a live runtime change, persist it, and restore the previous runtime
 * value if either step fails. The rollback deliberately also runs when apply()
 * rejects: an HTTP timeout is ambiguous and the core may already have accepted
 * the change before the response was lost.
 */
async function runReversibleLiveMutation({ apply, commit, rollback }) {
  try {
    await apply();
    return await commit();
  } catch (error) {
    if (typeof rollback === 'function') {
      try {
        await rollback();
      } catch (recoveryError) {
        if (error && typeof error === 'object') error.recoveryError = recoveryError;
      }
    }
    throw error;
  }
}

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
    // Reject work submitted after shutdown immediately instead of chaining it
    // behind an in-flight tail that closeAndDrain() is already waiting for.
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
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
    this.assertOpen();
    const key = this.remoteKey(scope, id);
    if (background && this.remoteTokens.has(key)) return null;
    const previous = this.remoteTokens.get(key);
    if (previous) previous.controller.abort(new Error('a newer update superseded this request'));
    const controller = new AbortController();
    const token = Object.freeze({
      id: Symbol(key),
      controller,
      signal: controller.signal,
    });
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
    const key = this.remoteKey(scope, id);
    const token = this.remoteTokens.get(key);
    this.remoteTokens.delete(key);
    if (token) token.controller.abort(new Error('update cancelled'));
  }

  cancelAllRemote() {
    this.remoteEpoch += 1;
    for (const token of this.remoteTokens.values()) {
      token.controller.abort(new Error('all updates cancelled'));
    }
    this.remoteTokens.clear();
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    this.cancelAllRemote();
  }

  /**
   * Stop accepting work, cancel remote operations, then wait for every channel
   * tail that existed when draining began. JavaScript runs close() and the
   * snapshot without an event-loop yield, so a caller cannot insert another
   * accepted tail between them. Work submitted afterwards is rejected by
   * queue(), while failures from already-running work are deliberately settled
   * rather than turning shutdown itself into another failure.
   */
  async closeAndDrain() {
    this.close();
    const pending = [...this.tails.values()];
    await Promise.allSettled(pending);
  }
}

module.exports = { OperationCoordinator, runReversibleLiveMutation };
