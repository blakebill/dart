'use strict';

const fs = require('fs');
const fetch = require('./fetch');
const github = require('./github');
const { assetSha256, parseSha256Sums, verifyFileSha256 } = require('./integrity');

/** App release update check against the project's GitHub releases. */

const UPDATE_REPO = 'blakebill/dart';

/** The Windows installer asset name the release workflow publishes for a version. */
function installerName(version) {
  return `Dart.Setup.${version}.exe`;
}

/** Reject truncated/error-page downloads before asking Windows to execute them. */
function validateInstaller(filePath, expectedSize = 0) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('downloaded installer is not a file');
  if (expectedSize > 0 && stat.size !== expectedSize) {
    throw new Error(`installer size mismatch (${stat.size}/${expectedSize} bytes)`);
  }
  if (stat.size < 1024 * 1024) throw new Error('downloaded installer is unexpectedly small');

  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.toString('latin1', 0, 2) !== 'MZ') {
      throw new Error('downloaded installer is not a Windows executable');
    }
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > stat.size - 4) throw new Error('downloaded installer has an invalid PE header');
    const signature = Buffer.alloc(4);
    fs.readSync(fd, signature, 0, signature.length, peOffset);
    if (!signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
      throw new Error('downloaded installer has an invalid PE signature');
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Check the latest release against the given current version. Never throws.
 *
 * GitHub's API is tried first (it knows the real asset list); when it is
 * unreachable the tag comes from jsDelivr and the installer URL is derived
 * from the release workflow's fixed naming scheme. The installer itself is
 * always downloaded from github.com — release binaries have no CDN mirror.
 */
async function checkUpdate(current, proxyPort = 0, log = () => {}, options = {}) {
  const fallbackUrl = `https://github.com/${UPDATE_REPO}/releases/latest`;
  try {
    const { tag, release, source } = await github.latestReleaseTag(UPDATE_REPO, proxyPort, log, options);
    const latest = tag.replace(/^v/, '');
    const expectedName = installerName(latest);
    const releaseAssets = release ? release.assets || [] : [];
    const assets = releaseAssets.filter((a) => /\.exe$/i.test(a.name || ''));
    const asset = assets.find((a) => String(a.name).toLowerCase() === expectedName.toLowerCase()) || null;
    const checksumAsset = releaseAssets.find((a) => /^SHA256SUMS(?:\.txt)?$/i.test(a.name || '')) || null;
    // Authoritative GitHub metadata can prove the expected installer is absent.
    // Only synthesize its conventional URL when the jsDelivr fallback supplied
    // a tag without an asset list; otherwise the UI should fall back to the
    // release page instead of attempting a guaranteed 404.
    const assetName = asset ? asset.name : release ? null : installerName(latest);
    const encodedTag = encodeURIComponent(tag);
    return {
      current,
      latest,
      hasUpdate: github.compareTags(latest, current) > 0,
      url: release && release.html_url ? release.html_url : `https://github.com/${UPDATE_REPO}/releases/tag/${encodedTag}`,
      assetUrl: asset
        ? asset.browser_download_url
        : assetName ? `https://github.com/${UPDATE_REPO}/releases/download/${encodedTag}/${assetName}` : null,
      assetName,
      assetSize: asset ? asset.size : 0,
      assetSha256: assetSha256(asset),
      checksumUrl: checksumAsset
        ? checksumAsset.browser_download_url
        : `https://github.com/${UPDATE_REPO}/releases/download/${encodedTag}/SHA256SUMS.txt`,
      source, // 'github' | 'jsdelivr', for the logs
    };
  } catch (e) {
    if (options.signal && options.signal.aborted) throw e;
    return { current, latest: null, hasUpdate: false, error: e.message, url: fallbackUrl };
  }
}

/** Verify an installer using its GitHub asset digest or the release checksum manifest. */
async function verifyInstallerIntegrity(filePath, info, proxyPort = 0, log = () => {}, options = {}) {
  let expected = info && info.assetSha256;
  if (!expected && info && info.checksumUrl) {
    const { body } = await fetch.getBufferWithFallback(info.checksumUrl, {
      proxyPort,
      log,
      signal: options.signal,
      maxBytes: 1024 * 1024,
    });
    expected = parseSha256Sums(body.toString('utf-8')).get(info.assetName);
  }
  if (!expected) {
    throw new Error('release does not provide a SHA-256 digest for the installer');
  }
  const actual = await verifyFileSha256(filePath, expected, info.assetName || 'installer');
  log('[gui] installer SHA-256 verified: ' + actual);
  return actual;
}

module.exports = { checkUpdate, installerName, validateInstaller, verifyInstallerIntegrity };
