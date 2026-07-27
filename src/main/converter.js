'use strict';

const {
  normalizePolicyGroups,
  singboxPolicyOutbounds,
  mihomoPolicyGroups,
} = require('./policy-groups');
const { smartRegionMembers } = require('./node-region');

const AUTO_GROUP = '♻️ Auto';
const SMART_GROUP = '🧠 Smart';
const FALLBACK_GROUP = '🛟 Fallback';
const APP_PROXY_GROUP = '🚀 Proxy';
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
const AUTO_TEST_INTERVAL_SECONDS = 60;
const AUTO_TEST_TIMEOUT_MS = 5000;
const SMART_MODES = new Set(['balanced', 'latency', 'stable']);

function normalizeSmartMode(value) {
  return SMART_MODES.has(value) ? value : 'balanced';
}

const APP_SELECTOR_ANCHORS = [APP_PROXY_GROUP, AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP];

function cleanOutboundName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 256 && !/[\r\n,]/.test(name) ? name : '';
}

function uniqueOutboundNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = cleanOutboundName(value);
    if (!name || seen.has(name)) continue;
    // Normalize built-ins to the tags used in generated configs.
    let key = name;
    if (name === 'DIRECT' || /^direct$/i.test(name)) key = 'direct';
    else if (name === 'REJECT' || name === 'REJECT-DROP' || /^reject(-drop)?$/i.test(name)) key = 'reject';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isBareDirectOutbound(name) {
  const n = cleanOutboundName(name);
  return !!(n && (n === 'direct' || n === 'DIRECT' || /^direct$/i.test(n)));
}

function isBareRejectOutbound(name) {
  const n = cleanOutboundName(name);
  return !!(n && (n === 'reject' || n === 'REJECT' || n === 'REJECT-DROP' || /^reject(-drop)?$/i.test(n)));
}

function isPreferDirectOrRejectMember(name) {
  const n = cleanOutboundName(name);
  if (!n) return false;
  if (isBareDirectOutbound(n)) return true;
  if (isBareRejectOutbound(n)) return true;
  return n.includes('直连') || n.includes('拦截') || n.includes('拒绝') || n.includes('广告')
    || n.toLowerCase().includes('direct');
}

/** Options that must not appear in the "选择出站" picker (bare direct / 全球直连-style). */
function isExcludedSourcePick(name) {
  const n = cleanOutboundName(name);
  if (!n) return true;
  if (isBareDirectOutbound(n)) return true;
  // Subscription "global direct" style labels — not the same as app 🚀 Proxy picks.
  if (n.includes('直连')) return true;
  return false;
}

/**
 * Normalize subscription policy groups for runtime generation. Source select
 * groups stay as real selectors so the UI can pick an outbound from the app
 * node list.
 */
function prepareSourcePolicyGroups(policyGroups, nodeNames = []) {
  return normalizePolicyGroups(policyGroups, nodeNames);
}

/**
 * Expand each select-type source group so the Clash API / UI picker can choose
 * the app main selector, strategy groups, every node, or residual original
 * members (nested groups, direct, …). Applies persisted `ruleGroupSelections`.
 *
 * Proxy-first groups default to 🚀 Proxy (follow the Nodes tab pick) when the
 * user has not chosen yet; prefer-direct groups keep their original first
 * member.
 */
function applySourceGroupSelections(groups, nodeNames = [], selections = null) {
  const nodes = (Array.isArray(nodeNames) ? nodeNames : [])
    .map((value) => (typeof value === 'string' ? value : value && value.name))
    .map(cleanOutboundName)
    .filter(Boolean);
  const picks = selections && typeof selections === 'object' && !Array.isArray(selections)
    ? selections
    : {};
  return (Array.isArray(groups) ? groups : []).map((group) => {
    if (!group || (group.type !== 'select' && group.type !== 'selector')) return group;
    const original = uniqueOutboundNames(group.members);
    const firstOriginal = original[0] || '';
    const preferDirect = !!(firstOriginal && isPreferDirectOrRejectMember(firstOriginal));
    const hasReject = original.some((member) => isBareRejectOutbound(member));
    // Drop bare direct / 全球直连-style entries from the selectable list, except
    // keep bare `direct` when this group itself is prefer-direct (needs a default).
    // Keep bare `reject` only when the subscription group already offered it.
    const originalKept = original.filter((member) => {
      if (isBareRejectOutbound(member)) return hasReject;
      if (isBareDirectOutbound(member)) return preferDirect;
      if (isExcludedSourcePick(member)) return false;
      return true;
    });
    const members = uniqueOutboundNames([
      ...APP_SELECTOR_ANCHORS,
      ...originalKept,
      ...nodes,
      ...(preferDirect ? ['direct'] : []),
      ...(hasReject ? ['reject'] : []),
    ]);
    if (!members.length) return group;

    const saved = cleanOutboundName(picks[group.name]);
    const norm = (name) => {
      if (name === 'DIRECT') return 'direct';
      if (name === 'REJECT' || name === 'REJECT-DROP') return 'reject';
      return name;
    };
    let chosen = saved && members.includes(norm(saved)) ? norm(saved) : '';
    if (!chosen) {
      const preferred = norm(cleanOutboundName(group.default) || original[0] || '');
      if (preferred && isPreferDirectOrRejectMember(preferred) && members.includes(preferred)) {
        chosen = preferred;
      } else if (members.includes(APP_PROXY_GROUP)) {
        chosen = APP_PROXY_GROUP;
      } else if (preferred && members.includes(preferred)) {
        chosen = preferred;
      } else {
        chosen = members[0];
      }
    }
    // Put the active pick first so Mihomo (no selector default field) starts on it.
    const ordered = [chosen, ...members.filter((name) => name !== chosen)];
    return { ...group, type: 'select', members: ordered, default: chosen };
  });
}

/**
 * UI picker list for one wired source group. Hides bare direct / 全球直连-style
 * labels; includes reject only when that group actually has a reject strategy.
 */
function sourcePicksForWiredGroup(group) {
  return uniqueOutboundNames(group && group.members || []).filter((name) => {
    if (isBareDirectOutbound(name)) return false;
    if (isExcludedSourcePick(name)) return false;
    return true;
  });
}

/** Flat picker options (anchors + nodes + non-direct extras). Used as a fallback. */
function sourceGroupPickOptions(nodes = [], groups = []) {
  const nodeNames = (Array.isArray(nodes) ? nodes : [])
    .map((value) => (typeof value === 'string' ? value : value && value.name))
    .map(cleanOutboundName)
    .filter(Boolean);
  const extras = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const member of group && group.members || []) {
      const name = cleanOutboundName(member);
      if (!name || isExcludedSourcePick(name)) continue;
      if (isBareRejectOutbound(name)) continue; // reject is per-group only
      extras.push(name);
    }
  }
  return uniqueOutboundNames([
    ...APP_SELECTOR_ANCHORS,
    ...nodeNames,
    ...extras,
  ]).filter((name) => !isExcludedSourcePick(name) && !isBareRejectOutbound(name));
}

/**
 * Conservative version fallback for callers that cannot execute the core.
 * Runtime config generation probes a minimal type:smart config instead.
 * Stock upstream builds never do. Older Dart forks report versions like
 * `1.13.14-dart.3` / `1.19.29-dart.4`.
 *
 * First builds that shipped kernel Smart:
 * - sing-box: `-dart.3`+
 * - mihomo:   `-dart.4`+
 */
function coreSupportsKernelSmart(coreType, version) {
  const text = String(version || '');
  const match = text.match(/-dart\.(\d+)/i);
  if (!match) return false;
  const rev = Number(match[1]);
  if (!Number.isFinite(rev)) return false;
  if (coreType === 'mihomo') return rev >= 4;
  if (coreType === 'sing-box') return rev >= 3;
  return false;
}

