'use strict';

const crypto = require('crypto');
const clashParser = require('./parsers/clash');
const linkParser = require('./parsers/share-link');
const { clashPolicyGroups } = require('./policy-groups');
const fetch = require('./fetch');
const { hasProxyProviders } = require('./proxy-providers');
const { parseSubscriptionContentAsync: parseContentAsync } = require('./subscription-parser-service');
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
  updateFingerprint(hash, source.clashProxyProviders || source.proxyProviders || {});
  return hash.digest('hex');
}

function hasUsableProxySource(value) {
  return !!(
    value &&
    ((Array.isArray(value.nodes) && value.nodes.length > 0) ||
      hasProxyProviders(value.clashProxyProviders || value.proxyProviders))
  );
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
 * Clash YAML and share-link subscriptions are accepted.
 */
function parseSubscriptionContent(content) {
  const text = String(content || '').trim();
  if (!text) return { nodes: [], groups: [], policyGroups: [], proxyProviders: {}, format: 'empty' };
  const decodedText = maybeBase64Decode(text);
  const candidates = decodedText ? [text, decodedText] : [text];

  // Clash YAML first. The cheap "proxies:" check gates the YAML load, and the
  // parse result is reused for detection + conversion (one parse, not two).
  for (const candidate of candidates) {
    if (/^\s*(?:proxies|proxy-providers)\s*:/m.test(candidate)) {
      try {
        const r = clashParser.parseClashConfig(candidate);
        if (r.isClash) {
          const nodes = uniqueNodeNames(r.nodes);
          const proxyProviders = r.proxyProviders || {};
          const policyGroups = clashPolicyGroups(r.groups, nodes, proxyProviders);
          return {
            nodes,
            groups: policyGroups,
            policyGroups,
            rules: r.rules,
            ruleProviders: r.ruleProviders,
            proxyProviders,
            format: 'clash',
          };
        }
      } catch (e) {
        /* not valid YAML; fall through to the link parser */
      }
    }
  }

  // Share links / base64 subscription
  const nodes = uniqueNodeNames(linkParser.parseSubscriptionLinks(text));
  if (nodes.length > 0) {
    return { nodes, groups: [], policyGroups: [], rules: [], proxyProviders: {}, format: 'links' };
  }

  // Fallback: try parsing as Clash again (some configs without a proxies: comment)
  for (const candidate of candidates) {
    try {
      const { nodes: cn, groups, rules, ruleProviders, proxyProviders = {} } = clashParser.parseClashConfig(candidate);
      if (cn.length > 0 || hasProxyProviders(proxyProviders)) {
        const normalizedNodes = uniqueNodeNames(cn);
        const policyGroups = clashPolicyGroups(groups, normalizedNodes, proxyProviders);
        return {
          nodes: normalizedNodes,
          groups: policyGroups,
          policyGroups,
          rules,
          ruleProviders,
          proxyProviders,
          format: 'clash',
        };
      }
    } catch (e) {
      /* ignore */
    }
  }

  return { nodes: [], groups: [], policyGroups: [], rules: [], proxyProviders: {}, format: 'unknown' };
}

/** Keep small inputs synchronous; parse large YAML/base64 profiles off the main thread. */
function parseSubscriptionContentAsync(content, options = {}) {
  return parseContentAsync(content, parseSubscriptionContent, options);
}

function formatSubscriptionForEditing(content) {
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
  return readable;
}

const MIHOMO_USER_AGENT = 'mihomo/1.18.10';
const SUBSCRIPTION_USER_AGENTS = [
  MIHOMO_USER_AGENT,
  'clash-verge/v2.0.2',
  'ClashforWindows/0.20.39',
  'clash.meta',
  'Clash/2023.08.17',
];

function subscriptionFormatRank(format, preferredFormat) {
  if (format === preferredFormat) return 3;
  if (format === 'clash') return 2;
  if (format === 'links') return 1;
  return 0;
}

/**
 * Fetch and parse a subscription. Requests Mihomo-compatible Clash output and
 * automatically retries compatible client identifiers when a provider rejects
 * or returns an unusable response for the preferred identifier.
 * @param {string} url subscription URL
 * @param {function} log
 * @param {{proxyPort?:number}} opts when proxyPort is set, the request tunnels
 *   through the local mixed proxy first and falls back to a direct connection
 *   (for providers whose subscription endpoint is itself blocked).
 * @returns {{ nodes, groups, format, userInfo }}
 */
async function fetchSubscription(url, log = () => {}, opts = {}) {
  const proxyPort = opts.proxyPort || 0;
  const expectedFormat = 'clash';
  let last = null;
  let usableFallback = null;
  let fallbackRank = 0;
  for (const ua of SUBSCRIPTION_USER_AGENTS) {
    let res;
    try {
      // One HTTP path for both modes: with proxyPort the request tunnels
      // through the local proxy first and falls back to direct.
      const r = await fetch.getBufferWithFallback(url, {
        proxyPort,
        log,
        signal: opts.signal,
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
    const result = await parseSubscriptionContentAsync(body, { signal: opts.signal });
    result.userInfo = parseUserInfo(res.headers);
    result.raw = body;
    const ct = res.headers['content-type'] || '';
    const providerCount = Object.keys(result.proxyProviders || {}).length;
    log(`[sub] UA="${ua}" len=${body.length} type="${ct}" format=${result.format} nodes=${result.nodes.length} providers=${providerCount}`);
    if (hasUsableProxySource(result)) {
      if (!expectedFormat || result.format === expectedFormat) return result;
      const rank = subscriptionFormatRank(result.format, expectedFormat);
      if (rank > fallbackRank) {
        usableFallback = result;
        fallbackRank = rank;
      }
      log(`[sub] preferred ${expectedFormat}, continuing after compatible ${result.format} response`);
      continue;
    }
    // Help diagnose airports that return an empty/notice config: show a snippet.
    const snippet = body.replace(/\s+/g, ' ').slice(0, 200);
    log(`[sub] no usable proxies or proxy providers; body starts: ${snippet}`);
    last = result;
  }
  if (usableFallback) return usableFallback;
  if (last && last.error) throw new Error(last.error);
  return last || { nodes: [], groups: [], policyGroups: [], rules: [], proxyProviders: {}, format: 'unknown' };
}

module.exports = {
  fetchSubscription,
  parseSubscriptionContent,
  parseSubscriptionContentAsync,
  parseUserInfo,
  configFingerprint,
  hasUsableProxySource,
  nodeFingerprint,
  formatSubscriptionForEditing,
  uniqueNodeNames,
};
