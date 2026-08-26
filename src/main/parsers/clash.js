'use strict';

const yaml = require('js-yaml');
const { normalizeProxyProviders } = require('../proxy-providers');

/**
 * Clash config parser
 *
 * Parses Clash / Clash.Meta YAML subscription content into a unified array of
 * internal node objects. Also tries to preserve proxy-groups information
 * (used to generate selector / urltest groups).
 */

/** Normalize a Clash proxy object into an internal node object. */
function cloneMihomoValue(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 24) throw new Error('Mihomo proxy nesting is too deep');
  if (Array.isArray(value)) return value.map((item) => cloneMihomoValue(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    const cloned = cloneMihomoValue(item, depth + 1);
    if (cloned !== undefined) out[key] = cloned;
  }
  return out;
}

function normalizeClashProxy(p) {
  if (!p || !p.type) return null;
  const type = String(p.type).toLowerCase();
  const server = typeof p.server === 'string' ? p.server.trim() : '';
  const port = Number(p.port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const base = {
    name: p.name,
    server,
    port,
    // Mihomo is now the sole runtime. Keep its complete native object so
    // fields unknown to the GUI remain lossless across import/update/build.
    mihomoProxy: cloneMihomoValue(p),
  };

  switch (type) {
    case 'ss':
    case 'shadowsocks':
      return {
        ...base,
        type: 'ss',
        cipher: p.cipher,
        password: p.password,
        plugin: p.plugin,
        pluginOpts: p['plugin-opts'],
        udp: p.udp,
      };

    case 'vmess':
      return {
        ...base,
        type: 'vmess',
        uuid: p.uuid,
        alterId: parseInt(p.alterId || p.alterid || 0, 10),
        cipher: p.cipher || 'auto',
        network: p.network || 'tcp',
        tls: !!p.tls,
        servername: p.servername || p.sni || '',
        alpn: p.alpn,
        skipCertVerify: p['skip-cert-verify'],
        wsOpts: p['ws-opts'],
        h2Opts: p['h2-opts'],
        grpcOpts: p['grpc-opts'],
        udp: p.udp,
      };

    case 'vless': {
      // Reality always implies TLS. Some subscription YAML omit `tls: true` and
      // only set reality-opts; Clash Meta still treats those as TLS nodes.
      const reality = p['reality-opts']
        ? {
            publicKey: p['reality-opts']['public-key'],
            shortId: p['reality-opts']['short-id'],
          }
        : undefined;
      return {
        ...base,
        type: 'vless',
        uuid: p.uuid,
        flow: p.flow || '',
        network: p.network || 'tcp',
        tls: !!p.tls || !!(reality && reality.publicKey),
        servername: p.servername || p.sni || '',
        alpn: p.alpn,
        clientFingerprint: p['client-fingerprint'],
        skipCertVerify: p['skip-cert-verify'],
        reality,
        wsOpts: p['ws-opts'],
        grpcOpts: p['grpc-opts'],
        h2Opts: p['h2-opts'],
        udp: p.udp,
      };
    }

    case 'trojan':
      return {
        ...base,
        type: 'trojan',
        password: p.password,
        tls: true,
        servername: p.sni || p.servername || p.server,
        alpn: p.alpn,
        skipCertVerify: p['skip-cert-verify'],
        network: p.network || 'tcp',
        wsOpts: p['ws-opts'],
        grpcOpts: p['grpc-opts'],
        udp: p.udp,
      };

    case 'hysteria2':
    case 'hy2':
      return {
        ...base,
        type: 'hysteria2',
        password: p.password || p.auth,
        obfs: p.obfs,
        obfsPassword: p['obfs-password'],
        servername: p.sni || p.servername || '',
        alpn: p.alpn,
        skipCertVerify: p['skip-cert-verify'],
        up: p.up,
        down: p.down,
      };

    case 'hysteria':
      return {
        ...base,
        type: 'hysteria',
        authStr: p['auth-str'] || p.auth_str || p.auth,
        obfs: p.obfs,
        servername: p.sni || p.servername || '',
        alpn: p.alpn,
        skipCertVerify: p['skip-cert-verify'],
        up: p.up,
        down: p.down,
      };

    case 'anytls':
      return {
        ...base,
        type: 'anytls',
        password: p.password,
        servername: p.sni || p.servername || p.server,
        alpn: p.alpn,
        clientFingerprint: p['client-fingerprint'],
        skipCertVerify: p['skip-cert-verify'],
        idleCheck: p['idle-session-check-interval'],
        idleTimeout: p['idle-session-timeout'],
        minIdleSession: p['min-idle-session'],
        udp: p.udp,
      };

    case 'tuic':
      return {
        ...base,
        type: 'tuic',
        uuid: p.uuid,
        password: p.password,
        congestionControl: p['congestion-controller'] || p['congestion-control'] || 'bbr',
        udpRelayMode: p['udp-relay-mode'] || 'native',
        servername: p.sni || p.servername || '',
        alpn: p.alpn,
        skipCertVerify: p['skip-cert-verify'],
      };

    case 'socks5':
    case 'socks':
      return {
        ...base,
        type: 'socks',
        username: p.username,
        password: p.password,
        udp: p.udp,
      };

    case 'http':
    case 'https':
      return {
        ...base,
        type: 'http',
        username: p.username,
        password: p.password,
        tls: p.tls || type === 'https',
        servername: p.sni || '',
        skipCertVerify: p['skip-cert-verify'],
      };

    default:
      return {
        ...base,
        type,
      };
  }
}

/**
 * Parse Clash YAML content.
 * @returns {{ nodes: object[], groups: object[], rules: string[], isClash: boolean }}
 *   isClash: whether the document actually carries a `proxies:` array — lets
 *   callers detect and convert with a single YAML parse.
 */
function parseClashConfig(content) {
  let doc;
  try {
    doc = yaml.load(content);
  } catch (e) {
    throw new Error('Clash YAML parse failed: ' + e.message);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('not a valid Clash config');
  }

  const proxyProviders = normalizeProxyProviders(doc['proxy-providers']);
  const isClash = Array.isArray(doc.proxies) || Object.keys(proxyProviders).length > 0;
  const nodes = [];
  for (const p of Array.isArray(doc.proxies) ? doc.proxies : []) {
    const node = normalizeClashProxy(p);
    if (node) nodes.push(node);
  }

  const groups = Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : [];
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  const ruleProviders = normalizeRuleProviders(doc['rule-providers']);

  return { nodes, groups, rules, ruleProviders, proxyProviders, isClash };
}

/**
 * Normalize a Clash `rule-providers:` map into { name: {type, behavior, url,
 * format} }. Only the fields we need to download + parse remote lists; `file`
 * and `inline` providers (no fetchable URL) are kept but carry no url.
 */
function normalizeRuleProviders(rp) {
  const out = {};
  if (!rp || typeof rp !== 'object') return out;
  for (const [name, def] of Object.entries(rp)) {
    // Assignment to __proto__ changes the prototype of a normal object instead
    // of creating a provider. These names are not useful Clash identifiers and
    // must not be allowed to alter the normalized result's object shape.
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') continue;
    if (!def || typeof def !== 'object') continue;
    out[name] = {
      type: def.type || 'http',
      behavior: def.behavior || 'classical',
      url: def.url || '',
      format: def.format || 'yaml',
    };
  }
  return out;
}

/** Whether the content is a Clash config (YAML containing a proxies field). */
function isClashConfig(content) {
  const text = String(content);
  if (!/^\s*(?:proxies|proxy-providers)\s*:/m.test(text)) return false;
  try {
    return parseClashConfig(text).isClash;
  } catch (e) {
    return false;
  }
}

module.exports = {
  parseClashConfig,
  isClashConfig,
};
