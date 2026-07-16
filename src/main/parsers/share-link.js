'use strict';

/**
 * Share-link parser
 *
 * Parses common proxy share links (vmess:// vless:// trojan:// ss:// hysteria2:// tuic:// ...)
 * into a unified internal "node object" structure, which is later turned into
 * sing-box outbounds by the converter.
 *
 * Internal node object shape (kept close to Clash proxy fields for unified handling):
 * {
 *   name, type, server, port,
 *   ...protocol-specific fields
 * }
 */

/** Safe base64 decode (tolerates url-safe alphabet and missing padding). */
function b64decode(str) {
  if (!str) return '';
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  while (s.length % 4 !== 0) s += '=';
  try {
    return Buffer.from(s, 'base64').toString('utf-8');
  } catch (e) {
    return '';
  }
}

/** Whether the string looks like base64-encoded subscription content. */
function isProbablyBase64(str) {
  const s = String(str).trim().replace(/\s/g, '');
  if (s.length === 0) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return false;
  const decoded = b64decode(s);
  // Only treat as a valid subscription if the decoded text contains a protocol prefix.
  return /(vmess|vless|trojan|ss|ssr|hysteria2?|tuic|hy2|anytls):\/\//i.test(decoded);
}

/** Split a comma-separated alpn value into a trimmed, non-empty list. */
function splitAlpn(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Parse a URL query string into an object. */
function parseQuery(search) {
  const params = {};
  if (!search) return params;
  const q = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx === -1) {
      params[decodeURIComponent(pair)] = '';
    } else {
      const k = decodeURIComponent(pair.slice(0, idx));
      const v = decodeURIComponent(pair.slice(idx + 1));
      params[k] = v;
    }
  }
  return params;
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}

function splitHostPort(hostPart) {
  // URL-shaped SIP002 links commonly include `/` before `?plugin=...`.
  const value = String(hostPart || '').replace(/\/$/, '');
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0 || value[end + 1] !== ':') return null;
    return { server: value.slice(1, end), port: Number(value.slice(end + 2)) };
  }
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return null;
  return { server: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
}

function parseSsPlugin(value) {
  const parts = String(value || '').split(';').filter(Boolean);
  if (!parts.length) return {};
  const plugin = parts.shift();
  const pluginOpts = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) pluginOpts[part] = true;
    else pluginOpts[part.slice(0, idx)] = part.slice(idx + 1);
  }
  if (plugin === 'obfs' || plugin === 'simple-obfs' || plugin === 'obfs-local') {
    return {
      plugin,
      pluginOpts: {
        mode: pluginOpts.obfs || pluginOpts.mode,
        host: pluginOpts['obfs-host'] || pluginOpts.host,
      },
    };
  }
  return { plugin, pluginOpts };
}

/** vmess:// (base64 JSON format, the mainstream standard) */
function parseVmess(uri) {
  const body = uri.slice('vmess://'.length);
  const json = b64decode(body);
  if (!json) return null;
  let cfg;
  try {
    cfg = JSON.parse(json);
  } catch (e) {
    return null;
  }
  const node = {
    type: 'vmess',
    name: cfg.ps || cfg.remark || `${cfg.add}:${cfg.port}`,
    server: cfg.add,
    port: Number(cfg.port),
    uuid: cfg.id,
    alterId: parseInt(cfg.aid || 0, 10),
    cipher: cfg.scy || 'auto',
    network: cfg.net || 'tcp',
  };
  // TLS
  if (cfg.tls === 'tls' || cfg.tls === true) {
    node.tls = true;
    node.servername = cfg.sni || cfg.host || '';
    if (cfg.alpn) node.alpn = splitAlpn(cfg.alpn);
  }
  // Transport layer
  const host = cfg.host || '';
  const path = cfg.path || '';
  if (node.network === 'ws') {
    node.wsOpts = { path: path || '/', headers: host ? { Host: host } : {} };
  } else if (node.network === 'h2' || node.network === 'http') {
    node.h2Opts = { path: path || '/', host: host ? [host] : [] };
  } else if (node.network === 'grpc') {
    node.grpcOpts = { serviceName: path || cfg.serviceName || '' };
  }
  return node;
}

