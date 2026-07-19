'use strict';

const fs = require('fs');
const path = require('path');
const { sha256File } = require('../src/main/integrity');

const releaseDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'release'));

function addBundledComponents(sbom, manifest) {
  const files = new Map((manifest.files || []).map((file) => [file.path, file]));
  sbom.components = Array.isArray(sbom.components) ? sbom.components : [];
  for (const component of manifest.components || []) {
    const binary = files.get(component.binaryPath);
    const repoPath = new URL(component.repository).pathname.slice(1);
    sbom.components.push({
      type: component.type || 'application',
      'bom-ref': `pkg:github/${repoPath}@${component.version}#${encodeURIComponent(component.asset)}`,
      name: component.name,
      version: component.version,
      licenses: [{ license: { id: component.license } }],
      hashes: binary ? [{ alg: 'SHA-256', content: binary.sha256 }] : undefined,
      externalReferences: [{ type: 'vcs', url: component.repository }],
      properties: [
        { name: 'dart:releaseAsset', value: component.asset },
        { name: 'dart:releaseAssetSha256', value: component.assetSha256 },
      ],
    });
  }
  return sbom;
}

function packagePurl(name, version) {
  const encodedName = String(name || '').split('/').map(encodeURIComponent).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function generateSbom() {
  const root = path.join(__dirname, '..');
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
  const manifestPath = path.join(__dirname, '..', 'bin', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    addBundledComponents(sbom, manifest);
  }
  fs.writeFileSync(path.join(releaseDir, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n', 'utf-8');
}

async function main() {
  if (!fs.existsSync(releaseDir)) throw new Error('release directory does not exist: ' + releaseDir);
  generateSbom();
  const names = fs.readdirSync(releaseDir)
    .filter((name) => name !== 'SHA256SUMS.txt' && fs.statSync(path.join(releaseDir, name)).isFile())
    .sort();
  const lines = [];
  for (const name of names) {
    lines.push(`${await sha256File(path.join(releaseDir, name))}  ${name}`);
  }
  fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf-8');
  console.log(`Wrote SBOM and ${lines.length} SHA-256 entries to ${releaseDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to generate release metadata:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { addBundledComponents, generateSbom };
