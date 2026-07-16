'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { URL } = require('url');
const { uniqueSibling, replaceFileSync } = require('./file-utils');

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function safeCall(callback, ...args) {
  try { callback(...args); } catch (_) {}
}

function abortedError() {
  const error = new Error('operation aborted');
  error.code = 'ABORT_ERR';
  return error;
}

/** Destroy a request/response when its caller cancels, without retaining it. */
function bindAbort(target, signal) {
  if (!signal || !target || typeof target.destroy !== 'function') return;
  const abort = () => target.destroy(abortedError());
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener('abort', abort, { once: true });
  target.once('close', () => signal.removeEventListener('abort', abort));
}

/** Open a TCP tunnel through the local mixed HTTP proxy. */
function connectTunnel(targetHost, targetPort, proxyPort, timeout = 20000, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortedError());
      return;
    }
    let settled = false;
    const done = (error, socket = null) => {
      if (settled) {
        if (socket) socket.destroy();
        return;
      }
      settled = true;
      if (error) reject(error);
      else resolve(socket);
    };
    const bareHost = String(targetHost).replace(/^\[|\]$/g, '');
    const authority = net.isIP(bareHost) === 6 ? `[${bareHost}]:${targetPort}` : `${bareHost}:${targetPort}`;
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      timeout,
    });
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error('proxy CONNECT failed HTTP ' + res.statusCode));
        return;
      }
      socket.setTimeout(0);
      if (head && head.length) socket.unshift(head);
      done(null, socket);
    });
    req.once('response', (res) => {
      res.once('error', () => {});
      done(new Error('proxy CONNECT failed HTTP ' + res.statusCode));
      res.resume();
    });
    req.once('error', (error) => done(error));
    req.once('timeout', () => req.destroy(new Error('proxy connect timeout')));
    bindAbort(req, signal);
    req.end();
  });
}

/** Build a one-shot HTTPS agent whose TLS transport is the CONNECT socket. */
function tunneledHttpsAgent(socket, hostname) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  let used = false;
  agent.createConnection = (options) => {
    if (used) throw new Error('tunnel socket already used');
    used = true;
    const tlsHost = String(hostname).replace(/^\[|\]$/g, '');
    const tlsOptions = { ...options, socket };
    if (net.isIP(tlsHost)) {
      delete tlsOptions.servername;
      tlsOptions.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(tlsHost, cert);
    } else {
      tlsOptions.servername = tlsHost;
    }
    const tlsSocket = tls.connect(tlsOptions);
    tlsSocket.on('error', () => {});
    return tlsSocket;
  };
  return agent;
}

/** Build a one-shot HTTP agent that writes the request through a CONNECT socket. */
function tunneledHttpAgent(socket) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  let used = false;
  agent.createConnection = () => {
    if (used) throw new Error('tunnel socket already used');
    used = true;
    return socket;
  };
  return agent;
}

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
  const { headers = {}, proxyPort = 0, timeout = 20000, signal = null } = opts;
  if (signal && signal.aborted) {
    errCb(abortedError());
    return;
  }
  const u = new URL(urlStr);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('unsupported URL protocol: ' + u.protocol);
  }
  const isHttps = u.protocol === 'https:';
  const port = parseInt(u.port, 10) || (isHttps ? 443 : 80);
  const reqHeaders = { 'User-Agent': 'dart', ...headers };
  const reqPath = u.pathname + u.search;

  const onResponse = (res) => {
    if (signal && signal.aborted) {
      res.destroy();
      errCb(abortedError());
      return;
    }
    cb(res);
    bindAbort(res, signal);
  };

  if (proxyPort) {
    // CONNECT both HTTP and HTTPS targets. Sending an HTTP URL directly here
    // used to bypass the requested proxy even when updateViaProxy was enabled.
    connectTunnel(u.hostname, port, proxyPort, timeout, signal).then((socket) => {
      if (signal && signal.aborted) {
        socket.destroy();
        errCb(abortedError());
        return;
      }
      // Swallow late resets on the tunneled socket: when the proxy (sing-box) is
      // torn down — e.g. the core is stopped right after an update download — the
      // tunnel emits ECONNRESET. Without a listener that would crash the process.
      socket.on('error', () => {});
      const agent = isHttps ? tunneledHttpsAgent(socket, u.hostname) : tunneledHttpAgent(socket);
      const lib = isHttps ? https : http;
      const req = lib.request(
        {
          host: u.hostname,
          port,
          path: reqPath,
          method: 'GET',
          headers: reqHeaders,
          agent,
          timeout,
        },
        onResponse
      );
      req.on('error', errCb);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      bindAbort(req, signal);
      req.end();
    }).catch(errCb);
    return;
  }

  const lib = isHttps ? https : http;
  const req = lib.request(
    { host: u.hostname, port, path: reqPath, method: 'GET', headers: reqHeaders, timeout },
    onResponse
  );
  req.on('error', errCb);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  bindAbort(req, signal);
  req.end();
}

