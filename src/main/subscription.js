'use strict';

const crypto = require('crypto');
const yaml = require('js-yaml');
const clashParser = require('./parsers/clash');
const linkParser = require('./parsers/share-link');
const singboxParser = require('./parsers/singbox');
const { singboxRuleToClashRules, nodeToClashProxy, nodeToOutbound } = require('./converter');
const { clashPolicyGroups, normalizePolicyGroups } = require('./policy-groups');
const fetch = require('./fetch');
const MAX_SUBSCRIPTION_BYTES = 32 * 1024 * 1024;
const MAX_PROFILE_EDIT_FORMAT_BYTES = 4 * 1024 * 1024;
const USER_INFO_FIELDS = new Set(['upload', 'download', 'total', 'expire']);

const RESERVED_NODE_NAMES = new Set([
  '🚀 Proxy', '♻️ Auto', '🧠 Smart', '🛟 Fallback',
  'direct', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL',
]);

function uniqueNodeNames(nodes) {
  const used = new Set(RESERVED_NODE_NAMES);
  const nextSuffix = new Map();
  return (nodes || []).filter((node) => node && typeof node === 'object' && !Array.isArray(node)).map((node, index) => {
    const fallback = `${node.type || 'node'} ${index + 1}`;
    const base = String(node.name || fallback).trim() || fallback;
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
    return name === node.name ? node : { ...node, name };
  });
}

function updateFingerprint(hash, value, stack = new Set()) {
  if (value === null || value === undefined) {
    hash.update('null;');
    return;
  }
  const type = typeof value;
  if (type === 'string') {
    hash.update(`s${Buffer.byteLength(value)}:`);
    hash.update(value);
    return;
  }
  if (type === 'number') {
    hash.update(`n${Number.isFinite(value) ? value : 'null'};`);
    return;
  }
  if (type === 'boolean') {
    hash.update(value ? 'b1;' : 'b0;');
    return;
  }
  if (type !== 'object') {
    hash.update(`x${String(value)};`);
    return;
  }
  if (stack.has(value)) throw new Error('cannot fingerprint a cyclic config');
  stack.add(value);
  if (Array.isArray(value)) {
    hash.update(`a${value.length}[`);
    for (const item of value) updateFingerprint(hash, item, stack);
    hash.update(']');
  } else {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    hash.update(`o${keys.length}{`);
    for (const key of keys) {
      updateFingerprint(hash, key, stack);
      updateFingerprint(hash, value[key], stack);
    }
    hash.update('}');
  }
  stack.delete(value);
}

/** Stable, incremental digest of the parts that change a running core config. */
function configFingerprint(value) {
  const source = value || {};
  const hash = crypto.createHash('sha256');
  updateFingerprint(hash, source.nodes || []);
  updateFingerprint(hash, source.policyGroups || source.groups || []);
  updateFingerprint(hash, source.clashRules || source.rules || []);
  updateFingerprint(hash, source.clashRuleProviders || source.ruleProviders || {});
  return hash.digest('hex');
}

/**
 * Stable identity for Smart history. Display names are intentionally excluded
 * so a renamed subscription node keeps its observations; every routing-
 * relevant field (including credentials) remains covered by the local digest.
 */
function nodeFingerprint(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const identity = {};
  for (const key of Object.keys(node).sort()) {
    if (key !== 'name' && node[key] !== undefined) identity[key] = node[key];
  }
  const hash = crypto.createHash('sha256');
  updateFingerprint(hash, identity);
  return hash.digest('hex');
}

/** Parse the airport traffic info header `subscription-userinfo`. */
function parseUserInfo(headers) {
  const raw = headers['subscription-userinfo'];
  if (!raw) return null;
  const info = {};
  for (const part of String(raw).split(';')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    const value = Number(v);
    if (USER_INFO_FIELDS.has(k) && v !== undefined && Number.isFinite(value) && value >= 0) info[k] = value;
  }
  return Object.keys(info).length ? info : null;
}

