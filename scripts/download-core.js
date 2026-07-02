'use strict';

/**
 * Download bundled proxy cores + their GeoData into ./bin before packaging.
 *
 * Output layout copied by electron-builder to resources/bin:
 *   bin/singbox/sing-box.exe
 *   bin/singbox/geoip-cn.srs
 *   bin/singbox/geosite-cn.srs
 *   bin/mihomo/mihomo.exe
 *   bin/mihomo/geoip.dat
 *   bin/mihomo/geosite.dat
 *   bin/mihomo/country.mmdb
 *
 * Usage:
 *   node scripts/download-core.js
 *   SINGBOX_VERSION=1.11.4 MIHOMO_VERSION=1.19.13 node scripts/download-core.js
 *   SINGBOX_OS=windows SINGBOX_ARCH=amd64 node scripts/download-core.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const SINGBOX_DIR = path.join(BIN_DIR, 'singbox');
const MIHOMO_DIR = path.join(BIN_DIR, 'mihomo');

function requestHeaders(extra = {}) {
  const headers = { 'User-Agent': 'dart-build', ...extra };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

function getJson(urlStr) {
  return new Promise((resolve, reject) => {
    https
      .get(urlStr, { headers: requestHeaders() }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(getJson(new URL(res.headers.location, urlStr).toString()));
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
  });
}

function download(urlStr, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(urlStr, { headers: { 'User-Agent': 'dart-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          file.close();
          fs.unlink(dest, () => {});
          return resolve(download(new URL(res.headers.location, urlStr).toString(), dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error('download failed HTTP ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function downloadFirst(urls, dest, validate) {
  let lastErr = null;
  for (const url of urls) {
    console.log('Downloading', url);
    try {
      await download(url, dest);
      if (!validate || validate(dest)) return url;
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
  if (process.env.SINGBOX_OS) return process.env.SINGBOX_OS;
  if (process.env.CORE_OS) return process.env.CORE_OS;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function detectArch() {
  if (process.env.SINGBOX_ARCH) return process.env.SINGBOX_ARCH;
  if (process.env.CORE_ARCH) return process.env.CORE_ARCH;
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

async function release(repo, versionEnv) {
  const version = (process.env[versionEnv] || '').trim();
  if (!version) {
    console.log(`Resolving latest ${repo} release...`);
    return getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  }
  const tag = version.startsWith('v') ? version : 'v' + version;
  console.log(`Resolving ${repo} release ${tag}...`);
  return getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
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

function validSrs(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 8) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(3);
    fs.readSync(fd, buf, 0, 3, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === 'SRS';
  } catch (_) {
    return false;
  }
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

function geoDataUrls(repo, file) {
  return [
    `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${file}`,
    `https://cdn.jsdelivr.net/gh/SagerNet/${repo}@rule-set/${file}`,
    `https://fastly.jsdelivr.net/gh/SagerNet/${repo}@rule-set/${file}`,
    `https://gcore.jsdelivr.net/gh/SagerNet/${repo}@rule-set/${file}`,
  ];
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
    'geodata-loader: standard',
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

async function latestReleaseTag(repo) {
  try {
    const r = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
    return r.tag_name || null;
  } catch (_) {
    return null;
  }
}

async function bundleSingBox(goos, arch) {
  cleanDir(SINGBOX_DIR);
  const binName = goos === 'windows' ? 'sing-box.exe' : 'sing-box';
  const rel = await release('SagerNet/sing-box', 'SINGBOX_VERSION');
  const tag = rel.tag_name;
  if (!tag) throw new Error('could not resolve sing-box release tag');
  const ver = String(tag).replace(/^v/, '');
  const ext = goos === 'windows' ? 'zip' : 'tar.gz';
  const fileName = `sing-box-${ver}-${goos}-${arch}.${ext}`;
  const archivePath = path.join(SINGBOX_DIR, fileName);
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${ver}/${fileName}`;

  console.log('Downloading sing-box core:', url);
  await download(url, archivePath);
  console.log('Extracting sing-box...');
  if (goos === 'windows') extractZip(archivePath, SINGBOX_DIR);
  else extractTarGz(archivePath, SINGBOX_DIR);

  const innerDir = findFile(SINGBOX_DIR, (name) => name === binName);
  if (!innerDir) throw new Error('sing-box binary not found after extraction');
  const root = path.dirname(innerDir);
  for (const f of fs.readdirSync(root)) {
    if (f === binName || /\.(dll|so|dylib)$/i.test(f)) {
      const target = path.join(SINGBOX_DIR, f);
      fs.copyFileSync(path.join(root, f), target);
      if (goos !== 'windows' && f === binName) fs.chmodSync(target, 0o755);
    }
  }
  for (const entry of fs.readdirSync(SINGBOX_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(SINGBOX_DIR, entry.name), { recursive: true, force: true });
  }
  fs.unlinkSync(archivePath);

  const ruleSets = [
    { file: 'geoip-cn.srs', repo: 'sing-geoip' },
    { file: 'geosite-cn.srs', repo: 'sing-geosite' },
  ];
  const meta = {};
  for (const rs of ruleSets) {
    const dest = path.join(SINGBOX_DIR, rs.file);
    await downloadFirst(geoDataUrls(rs.repo, rs.file), dest, validSrs);
    meta[rs.file] = { version: await latestReleaseTag(`SagerNet/${rs.repo}`), updatedAt: Date.now() };
  }
  fs.writeFileSync(path.join(SINGBOX_DIR, 'geodata-meta.json'), JSON.stringify(meta), 'utf-8');
  console.log('sing-box bundle ready in', SINGBOX_DIR);
}

function mihomoAsset(rel, goos, arch) {
  const ext = goos === 'windows' ? 'zip' : 'gz';
  const assets = rel.assets || [];
  const candidates = assets
    .map((a) => ({ name: a.name || '', url: a.browser_download_url || '' }))
    .filter((a) =>
      /mihomo/i.test(a.name) &&
      a.name.toLowerCase().includes(goos) &&
      a.name.toLowerCase().includes(arch) &&
      new RegExp(`\\.${ext}$`, 'i').test(a.name) &&
      a.url
    )
    .sort((a, b) => Number(/compatible|go\d+/i.test(a.name)) - Number(/compatible|go\d+/i.test(b.name)));
  if (candidates[0]) return candidates[0];
  const tag = String(rel.tag_name || '').replace(/^v/, '');
  const name = `mihomo-${goos}-${arch}-v${tag}.${ext}`;
  return { name, url: `https://github.com/MetaCubeX/mihomo/releases/download/v${tag}/${name}` };
}

async function bundleMihomo(goos, arch) {
  cleanDir(MIHOMO_DIR);
  const binName = goos === 'windows' ? 'mihomo.exe' : 'mihomo';
  const rel = await release('MetaCubeX/mihomo', 'MIHOMO_VERSION');
  if (!rel.tag_name) throw new Error('could not resolve mihomo release tag');
  const asset = mihomoAsset(rel, goos, arch);
  const archivePath = path.join(MIHOMO_DIR, asset.name);

  console.log('Downloading mihomo core:', asset.url);
  await download(asset.url, archivePath);
  console.log('Extracting mihomo...');
  if (/\.gz$/i.test(asset.name) && !/\.tar\.gz$/i.test(asset.name)) {
    const data = zlib.gunzipSync(fs.readFileSync(archivePath));
    fs.writeFileSync(path.join(MIHOMO_DIR, binName), data);
    if (goos !== 'windows') fs.chmodSync(path.join(MIHOMO_DIR, binName), 0o755);
  } else if (goos === 'windows') {
    extractZip(archivePath, MIHOMO_DIR);
    const found = findFile(MIHOMO_DIR, (name) =>
      name.toLowerCase() === binName.toLowerCase() || (/^mihomo/i.test(name) && /\.exe$/i.test(name))
    );
    if (!found) throw new Error('mihomo binary not found after extraction');
    if (path.resolve(found) !== path.resolve(path.join(MIHOMO_DIR, binName))) {
      fs.copyFileSync(found, path.join(MIHOMO_DIR, binName));
    }
  } else {
    extractTarGz(archivePath, MIHOMO_DIR);
    const found = findFile(MIHOMO_DIR, (name) => name === binName || (/^mihomo/i.test(name) && !/\.(gz|zip|txt|md)$/i.test(name)));
    if (!found) throw new Error('mihomo binary not found after extraction');
    if (path.resolve(found) !== path.resolve(path.join(MIHOMO_DIR, binName))) {
      fs.copyFileSync(found, path.join(MIHOMO_DIR, binName));
    }
    fs.chmodSync(path.join(MIHOMO_DIR, binName), 0o755);
  }
  for (const entry of fs.readdirSync(MIHOMO_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(MIHOMO_DIR, entry.name), { recursive: true, force: true });
  }
  fs.unlinkSync(archivePath);

  const metaTag = await latestReleaseTag('MetaCubeX/meta-rules-dat');
  const meta = {};
  for (const file of ['geoip.dat', 'geosite.dat', 'country.mmdb']) {
    await downloadFirst(mihomoGeoDataUrls(file), path.join(MIHOMO_DIR, file), validGeo);
    meta[file] = { version: metaTag, updatedAt: Date.now() };
  }
  validateMihomoGeoData(MIHOMO_DIR, binName);
  fs.writeFileSync(path.join(MIHOMO_DIR, 'geodata-meta.json'), JSON.stringify(meta), 'utf-8');
  console.log('mihomo bundle ready in', MIHOMO_DIR);
}

async function main() {
  const goos = detectOs();
  const arch = detectArch();
  fs.mkdirSync(BIN_DIR, { recursive: true });
  await bundleSingBox(goos, arch);
  await bundleMihomo(goos, arch);
  console.log('Bundled cores and GeoData in', BIN_DIR);
}

main().catch((err) => {
  console.error('Failed to download bundled cores:', err.message);
  process.exit(1);
});