/** Build the 🧠 Smart group for sing-box (kernel smart or app-managed fallback). */
function buildSingboxSmartGroup(nodeTags, opts = {}) {
  const {
    kernelSmart = false,
    kernelSmartMode = false,
    smartMode = 'balanced',
  } = opts;
  if (kernelSmart) {
    const group = {
      type: 'smart',
      tag: SMART_GROUP,
      outbounds: nodeTags,
      interrupt_exist_connections: false,
    };
    if (kernelSmartMode) group.mode = normalizeSmartMode(smartMode);
    return group;
  }
  return { type: 'selector', tag: SMART_GROUP, outbounds: nodeTags, default: nodeTags[0] };
}

/** Build the 🧠 Smart proxy-group for mihomo (kernel smart or app-managed fallback). */
function buildMihomoSmartGroup(proxyNames, opts = {}) {
  const {
    kernelSmart = false,
    kernelSmartMode = false,
    latencyUrl = DEFAULT_TEST_URL,
    smartMode = 'balanced',
  } = opts;
  if (kernelSmart) {
    const group = {
      name: SMART_GROUP,
      type: 'smart',
      proxies: proxyNames,
      url: latencyUrl,
      interval: AUTO_TEST_INTERVAL_SECONDS,
      timeout: AUTO_TEST_TIMEOUT_MS,
      lazy: true,
    };
    if (kernelSmartMode) group.mode = normalizeSmartMode(smartMode);
    return group;
  }
  return { name: SMART_GROUP, type: 'select', proxies: proxyNames };
}

/**
 * Core converter
 *
 * 1) nodeToOutbound: internal node object -> sing-box outbound
 * 2) buildSingboxConfig: node list + options -> full sing-box config
 *    (inbounds, DNS, route, groups)
 *
 * This layer hides source differences: whether nodes come from Clash YAML or
 * share links, the internal node object shape is the same, so the conversion
 * logic is unified.
 */

