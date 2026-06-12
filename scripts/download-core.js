'use strict';

/**
 * Download the sing-box core into ./bin before packaging.
 *
 * Usage:
 *   node scripts/download-core.js                # latest release, current platform
 *   SINGBOX_VERSION=1.11.4 node scripts/download-core.js
 *   SINGBOX_OS=windows SINGBOX_ARCH=amd64 node scripts/download-core.js
 *
 * No external dependencies — only Node built-ins. zip is extracted with
 * PowerShell on Windows; tar.gz with `tar` elsewhere.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const BIN_DIR = path.join(__dirname, '..', 'bin');

function getJson(urlStr) {
  const headers = { 'User-Agent': 'singbox-gui-build' };
  // Authenticate when a token is available to avoid GitHub API rate limits in CI.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Promise((resolve, reject) => {
    https
      .get(urlStr, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(getJson(res.headers.location));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
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
    const file = fs.createWriteStream(dest);
    https
      .get(urlStr, { headers: { 'User-Agent': 'singbox-gui-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          file.close();
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

function detectOs() {
  if (process.env.SINGBOX_OS) return process.env.SINGBOX_OS;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function detectArch() {
  if (process.env.SINGBOX_ARCH) return process.env.SINGBOX_ARCH;
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

async function main() {
  const goos = detectOs();
  const arch = detectArch();
  const binName = goos === 'windows' ? 'sing-box.exe' : 'sing-box';

  let version = process.env.SINGBOX_VERSION;
  if (!version) {
    console.log('Resolving latest sing-box release...');
    const latest = await getJson('https://api.github.com/repos/SagerNet/sing-box/releases/latest');
    version = latest.tag_name;
    if (!version) {
      throw new Error(
        'could not resolve latest version' +
          (latest.message ? ' (' + latest.message + ')' : '') +
          '. Set SINGBOX_VERSION to pin a version, e.g. SINGBOX_VERSION=1.11.4'
      );
    }
  }
  const ver = String(version).replace(/^v/, '');
  const ext = goos === 'windows' ? 'zip' : 'tar.gz';
  const fileName = `sing-box-${ver}-${goos}-${arch}.${ext}`;
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${ver}/${fileName}`;

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  const archivePath = path.join(BIN_DIR, fileName);

  console.log('Downloading', url);
  await download(url, archivePath);

  console.log('Extracting...');
  if (goos === 'windows') {
    const r = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${BIN_DIR}' -Force`,
    ], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Expand-Archive failed');
  } else {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', BIN_DIR], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar extraction failed');
  }

  // The files live in a sub-folder sing-box-x.y.z-os-arch/; move the executable
  // AND any sidecar libraries (e.g. libcronet.dll on Windows) to bin/ root.
  for (const entry of fs.readdirSync(BIN_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('sing-box-')) {
      const innerDir = path.join(BIN_DIR, entry.name);
      for (const f of fs.readdirSync(innerDir)) {
        if (f === binName || /\.(dll|so|dylib)$/i.test(f)) {
          const target = path.join(BIN_DIR, f);
          fs.copyFileSync(path.join(innerDir, f), target);
          if (goos !== 'windows' && f === binName) fs.chmodSync(target, 0o755);
        }
      }
      fs.rmSync(innerDir, { recursive: true, force: true });
    }
  }
  fs.unlinkSync(archivePath);

  const finalPath = path.join(BIN_DIR, binName);
  if (!fs.existsSync(finalPath)) throw new Error('core binary not found after extraction');
  console.log('Core ready at', finalPath);

  // Bundle the routing rule-sets so the app starts without any network access.
  const ruleSets = [
    { file: 'geoip-cn.srs', repo: 'sing-geoip' },
    { file: 'geosite-cn.srs', repo: 'sing-geosite' },
  ];
  for (const rs of ruleSets) {
    const dest = path.join(BIN_DIR, rs.file);
    const url = `https://raw.githubusercontent.com/SagerNet/${rs.repo}/rule-set/${rs.file}`;
    console.log('Downloading rule-set', url);
    await download(url, dest);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      throw new Error('failed to download rule-set ' + rs.file);
    }
  }
  console.log('Rule-sets bundled in', BIN_DIR);
}

main().catch((err) => {
  console.error('Failed to download core:', err.message);
  process.exit(1);
});
