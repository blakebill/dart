'use strict';

const clashParser = require('./parsers/clash');
const linkParser = require('./parsers/share-link');
const fetch = require('./fetch');

/** Parse the airport traffic info header `subscription-userinfo`. */
function parseUserInfo(headers) {
  const raw = headers['subscription-userinfo'];
  if (!raw) return null;
  const info = {};
  for (const part of String(raw).split(';')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k && v !== undefined) info[k] = Number(v);
  }
  return info;
}

/**
 * Auto-detect the content format and parse it into a unified array of node objects.
 * Prefer Clash YAML (with conversion), then fall back to share links / base64 subscription.
 */
function parseSubscriptionContent(content) {
  const text = String(content || '').trim();
  if (!text) return { nodes: [], groups: [], format: 'empty' };

  // Clash YAML first. The cheap "proxies:" check gates the YAML load, and the
  // parse result is reused for detection + conversion (one parse, not two).
  if (/proxies\s*:/.test(text)) {
    try {
      const r = clashParser.parseClashConfig(text);
      if (r.isClash) return { nodes: r.nodes, groups: r.groups, rules: r.rules, ruleProviders: r.ruleProviders, format: 'clash' };
    } catch (e) {
      /* not valid YAML; fall through to the link parser */
    }
  }

  // Share links / base64 subscription
  const nodes = linkParser.parseSubscriptionLinks(text);
  if (nodes.length > 0) {
    return { nodes, groups: [], rules: [], format: 'links' };
  }

  // Fallback: try parsing as Clash again (some configs without a proxies: comment)
  try {
    const { nodes: cn, groups, rules, ruleProviders } = clashParser.parseClashConfig(text);
    if (cn.length > 0) return { nodes: cn, groups, rules, ruleProviders, format: 'clash' };
  } catch (e) {
    /* ignore */
  }

  return { nodes: [], groups: [], rules: [], format: 'unknown' };
}

// Many airports gate their Clash/sing-box output behind a recognized client
// User-Agent. Try a few common ones until we actually get usable nodes.
const SUB_USER_AGENTS = [
  'clash-verge/v2.0.2',
  'ClashforWindows/0.20.39',
  'mihomo/1.18.10',
  'sing-box/1.13.0',
  'clash.meta',
  'Clash/2023.08.17',
];

/**
 * Fetch and parse a subscription. Retries with different client User-Agents so
 * airports that only serve a real config to "Clash" clients still work.
 * @param {string} url subscription URL
 * @param {function} log
 * @param {{proxyPort?:number}} opts when proxyPort is set, the request tunnels
 *   through the local mixed proxy first and falls back to a direct connection
 *   (for airports whose subscription endpoint is itself blocked).
 * @returns {{ nodes, groups, format, userInfo }}
 */
async function fetchSubscription(url, log = () => {}, opts = {}) {
  const proxyPort = opts.proxyPort || 0;
  let last = null;
  for (const ua of SUB_USER_AGENTS) {
    let res;
    try {
      // One HTTP path for both modes: with proxyPort the request tunnels
      // through the local proxy first and falls back to direct.
      const r = await fetch.getBufferWithFallback(url, {
        proxyPort,
        headers: { 'User-Agent': ua, Accept: '*/*' },
      });
      res = { body: r.body.toString('utf-8'), headers: r.headers || {} };
    } catch (e) {
      log(`[sub] UA="${ua}" request error: ${e.message}`);
      last = { nodes: [], groups: [], rules: [], format: 'error', error: e.message };
      continue;
    }
    const body = res.body || '';
    const result = parseSubscriptionContent(body);
    result.userInfo = parseUserInfo(res.headers);
    result.raw = body;
    const ct = res.headers['content-type'] || '';
    log(`[sub] UA="${ua}" len=${body.length} type="${ct}" format=${result.format} nodes=${result.nodes.length}`);
    if (result.nodes.length > 0) return result;
    // Help diagnose airports that return an empty/notice config: show a snippet.
    const snippet = body.replace(/\s+/g, ' ').slice(0, 200);
    log(`[sub] no usable nodes; body starts: ${snippet}`);
    last = result;
  }
  if (last && last.error) throw new Error(last.error);
  return last || { nodes: [], groups: [], rules: [], format: 'unknown' };
}

module.exports = {
  fetchSubscription,
  parseSubscriptionContent,
};