/** Normalize the alpn field into a string array. */
function normAlpn(alpn) {
  if (!alpn) return undefined;
  if (Array.isArray(alpn)) return alpn.filter(Boolean);
  return String(alpn)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build a sing-box TLS config block. */
function buildTls(node) {
  if (!node.tls) return undefined;
  const tls = {
    enabled: true,
    server_name: node.servername || node.server || '',
  };
  if (node.skipCertVerify) tls.insecure = true;
  const alpn = normAlpn(node.alpn);
  if (alpn) tls.alpn = alpn;
  if (node.clientFingerprint) {
    tls.utls = { enabled: true, fingerprint: node.clientFingerprint };
  }
  if (node.reality && node.reality.publicKey) {
    tls.reality = {
      enabled: true,
      public_key: node.reality.publicKey,
      short_id: node.reality.shortId || '',
    };
    // reality requires utls
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
  }
  return tls;
}

/** Build a sing-box v2ray transport config block (ws/grpc/http). */
function buildTransport(node) {
  const net = node.network;
  if (!net || net === 'tcp') return undefined;

  if (net === 'ws') {
    const opts = node.wsOpts || {};
    const headers = opts.headers || {};
    const transport = {
      type: 'ws',
      path: opts.path || '/',
    };
    // sing-box uses headers.Host to specify the ws host
    const host = headers.Host || headers.host;
    if (host) transport.headers = { Host: host };
    if (opts['max-early-data'] || opts.maxEarlyData) {
      transport.max_early_data = opts['max-early-data'] || opts.maxEarlyData;
    }
    if (opts['early-data-header-name'] || opts.earlyDataHeaderName) {
      transport.early_data_header_name = opts['early-data-header-name'] || opts.earlyDataHeaderName;
    }
    return transport;
  }

  if (net === 'grpc') {
    const opts = node.grpcOpts || {};
    return {
      type: 'grpc',
      service_name: opts.serviceName || opts['grpc-service-name'] || '',
    };
  }

  if (net === 'h2' || net === 'http') {
    const opts = node.h2Opts || {};
    const transport = { type: 'http' };
    if (opts.path) transport.path = opts.path;
    const hosts = opts.host || opts.Host;
    if (hosts) transport.host = Array.isArray(hosts) ? hosts : [hosts];
    return transport;
  }

  return undefined;
}

/**
 * Convert an internal node object into a sing-box outbound object.
 * Returns null for unsupported types.
 */
function nodeToOutbound(node) {
  if (!node || !node.type) return null;
  const tag = node.name;

  switch (node.type) {
    case 'ss': {
      const ob = {
        type: 'shadowsocks',
        tag,
        server: node.server,
        server_port: node.port,
        method: node.cipher,
        password: node.password,
      };
      // Simple pass-through for shadowsocks plugins (obfs / v2ray-plugin)
      if (node.plugin === 'obfs' || node.plugin === 'simple-obfs' || node.plugin === 'obfs-local') {
        ob.plugin = 'obfs-local';
        const o = node.pluginOpts || {};
        const parts = [];
        if (o.mode) parts.push(`obfs=${o.mode}`);
        if (o.host) parts.push(`obfs-host=${o.host}`);
        ob.plugin_opts = parts.join(';');
      } else if (node.plugin === 'v2ray-plugin') {
        ob.plugin = 'v2ray-plugin';
        const o = node.pluginOpts || {};
        const parts = [];
        if (o.mode) parts.push(`mode=${o.mode}`);
        if (o.tls) parts.push('tls');
        if (o.host) parts.push(`host=${o.host}`);
        if (o.path) parts.push(`path=${o.path}`);
        ob.plugin_opts = parts.join(';');
      }
      return ob;
    }

    case 'vmess': {
      const ob = {
        type: 'vmess',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: node.uuid,
        security: node.cipher || 'auto',
        alter_id: node.alterId || 0,
      };
      const tls = buildTls(node);
      if (tls) ob.tls = tls;
      const transport = buildTransport(node);
      if (transport) ob.transport = transport;
      return ob;
    }

    case 'vless': {
      const ob = {
        type: 'vless',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: node.uuid,
      };
      if (node.flow) ob.flow = node.flow;
      const tls = buildTls(node);
      if (tls) ob.tls = tls;
      const transport = buildTransport(node);
      if (transport) ob.transport = transport;
      return ob;
    }

    case 'trojan': {
      const ob = {
        type: 'trojan',
        tag,
        server: node.server,
        server_port: node.port,
        password: node.password,
      };
      const tls = buildTls({ ...node, tls: true });
      if (tls) ob.tls = tls;
      const transport = buildTransport(node);
      if (transport) ob.transport = transport;
      return ob;
    }

    case 'hysteria2': {
      const ob = {
        type: 'hysteria2',
        tag,
        server: node.server,
        server_port: node.port,
        password: node.password,
        tls: {
          enabled: true,
          server_name: node.servername || node.server,
        },
      };
      if (node.skipCertVerify) ob.tls.insecure = true;
      const alpn = normAlpn(node.alpn);
      if (alpn) ob.tls.alpn = alpn;
      if (node.obfs) {
        ob.obfs = { type: node.obfs, password: node.obfsPassword || '' };
      }
      if (node.up) ob.up_mbps = parseInt(node.up, 10) || undefined;
      if (node.down) ob.down_mbps = parseInt(node.down, 10) || undefined;
      return ob;
    }

    case 'hysteria': {
      const ob = {
        type: 'hysteria',
        tag,
        server: node.server,
        server_port: node.port,
        auth_str: node.authStr,
        tls: {
          enabled: true,
          server_name: node.servername || node.server,
        },
      };
      if (node.skipCertVerify) ob.tls.insecure = true;
      const alpn = normAlpn(node.alpn);
      if (alpn) ob.tls.alpn = alpn;
      if (node.obfs) ob.obfs = node.obfs;
      if (node.up) ob.up_mbps = parseInt(node.up, 10) || undefined;
      if (node.down) ob.down_mbps = parseInt(node.down, 10) || undefined;
      return ob;
    }

    case 'anytls': {
      const ob = {
        type: 'anytls',
        tag,
        server: node.server,
        server_port: node.port,
        password: node.password,
        tls: {
          enabled: true,
          server_name: node.servername || node.server,
        },
      };
      if (node.skipCertVerify) ob.tls.insecure = true;
      const alpn = normAlpn(node.alpn);
      if (alpn) ob.tls.alpn = alpn;
      if (node.clientFingerprint) ob.tls.utls = { enabled: true, fingerprint: node.clientFingerprint };
      const dur = (v) => (v == null || v === '' ? undefined : /[a-z]/i.test(String(v)) ? String(v) : String(v) + 's');
      if (dur(node.idleCheck)) ob.idle_session_check_interval = dur(node.idleCheck);
      if (dur(node.idleTimeout)) ob.idle_session_timeout = dur(node.idleTimeout);
      if (node.minIdleSession != null && node.minIdleSession !== '') {
        ob.min_idle_session = parseInt(node.minIdleSession, 10) || 0;
      }
      return ob;
    }

    case 'tuic': {
      const ob = {
        type: 'tuic',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: node.uuid,
        password: node.password || '',
        congestion_control: node.congestionControl || 'bbr',
        udp_relay_mode: node.udpRelayMode || 'native',
        tls: {
          enabled: true,
          server_name: node.servername || node.server,
        },
      };
      if (node.skipCertVerify) ob.tls.insecure = true;
      const alpn = normAlpn(node.alpn);
      if (alpn) ob.tls.alpn = alpn;
      return ob;
    }

    case 'socks': {
      const ob = {
        type: 'socks',
        tag,
        server: node.server,
        server_port: node.port,
        version: '5',
      };
      if (node.username) ob.username = node.username;
      if (node.password) ob.password = node.password;
      return ob;
    }

    case 'http': {
      const ob = {
        type: 'http',
        tag,
        server: node.server,
        server_port: node.port,
      };
      if (node.username) ob.username = node.username;
      if (node.password) ob.password = node.password;
      if (node.tls) {
        ob.tls = { enabled: true, server_name: node.servername || node.server };
        if (node.skipCertVerify) ob.tls.insecure = true;
      }
      return ob;
    }

    default:
      return null;
  }
}

function cleanObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** Convert an internal node object back into a Clash/Mihomo proxy object. */
function nodeToClashProxy(node) {
  if (!node || !node.type) return null;
  const base = { name: node.name, server: node.server, port: node.port };
  switch (node.type) {
    case 'ss':
      return cleanObject({
        ...base,
        type: 'ss',
        cipher: node.cipher,
        password: node.password,
        plugin: node.plugin,
        'plugin-opts': node.pluginOpts,
        udp: node.udp,
      });
    case 'vmess':
      return cleanObject({
        ...base,
        type: 'vmess',
        uuid: node.uuid,
        alterId: node.alterId || 0,
        cipher: node.cipher || 'auto',
        network: node.network || 'tcp',
        tls: !!node.tls,
        servername: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        'ws-opts': node.wsOpts,
        'h2-opts': node.h2Opts,
        'grpc-opts': node.grpcOpts,
        udp: node.udp,
      });
    case 'vless':
      return cleanObject({
        ...base,
        type: 'vless',
        uuid: node.uuid,
        flow: node.flow || undefined,
        network: node.network || 'tcp',
        tls: !!node.tls,
        servername: node.servername || undefined,
        alpn: node.alpn,
        'client-fingerprint': node.clientFingerprint,
        'skip-cert-verify': node.skipCertVerify,
        'reality-opts': node.reality
          ? cleanObject({ 'public-key': node.reality.publicKey, 'short-id': node.reality.shortId })
          : undefined,
        'ws-opts': node.wsOpts,
        'h2-opts': node.h2Opts,
        'grpc-opts': node.grpcOpts,
        udp: node.udp,
      });
    case 'trojan':
      return cleanObject({
        ...base,
        type: 'trojan',
        password: node.password,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        network: node.network || 'tcp',
        'ws-opts': node.wsOpts,
        'grpc-opts': node.grpcOpts,
        udp: node.udp,
      });
    case 'hysteria2':
      return cleanObject({
        ...base,
        type: 'hysteria2',
        password: node.password,
        obfs: node.obfs,
        'obfs-password': node.obfsPassword,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        up: node.up,
        down: node.down,
      });
    case 'hysteria':
      return cleanObject({
        ...base,
        type: 'hysteria',
        auth: node.authStr,
        obfs: node.obfs,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        up: node.up,
        down: node.down,
      });
    case 'anytls':
      return cleanObject({
        ...base,
        type: 'anytls',
        password: node.password,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'client-fingerprint': node.clientFingerprint,
        'skip-cert-verify': node.skipCertVerify,
        'idle-session-check-interval': node.idleCheck,
        'idle-session-timeout': node.idleTimeout,
        'min-idle-session': node.minIdleSession,
        udp: node.udp,
      });
    case 'tuic':
      return cleanObject({
        ...base,
        type: 'tuic',
        uuid: node.uuid,
        password: node.password,
        'congestion-control': node.congestionControl || 'bbr',
        'udp-relay-mode': node.udpRelayMode || 'native',
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
      });
    case 'socks':
      return cleanObject({ ...base, type: 'socks5', username: node.username, password: node.password, udp: node.udp });
    case 'http':
      return cleanObject({
        ...base,
        type: node.tls ? 'https' : 'http',
        username: node.username,
        password: node.password,
        tls: node.tls,
        sni: node.servername || undefined,
        'skip-cert-verify': node.skipCertVerify,
      });
    default:
      return null;
  }
}

/**
 * Convert a user-entered DNS address into a sing-box 1.12+ DNS server object.
 * Accepts: https://host/dns-query (DoH), tls://host (DoT), quic://host,
 * h3://host, udp://host or a bare host/IP (UDP), tcp://host. Optional :port.
 */
function dnsServerFromAddress(addr, tag, detour) {
  const out = { tag };
  let s = String(addr || '').trim();
  let type = 'udp';
  let path;
  const m = s.match(/^([a-z0-9]+):\/\//i);
  if (m) {
    const scheme = m[1].toLowerCase();
    type = { https: 'https', http3: 'h3', h3: 'h3', tls: 'tls', quic: 'quic', tcp: 'tcp', udp: 'udp' }[scheme] || 'udp';
    s = s.slice(m[0].length);
  }
  // For DoH, capture and strip the path (e.g. /dns-query).
  const slash = s.indexOf('/');
  if (slash >= 0) {
    path = s.slice(slash);
    s = s.slice(0, slash);
  }
  // Split an optional port. Bracketed IPv6 is required when a port is present;
  // bare IPv6 remains unambiguous and is kept as-is.
  let server = s;
  let port;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) throw new Error('invalid bracketed DNS server');
    server = s.slice(1, end);
    const suffix = s.slice(end + 1);
    if (suffix) {
      if (!/^:\d+$/.test(suffix)) throw new Error('invalid DNS server port');
      port = Number(suffix.slice(1));
    }
  } else {
    const firstColon = s.indexOf(':');
    const lastColon = s.lastIndexOf(':');
    if (firstColon > 0 && firstColon === lastColon) {
      const maybePort = s.slice(lastColon + 1);
      if (!/^\d+$/.test(maybePort)) throw new Error('invalid DNS server port');
      server = s.slice(0, lastColon);
      port = Number(maybePort);
    }
  }
  if (!server) throw new Error('DNS server is empty');
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('invalid DNS server port');
  }
  out.type = type;
  out.server = server;
  if (port) out.server_port = port;
  if (type === 'https' && path && path !== '/dns-query') out.path = path;
  if (detour) out.detour = detour;
  return out;
}

/**
 * Map a Clash rule target (proxy/group name) to a sing-box outbound tag.
 * `overrides` lets the user remap a subscription policy group by name to
 * 'direct' | 'proxy' | 'reject' (so the sub's matching is kept but its
 * outbound is the user's choice). DIRECT/REJECT in the rule itself always win.
 */
function mapClashTarget(name, overrides, availableTargets = null) {
  const n = String(name || '').trim();
  if (/^DIRECT$/i.test(n)) return 'direct';
  if (/^REJECT/i.test(n)) return 'reject'; // handled as an action below
  if (overrides) {
    const ov = overrides[n];
    if (ov === 'direct') return 'direct';
    if (ov === 'reject') return 'reject';
    if (ov === 'proxy') return '🚀 Proxy';
  }
  // Keep a source group/node target when the generated config contains it.
  if (availableTargets instanceof Set && availableTargets.has(n)) return n;
  return '🚀 Proxy';
}

