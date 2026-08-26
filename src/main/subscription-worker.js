'use strict';

const { parentPort } = require('worker_threads');
const { parseSubscriptionContent } = require('./subscription');

if (!parentPort) throw new Error('subscription worker requires a parent port');

parentPort.once('message', (message) => {
  try {
    const content = message && typeof message.content === 'string' ? message.content : '';
    parentPort.postMessage({ ok: true, result: parseSubscriptionContent(content) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: String(error && error.name || 'Error'),
        message: String(error && error.message || error || 'profile parsing failed').slice(0, 16 * 1024),
      },
    });
  }
});