function resolveRedirect(location, currentUrl) {
  try {
    return new URL(location, currentUrl).toString();
  } catch (error) {
    throw new Error('invalid redirect location: ' + error.message);
  }
}

/** GET a URL into a Buffer (follows redirects). */
function getBuffer(urlStr, opts = {}) {
  const { redirects = 5, maxBytes = DEFAULT_MAX_BUFFER_BYTES } = opts;
  return new Promise((resolve, reject) => {
    openRequest(
      urlStr,
      opts,
      (res) => {
        res.once('error', reject);
        res.once('aborted', () => reject(new Error('response aborted')));
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          let nextUrl;
          try {
            nextUrl = resolveRedirect(res.headers.location, urlStr);
          } catch (error) {
            reject(error);
            res.resume();
            return;
          }
          if (typeof opts.onRedirect === 'function') safeCall(opts.onRedirect, nextUrl, urlStr);
          resolve(
            getBuffer(nextUrl, { ...opts, redirects: redirects - 1 })
          );
          res.resume();
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode));
          res.resume();
          return;
        }
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        if (maxBytes > 0 && contentLength > maxBytes) {
          reject(new Error(`response exceeds ${maxBytes} bytes`));
          res.resume();
          return;
        }
        let body;
        let chunks;
        try {
          body = contentLength > 0 ? Buffer.allocUnsafe(contentLength) : null;
          chunks = body ? null : [];
        } catch (error) {
          reject(error);
          res.destroy();
          return;
        }
        let received = 0;
        let failed = false;
        res.on('data', (c) => {
          if (failed) return;
          const offset = received;
          received += c.length;
          if ((maxBytes > 0 && received > maxBytes) || (body && received > body.length)) {
            failed = true;
            reject(new Error(body && received > body.length ? 'response exceeds its content length' : `response exceeds ${maxBytes} bytes`));
            res.destroy();
            return;
          }
          if (body) c.copy(body, offset);
          else chunks.push(c);
        });
        res.on('end', () => {
          if (failed) return;
          if (body && received !== body.length) {
            failed = true;
            reject(new Error('response ended before its content length'));
            return;
          }
          resolve({ body: body || Buffer.concat(chunks), headers: res.headers, statusCode: res.statusCode });
        });
      },
      reject
    );
  });
}

/** Download a URL to a file (follows redirects), reporting 0..1 progress. */
function download(urlStr, dest, opts = {}) {
  const { onProgress = () => {}, redirects = 5, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = opts;
  const temp = uniqueSibling(dest, 'part');
  return new Promise((resolve, reject) => {
    let settled = false;
    let file = null;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      const finish = () => {
        fs.unlink(temp, (cleanupError) => {
          if (cleanupError && cleanupError.code !== 'ENOENT') e.cleanupError = cleanupError;
          reject(e);
        });
      };
      if (file && !file.closed) {
        file.once('close', finish);
        file.destroy();
      } else {
        finish();
      }
    };
    openRequest(
      urlStr,
      opts,
      (res) => {
        res.once('error', fail);
        res.once('aborted', () => fail(new Error('response aborted')));
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          let nextUrl;
          try {
            nextUrl = resolveRedirect(res.headers.location, urlStr);
          } catch (error) {
            fail(error);
            res.resume();
            return;
          }
          settled = true;
          res.resume();
          if (typeof opts.onRedirect === 'function') safeCall(opts.onRedirect, nextUrl, urlStr);
          return resolve(
            download(nextUrl, dest, { ...opts, redirects: redirects - 1 })
          );
        }
        if (res.statusCode !== 200) {
          fail(new Error('HTTP ' + res.statusCode));
          res.resume();
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        if (maxBytes > 0 && total > maxBytes) {
          fail(new Error(`download exceeds ${maxBytes} bytes`));
          res.resume();
          return;
        }
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          file = fs.createWriteStream(temp);
        } catch (error) {
          fail(error);
          res.resume();
          return;
        }
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          if (maxBytes > 0 && received > maxBytes) {
            res.destroy(new Error(`download exceeds ${maxBytes} bytes`));
            return;
          }
          if (total) safeCall(onProgress, received / total);
        });
        pipeline(res, file, (error) => {
          if (error) return fail(error);
          if (settled) return;
          try {
            replaceFileSync(temp, dest);
            settled = true;
            safeCall(onProgress, 1);
            resolve(dest);
          } catch (replaceError) {
            fail(replaceError);
          }
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
      if (rest.signal && rest.signal.aborted) throw e;
      // A silent fallback hides real failures ("the core is running, why did
      // it go direct?"), so name the reason before retrying without the tunnel.
      safeCall(log, `[gui] proxy download failed (${e.message}), retrying direct: ${urlStr}`);
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
      if (rest.signal && rest.signal.aborted) throw e;
      safeCall(log, `[gui] proxy fetch failed (${e.message}), retrying direct: ${urlStr}`);
    }
  }
  return getBuffer(urlStr, { ...rest, proxyPort: 0 });
}

module.exports = { connectTunnel, download, downloadWithFallback, getBuffer, getBufferWithFallback };
