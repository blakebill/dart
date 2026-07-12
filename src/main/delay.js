'use strict';

const { DEFAULT_TEST_URL } = require('./converter');

function buildDelayApiPath(name, testUrl, timeout = 5000) {
  const url = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  const params = new URLSearchParams({ url, timeout: String(timeout) });
  return `/proxies/${encodeURIComponent(name)}/delay?${params.toString()}`;
}

module.exports = { buildDelayApiPath };
