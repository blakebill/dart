'use strict';

/**
 * Download bundled proxy cores + their GeoData into ./bin before packaging.
 *
 * Output layout copied by electron-builder to resources/bin:
 *   bin/mihomo/mihomo.exe
 *   bin/mihomo/geoip.dat
 *   bin/mihomo/geosite.dat
 *   bin/mihomo/country.mmdb
 *
 * Usage:
 *   node scripts/download-core.js
 *   MIHOMO_VERSION=1.19.13 node scripts/download-core.js
 *   MIHOMO_OS=windows MIHOMO_ARCH=amd64 node scripts/download-core.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { URL } = require('url');
const { assetSha256, sha256File, verifyFileSha256 } = require('../src/main/integrity');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const MIHOMO_DIR = path.join(BIN_DIR, 'mihomo');
const DART_MIHOMO_REPO = 'blakebill/mihomo';
const DART_RELEASE_PATTERN = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-dart\.([1-9]\d*)$/;
const BASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function requestHeaders(extra = {}) {
  const headers = { 'User-Agent': 'dart-build', ...extra };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

function getJson(urlStr, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https
      .get(urlStr, { headers: requestHeaders(), timeout: 20000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(getJson(new URL(res.headers.location, urlStr).toString(), redirects - 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('GitHub API HTTP ' + res.statusCode + ': ' + text.slice(0, 200)));
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
  });
}

function download(urlStr, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let file = null;
    const fail = (err) => {
      if (file) {
        file.destroy();
        try { fs.unlinkSync(dest); } catch (_) {}
      }
      reject(err);
    };
    const req = https
      .get(urlStr, { headers: { 'User-Agent': 'dart-build' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(download(new URL(res.headers.location, urlStr).toString(), dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('download failed HTTP ' + res.statusCode));
        }
        file = fs.createWriteStream(dest);
        file.on('error', fail);
        res.on('error', fail);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', fail);
    req.on('timeout', () => req.destroy(new Error('download timeout')));
  });
}

async function downloadFirst(urls, dest, validate) {
  let lastErr = null;
  for (const url of urls) {
    console.log('Downloading', url);
    try {
      await download(url, dest);
      if (!validate || await validate(dest)) return url;
      throw new Error('downloaded file failed validation');
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dest); } catch (_) {}
      console.warn('  failed:', e.message);
    }
  }
  throw lastErr || new Error('all download sources failed');
}

function detectOs() {
  if (process.env.MIHOMO_OS) return process.env.MIHOMO_OS;
  if (process.env.CORE_OS) return process.env.CORE_OS;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function detectArch() {
  if (process.env.MIHOMO_ARCH) return process.env.MIHOMO_ARCH;
  if (process.env.CORE_ARCH) return process.env.CORE_ARCH;
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

function parseDartReleaseTag(value) {
  const match = String(value || '').trim().match(DART_RELEASE_PATTERN);
  if (!match) return null;
  return {
    tag: `v${match[1]}-dart.${match[2]}`,
    version: `${match[1]}-dart.${match[2]}`,
    base: match[1],
    baseParts: match[1].split('.').map(Number),
    revision: Number(match[2]),
  };
}

function compareDartReleaseVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.baseParts[i] !== b.baseParts[i]) return a.baseParts[i] - b.baseParts[i];
  }
  return a.revision - b.revision;
}

function selectStableDartRelease(releases, requestedVersion = '') {
  const requested = String(requestedVersion || '').trim().replace(/^v/, '');
  const requestedFull = parseDartReleaseTag(requested);
  if (requested && !requestedFull && !BASE_VERSION_PATTERN.test(requested)) {
    throw new Error(
      `invalid Dart core version ${requested}; expected X.Y.Z or X.Y.Z-dart.N`
    );
  }
  const requestedBase = requestedFull ? requestedFull.base : requested;
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter((candidate) => candidate && candidate.draft !== true && candidate.prerelease !== true)
    .map((releaseInfo) => ({ releaseInfo, parsed: parseDartReleaseTag(releaseInfo.tag_name) }))
    .filter(({ parsed }) =>
      parsed &&
      (!requestedBase || parsed.base === requestedBase) &&
      (!requestedFull || parsed.version === requestedFull.version)
    )
    .sort((a, b) => compareDartReleaseVersions(a.parsed, b.parsed));
  if (!candidates.length) {
    const suffix = requested ? ` matching ${requested}` : '';
    throw new Error(`no stable Dart release found${suffix}`);
  }
  return candidates[candidates.length - 1].releaseInfo;
}

async function release(repo, versionEnv) {
  const requested = String(process.env[versionEnv] || '').trim().replace(/^v/, '');
  const requestedFull = parseDartReleaseTag(requested);
  if (requested && !requestedFull && !BASE_VERSION_PATTERN.test(requested)) {
    throw new Error(
      `invalid ${versionEnv} value ${requested}; expected X.Y.Z or X.Y.Z-dart.N`
    );
  }
  if (requestedFull) {
    console.log(`Resolving exact ${repo} release ${requestedFull.tag}...`);
    const exact = await getJson(
      `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(requestedFull.tag)}`
    );
    return selectStableDartRelease([exact], requestedFull.version);
  }

  const label = requested || 'latest';
  console.log(`Resolving stable ${repo} release (${label})...`);
  const releases = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=100`);
  const selected = selectStableDartRelease(releases, requested);
  console.log(`Resolved ${repo} to ${selected.tag_name}`);
  return selected;
}

function cleanDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'README.md') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function extractZip(archivePath, destDir) {
  const r = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Expand-Archive failed');
}

function extractTarGz(archivePath, destDir) {
  const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar extraction failed');
}

function findFile(dir, predicate, depth = 3) {
  if (depth < 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && predicate(e.name, p)) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const p = findFile(path.join(dir, e.name), predicate, depth - 1);
      if (p) return p;
    }
  }
  return null;
}

function validGeo(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const st = fs.statSync(file);
    if (st.size < 1024) return false;
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(st.size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    const tailSize = Math.min(st.size, 65536);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, st.size - tailSize);
    fs.closeSync(fd);
    const text = head.slice(0, Math.min(head.length, 256)).toString('utf-8').trimStart().toLowerCase();
    if (
      head.slice(0, 3).toString('latin1') === 'SRS' ||
      (head[0] === 0x1f && head[1] === 0x8b) ||
      (head[0] === 0x50 && head[1] === 0x4b) ||
      text.startsWith('<!doctype') ||
      text.startsWith('<html') ||
      text.startsWith('{') ||
      text.startsWith('[') ||
      text.startsWith('not found') ||
      text.startsWith('invalid')
    ) {
      return false;
    }
    const first = head[0];
    if (head.every((b) => b === first)) return false;
    if (path.basename(file).toLowerCase() === 'country.mmdb') {
      return tail.includes(Buffer.from('MaxMind.com'));
    }
    return true;
  } catch (_) {
    return false;
  }
}

function mihomoGeoDataUrls(file) {
  return [
    `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/${file}`,
    `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/${file}`,
    `https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/${file}`,
    `https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/${file}`,
  ];
}

function mihomoGeoTestConfig() {
  return [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: silent',
    'geodata-mode: true',
    'geodata-loader: memconservative',
    'geo-auto-update: false',
    'rules:',
    '  - GEOSITE,cn,DIRECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
}

function validateMihomoGeoData(dir, binName) {
  const configPath = path.join(dir, 'mihomo-geodata-check.yaml');
  fs.writeFileSync(configPath, mihomoGeoTestConfig(), 'utf-8');
  const bin = path.join(dir, binName);
  try {
    const r = spawnSync(bin, ['-t', '-f', configPath, '-d', dir], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });
    if (r.status !== 0) {
      const out = String(r.stderr || r.stdout || r.error || '').trim();
      throw new Error('mihomo rejected bundled GeoData: ' + out.slice(-1000));
    }
  } finally {
    try { fs.unlinkSync(configPath); } catch (_) {}
  }
}

function mihomoAsset(rel, goos, arch) {
  const ext = goos === 'windows' ? 'zip' : 'gz';
  const tag = String(rel.tag_name || '').replace(/^v/, '');
  const name = `mihomo-${goos}-${arch}-v${tag}.${ext}`;
  const releaseAsset = (rel.assets || []).find((candidate) =>
    candidate &&
    candidate.name === name &&
    candidate.browser_download_url
  );
  if (!releaseAsset) throw new Error('mihomo release does not contain canonical asset ' + name);
  return {
    name,
    url: releaseAsset.browser_download_url,
    sha256: assetSha256(releaseAsset),
  };
}

async function bundleMihomo(goos, arch, outputDir = MIHOMO_DIR) {
  cleanDir(outputDir);
  const binName = goos === 'windows' ? 'mihomo.exe' : 'mihomo';
  const rel = await release(DART_MIHOMO_REPO, 'MIHOMO_VERSION');
  if (!rel.tag_name) throw new Error('could not resolve mihomo release tag');
  const asset = mihomoAsset(rel, goos, arch);
  const archivePath = path.join(outputDir, asset.name);
  if (!asset.sha256) throw new Error('mihomo release asset has no SHA-256 digest: ' + asset.name);

  console.log('Downloading mihomo core:', asset.url);
  await download(asset.url, archivePath);
  await verifyFileSha256(archivePath, asset.sha256, asset.name);
  console.log('Verified mihomo SHA-256:', asset.sha256);
  console.log('Extracting mihomo...');
  if (/\.gz$/i.test(asset.name) && !/\.tar\.gz$/i.test(asset.name)) {
    const data = zlib.gunzipSync(fs.readFileSync(archivePath));
    fs.writeFileSync(path.join(outputDir, binName), data);
    if (goos !== 'windows') fs.chmodSync(path.join(outputDir, binName), 0o755);
  } else if (goos === 'windows') {
    extractZip(archivePath, outputDir);
    const found = findFile(outputDir, (name) =>
      name.toLowerCase() === binName.toLowerCase() || (/^mihomo/i.test(name) && /\.exe$/i.test(name))
    );
    if (!found) throw new Error('mihomo binary not found after extraction');
    if (path.resolve(found) !== path.resolve(path.join(outputDir, binName))) {
      fs.copyFileSync(found, path.join(outputDir, binName));
    }
  } else {
    extractTarGz(archivePath, outputDir);
    const found = findFile(outputDir, (name) => name === binName || (/^mihomo/i.test(name) && !/\.(gz|zip|txt|md)$/i.test(name)));
    if (!found) throw new Error('mihomo binary not found after extraction');
    if (path.resolve(found) !== path.resolve(path.join(outputDir, binName))) {
      fs.copyFileSync(found, path.join(outputDir, binName));
    }
    fs.chmodSync(path.join(outputDir, binName), 0o755);
  }
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(outputDir, entry.name), { recursive: true, force: true });
  }
  fs.unlinkSync(archivePath);

  const geoRelease = await getJson('https://api.github.com/repos/MetaCubeX/meta-rules-dat/releases/latest');
  if (!geoRelease.tag_name) throw new Error('could not resolve meta-rules-dat release tag');
  const meta = {};
  const dataComponents = [];
  for (const file of ['geoip.dat', 'geosite.dat', 'country.mmdb']) {
    const geoAsset = (geoRelease.assets || []).find((candidate) => candidate.name === file);
    const geoDigest = assetSha256(geoAsset);
    if (!geoAsset || !geoAsset.browser_download_url || !geoDigest) {
      throw new Error('meta-rules-dat release has no verifiable asset: ' + file);
    }
    await downloadFirst(
      [geoAsset.browser_download_url, ...mihomoGeoDataUrls(file).slice(1)],
      path.join(outputDir, file),
      async (downloaded) => {
        if (!validGeo(downloaded)) return false;
        await verifyFileSha256(downloaded, geoDigest, file);
        return true;
      }
    );
    meta[file] = { updatedAt: Date.now() };
    dataComponents.push({
      type: 'data',
      name: `meta-rules-dat-${path.parse(file).name}`,
      version: String(geoRelease.tag_name).replace(/^v/, ''),
      repository: 'https://github.com/MetaCubeX/meta-rules-dat',
      license: 'GPL-3.0-only',
      asset: file,
      assetSha256: geoDigest,
      binaryPath: `mihomo/${file}`,
    });
  }
  validateMihomoGeoData(outputDir, binName);
  fs.writeFileSync(path.join(outputDir, 'geodata-meta.json'), JSON.stringify(meta), 'utf-8');
  console.log('mihomo bundle ready in', outputDir);
  return [{
    type: 'application',
    name: 'mihomo',
    version: String(rel.tag_name).replace(/^v/, ''),
    repository: `https://github.com/${DART_MIHOMO_REPO}`,
    license: 'GPL-3.0-only',
    asset: asset.name,
    assetSha256: asset.sha256,
    binaryPath: `mihomo/${binName}`,
  }, ...dataComponents];
}

async function createBundleManifest(bundleRoot, bundledComponents) {
  const components = [...bundledComponents];
  const files = [];
  for (const folder of ['mihomo']) {
    const dir = path.join(bundleRoot, folder);
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      files.push({ path: `${folder}/${name}`, size: stat.size, sha256: await sha256File(file) });
    }
  }
  fs.writeFileSync(
    path.join(bundleRoot, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, components, files }, null, 2) + '\n',
    'utf-8'
  );
}

function installStagedBundle(stageRoot, binDir) {
  const names = ['mihomo', 'manifest.json'];
  const backupDir = path.join(stageRoot, '.previous');
  const installed = [];
  const backedUp = [];
  fs.mkdirSync(backupDir, { recursive: true });
  try {
    for (const name of names) {
      const target = path.join(binDir, name);
      if (!fs.existsSync(target)) continue;
      fs.renameSync(target, path.join(backupDir, name));
      backedUp.push(name);
    }
    for (const name of names) {
      const staged = path.join(stageRoot, name);
      if (!fs.existsSync(staged)) throw new Error('staged bundle is missing ' + name);
      fs.renameSync(staged, path.join(binDir, name));
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse()) {
      fs.rmSync(path.join(binDir, name), { recursive: true, force: true });
    }
    for (const name of backedUp.reverse()) {
      const backup = path.join(backupDir, name);
      if (fs.existsSync(backup)) fs.renameSync(backup, path.join(binDir, name));
    }
    throw error;
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
}

async function buildCoreBundle(options = {}) {
  const binDir = options.binDir || BIN_DIR;
  const goos = options.goos || detectOs();
  const arch = options.arch || detectArch();
  const mihomoBundler = options.bundleMihomo || bundleMihomo;
  fs.mkdirSync(binDir, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(binDir, '.core-bundle-'));
  try {
    const components = await mihomoBundler(goos, arch, path.join(stageRoot, 'mihomo'));
    await createBundleManifest(stageRoot, components);
    installStagedBundle(stageRoot, binDir);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
  console.log('Bundled Mihomo and GeoData in', binDir);
}

async function main() {
  await buildCoreBundle();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to download bundled Mihomo:', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCoreBundle,
  compareDartReleaseVersions,
  createBundleManifest,
  installStagedBundle,
  mihomoAsset,
  parseDartReleaseTag,
  selectStableDartRelease,
};
