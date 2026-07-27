'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSha256, sha256File } = require('../src/main/integrity');

const releaseDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'release'));
const RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function releaseVersionFromTag(tag) {
  const version = String(tag || '').trim().replace(/^v/, '');
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`invalid release tag ${tag}; expected vX.Y.Z or vX.Y.Z-prerelease`);
  }
  return version;
}

function addBundledComponents(sbom, manifest) {
  const files = new Map((manifest.files || []).map((file) => [file.path, file]));
  sbom.components = Array.isArray(sbom.components) ? sbom.components : [];
  for (const component of manifest.components || []) {
    const binary = files.get(component.binaryPath);
    const binaryDigest = normalizeSha256(binary && binary.sha256);
    const assetDigest = normalizeSha256(component.assetSha256);
    if (!binary || !binaryDigest) {
      throw new Error(`bundle manifest has no valid binary hash for ${component.name}`);
    }
    if (!assetDigest) {
      throw new Error(`bundle manifest has no valid release-asset hash for ${component.name}`);
    }
    const repository = new URL(component.repository);
    if (repository.protocol !== 'https:' || repository.hostname.toLowerCase() !== 'github.com') {
      throw new Error(`bundle manifest repository is not a GitHub HTTPS URL: ${component.repository}`);
    }
    const repoPath = repository.pathname.replace(/^\/|\/$/g, '');
    if (!/^[^/]+\/[^/]+$/.test(repoPath)) {
      throw new Error(`bundle manifest repository is not owner/name: ${component.repository}`);
    }
    sbom.components.push({
      type: component.type || 'application',
      'bom-ref': `pkg:github/${repoPath}@${component.version}#${encodeURIComponent(component.asset)}`,
      name: component.name,
      version: component.version,
      licenses: [{ license: { id: component.license } }],
      hashes: [{ alg: 'SHA-256', content: binaryDigest }],
      externalReferences: [{ type: 'vcs', url: component.repository }],
      properties: [
        { name: 'dart:releaseAsset', value: component.asset },
        { name: 'dart:releaseAssetSha256', value: assetDigest },
      ],
    });
  }
  return sbom;
}

function packagePurl(name, version) {
  const encodedName = String(name || '').split('/').map(encodeURIComponent).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function generateSbom(targetReleaseDir = releaseDir, root = path.join(__dirname, '..')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf-8'));
  const components = [];
  const seen = new Set();
  for (const [packagePath, pkg] of Object.entries(lock.packages || {})) {
    if (!packagePath || !pkg || !pkg.version) continue;
    const name = pkg.name || packagePath.replace(/^.*node_modules\//, '');
    const ref = packagePurl(name, pkg.version);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const component = {
      type: 'library',
      'bom-ref': ref,
      name,
      version: pkg.version,
      purl: ref,
    };
    if (typeof pkg.license === 'string') component.licenses = [{ license: { name: pkg.license } }];
    components.push(component);
  }
  const rootRef = packagePurl(manifest.name, manifest.version);
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${require('crypto').randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: manifest.name,
        version: manifest.version,
        purl: rootRef,
      },
    },
    components,
  };
  const manifestPath = path.join(root, 'bin', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    addBundledComponents(sbom, manifest);
  }
  fs.writeFileSync(path.join(targetReleaseDir, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n', 'utf-8');
}

function publishedReleaseAssetNames(targetReleaseDir) {
  return fs.readdirSync(targetReleaseDir)
    .filter((name) => {
      const file = path.join(targetReleaseDir, name);
      if (!fs.statSync(file).isFile()) return false;
      return (
        /\.exe$/i.test(name) ||
        /\.blockmap$/i.test(name) ||
        name === 'latest.yml' ||
        name === 'sbom.cdx.json'
      );
    })
    .sort();
}

function validatePublishedReleaseAssets(names) {
  const installers = names.filter((name) => /\.exe$/i.test(name));
  if (installers.length !== 1) {
    throw new Error(`expected exactly one Windows installer, found ${installers.length}`);
  }
  if (!names.includes(installers[0] + '.blockmap')) {
    throw new Error('release is missing installer blockmap: ' + installers[0] + '.blockmap');
  }
  for (const required of ['latest.yml', 'sbom.cdx.json']) {
    if (!names.includes(required)) throw new Error('release is missing ' + required);
  }
}

async function main(targetReleaseDir = releaseDir) {
  if (!fs.existsSync(targetReleaseDir)) {
    throw new Error('release directory does not exist: ' + targetReleaseDir);
  }
  generateSbom(targetReleaseDir);
  const names = publishedReleaseAssetNames(targetReleaseDir);
  validatePublishedReleaseAssets(names);
  const lines = [];
  for (const name of names) {
    lines.push(`${await sha256File(path.join(targetReleaseDir, name))}  ${name}`);
  }
  fs.writeFileSync(path.join(targetReleaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf-8');
  console.log(`Wrote SBOM and ${lines.length} SHA-256 entries to ${targetReleaseDir}`);
}

if (require.main === module) {
  if (process.argv[2] === '--version-from-tag') {
    try {
      console.log(releaseVersionFromTag(process.argv[3]));
    } catch (error) {
      console.error('Failed to parse release version:', error.message);
      process.exitCode = 1;
    }
  } else {
    main().catch((error) => {
      console.error('Failed to generate release metadata:', error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  addBundledComponents,
  generateSbom,
  main,
  publishedReleaseAssetNames,
  releaseVersionFromTag,
  validatePublishedReleaseAssets,
};