/**
 * Parse one Clash `rules:` line into { type, value, target }. The line shape is
 * `TYPE,VALUE,TARGET` (e.g. DOMAIN-SUFFIX,x.com,Proxy); MATCH/FINAL carry the
 * target in the second field. Returns null for non-strings / blank types. This
 * is the single place that knows the rule-line layout — every extractor and the
 * converter route through it.
 */
function parseClashRule(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((s) => s.trim());
  const type = (parts[0] || '').toUpperCase();
  if (!type) return null;
  const isMatch = type === 'MATCH' || type === 'FINAL';
  return { type, value: parts[1], target: isMatch ? parts[1] : parts[2] };
}

/**
 * Expand one-level Clash logical rules (AND/OR/NOT) into plain rule lines or a
 * single AND descriptor. Deeper nesting and unsupported matchers are skipped
 * rather than mis-routed.
 * @returns {null|Array<string|object>} null when `raw` is not a logical rule
 */
function expandLogicalClashRule(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const head = text.match(/^(AND|OR|NOT)\s*,/i);
  if (!head) return null;
  const kind = head[1].toUpperCase();
  const rest = text.slice(head[0].length).trim();
  if (!rest.startsWith('(')) return [];
  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const payload = rest.slice(0, end + 1);
  const after = rest.slice(end + 1).replace(/^\s*,\s*/, '').trim();
  const target = after.split(',')[0].trim();
  if (!target || /[\r\n]/.test(target)) return [];

  const inner = payload.slice(1, -1);
  const children = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === ',' || /\s/.test(inner[i]))) i += 1;
    if (i >= inner.length) break;
    if (inner[i] !== '(') return [];
    let d = 0;
    let j = i;
    for (; j < inner.length; j++) {
      if (inner[j] === '(') d += 1;
      else if (inner[j] === ')') {
        d -= 1;
        if (d === 0) {
          j += 1;
          break;
        }
      }
    }
    if (d !== 0) return [];
    const child = inner.slice(i + 1, j - 1).trim();
    if (!child) return [];
    children.push(child);
    i = j;
  }
  if (!children.length) return [];

  if (kind === 'OR') {
    return children.map((child) => `${child},${target}`);
  }
  if (kind === 'AND') {
    return [{ logical: 'AND', parts: children, target }];
  }
  // NOT cannot be expressed losslessly with the matchers we emit; drop it.
  return [];
}

/** Flatten logical Clash rules so converters always see plain lines or AND descriptors. */
function flattenClashRules(clashRules) {
  const out = [];
  for (const raw of clashRules || []) {
    const expanded = expandLogicalClashRule(raw);
    if (expanded === null) {
      out.push(raw);
      continue;
    }
    for (const item of expanded) out.push(item);
  }
  return out;
}

const AND_FIELD_BY_TYPE = {
  DOMAIN: 'domain',
  HOST: 'domain',
  'DOMAIN-SUFFIX': 'domain_suffix',
  'HOST-SUFFIX': 'domain_suffix',
  'DOMAIN-KEYWORD': 'domain_keyword',
  'HOST-KEYWORD': 'domain_keyword',
  'DOMAIN-REGEX': 'domain_regex',
  'IP-CIDR': 'ip_cidr',
  'IP-CIDR6': 'ip_cidr',
  'IP6-CIDR': 'ip_cidr',
  'IP-ADDR': 'ip_cidr',
  'DST-PORT': 'port',
  'SRC-PORT': 'source_port',
  'PROCESS-NAME': 'process_name',
};

/** Build one sing-box rule from a flattened AND descriptor, or null when unsupported. */
function andDescriptorToSingboxRule(descriptor, overrides, availableTargets) {
  if (!descriptor || descriptor.logical !== 'AND' || !Array.isArray(descriptor.parts)) return null;
  const target = mapClashTarget(descriptor.target, overrides, availableTargets);
  const rule = {};
  const usedFields = new Set();
  for (const part of descriptor.parts) {
    const segs = String(part || '').split(',').map((s) => s.trim());
    const type = (segs[0] || '').toUpperCase().replace(/\s+/g, '');
    const value = segs[1];
    if (!type || value === undefined || value === '') return null;
    if (type === 'GEOIP' || type === 'GEOSITE' || type === 'RULE-SET' || type === 'NETWORK') {
      // These need side-channel rule-set plumbing or are not expressible as AND
      // fields alongside the rest of our converter path.
      return null;
    }
    const field = AND_FIELD_BY_TYPE[type];
    if (!field) return null;
    // Same matcher field twice would be OR inside sing-box; that is not AND.
    if (usedFields.has(field)) return null;
    usedFields.add(field);
    if (field === 'port' || field === 'source_port') {
      const port = parseInt(value, 10);
      if (Number.isNaN(port)) return null;
      rule[field] = [port];
    } else {
      rule[field] = [value];
    }
  }
  if (!usedFields.size) return null;
  if (target === 'reject') rule.action = 'reject';
  else rule.outbound = target;
  return rule;
}

/** Preserve Clash/Mihomo AND semantics while applying the selected target override. */
function andDescriptorToMihomoRule(descriptor, overrides, availableTargets) {
  if (!descriptor || descriptor.logical !== 'AND' || !Array.isArray(descriptor.parts)) return null;
  if (!descriptor.parts.length || descriptor.parts.some((part) => !String(part || '').trim())) return null;
  const target = clashTargetName(mapClashTarget(descriptor.target, overrides, availableTargets));
  const children = descriptor.parts.map((part) => `(${String(part).trim()})`).join(',');
  return `AND,(${children}),${target}`;
}

/**
 * Distinct subscription policy-group names referenced by proxy-bound rules
 * (including MATCH/FINAL targets, excluding DIRECT/REJECT). These are the groups the user
 * can remap via `overrides`. Returned sorted for a stable UI.
 */
function extractRuleGroups(clashRules) {
  const groups = new Set();
  for (const raw of flattenClashRules(clashRules)) {
    if (raw && typeof raw === 'object' && raw.logical === 'AND') {
      const n = String(raw.target || '').trim();
      if (n && !/^DIRECT$/i.test(n) && !/^REJECT/i.test(n)) groups.add(n);
      continue;
    }
    const r = parseClashRule(raw);
    if (!r) continue;
    const n = String(r.target || '').trim();
    if (!n || /^DIRECT$/i.test(n) || /^REJECT/i.test(n)) continue;
    groups.add(n);
  }
  return Array.from(groups).sort();
}

/** Distinct rule-provider names referenced by `RULE-SET,<name>,...` rules. */
function extractRuleSetRefs(clashRules) {
  const names = new Set();
  for (const raw of flattenClashRules(clashRules)) {
    if (raw && typeof raw === 'object') continue;
    const r = parseClashRule(raw);
    if (r && r.type === 'RULE-SET' && r.value) names.add(r.value);
  }
  return names;
}

/**
 * The sing-box rule-set tag for a GEOSITE/GEOIP category, or null when the
 * category name is exotic (e.g. `geolocation-!cn`). Restricting to
 * [a-z0-9-] keeps tags/filenames sane; the skipped "!cn = foreign" categories
 * usually route to the proxy anyway, which is already the route's final.
 */
function geoTag(kind, cat) {
  const c = String(cat || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(c)) return null;
  return `${kind}-${c}`;
}

/** Default set of available geo tags: the bundled CN pair when geodata exists. */
function defaultGeoAvailable(hasGeo) {
  return new Set(hasGeo ? ['geoip-cn', 'geosite-cn'] : []);
}

/** Resolve a geoAvailable argument: an explicit Set wins, else the default. */
function resolveGeoAvailable(geoAvailable, hasGeo) {
  if (!hasGeo) return new Set();
  return geoAvailable instanceof Set ? geoAvailable : defaultGeoAvailable(hasGeo);
}

/**
 * Distinct GEOSITE/GEOIP rule-sets a subscription references, as
 * { repo, file, tag } — so the caller can ensure each .srs is on disk before
 * the config references it. Exotic category names are skipped (see geoTag).
 */
