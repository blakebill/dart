'use strict';

const fetch = require('./fetch');

/**
 * GitHub release/tag lookups with a jsDelivr fallback.
 *
 * App and core version checks need api.github.com, which is often unreachable from
 * mainland China unless the proxy is up AND the node can reach GitHub.
 * jsDelivr's data API serves the same tag list over a CDN that is reachable
 * directly, so it backs the canonical API: GitHub first (proxy-first, then
 * direct), then jsDelivr (same order).
 *
 * Release BINARIES have no jsDelivr mirror — only tag metadata does — so
 * asset downloads stay on github.com; callers synthesize the asset URL from
 * the tag when the lookup came from the fallback path.
 */

/** Compare two dotted version/tag strings numerically; >0 when a>b. */
function compareTags(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * The newest stable tag from a list, or null. Prerelease tags (-alpha/-beta/
 * -rc/-pre) are skipped: jsDelivr lists every git tag, while the GitHub
 * "latest release" this stands in for never points at a prerelease.
 */
function pickLatestTag(tags) {
  const stable = (tags || []).filter((t) => t && !/[-+]/.test(String(t)));
  if (!stable.length) return null;
  return stable.reduce((best, t) => (compareTags(t, best) > 0 ? t : best));
}

/** HTTPS GET → parsed JSON, proxy-first with direct fallback. */
async function getJson(url, proxyPort, log, headers = {}, options = {}) {
  const { body } = await fetch.getBufferWithFallback(url, {
    proxyPort,
    log,
    headers,
    signal: options.signal,
    maxBytes: 8 * 1024 * 1024,
  });
  return JSON.parse(body.toString('utf-8'));
}

/**
 * Resolve the latest release tag of a repo ("owner/name").
 * @returns {{ tag: string, release: object|null, source: 'github'|'jsdelivr' }}
 *   `release` is the full GitHub release object only when the API answered
 *   (the jsDelivr path knows tags, not assets).
 */
async function latestReleaseTag(repo, proxyPort = 0, log = () => {}, options = {}) {
  try {
    const rel = await getJson(
      `https://api.github.com/repos/${repo}/releases/latest`,
      proxyPort,
      log,
      { Accept: 'application/vnd.github+json' },
      options
    );
    if (rel.tag_name) return { tag: rel.tag_name, release: rel, source: 'github' };
    throw new Error(rel.message || 'no tag_name in the API response');
  } catch (e) {
    if (options.signal && options.signal.aborted) throw e;
    log(`[gui] GitHub API lookup failed for ${repo} (${e.message}); trying jsDelivr`);
  }
  const data = await getJson(`https://data.jsdelivr.com/v1/packages/gh/${repo}`, proxyPort, log, {}, options);
  const tag = pickLatestTag((data.versions || []).map((v) => v.version));
  if (!tag) throw new Error(`no release tags for ${repo} via jsDelivr`);
  return { tag, release: null, source: 'jsdelivr' };
}

module.exports = { compareTags, pickLatestTag, latestReleaseTag };
