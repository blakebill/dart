'use strict';

const github = require('./github');

/** App release update check against the project's GitHub releases. */

const UPDATE_REPO = 'blakebill/dart';

/** The Windows installer asset name the release workflow publishes for a version. */
function installerName(version) {
  return `Dart.Setup.${version}.exe`;
}

/**
 * Check the latest release against the given current version. Never throws.
 *
 * GitHub's API is tried first (it knows the real asset list); when it is
 * unreachable the tag comes from jsDelivr and the installer URL is derived
 * from the release workflow's fixed naming scheme. The installer itself is
 * always downloaded from github.com — release binaries have no CDN mirror.
 */
async function checkUpdate(current, proxyPort = 0, log = () => {}) {
  const fallbackUrl = `https://github.com/${UPDATE_REPO}/releases/latest`;
  try {
    const { tag, release, source } = await github.latestReleaseTag(UPDATE_REPO, proxyPort, log);
    const latest = tag.replace(/^v/, '');
    const asset = release ? (release.assets || []).find((a) => /\.exe$/i.test(a.name || '')) : null;
    const assetName = asset ? asset.name : installerName(latest);
    return {
      current,
      latest,
      hasUpdate: github.compareTags(latest, current) > 0,
      url: release && release.html_url ? release.html_url : `https://github.com/${UPDATE_REPO}/releases/tag/v${latest}`,
      assetUrl: asset ? asset.browser_download_url : `https://github.com/${UPDATE_REPO}/releases/download/v${latest}/${assetName}`,
      assetName,
      assetSize: asset ? asset.size : 0,
      source, // 'github' | 'jsdelivr', for the logs
    };
  } catch (e) {
    return { current, latest: null, hasUpdate: false, error: e.message, url: fallbackUrl };
  }
}

module.exports = { checkUpdate };
