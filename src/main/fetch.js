'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const { URL } = require('url');

/**
 * HTTP(S) fetch helpers that can optionally tunnel through the local mixed
 * proxy (sing-box) via HTTP CONNECT. Used to download rule-sets: we try through
 * the proxy first (so GFW-blocked GitHub raw URLs work) and fall back to a
 * direct connection on timeout/failure.
 */

/**
 * Open a GET request either directly or tunneled through 127.0.0.1:proxyPort.
 * @param {string} urlStr
 * @param {{headers?:object, proxyPort?:number, timeout?:number}} opts
 * @param {(res:import('http').IncomingMessage)=>void} cb
 * @param {(err:Error)=>void} errCb
 */
function openRequest(urlStr, opts, cb, errCb) {
  const { headers = {}, proxyPort = 0, timeout = 20000 } = opts;
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const port = parseInt(u.port, 10) || (isHttps ? 443 : 80);
  const reqHeaders = { 'User-Agent': 'dart', ...headers };
  const reqPath = u.pathname + u.search;

  if (proxyPort && isHttps) {
    // Tunnel: CONNECT to the proxy, then run TLS + GET over the tunneled socket.
    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      timeout,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return errCb(new Error('proxy CONNECT failed HTTP ' + res.statusCode));
      }
      // Swallow late resets on the tunneled socket: when the proxy (sing-box) is
      // torn down — e.g. the core is stopped right after an update download — the
      // tunnel emits ECONNRESET. Without a listener that would crash the process.
      socket.on('error', () => {});
      const req = https.request(
        {
          host: u.hostname,
          port,
          path: reqPath,
          method: 'GET',
          headers: reqHeaders,
          agent: false,
          timeout,
          createConnection: () => {
            const tlsSock = tls.connect({ socket, servername: u.hostname });
            tlsSock.on('error', () => {});
            return tlsSock;
          },
        },
        cb
      );
      req.on('error', errCb);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    connectReq.on('error', errCb);
    connectReq.on('timeout', () => connectReq.destroy(new Error('proxy connect timeout')));
    connectReq.end();
    return;
  }

  const lib = isHttps ? https : http;
  const req = lib.request(
    { host: u.hostname, port, path: reqPath, method: 'GET', headers: reqHeaders, timeout },
    cb
  );
  req.on('error', errCb);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.end();
}

/** GET a URL into a Buffer (follows redirects). */
function getBuffer(urlStr, opts = {}) {
  const { redirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    openRequest(
      urlStr,
      opts,
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(
            getBuffer(new URL(res.headers.location, urlStr).toString(), { ...opts, redirects: redirects - 1 })
          );
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers, statusCode: res.statusCode }));
        res.on('error', reject);
      },
      reject
    );
  });
}

/** Download a URL to a file (follows redirects), reporting 0..1 progress. */
function download(urlStr, dest, opts = {}) {
  const { onProgress = () => {}, redirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      file.close();
      fs.unlink(dest, () => {});
      reject(e);
    };
    openRequest(
      urlStr,
      opts,
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          settled = true;
          res.resume();
          file.close();
          fs.unlink(dest, () => {});
          return resolve(
            download(new URL(res.headers.location, urlStr).toString(), dest, { ...opts, redirects: redirects - 1 })
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          if (total) onProgress(received / total);
        });
        res.on('error', fail);
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          file.close(() => resolve(dest));
        });
      },
      fail
    );
  });
}

/** Download, trying through the proxy first (if given) then falling back to direct. */
async function downloadWithFallback(urlStr, dest, opts = {}) {
  const { proxyPort = 0, log = () => {}, ...rest } = opts;
  if (proxyPort) {
    try {
      return await download(urlStr, dest, { ...rest, proxyPort, timeout: rest.timeout || 15000 });
    } catch (e) {
      // A silent fallback hides real failures ("the core is running, why did
      // it go direct?"), so name the reason before retrying without the tunnel.
      log(`[gui] proxy download failed (${e.message}), retrying direct: ${urlStr}`);
    }
  }
  return download(urlStr, dest, { ...rest, proxyPort: 0 });
}

/** getBuffer, trying through the proxy first (if given) then falling back to direct. */
async function getBufferWithFallback(urlStr, opts = {}) {
  const { proxyPort = 0, log = () => {}, ...rest } = opts;
  if (proxyPort) {
    try {
      return await getBuffer(urlStr, { ...rest, proxyPort, timeout: rest.timeout || 15000 });
    } catch (e) {
      log(`[gui] proxy fetch failed (${e.message}), retrying direct: ${urlStr}`);
    }
  }
  return getBuffer(urlStr, { ...rest, proxyPort: 0 });
}

module.exports = { getBuffer, download, downloadWithFallback, getBufferWithFallback };
