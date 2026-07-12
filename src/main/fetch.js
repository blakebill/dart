'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const { URL } = require('url');

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Open a TCP tunnel through the local mixed HTTP proxy. */
function connectTunnel(targetHost, targetPort, proxyPort, timeout = 20000) {
  return new Promise((resolve, reject) => {
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
      res.resume();
      done(new Error('proxy CONNECT failed HTTP ' + res.statusCode));
    });
    req.once('error', (error) => done(error));
    req.once('timeout', () => req.destroy(new Error('proxy connect timeout')));
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
    // Tunnel: CONNECT to the proxy, then run TLS + GET over that exact socket.
    connectTunnel(u.hostname, port, proxyPort, timeout).then((socket) => {
      // Swallow late resets on the tunneled socket: when the proxy (sing-box) is
      // torn down — e.g. the core is stopped right after an update download — the
      // tunnel emits ECONNRESET. Without a listener that would crash the process.
      socket.on('error', () => {});
      const agent = tunneledHttpsAgent(socket, u.hostname);
      const req = https.request(
        {
          host: u.hostname,
          port,
          path: reqPath,
          method: 'GET',
          headers: reqHeaders,
          agent,
          timeout,
        },
        cb
      );
      req.on('error', errCb);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    }).catch(errCb);
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
  const { redirects = 5, maxBytes = DEFAULT_MAX_BUFFER_BYTES } = opts;
  return new Promise((resolve, reject) => {
    openRequest(
      urlStr,
      opts,
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          if (typeof opts.onRedirect === 'function') opts.onRedirect(nextUrl, urlStr);
          return resolve(
            getBuffer(nextUrl, { ...opts, redirects: redirects - 1 })
          );
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        if (maxBytes > 0 && contentLength > maxBytes) {
          res.resume();
          return reject(new Error(`response exceeds ${maxBytes} bytes`));
        }
        const chunks = [];
        let received = 0;
        let failed = false;
        res.on('data', (c) => {
          if (failed) return;
          received += c.length;
          if (maxBytes > 0 && received > maxBytes) {
            failed = true;
            res.destroy();
            reject(new Error(`response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (!failed) resolve({ body: Buffer.concat(chunks), headers: res.headers, statusCode: res.statusCode });
        });
        res.on('error', (e) => {
          if (!failed) reject(e);
        });
      },
      reject
    );
  });
}

/** Download a URL to a file (follows redirects), reporting 0..1 progress. */
function download(urlStr, dest, opts = {}) {
  const { onProgress = () => {}, redirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let file = null;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      if (file) {
        file.destroy();
        fs.unlink(dest, () => {});
      }
      reject(e);
    };
    openRequest(
      urlStr,
      opts,
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          settled = true;
          res.resume();
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          if (typeof opts.onRedirect === 'function') opts.onRedirect(nextUrl, urlStr);
          return resolve(
            download(nextUrl, dest, { ...opts, redirects: redirects - 1 })
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('HTTP ' + res.statusCode));
        }
        file = fs.createWriteStream(dest);
        file.on('error', fail);
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

module.exports = { connectTunnel, download, downloadWithFallback, getBuffer, getBufferWithFallback };