function extractGeoCategories(clashRules) {
  const seen = new Map();
  for (const raw of flattenClashRules(clashRules)) {
    if (raw && typeof raw === 'object') continue;
    const r = parseClashRule(raw);
    if (!r) continue;
    let kind = null;
    let repo = null;
    if (r.type === 'GEOSITE') { kind = 'geosite'; repo = 'sing-geosite'; }
    else if (r.type === 'GEOIP') { kind = 'geoip'; repo = 'sing-geoip'; }
    else continue;
    const tag = geoTag(kind, r.value);
    if (tag) seen.set(tag, { repo, file: tag + '.srs', tag });
  }
  return [...seen.values()];
}

/**
 * Convert Clash `rules:` entries into sing-box route rules.
 * Unsupported rule types are skipped gracefully. MATCH/FINAL is ignored (the
 * generated config keeps its own final outbound).
 * @param {string[]} clashRules
 * @param {boolean} hasGeo  whether the bundled geoip-cn/geosite-cn exist.
 * @param {object|null} overrides  policy-group outbound overrides.
 * @param {Set<string>|null} geoAvailable  geo rule-set tags backed by a real
 *   local .srs. A GEOSITE/GEOIP rule is only emitted when its tag is in here,
 *   so the config never references an undefined rule_set (a fatal error in
 *   sing-box). Defaults to the bundled CN pair when hasGeo.
 * @param {object|null} ruleSetData  RULE-SET provider name -> parsed matcher
 *   arrays ({domain, domain_suffix, ip_cidr, ...}). A RULE-SET rule is only
 *   emitted when its provider has been downloaded + parsed into here.
 * @returns {{ rules: object[], usedGeoTags: Set<string> }}
 */
