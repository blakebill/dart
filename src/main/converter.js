'use strict';

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
      if (node.plugin === 'obfs' || node.plugin === 'simple-obfs') {
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
  // Split optional port.
  let server = s;
  let port;
  const lastColon = s.lastIndexOf(':');
  if (lastColon > 0 && !s.includes('::')) {
    const maybePort = s.slice(lastColon + 1);
    if (/^\d+$/.test(maybePort)) {
      server = s.slice(0, lastColon);
      port = parseInt(maybePort, 10);
    }
  }
  out.type = type;
  out.server = server;
  if (port) out.server_port = port;
  if (type === 'https' && path && path !== '/dns-query') out.path = path;
  if (detour) out.detour = detour;
  return out;
}

/** Map a Clash rule target (proxy/group name) to a sing-box outbound tag. */
function mapClashTarget(name) {
  const n = String(name || '').trim();
  if (/^DIRECT$/i.test(n)) return 'direct';
  if (/^REJECT/i.test(n)) return 'reject'; // handled as an action below
  // All proxy groups / node references collapse onto our single selector.
  return '🚀 Proxy';
}

/**
 * Convert Clash `rules:` entries into sing-box route rules.
 * Unsupported rule types are skipped gracefully. MATCH/FINAL is ignored (the
 * generated config keeps its own final outbound).
 * @param {string[]} clashRules
 * @param {boolean} hasGeo  whether the geoip-cn/geosite-cn rule-sets exist; when
 *   false, GEOIP,CN rules are skipped so the config never references a rule-set
 *   that isn't defined (sing-box treats an unknown rule_set as a fatal error).
 * @returns {{ rules: object[] }}
 */
function clashRulesToSingbox(clashRules, hasGeo = true) {
  const out = [];
  for (const raw of clashRules || []) {
    if (typeof raw !== 'string') continue;
    const parts = raw.split(',').map((s) => s.trim());
    const type = (parts[0] || '').toUpperCase();
    const value = parts[1];
    const targetRaw = type === 'MATCH' || type === 'FINAL' ? parts[1] : parts[2];
    const target = mapClashTarget(targetRaw);
    const apply = (rule) => {
      if (target === 'reject') rule.action = 'reject';
      else rule.outbound = target;
      out.push(rule);
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
        // Only CN is backed by a rule-set, and only when geodata is present;
        // otherwise the reference would point at an undefined rule_set.
        if (hasGeo && String(value).toUpperCase() === 'CN') apply({ rule_set: ['geoip-cn'] });
        break;
      default:
        // RULE-SET, GEOSITE, PROCESS-PATH, MATCH/FINAL, etc. -> skipped.
        break;
    }
  }
  return { rules: out };
}

/**
 * Parse a remote rule list (Clash rule-provider classical/domain/ipcidr, Surge,
 * Loon, QuantumultX, or a plain domain list) into sing-box matcher arrays.
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
 * @returns {{ rule: object|null, count: number }}
 */
function ruleListToSingboxRule(text, target) {
  const m = parseRuleList(text);
  const rule = {};
  let count = 0;
  for (const k of Object.keys(m)) {
    if (m[k].length) {
      rule[k] = m[k];
      count += m[k].length;
    }
  }
  if (count === 0) return { rule: null, count: 0 };
  if (target === 'direct') rule.outbound = 'direct';
  else if (target === 'reject') rule.action = 'reject';
  else rule.outbound = '🚀 Proxy';
  return { rule, count };
}

/** Deduplicate tags and handle nodes with duplicate names. */
function dedupeTags(outbounds) {
  const seen = new Map();
  for (const ob of outbounds) {
    let tag = ob.tag || 'node';
    if (seen.has(tag)) {
      const count = seen.get(tag) + 1;
      seen.set(tag, count);
      ob.tag = `${tag} ${count}`;
    } else {
      seen.set(tag, 1);
    }
  }
  return outbounds;
}

/**
 * Build just the sing-box route block ({ rules, rule_set }) from options. The
 * route references outbounds by tag (string), so it does not need the node
 * outbounds — letting callers (e.g. the Rules view) compute it cheaply without
 * converting every node.
 */
