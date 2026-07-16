'use strict';

/**
 * sing-box config parser
 *
 * Parses a sing-box JSON config (or a bare outbounds array) into the app's
 * unified internal node objects — the inverse of converter.nodeToOutbound — so
 * a sing-box-format subscription can be added directly. Non-proxy outbounds
 * (direct/block/dns/selector/urltest/...) are skipped.
 */

/** TLS fields from a sing-box outbound's `tls` block -> internal node fields. */
function tlsFields(ob) {
  const t = ob.tls;
  if (!t || !t.enabled) return {};
  const f = { tls: true };
  if (t.server_name) f.servername = t.server_name;
  if (t.insecure) f.skipCertVerify = true;
  if (Array.isArray(t.alpn) && t.alpn.length) f.alpn = t.alpn;
  if (t.utls && t.utls.fingerprint) f.clientFingerprint = t.utls.fingerprint;
  if (t.reality && t.reality.enabled && t.reality.public_key) {
    f.reality = { publicKey: t.reality.public_key, shortId: t.reality.short_id || '' };
  }
  return f;
}

/** v2ray transport block (ws/grpc/http) -> internal node fields. */
function transportFields(ob) {
  const t = ob.transport;
  if (!t || !t.type) return {};
  if (t.type === 'ws') {
    const ws = { path: t.path || '/' };
    const host = t.headers && (t.headers.Host || t.headers.host);
    if (host) ws.headers = { Host: host };
    if (t.max_early_data) ws.maxEarlyData = t.max_early_data;
    if (t.early_data_header_name) ws.earlyDataHeaderName = t.early_data_header_name;
    return { network: 'ws', wsOpts: ws };
  }
  if (t.type === 'grpc') return { network: 'grpc', grpcOpts: { serviceName: t.service_name || '' } };
  if (t.type === 'http') {
    const h2 = {};
    if (t.path) h2.path = t.path;
    if (t.host) h2.host = t.host;
    return { network: 'http', h2Opts: h2 };
  }
  return {};
}

/** Shadowsocks obfs/v2ray plugin -> internal plugin fields. */
function ssPlugin(ob) {
  if (!ob.plugin) return {};
  const opts = {};
  for (const part of String(ob.plugin_opts || '').split(';')) {
    const [k, v] = part.split('=');
    if (k) opts[k.trim()] = v === undefined ? true : String(v).trim();
  }
  if (ob.plugin === 'obfs-local' || ob.plugin === 'obfs' || ob.plugin === 'simple-obfs') {
    return { plugin: 'obfs', pluginOpts: { mode: opts.obfs, host: opts['obfs-host'] } };
  }
  if (ob.plugin === 'v2ray-plugin') {
    return { plugin: 'v2ray-plugin', pluginOpts: { mode: opts.mode, tls: 'tls' in opts, host: opts.host, path: opts.path } };
  }
  return {};
}

/** Convert one sing-box outbound into an internal node, or null if unsupported. */
function outboundToNode(ob) {
  if (!ob || typeof ob !== 'object' || !ob.type) return null;
  const server = typeof ob.server === 'string' ? ob.server.trim() : '';
  const port = Number(ob.server_port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const base = { name: ob.tag || `${server}:${port}`, server, port };

  switch (ob.type) {
    case 'shadowsocks':
      return { ...base, type: 'ss', cipher: ob.method, password: ob.password, ...ssPlugin(ob) };
    case 'vmess':
      return { ...base, type: 'vmess', uuid: ob.uuid, cipher: ob.security || 'auto', alterId: ob.alter_id || 0, ...tlsFields(ob), ...transportFields(ob) };
    case 'vless':
      return { ...base, type: 'vless', uuid: ob.uuid, flow: ob.flow || '', ...tlsFields(ob), ...transportFields(ob) };
    case 'trojan':
      return { ...base, type: 'trojan', password: ob.password, ...tlsFields(ob), ...transportFields(ob) };
    case 'hysteria2':
      return {
        ...base, type: 'hysteria2', password: ob.password,
        obfs: ob.obfs && ob.obfs.type, obfsPassword: ob.obfs && ob.obfs.password,
        up: ob.up_mbps, down: ob.down_mbps, ...tlsFields(ob),
      };
    case 'hysteria':
      return {
        ...base, type: 'hysteria', authStr: ob.auth_str,
        obfs: ob.obfs, up: ob.up_mbps, down: ob.down_mbps, ...tlsFields(ob),
      };
    case 'tuic':
      return {
        ...base, type: 'tuic', uuid: ob.uuid, password: ob.password || '',
        congestionControl: ob.congestion_control, udpRelayMode: ob.udp_relay_mode, ...tlsFields(ob),
      };
    case 'anytls':
      return {
        ...base, type: 'anytls', password: ob.password,
        idleCheck: ob.idle_session_check_interval, idleTimeout: ob.idle_session_timeout,
        minIdleSession: ob.min_idle_session, ...tlsFields(ob),
      };
    case 'socks':
      return { ...base, type: 'socks', username: ob.username, password: ob.password };
    case 'http':
      return { ...base, type: 'http', username: ob.username, password: ob.password, ...tlsFields(ob) };
    default:
      return null; // direct / block / dns / selector / urltest / ...
  }
}

/**
 * Parse sing-box JSON content into nodes.
 * Accepts a full config ({ outbounds: [...] }) or a bare outbounds array.
 * @returns {{ nodes: object[], routeRules: object[], isSingbox: boolean }}
 */
function parseSingboxConfig(content) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    return { nodes: [], routeRules: [], isSingbox: false };
  }
  let outbounds = null;
  if (Array.isArray(doc)) outbounds = doc;
  else if (doc && Array.isArray(doc.outbounds)) outbounds = doc.outbounds;
  if (!outbounds) return { nodes: [], routeRules: [], isSingbox: false };

  const nodes = [];
  for (const ob of outbounds) {
    const node = outboundToNode(ob);
    if (node) nodes.push(node);
  }
  const routeRules = !Array.isArray(doc) && doc.route && Array.isArray(doc.route.rules)
    ? doc.route.rules
    : [];
  return { nodes, routeRules, isSingbox: true };
}

module.exports = { parseSingboxConfig, outboundToNode };