/** vless://uuid@host:port?params#name */
function parseVless(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch (e) {
    return null;
  }
  const params = parseQuery(u.search);
  const node = {
    type: 'vless',
    name: safeDecodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    port: Number(u.port),
    uuid: decodeURIComponent(u.username),
    network: params.type || 'tcp',
    flow: params.flow || '',
  };
  const security = params.security || 'none';
  if (security === 'tls' || security === 'xtls' || security === 'reality') {
    node.tls = true;
    node.servername = params.sni || params.peer || '';
    if (params.alpn) node.alpn = splitAlpn(params.alpn);
    if (params.fp) node.clientFingerprint = params.fp;
    if (security === 'reality') {
      node.reality = {
        publicKey: params.pbk || '',
        shortId: params.sid || '',
      };
    }
  }
  const host = params.host || '';
  const path = params.path || '';
  if (node.network === 'ws') {
    node.wsOpts = { path: path || '/', headers: host ? { Host: host } : {} };
  } else if (node.network === 'grpc') {
    node.grpcOpts = { serviceName: params.serviceName || params.path || '' };
  } else if (node.network === 'http' || node.network === 'h2') {
    node.h2Opts = { path: path || '/', host: host ? [host] : [] };
  }
  return node;
}

/** trojan://password@host:port?params#name */
function parseTrojan(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch (e) {
    return null;
  }
  const params = parseQuery(u.search);
  const node = {
    type: 'trojan',
    name: safeDecodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    port: Number(u.port),
    password: decodeURIComponent(u.username),
    tls: true,
    servername: params.sni || params.peer || u.hostname,
    network: params.type || 'tcp',
  };
  if (params.alpn) node.alpn = splitAlpn(params.alpn);
  if (params.fp) node.clientFingerprint = params.fp;
  if (params['allowInsecure'] === '1' || params.allowInsecure === 'true') node.skipCertVerify = true;
  const host = params.host || '';
  const path = params.path || '';
  if (node.network === 'ws') {
    node.wsOpts = { path: path || '/', headers: host ? { Host: host } : {} };
  } else if (node.network === 'grpc') {
    node.grpcOpts = { serviceName: params.serviceName || '' };
  }
  return node;
}

/**
 * ss:// parser, supporting both formats:
 *  1) ss://base64(method:password)@host:port#name
 *  2) ss://base64(method:password@host:port)#name  (legacy fully-encoded form)
 */
function parseShadowsocks(uri) {
  let rest = uri.slice('ss://'.length);
  let name = '';
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    name = safeDecodeURIComponent(rest.slice(hashIdx + 1));
    rest = rest.slice(0, hashIdx);
  }
  // Strip any query parameters (plugin, etc.)
  let query = '';
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  let method;
  let password;
  let server;
  let port;

  if (rest.includes('@')) {
    // Format 1
    const atIdx = rest.lastIndexOf('@');
    const userInfo = rest.slice(0, atIdx);
    const hostPart = rest.slice(atIdx + 1);
    const plainCredentials = safeDecodeURIComponent(userInfo);
    const decoded = plainCredentials.includes(':') ? plainCredentials : b64decode(userInfo);
    const colonIdx = decoded.indexOf(':');
    if (colonIdx <= 0) return null;
    method = decoded.slice(0, colonIdx);
    password = decoded.slice(colonIdx + 1);
    const endpoint = splitHostPort(hostPart);
    if (!endpoint) return null;
    ({ server, port } = endpoint);
  } else {
    // Format 2: fully base64-encoded
    const decoded = b64decode(rest);
    const atIdx = decoded.lastIndexOf('@');
    if (atIdx <= 0) return null;
    const cred = decoded.slice(0, atIdx);
    const hostPart = decoded.slice(atIdx + 1);
    const colonIdx = cred.indexOf(':');
    if (colonIdx <= 0) return null;
    method = cred.slice(0, colonIdx);
    password = cred.slice(colonIdx + 1);
    const endpoint = splitHostPort(hostPart);
    if (!endpoint) return null;
    ({ server, port } = endpoint);
  }

  const node = {
    type: 'ss',
    name: name || `${server}:${port}`,
    server,
    port,
    cipher: method,
    password,
  };

  // Plugin support (v2ray-plugin / obfs)
  const params = parseQuery(query);
  if (params.plugin) {
    Object.assign(node, parseSsPlugin(params.plugin));
  }
  return node;
}