/** Decode a base64 body to text if it plausibly is base64, else return null. */
function maybeBase64Decode(text) {
  // A JSON/YAML body contains characters base64 never does; skip those fast.
  if (/[{}:"']/.test(text)) return null;
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf-8');
    return decoded && /[ -~]/.test(decoded) ? decoded.trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Auto-detect the content format and parse it into a unified array of node objects.
 * Native sing-box JSON is checked before Clash YAML and share-link subscriptions.
 */
function parseSubscriptionContent(content) {
  const text = String(content || '').trim();
  if (!text) return { nodes: [], groups: [], policyGroups: [], format: 'empty' };
  const decodedText = maybeBase64Decode(text);
  const candidates = decodedText ? [text, decodedText] : [text];

  // sing-box JSON config (a sing-box client must accept its own format). Try the
  // raw text, then a base64-decoded copy (some airports base64 the whole body).
  for (const candidate of candidates) {
    if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) continue;
    const r = singboxParser.parseSingboxConfig(candidate);
    if (r.isSingbox && r.nodes.length) {
      const nodes = uniqueNodeNames(r.nodes);
      const policyGroups = normalizePolicyGroups(r.groups, nodes);
      const rules = (r.routeRules || []).flatMap((rule) => (
        singboxRuleToClashRules(rule, { includeRuleSets: false, preserveOutbound: true })
      ));
      const routeFinal = String(r.routeFinal || '').trim();
      if (routeFinal && !/[\r\n,]/.test(routeFinal)) rules.push(`MATCH,${routeFinal}`);
      return {
        nodes,
        groups: policyGroups,
        policyGroups,
        // sing-box binary rule sets are not Clash-compatible; preserve common
        // inline matchers and omit unresolved RULE-SET references.
        rules,
        format: 'singbox',
      };
    }
  }

  // Clash YAML first. The cheap "proxies:" check gates the YAML load, and the
  // parse result is reused for detection + conversion (one parse, not two).
  for (const candidate of candidates) {
    if (/proxies\s*:/.test(candidate)) {
      try {
        const r = clashParser.parseClashConfig(candidate);
        if (r.isClash) {
          const nodes = uniqueNodeNames(r.nodes);
          const policyGroups = clashPolicyGroups(r.groups, nodes);
          return { nodes, groups: policyGroups, policyGroups, rules: r.rules, ruleProviders: r.ruleProviders, format: 'clash' };
        }
      } catch (e) {
        /* not valid YAML; fall through to the link parser */
      }
    }
  }

  // Share links / base64 subscription
  const nodes = uniqueNodeNames(linkParser.parseSubscriptionLinks(text));
  if (nodes.length > 0) {
    return { nodes, groups: [], policyGroups: [], rules: [], format: 'links' };
  }

  // Fallback: try parsing as Clash again (some configs without a proxies: comment)
  for (const candidate of candidates) {
    try {
      const { nodes: cn, groups, rules, ruleProviders } = clashParser.parseClashConfig(candidate);
      if (cn.length > 0) {
        const normalizedNodes = uniqueNodeNames(cn);
        const policyGroups = clashPolicyGroups(groups, normalizedNodes);
        return { nodes: normalizedNodes, groups: policyGroups, policyGroups, rules, ruleProviders, format: 'clash' };
      }
    } catch (e) {
      /* ignore */
    }
  }

  return { nodes: [], groups: [], policyGroups: [], rules: [], format: 'unknown' };
}

function formatSubscriptionForEditing(content, targetFormat = 'auto') {
  const text = typeof content === 'string' ? content : '';
  if (!text || Buffer.byteLength(text, 'utf-8') > MAX_PROFILE_EDIT_FORMAT_BYTES) return text;
  const readable = maybeBase64Decode(text) || text;
  if (Buffer.byteLength(readable, 'utf-8') > MAX_PROFILE_EDIT_FORMAT_BYTES) return text;
  try {
    return JSON.stringify(JSON.parse(readable), null, 2);
  } catch (_) {
    // Continue below: an encoded share-link list can be rendered as the
    // explicitly requested subscription format instead of opaque URIs.
  }
  const parsed = parseSubscriptionContent(readable);
  try {
    if (parsed.format === 'links' && parsed.nodes.length && targetFormat === 'clash') {
      const proxies = parsed.nodes.map(nodeToClashProxy).filter(Boolean);
      if (proxies.length) {
        return yaml.dump(
          { proxies },
          { noRefs: true, lineWidth: -1, noCompatMode: true }
        ).trimEnd();
      }
    }
    if (parsed.format === 'links' && parsed.nodes.length && targetFormat === 'sing-box') {
      const outbounds = parsed.nodes.map(nodeToOutbound).filter(Boolean);
      if (outbounds.length) return JSON.stringify({ outbounds }, null, 2);
    }
  } catch (_) {
    return readable;
  }
  return readable;
}

// Many airports select an output format from the client User-Agent. Ask for the
// active core's native format first, then fall back to the other ecosystem.
const SINGBOX_USER_AGENTS = ['sing-box/1.13.0'];
const MIHOMO_USER_AGENT = 'mihomo/1.18.10';
const CLASH_USER_AGENTS = [
  'clash-verge/v2.0.2',
  'ClashforWindows/0.20.39',
  'clash.meta',
  'Clash/2023.08.17',
];

function subscriptionUserAgents(coreType, userAgentMode = 'auto') {
  if (userAgentMode === 'sing-box') return [...SINGBOX_USER_AGENTS];
  if (userAgentMode === 'clash') return [...CLASH_USER_AGENTS, MIHOMO_USER_AGENT];
  return coreType === 'sing-box'
    ? [...SINGBOX_USER_AGENTS, MIHOMO_USER_AGENT, ...CLASH_USER_AGENTS]
    : [MIHOMO_USER_AGENT, ...CLASH_USER_AGENTS, ...SINGBOX_USER_AGENTS];
}

function preferredSubscriptionFormat(coreType, userAgentMode = 'auto') {
  if (userAgentMode === 'sing-box') return 'singbox';
  if (userAgentMode === 'clash') return 'clash';
  if (coreType === 'sing-box') return 'singbox';
  if (coreType === 'mihomo') return 'clash';
  return null;
}

function subscriptionFormatRank(format, preferredFormat) {
  if (format === preferredFormat) return 3;
  if (format === 'clash' || format === 'singbox') return 2;
  if (format === 'links') return 1;
  return 0;
}

function userAgentNativeFormat(userAgent) {
  return String(userAgent).startsWith('sing-box/') ? 'singbox' : 'clash';
}

/**
 * Fetch and parse a subscription. Requests the active core's native format
 * first, then retries with compatible client User-Agents when necessary.
 * @param {string} url subscription URL
 * @param {function} log
 * @param {{proxyPort?:number,coreType?:string,userAgentMode?:string}} opts when proxyPort is set, the request tunnels
 *   through the local mixed proxy first and falls back to a direct connection
 *   (for airports whose subscription endpoint is itself blocked). userAgentMode
 *   can pin requests to the sing-box or Clash client ecosystem.
 * @returns {{ nodes, groups, format, userInfo }}
 */
async function fetchSubscription(url, log = () => {}, opts = {}) {
  const proxyPort = opts.proxyPort || 0;
  const expectedFormat = preferredSubscriptionFormat(opts.coreType, opts.userAgentMode);
  let last = null;
  let usableFallback = null;
  let fallbackRank = 0;
  const userAgents = subscriptionUserAgents(opts.coreType, opts.userAgentMode);
  let preferredAgentsLeft = expectedFormat
    ? userAgents.filter((ua) => userAgentNativeFormat(ua) === expectedFormat).length
    : 0;
  for (const ua of userAgents) {
    const isPreferredAgent = userAgentNativeFormat(ua) === expectedFormat;
    if (isPreferredAgent) preferredAgentsLeft -= 1;
    let res;
    try {
      // One HTTP path for both modes: with proxyPort the request tunnels
      // through the local proxy first and falls back to direct.
      const r = await fetch.getBufferWithFallback(url, {
        proxyPort,
        maxBytes: MAX_SUBSCRIPTION_BYTES,
        headers: { 'User-Agent': ua, Accept: '*/*' },
      });
      res = { body: r.body.toString('utf-8'), headers: r.headers || {} };
    } catch (e) {
      log(`[sub] UA="${ua}" request error: ${e.message}`);
      last = { nodes: [], groups: [], rules: [], format: 'error', error: e.message };
      // User-Agent rotation can change a server's HTTP response, but cannot
      // repair DNS, TCP or TLS reachability. getBufferWithFallback has already
      // tried the configured proxy and direct path, so fail without repeating
      // the same 20-35 second network timeout five more times.
      if (!/^HTTP\s+(?:400|401|403|406)\b/i.test(String(e.message || ''))) {
        if (usableFallback) return usableFallback;
        throw e;
      }
      continue;
    }
    const body = res.body || '';
    const result = parseSubscriptionContent(body);
    result.userInfo = parseUserInfo(res.headers);
    result.raw = body;
    const ct = res.headers['content-type'] || '';
    log(`[sub] UA="${ua}" len=${body.length} type="${ct}" format=${result.format} nodes=${result.nodes.length}`);
    if (result.nodes.length > 0) {
      if (!expectedFormat || result.format === expectedFormat) return result;
      const rank = subscriptionFormatRank(result.format, expectedFormat);
      if (rank > fallbackRank) {
        usableFallback = result;
        fallbackRank = rank;
      }
      // Once every UA from the preferred ecosystem has been tried, a full
      // config from the other ecosystem is strictly better than Links and no
      // further request can produce the preferred native format.
      if (rank >= 2 && preferredAgentsLeft === 0) {
        log(`[sub] preferred ${expectedFormat} unavailable; using structured ${usableFallback.format} response`);
        return usableFallback;
      }
      log(`[sub] preferred ${expectedFormat}, continuing after compatible ${result.format} response`);
      continue;
    }
    // Help diagnose airports that return an empty/notice config: show a snippet.
    const snippet = body.replace(/\s+/g, ' ').slice(0, 200);
    log(`[sub] no usable nodes; body starts: ${snippet}`);
    last = result;
  }
  if (usableFallback) return usableFallback;
  if (last && last.error) throw new Error(last.error);
  return last || { nodes: [], groups: [], policyGroups: [], rules: [], format: 'unknown' };
}

module.exports = {
  fetchSubscription,
  parseSubscriptionContent,
  parseUserInfo,
  configFingerprint,
  nodeFingerprint,
  formatSubscriptionForEditing,
  uniqueNodeNames,
};