function clashRulesToSingbox(
  clashRules,
  hasGeo = true,
  overrides = null,
  geoAvailable = null,
  ruleSetData = null,
  availableTargets = null
) {
  const avail = resolveGeoAvailable(geoAvailable, hasGeo);
  const out = [];
  const usedGeoTags = new Set();
  let finalTarget = null;
  for (const raw of flattenClashRules(clashRules)) {
    if (raw && typeof raw === 'object' && raw.logical === 'AND') {
      const combined = andDescriptorToSingboxRule(raw, overrides, availableTargets);
      if (combined) out.push(combined);
      continue;
    }
    const parsed = parseClashRule(raw);
    if (!parsed) continue;
    const { type, value } = parsed;
    const target = mapClashTarget(parsed.target, overrides, availableTargets);
    if (type === 'MATCH' || type === 'FINAL') {
      if (finalTarget === null) finalTarget = target;
      continue;
    }
    const apply = (rule) => {
      if (target === 'reject') rule.action = 'reject';
      else rule.outbound = target;
      out.push(rule);
    };
    const applyGeo = (kind) => {
      const tag = geoTag(kind, value);
      if (tag && avail.has(tag)) {
        apply({ rule_set: [tag] });
        usedGeoTags.add(tag);
      }
    };
    const port = () => parseInt(value, 10);
    switch (type) {
      case 'DOMAIN':
        if (value) apply({ domain: [value] });
        break;
      case 'DOMAIN-SUFFIX':
        if (value) apply({ domain_suffix: [value] });
        break;
      case 'DOMAIN-KEYWORD':
        if (value) apply({ domain_keyword: [value] });
        break;
      case 'DOMAIN-REGEX':
        if (value) apply({ domain_regex: [value] });
        break;
      case 'IP-CIDR':
      case 'IP-CIDR6':
      case 'IP-ADDR':
        if (value) apply({ ip_cidr: [value] });
        break;
      case 'DST-PORT':
        if (!Number.isNaN(port())) apply({ port: [port()] });
        break;
      case 'SRC-PORT':
        if (!Number.isNaN(port())) apply({ source_port: [port()] });
        break;
      case 'PROCESS-NAME':
        if (value) apply({ process_name: [value] });
        break;
      case 'GEOIP':
        // Any country whose geoip-<cc>.srs is on disk; CN ships bundled.
        applyGeo('geoip');
        break;
      case 'GEOSITE':
        // Any category whose geosite-<cat>.srs is on disk (downloaded on demand).
        applyGeo('geosite');
        break;
      case 'RULE-SET': {
        // The referenced rule-provider, downloaded + parsed into matcher arrays.
        // Emit one rule per matcher field: different fields in a single sing-box
        // rule are AND-combined, so separate rules give the OR we want across
        // a provider's mixed domain/ip entries.
        const data = ruleSetData && ruleSetData[value];
        if (data) {
          for (const field of ['domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'process_name']) {
            const vals = data[field];
            if (Array.isArray(vals) && vals.length) apply({ [field]: vals.slice() });
          }
        }
        break;
      }
      default:
        // PROCESS-PATH, MATCH/FINAL, etc. -> skipped.
        break;
    }
  }
  return { rules: out, usedGeoTags, finalTarget };
}

/**
 * Parse a remote Clash-style rule list (classical/domain/ipcidr, or a plain
 * domain list) into sing-box matcher arrays.
 */
function parseRuleList(text) {
  const m = { domain: [], domain_suffix: [], domain_keyword: [], ip_cidr: [], process_name: [] };
  for (let raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^(#|;|\/\/|payload\s*:)/i.test(line)) continue;
    // strip YAML list dash + surrounding quotes + trailing inline comments
    line = line.replace(/^-\s*/, '').replace(/\s+#.*$/, '').trim();
    line = line.replace(/^['"]|['"]$/g, '').trim();
    if (!line) continue;
    if (line.includes(',')) {
      const parts = line.split(',').map((s) => s.trim());
      const type = (parts[0] || '').toUpperCase().replace(/\s+/g, '');
      const val = parts[1];
      if (!val) continue;
      switch (type) {
        case 'DOMAIN':
        case 'HOST':
          m.domain.push(val);
          break;
        case 'DOMAIN-SUFFIX':
        case 'HOST-SUFFIX':
          m.domain_suffix.push(val);
          break;
        case 'DOMAIN-KEYWORD':
        case 'HOST-KEYWORD':
          m.domain_keyword.push(val);
          break;
        case 'IP-CIDR':
        case 'IP-CIDR6':
        case 'IP6-CIDR':
          m.ip_cidr.push(val);
          break;
        case 'PROCESS-NAME':
          m.process_name.push(val);
          break;
        default:
          break; // USER-AGENT / GEOIP / URL-REGEX / etc. skipped
      }
    } else {
      // Bare entry: domain list. '+.x'/'.x' -> suffix; CIDR -> ip_cidr; else suffix.
      if (line.startsWith('+.')) m.domain_suffix.push(line.slice(2));
      else if (line.startsWith('.')) m.domain_suffix.push(line.slice(1));
      else if (/\/\d{1,3}$/.test(line)) m.ip_cidr.push(line);
      else m.domain_suffix.push(line);
    }
  }
  return m;
}

/**
 * Build a single sing-box route rule from a remote rule list + a target.
 * @param {string} text  the downloaded rule list
 * @param {string} target 'proxy' | 'direct' | 'reject'
 * @returns {{ rule: object|null, rules: object[], count: number }}
 */
function ruleListToSingboxRule(text, target) {
  const m = parseRuleList(text);
  const rules = [];
  let count = 0;
  for (const k of Object.keys(m)) {
    if (m[k].length) {
      const rule = { [k]: m[k].slice() };
      if (target === 'direct') rule.outbound = 'direct';
      else if (target === 'reject') rule.action = 'reject';
      else rule.outbound = '🚀 Proxy';
      rules.push(rule);
      count += m[k].length;
    }
  }
  // Different matcher fields in one sing-box rule are AND-combined. Emit one
  // rule per field so a mixed domain/IP/process list behaves as the source
  // list intended: any entry may match.
  return { rule: rules.length === 1 ? rules[0] : null, rules, count };
}

function dedupeNames(items, key, reserved = []) {
  const used = new Set(reserved);
  const nextSuffix = new Map();
  for (const item of items) {
    const base = String(item[key] || 'node');
    let name = base;
    if (used.has(name)) {
      let suffix = nextSuffix.get(base) || 2;
      while (used.has(`${base} ${suffix}`)) suffix += 1;
      name = `${base} ${suffix}`;
      nextSuffix.set(base, suffix + 1);
    } else {
      nextSuffix.set(base, 2);
    }
    used.add(name);
    item[key] = name;
  }
  return items;
}

/** Deduplicate tags and keep generated strategy outbounds unambiguous. */
function dedupeTags(outbounds) {
  return dedupeNames(outbounds, 'tag', ['🚀 Proxy', AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, 'direct']);
}

/**
 * Build just the sing-box route block ({ rules, rule_set }) from options. The
 * route references outbounds by tag (string), so it does not need the node
 * outbounds — letting callers (e.g. the Rules view) compute it cheaply without
 * converting every node.
 */
function buildRoute(opts = {}) {
  const {
    ruleSetDir = null,
    clashRules = [],
    extraRules = [],
    extraRuleSets = [],
    ruleOverrides = null,
    geoAvailable = null,
    ruleSetData = null,
    availableTargets = null,
  } = opts;
  // Local .srs only. A `remote` rule-set would be fetched during start-up via
  // download_detour, and sing-box treats a failed fetch as FATAL — so a fresh
  // install with no geodata (and raw.githubusercontent.com blocked, or no
  // healthy node yet) would crash on boot. When the geodata is absent we drop
  // the geoip-cn/geosite-cn optimization entirely instead: the core starts
  // clean (all traffic via the proxy), and the rule-set returns once geodata
  // is bundled or downloaded.
  const hasGeo = !!ruleSetDir;
  // Which geo rule-sets are backed by a real local .srs. Defaults to the bundled
  // CN pair; the caller passes a wider set once extra category .srs are on disk.
  const avail = resolveGeoAvailable(geoAvailable, hasGeo);
  const { rules: convertedRules, usedGeoTags, finalTarget } = clashRulesToSingbox(
    clashRules,
    hasGeo,
    ruleOverrides,
    avail,
    ruleSetData,
    availableTargets
  );

  // Define a local rule_set for every geo tag that is both available and used,
  // plus the CN pair (needed by the direct fallback + DNS). The file is always
  // <tag>.srs in ruleSetDir. Tags are unique so this also dedupes.
  const baseCn = ['geoip-cn', 'geosite-cn'].filter((t) => avail.has(t));
  const geoTags = [...new Set([...baseCn, ...usedGeoTags])];
  const geoRuleSets = geoTags.map((tag) => ({
    type: 'local', tag, format: 'binary', path: (ruleSetDir + '/' + tag + '.srs').replace(/\\/g, '/'),
  }));
  // The "CN traffic goes direct" fallback only when both CN rule-sets exist.
  const geoDirectRule = baseCn.length === 2 ? [{ rule_set: ['geoip-cn', 'geosite-cn'], outbound: 'direct' }] : [];

  return {
    rules: [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' },
      // Block mode: reject every connection (placed above all other routing).
      { clash_mode: 'block', action: 'reject' },
      { ip_is_private: true, outbound: 'direct' },
      { clash_mode: 'direct', outbound: 'direct' },
      { clash_mode: 'global', outbound: '🚀 Proxy' },
      // Custom rule-sets (user-added) take top priority.
      ...extraRules,
      // Converted from the subscription's Clash rules (above the geoip/geosite fallback).
      ...convertedRules,
      ...geoDirectRule,
      ...(finalTarget === 'reject' ? [{ action: 'reject' }] : []),
    ],
    rule_set: [...geoRuleSets, ...extraRuleSets],
    final: finalTarget && finalTarget !== 'reject' ? finalTarget : '🚀 Proxy',
  };
}

/**
 * Assemble a full sing-box config.
 *
 * @param {object[]} nodes  array of internal node objects
 * @param {object}   opts   options
 *   - mixedPort: mixed inbound port (default 7890)
 *   - enableTun: whether to enable TUN (default false)
 *   - logLevel: log level (default info)
 *   - finalOutbound: fallback outbound tag (default node selector)
 * @returns {object} sing-box config
 */
function buildSingboxConfig(nodes, opts = {}) {
  const {
    mixedPort = 7890,
    enableTun = false,
    clashApiPort = 9090,
    clashApiSecret = '', // when set, the Clash API requires Authorization
    externalUiDir = '', // serve a local dashboard at /ui when set
    externalUiDownloadUrl = '',
    logLevel = 'info',
    ruleSetDir = null,
    selected = null,
    clashMode = 'rule',
    clashRules = [],
    policyGroups = [],
    ruleOverrides = null, // { [policyGroupName]: 'direct'|'proxy'|'reject' }
    ruleGroupSelections = null, // { [policyGroupName]: outboundTag } for source selectors
    geoAvailable = null, // Set of geo rule-set tags backed by a local .srs
    ruleSetData = null, // RULE-SET provider name -> parsed matcher arrays
    enableIpv6 = true,
    tunInterfaceName = 'Dart',
    dnsRemote = 'https://1.1.1.1/dns-query',
    dnsLocal = 'https://223.5.5.5/dns-query',
    dnsStrategy = 'prefer_ipv4',
    testUrl = DEFAULT_TEST_URL,
    extraRules = [], // route rules from custom rule-sets
    extraRuleSets = [], // local rule_set defs from custom .srs
  } = opts;

  const nodeEntries = nodes
    .map((node) => ({ node, outbound: nodeToOutbound(node) }))
    .filter((entry) => !!entry.outbound);
  const nodeOutbounds = dedupeTags(nodeEntries.map((entry) => entry.outbound));
  const nodeTags = nodeOutbounds.map((o) => o.tag);
  if (!nodeTags.length) throw new Error('No supported proxy nodes are available.');
  const smartNodeTags = smartRegionMembers(
    nodeEntries.map((entry) => entry.node),
    nodeTags,
    opts.smartRegions
  );
  const latencyUrl = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  const sourceGroups = applySourceGroupSelections(
    prepareSourcePolicyGroups(policyGroups, nodeTags),
    nodeTags,
    ruleGroupSelections
  );
  const sourceGroupNames = sourceGroups.map((group) => group.name);
  const availableTargets = new Set([AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, ...nodeTags, ...sourceGroupNames]);

  // Members of 🚀 Proxy only — never source policy groups (they may point back
  // at 🚀 Proxy for "follow main selection").
  const proxyMembers = [AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, ...nodeTags, 'direct'];
  const defaultOutbound =
    selected && (proxyMembers.includes(selected) || selected === 'DIRECT')
      ? (selected === 'DIRECT' ? 'direct' : selected)
      : AUTO_GROUP;

  // sing-box has no distinct ordered-fallback outbound. A sticky URLTest group
  // is its native health-checked equivalent: it keeps a healthy route and
  // moves when that route fails.
  const proxyGroup = {
    type: 'selector',
    tag: APP_PROXY_GROUP,
    outbounds: proxyMembers,
    default: defaultOutbound,
  };
  // Dart owns Auto selection and applies its measured winner through the
  // always-on local Clash API.
  const autoGroup = { type: 'selector', tag: AUTO_GROUP, outbounds: nodeTags, default: nodeTags[0] };
  const smartGroup = buildSingboxSmartGroup(smartNodeTags, {
    kernelSmart: !!opts.kernelSmart,
    kernelSmartMode: !!opts.kernelSmartMode,
    smartMode: opts.smartMode,
  });
  const fallbackGroup = {
    type: 'urltest',
    tag: FALLBACK_GROUP,
    outbounds: nodeTags,
    url: latencyUrl,
    interval: '1m',
    tolerance: 10000,
    idle_timeout: '1m',
  };

  // direct is a real outbound; reject uses type block so selectors can offer it
  // when a subscription group includes REJECT. Route actions still use reject.
  const sourceGroupOutbounds = singboxPolicyOutbounds(sourceGroups, latencyUrl, AUTO_TEST_INTERVAL_SECONDS);
  const needsRejectOutbound = sourceGroups.some((group) => (
    Array.isArray(group.members) && group.members.includes('reject')
  ));
  const outbounds = [
    proxyGroup,
    autoGroup,
    smartGroup,
    fallbackGroup,
    ...sourceGroupOutbounds,
    ...nodeOutbounds,
    { type: 'direct', tag: 'direct' },
    ...(needsRejectOutbound ? [{ type: 'block', tag: 'reject' }] : []),
  ];

  // Inbounds (sing-box 1.12+: sniffing is a route rule action, not an inbound field)
  const inbounds = [];
  if (enableTun) {
    inbounds.push({
      type: 'tun',
      tag: 'tun-in',
      ...(tunInterfaceName ? { interface_name: tunInterfaceName } : {}),
      // IPv4-only when IPv6 is disabled, so the TUN never advertises a v6 route.
      address: enableIpv6 ? ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'] : ['172.19.0.1/30'],
      mtu: 9000,
      auto_route: true,
      strict_route: true,
      // "mixed" (system TCP + gVisor UDP) is the most compatible on Windows.
      stack: 'mixed',
    });
  }
  inbounds.push({
    type: 'mixed',
    tag: 'mixed-in',
    listen: '127.0.0.1',
    listen_port: mixedPort,
  });

  const avail = resolveGeoAvailable(geoAvailable, !!ruleSetDir);
  const route = buildRoute({
    ruleSetDir,
    clashRules,
    extraRules,
    extraRuleSets,
    ruleOverrides,
    geoAvailable: avail,
    ruleSetData,
    availableTargets,
  });

  const config = {
    log: {
      level: logLevel,
      timestamp: true,
    },
    dns: {
      servers: [
        dnsServerFromAddress(dnsRemote, 'proxy-dns', '🚀 Proxy'),
        dnsServerFromAddress(dnsLocal, 'local-dns'),
      ],
      rules: [
        { clash_mode: 'direct', server: 'local-dns' },
        { clash_mode: 'global', server: 'proxy-dns' },
        // Resolve CN domains with the local resolver — only when the rule-set
        // exists (see buildRoute: a missing geosite-cn must not be referenced).
        ...(avail.has('geosite-cn') ? [{ rule_set: 'geosite-cn', server: 'local-dns' }] : []),
      ],
      final: 'proxy-dns',
      // When IPv6 is disabled, force IPv4-only resolution regardless of the
      // user's preferred strategy.
      strategy: enableIpv6 ? dnsStrategy : 'ipv4_only',
    },
    inbounds,
    outbounds,
    route: {
      rules: route.rules,
      rule_set: route.rule_set,
      final: route.final,
      default_domain_resolver: 'local-dns',
    },
  };

  // Bind outbounds to the default physical interface only in TUN mode, where it
  // is required to keep sing-box's own traffic out of its own TUN (routing
  // loop). In system-proxy mode the binding is unnecessary and actively harmful:
  // with a WireGuard full tunnel up, its kill-switch (WFP) rejects any traffic
  // pinned to another interface (WSAEACCES), while unbound sockets follow the
  // routing table into the WG tunnel — i.e. proxy-over-WG chaining just works.
  if (enableTun) config.route.auto_detect_interface = true;

  config.experimental = {
    clash_api: {
      external_controller: `127.0.0.1:${clashApiPort}`,
      default_mode: clashMode || 'rule',
      ...(clashApiSecret ? { secret: clashApiSecret } : {}),
      // Local panel hosting: the core serves the dashboard at /ui (same
      // origin as the API) and downloads it through its own proxy outbound.
      ...(externalUiDir
        ? {
            external_ui: externalUiDir,
            ...(externalUiDownloadUrl ? { external_ui_download_url: externalUiDownloadUrl } : {}),
            external_ui_download_detour: '🚀 Proxy',
          }
        : {}),
    },
    cache_file: {
      enabled: true,
    },
  };

  return config;
}

function dedupeProxyNames(proxies) {
  return dedupeNames(proxies, 'name', ['🚀 Proxy', AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, 'direct', 'DIRECT', 'REJECT', 'GLOBAL']);
}

function clashTargetName(target) {
  if (target === 'direct') return 'DIRECT';
  if (target === 'reject') return 'REJECT';
  return target || '🚀 Proxy';
}

function singboxRuleToClashRules(rule, options = {}) {
  if (!rule || typeof rule !== 'object' || ['sniff', 'hijack-dns'].includes(rule.action)) return [];
  const rawOutbound = String(rule.outbound || '').trim();
  const outbound = rawOutbound.toLowerCase();
  const preservedOutbound = options.preserveOutbound && rawOutbound && !/[\r\n,]/.test(rawOutbound)
    ? rawOutbound
    : '🚀 Proxy';
  const target = rule.action === 'reject' || ['block', 'reject'].includes(outbound)
    ? 'REJECT'
    : outbound === 'direct' ? 'DIRECT' : preservedOutbound;
  const out = [];
  const add = (type, vals) => {
    const values = Array.isArray(vals) ? vals : vals === undefined ? [] : [vals];
    for (const v of values) out.push(`${type},${v},${target}`);
  };
  add('DOMAIN', rule.domain);
  add('DOMAIN-SUFFIX', rule.domain_suffix);
  add('DOMAIN-KEYWORD', rule.domain_keyword);
  add('IP-CIDR', rule.ip_cidr);
  add('PROCESS-NAME', rule.process_name);
  add('DST-PORT', rule.port);
  if (rule.ip_is_private === true) {
    add('IP-CIDR', ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8']);
    add('IP-CIDR6', ['fc00::/7', 'fe80::/10', '::1/128']);
  }
  if (options.includeRuleSets !== false) {
    const ruleSets = Array.isArray(rule.rule_set) ? rule.rule_set : rule.rule_set ? [rule.rule_set] : [];
    for (const tag of ruleSets) out.push(`RULE-SET,${tag},${target}`);
  }
  if (rule.type === 'logical' && rule.mode === 'or' && Array.isArray(rule.rules)) {
    for (const child of rule.rules) {
      for (const converted of singboxRuleToClashRules(
        { ...child, outbound: rule.outbound, action: rule.action },
        options
      )) out.push(converted);
    }
  }
  return out;
}

function clashRuleToMihomo(raw, overrides, availableRuleProviders = null, availableTargets = null) {
  const parts = String(raw || '').split(',').map((s) => s.trim());
  const type = (parts[0] || '').toUpperCase();
  if (!type) return null;
  const parsed = parseClashRule(raw);
  if (!parsed) return null;
  const target = clashTargetName(mapClashTarget(parsed.target, overrides, availableTargets));
  if (type === 'MATCH' || type === 'FINAL') return `MATCH,${target}`;
  if (!parsed.value) return null;
  if (type === 'RULE-SET' && availableRuleProviders && !availableRuleProviders.has(parsed.value)) {
    return null;
  }
  const extra = parts.slice(3).filter(Boolean);
  return [type, parsed.value, target, ...extra].join(',');
}

/**
 * Imported subscriptions cannot supply files next to the generated runtime
 * config, and the parser intentionally does not retain arbitrary local paths
 * or inline payloads. Keep only remote providers Mihomo can fetch by itself.
 */
function normalizeMihomoRuleProviders(ruleProviders) {
  const normalized = {};
  if (!ruleProviders || typeof ruleProviders !== 'object') return normalized;
  const behaviors = new Set(['domain', 'ipcidr', 'classical']);
  const formats = new Set(['yaml', 'text', 'mrs']);
  for (const [name, provider] of Object.entries(ruleProviders)) {
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') continue;
    if (!name || name.length > 256 || /[\r\n,]/.test(name)) continue;
    if (!provider || typeof provider !== 'object') continue;
    if (String(provider.type || 'http').toLowerCase() !== 'http') continue;
    const behavior = String(provider.behavior || 'classical').toLowerCase();
    const format = String(provider.format || 'yaml').toLowerCase();
    if (!behaviors.has(behavior) || !formats.has(format)) continue;
    if (format === 'mrs' && behavior === 'classical') continue;
    const url = String(provider.url || '').trim();
    try {
      const protocol = new URL(url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') continue;
    } catch (_) {
      continue;
    }
    normalized[name] = { type: 'http', behavior, url, format };
  }
  return normalized;
}

function buildMihomoConfig(nodes, opts = {}) {
  const {
    mixedPort = 7890,
    clashApiPort = 9090,
    clashApiSecret = '',
    logLevel = 'info',
    selected = null,
    clashMode = 'rule',
    clashRules = [],
    policyGroups = [],
    ruleOverrides = null,
    ruleGroupSelections = null,
    ruleProviders = {},
    enableIpv6 = true,
    enableTun = false,
    tunInterfaceName = 'Dart',
    dnsRemote = 'https://1.1.1.1/dns-query',
    dnsLocal = 'https://223.5.5.5/dns-query',
    testUrl = DEFAULT_TEST_URL,
    externalUiDir = '',
    externalUiDownloadUrl = '',
    extraRules = [],
    hasGeoData = true,
  } = opts;

  const nodeEntries = nodes
    .map((node) => ({ node, proxy: nodeToClashProxy(node) }))
    .filter((entry) => !!entry.proxy);
  const proxies = dedupeProxyNames(nodeEntries.map((entry) => entry.proxy));
  const proxyNames = proxies.map((p) => p.name);
  if (!proxyNames.length) throw new Error('No supported proxy nodes are available.');
  const smartProxyNames = smartRegionMembers(
    nodeEntries.map((entry) => entry.node),
    proxyNames,
    opts.smartRegions
  );
  const sourceGroups = applySourceGroupSelections(
    prepareSourcePolicyGroups(policyGroups, proxyNames),
    proxyNames,
    ruleGroupSelections
  );
  const sourceGroupNames = sourceGroups.map((group) => group.name);
  const availableTargets = new Set([AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, ...proxyNames, ...sourceGroupNames]);
  const mihomoRuleProviders = normalizeMihomoRuleProviders(ruleProviders);
  const availableRuleProviders = new Set(Object.keys(mihomoRuleProviders));
  const latencyUrl = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  // Same as sing-box: 🚀 Proxy must not list source policy groups. Those groups
  // already include 🚀 Proxy for "follow main selection"; nesting both ways is a
  // cycle (Mihomo may accept it, but selection/routing becomes undefined).
  const proxyMembers = [AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, ...proxyNames, 'DIRECT'];
  const defaultProxy =
    selected && (proxyMembers.includes(selected) || selected === 'direct')
      ? (selected === 'direct' ? 'DIRECT' : selected)
      : AUTO_GROUP;
  const manualProxies = [];
  const manualSeen = new Set();
  const addManual = (name) => {
    if (name && !manualSeen.has(name)) {
      manualSeen.add(name);
      manualProxies.push(name);
    }
  };
  addManual(defaultProxy);
  for (const name of proxyMembers) addManual(name);

  const autoGroup = { name: AUTO_GROUP, type: 'select', proxies: proxyNames };
  const smartGroup = buildMihomoSmartGroup(smartProxyNames, {
    kernelSmart: !!opts.kernelSmart,
    kernelSmartMode: !!opts.kernelSmartMode,
    latencyUrl,
    smartMode: opts.smartMode,
  });

  const rules = [];
  let finalRule = 'MATCH,🚀 Proxy';
  if (clashMode === 'block') {
    rules.push('MATCH,REJECT');
  } else {
    // Always prepend private-LAN direct, matching sing-box's early
    // ip_is_private rule — even when the subscription ships its own rules.
    const privateDirect = [
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
      'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
      'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
      'IP-CIDR6,::1/128,DIRECT,no-resolve',
    ];
    for (const rule of privateDirect) rules.push(rule);
    for (const r of extraRules) {
      for (const converted of singboxRuleToClashRules(r)) rules.push(converted);
    }
    for (const raw of flattenClashRules(clashRules)) {
      if (raw && typeof raw === 'object' && raw.logical === 'AND') {
        const combined = andDescriptorToMihomoRule(raw, ruleOverrides, availableTargets);
        if (combined) rules.push(combined);
        continue;
      }
      const rule = clashRuleToMihomo(raw, ruleOverrides, availableRuleProviders, availableTargets);
      if (!hasGeoData && /^(GEOIP|GEOSITE),/i.test(rule || '')) continue;
      if (/^MATCH,/i.test(rule || '')) finalRule = rule;
      else if (rule) rules.push(rule);
    }
    // CN direct fallback, after subscription rules and before MATCH — same
    // relative order as sing-box's geoip-cn/geosite-cn rule.
    if (hasGeoData) rules.push('GEOIP,CN,DIRECT');
    rules.push(finalRule);
  }

  const sourceProxyGroups = mihomoPolicyGroups(sourceGroups, latencyUrl, {
    interval: AUTO_TEST_INTERVAL_SECONDS,
    timeout: AUTO_TEST_TIMEOUT_MS,
  });

  const config = {
    'mixed-port': mixedPort,
    'allow-lan': false,
    mode: clashMode === 'global' ? 'global' : clashMode === 'direct' ? 'direct' : 'rule',
    'log-level': logLevel,
    ipv6: !!enableIpv6,
    // Race every address returned for a hostname and keep the first successful
    // TCP connection. Mihomo otherwise dials addresses within each IP family
    // serially, so a stale/unreachable address can stall even DIRECT traffic
    // for seconds before the next address is attempted.
    'tcp-concurrent': true,
    'geodata-mode': true,
    'geodata-loader': 'memconservative',
    'geo-auto-update': false,
    proxies,
    'proxy-groups': [
      { name: '🚀 Proxy', type: 'select', proxies: manualProxies },
      autoGroup,
      smartGroup,
      {
        name: FALLBACK_GROUP,
        type: 'fallback',
        proxies: proxyNames,
        url: latencyUrl,
        interval: AUTO_TEST_INTERVAL_SECONDS,
        timeout: AUTO_TEST_TIMEOUT_MS,
        'max-failed-times': 2,
        lazy: true,
      },
      ...sourceProxyGroups,
    ],
    rules,
  };
  if (enableTun) {
    // TUN captures the system's port 53 traffic, so Mihomo's DNS module must
    // answer it. Resolve proxy server hostnames through the local resolver to
    // avoid a bootstrap loop, while regular queries follow the proxy rules.
    config.dns = {
      enable: true,
      ipv6: !!enableIpv6,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter': ['*.lan', '*.local', 'localhost', 'localhost.*'],
      'default-nameserver': ['223.5.5.5', '1.1.1.1'],
      nameserver: [dnsRemote],
      'proxy-server-nameserver': [dnsLocal],
      'direct-nameserver': [dnsLocal],
      'respect-rules': true,
    };
    config.tun = {
      enable: true,
      ...(tunInterfaceName ? { device: tunInterfaceName } : {}),
      stack: 'mixed',
      mtu: 9000,
      'auto-route': true,
      'strict-route': true,
      'auto-detect-interface': true,
      'dns-hijack': ['any:53', 'tcp://any:53'],
    };
  }
  config['external-controller'] = `127.0.0.1:${clashApiPort}`;
  if (clashApiSecret) config.secret = clashApiSecret;
  if (externalUiDir) {
    config['external-ui'] = externalUiDir;
    if (externalUiDownloadUrl) config['external-ui-url'] = externalUiDownloadUrl;
  }
  if (availableRuleProviders.size) config['rule-providers'] = mihomoRuleProviders;
  return config;
}

module.exports = {
  DEFAULT_TEST_URL,
  SMART_GROUP,
  APP_PROXY_GROUP,
  coreSupportsKernelSmart,
  buildSingboxSmartGroup,
  buildMihomoSmartGroup,
  prepareSourcePolicyGroups,
  applySourceGroupSelections,
  sourceGroupPickOptions,
  sourcePicksForWiredGroup,
  nodeToOutbound,
  nodeToClashProxy,
  buildSingboxConfig,
  buildMihomoConfig,
  buildRoute,
  clashRulesToSingbox,
  extractRuleGroups,
  extractRuleSetRefs,
  extractGeoCategories,
  parseRuleList,
  dnsServerFromAddress,
  singboxRuleToClashRules,
  ruleListToSingboxRule,
};