function buildRoute(opts = {}) {
  const { ruleSetDir = null, clashRules = [], extraRules = [], extraRuleSets = [] } = opts;
  // Local .srs only. A `remote` rule-set would be fetched during start-up via
  // download_detour, and sing-box treats a failed fetch as FATAL — so a fresh
  // install with no geodata (and raw.githubusercontent.com blocked, or no
  // healthy node yet) would crash on boot. When the geodata is absent we drop
  // the geoip-cn/geosite-cn optimization entirely instead: the core starts
  // clean (all traffic via the proxy), and the rule-set returns once geodata
  // is bundled or downloaded.
  const hasGeo = !!ruleSetDir;
  const convertedRules = clashRulesToSingbox(clashRules, hasGeo).rules;

  const RS = [
    { tag: 'geoip-cn', file: 'geoip-cn.srs' },
    { tag: 'geosite-cn', file: 'geosite-cn.srs' },
  ];
  const geoRuleSets = hasGeo
    ? RS.map((r) => ({ type: 'local', tag: r.tag, format: 'binary', path: (ruleSetDir + '/' + r.file).replace(/\\/g, '/') }))
    : [];
  // The "CN traffic goes direct" rule only when its rule-sets are defined.
  const geoDirectRule = hasGeo ? [{ rule_set: ['geoip-cn', 'geosite-cn'], outbound: 'direct' }] : [];

  return {
    rules: [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' },
      // Block mode: reject every connection (placed above all other routing).
      { clash_mode: 'Block', action: 'reject' },
      { ip_is_private: true, outbound: 'direct' },
      { clash_mode: 'Direct', outbound: 'direct' },
      { clash_mode: 'Global', outbound: '🚀 Proxy' },
      // Custom rule-sets (user-added) take top priority.
      ...extraRules,
      // Converted from the subscription's Clash rules (above the geoip/geosite fallback).
      ...convertedRules,
      ...geoDirectRule,
    ],
    rule_set: [...geoRuleSets, ...extraRuleSets],
  };
}

/**
 * Assemble a full sing-box config.
 *
 * @param {object[]} nodes  array of internal node objects
 * @param {object}   opts   options
 *   - mixedPort: mixed inbound port (default 7890)
 *   - enableTun: whether to enable TUN (default false)
 *   - enableClashApi: whether to enable Clash API (default true, port 9090)
 *   - logLevel: log level (default info)
 *   - finalOutbound: fallback outbound tag (default node selector)
 * @returns {object} sing-box config
 */
function buildSingboxConfig(nodes, opts = {}) {
  const {
    mixedPort = 7890,
    enableTun = false,
    enableClashApi = true,
    clashApiPort = 9090,
    clashApiSecret = '', // when set, the Clash API requires Authorization
    externalUiDir = '', // serve a local dashboard at /ui when set
    externalUiDownloadUrl = '',
    logLevel = 'info',
    ruleSetDir = null,
    selected = null,
    clashMode = 'rule',
    clashRules = [],
    enableIpv6 = true,
    dnsRemote = 'https://1.1.1.1/dns-query',
    dnsLocal = 'https://223.5.5.5/dns-query',
    dnsStrategy = 'prefer_ipv4',
    extraRules = [], // route rules from custom rule-sets
    extraRuleSets = [], // local rule_set defs from custom .srs
  } = opts;

  const nodeOutbounds = dedupeTags(
    nodes.map(nodeToOutbound).filter(Boolean)
  );
  const nodeTags = nodeOutbounds.map((o) => o.tag);

  // Default selection: a specific node tag if it still exists, else auto.
  const defaultOutbound =
    selected && (selected === '♻️ Auto' || selected === 'direct' || nodeTags.includes(selected))
      ? selected
      : '♻️ Auto';

  // Node groups: manual selector + automatic urltest
  const proxyGroup = {
    type: 'selector',
    tag: '🚀 Proxy',
    outbounds: ['♻️ Auto', ...nodeTags, 'direct'],
    default: defaultOutbound,
  };
  const autoGroup = {
    type: 'urltest',
    tag: '♻️ Auto',
    outbounds: nodeTags,
    url: 'https://www.gstatic.com/generate_204',
    interval: '1m',
    tolerance: 50,
    idle_timeout: '30m',
  };

  // Only "direct" remains a special outbound; block / dns are handled via route
  // rule actions (reject / hijack-dns) in sing-box 1.12+.
  const outbounds = [proxyGroup, autoGroup, ...nodeOutbounds, { type: 'direct', tag: 'direct' }];

  // Inbounds (sing-box 1.12+: sniffing is a route rule action, not an inbound field)
  const inbounds = [];
  if (enableTun) {
    inbounds.push({
      type: 'tun',
      tag: 'tun-in',
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

  const route = buildRoute({ ruleSetDir, clashRules, extraRules, extraRuleSets });

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
        { clash_mode: 'Direct', server: 'local-dns' },
        { clash_mode: 'Global', server: 'proxy-dns' },
        // Resolve CN domains with the local resolver — only when the rule-set
        // exists (see buildRoute: a missing geosite-cn must not be referenced).
        ...(ruleSetDir ? [{ rule_set: 'geosite-cn', server: 'local-dns' }] : []),
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
      final: '🚀 Proxy',
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

  if (enableClashApi) {
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
  }

  return config;
}

module.exports = {
  nodeToOutbound,
  buildSingboxConfig,
  buildRoute,
  clashRulesToSingbox,
  dnsServerFromAddress,
  parseRuleList,
  ruleListToSingboxRule,
};