/** hysteria2://password@host:port?params#name */
function parseHysteria2(uri) {
  let u;
  try {
    u = new URL(uri.replace(/^hy2:\/\//, 'hysteria2://'));
  } catch (e) {
    return null;
  }
  const params = parseQuery(u.search);
  return {
    type: 'hysteria2',
    name: safeDecodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    port: Number(u.port),
    password: decodeURIComponent(u.username) || params.password || '',
    obfs: params.obfs || '',
    obfsPassword: params['obfs-password'] || '',
    servername: params.sni || '',
    skipCertVerify: params.insecure === '1' || params.insecure === 'true',
    alpn: params.alpn ? splitAlpn(params.alpn) : undefined,
  };
}

/** tuic://uuid:password@host:port?params#name */
function parseTuic(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch (e) {
    return null;
  }
  const params = parseQuery(u.search);
  return {
    type: 'tuic',
    name: safeDecodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    port: Number(u.port),
    uuid: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ''),
    congestionControl: params.congestion_control || 'bbr',
    udpRelayMode: params.udp_relay_mode || 'native',
    servername: params.sni || '',
    alpn: params.alpn ? splitAlpn(params.alpn) : undefined,
    skipCertVerify: params.allow_insecure === '1' || params.insecure === '1',
  };
}

/** anytls://password@host:port?sni=&insecure=#name */
function parseAnytls(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch (e) {
    return null;
  }
  const params = parseQuery(u.search);
  return {
    type: 'anytls',
    name: safeDecodeURIComponent(u.hash.slice(1)) || `${u.hostname}:${u.port}`,
    server: u.hostname,
    port: Number(u.port),
    password: decodeURIComponent(u.username || '') || params.password || '',
    servername: params.sni || params.peer || '',
    skipCertVerify: params.insecure === '1' || params.insecure === 'true' || params.allowInsecure === '1',
    alpn: params.alpn ? splitAlpn(params.alpn) : undefined,
    clientFingerprint: params.fp,
  };
}

/** Parse a single share link. */
function parseSingleLink(uri) {
  uri = uri.trim();
  if (!uri) return null;
  try {
    const separator = uri.indexOf('://');
    if (separator > 0) uri = uri.slice(0, separator).toLowerCase() + uri.slice(separator);
    let node = null;
    if (uri.startsWith('vmess://')) node = parseVmess(uri);
    else if (uri.startsWith('vless://')) node = parseVless(uri);
    else if (uri.startsWith('trojan://')) node = parseTrojan(uri);
    else if (uri.startsWith('ss://')) node = parseShadowsocks(uri);
    else if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) node = parseHysteria2(uri);
    else if (uri.startsWith('tuic://')) node = parseTuic(uri);
    else if (uri.startsWith('anytls://')) node = parseAnytls(uri);
    if (!node || typeof node.server !== 'string') return null;
    node.server = node.server.trim();
    return node.server && Number.isInteger(node.port) && node.port > 0 && node.port <= 65535 ? node : null;
  } catch (e) {
    return null;
  }
}

/**
 * Parse subscription content (may be fully base64-encoded, or multiple share links per line).
 * Returns an array of internal node objects.
 */
function parseSubscriptionLinks(content) {
  let text = String(content).trim();
  // Fully base64-encoded subscription
  if (isProbablyBase64(text)) {
    text = b64decode(text);
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nodes = [];
  for (const line of lines) {
    const node = parseSingleLink(line);
    if (node && node.server && node.port) {
      nodes.push(node);
    }
  }
  return nodes;
}

module.exports = {
  b64decode,
  isProbablyBase64,
  parseSingleLink,
  parseSubscriptionLinks,
};
