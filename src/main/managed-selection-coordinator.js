'use strict';

/**
 * Serialize complete user selection transactions, not only the live API PUT.
 * The revision changes as soon as an intent is submitted so temporary
 * diagnostic selector leases can detect and preserve newer user choices.
 */
class ManagedSelectionCoordinator {
  constructor(apply) {
    if (typeof apply !== 'function') throw new Error('selection apply callback is required');
    this.apply = apply;
    this.tail = Promise.resolve();
    this.revision = 0;
    this.closed = false;
  }

  select(value) {
    if (this.closed) return Promise.reject(new Error('selection coordinator is closed'));
    const revision = ++this.revision;
    const run = () => this.apply(value, revision);
    const operation = this.tail.then(run, run);
    this.tail = operation.catch(() => {});
    return operation;
  }

  getRevision() {
    return this.revision;
  }

  isRevisionCurrent(revision) {
    return revision === this.revision;
  }

  close() {
    this.closed = true;
    this.revision += 1;
  }
}

module.exports = { ManagedSelectionCoordinator };
