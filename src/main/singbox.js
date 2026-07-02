'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const zlib = require('zlib');
const yaml = require('js-yaml');
const fetch = require('./fetch');
const github = require('./github');

// Matches ANSI CSI escape sequences (e.g. color codes like "\x1b[38;5;74m").
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Remove ANSI escape sequences from a string. */
function stripAnsi(str) {
  return str.replace(ANSI_PATTERN, '');
}

/**
 * Candidate download URLs for a rule-set file, in priority order.
 *
 * raw.githubusercontent.com is the canonical source but is unreliable from
 * mainland China even through some proxy nodes (slow, rate-limited, or it
 * returns an error/redirect page that fails .srs validation). jsDelivr serves
 * the same repo@branch over a CDN that is far more reachable, so its mirrors
 * are used as fallbacks. Each URL is still attempted proxy-first then direct.
 */
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

function looksLikeTextError(buf) {
  const head = buf.slice(0, Math.min(buf.length, 256)).toString('utf-8').trimStart().toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('{') ||
    head.startsWith('[') ||
    head.startsWith('not found') ||
    head.startsWith('invalid')
  );
}

function sampleIsOneByte(buf) {
  if (!buf.length) return true;
  const first = buf[0];
  const step = Math.max(1, Math.floor(buf.length / 64));
  for (let i = 0; i < buf.length; i += step) {
    if (buf[i] !== first) return false;
  }
  return true;
}

function validMihomoGeoFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (st.size < 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(Math.min(st.size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    const tailSize = Math.min(st.size, 65536);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, st.size - tailSize);
    fs.closeSync(fd);

    if (head.slice(0, 3).toString('latin1') === 'SRS') return false;
    if (head[0] === 0x1f && head[1] === 0x8b) return false; // gzip error/archive
    if (head[0] === 0x50 && head[1] === 0x4b) return false; // zip/archive
    if (looksLikeTextError(head)) return false;
    if (sampleIsOneByte(head)) return false;

    if (path.basename(filePath).toLowerCase() === 'country.mmdb') {
      return tail.includes(Buffer.from('MaxMind.com'));
    }
    return true;
  } catch (_) {
    return false;
  }
}

function mihomoGeoTestConfig() {
  return {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'silent',
    'geodata-mode': true,
    'geodata-loader': 'standard',
    'geo-auto-update': false,
    rules: [
      'GEOSITE,cn,DIRECT',
      'GEOIP,CN,DIRECT',
      'MATCH,DIRECT',
    ],
  };
}

/**
 * Proxy core process manager
 *
 * Responsible for: locating the selected core binary, writing the config,
 * starting/stopping the process, forwarding logs, and downloading the core.
 */
class SingBoxManager {
  /**
   * @param {object} opts
   *   - resourcesDir: directory of the bundled core after packaging (extraResources/bin)
   *   - runtimeDir:  runtime directory (writes config.json, cache, etc.)
   *   - onLog: (line) => void log callback
   */
  constructor(opts = {}) {
    this.resourcesDir = opts.resourcesDir;
    this.runtimeDir = opts.runtimeDir;
    this.onLog = opts.onLog || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.coreType = opts.coreType || 'sing-box';
    this.proc = null;
    if (!fs.existsSync(this.runtimeDir)) {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
    }
    this._migrateLegacyLayout();
  }

  setCoreType(type) {
    this.coreType = type === 'mihomo' ? 'mihomo' : 'sing-box';
    this._versionCache = null;
    this.ensureCoreDir();
  }

  getCoreType() {
    return this.coreType || 'sing-box';
  }

  get coreLabel() {
    return this.getCoreType() === 'mihomo' ? 'mihomo' : 'sing-box';
  }

  coreFolderName(type = this.getCoreType()) {
    return type === 'mihomo' ? 'mihomo' : 'singbox';
  }

  coreDir(type = this.getCoreType()) {
    return path.join(this.runtimeDir, this.coreFolderName(type));
  }

  ensureCoreDir(type = this.getCoreType()) {
    const dir = this.coreDir(type);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  resourceDirs(type = this.getCoreType()) {
    if (!this.resourcesDir) return [];
    return [
      path.join(this.resourcesDir, this.coreFolderName(type)),
      path.join(this.resourcesDir, type === 'mihomo' ? 'mihomo' : 'sing-box'),
      this.resourcesDir,
    ].filter((d, i, arr) => d && arr.indexOf(d) === i);
  }

  get configPath() {
    return path.join(this.ensureCoreDir(), this.getCoreType() === 'mihomo' ? 'config.yaml' : 'config.json');
  }

  /** Selected core executable file name. */
  get binName() {
    if (this.getCoreType() === 'mihomo') return process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
    return process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  }

  /**
   * Resolve the core path. A user-downloaded core (runtimeDir) takes precedence
   * over the bundled one (resourcesDir) so "Download core" can update it.
   */
  resolveBinaryPath() {
    const candidates = [
      path.join(this.coreDir(), this.binName),
      path.join(this.coreDir(), 'bin', this.binName),
      // Legacy layout from older builds. Kept as a fallback, but new installs
      // and updates write to the per-core folders above.
      path.join(this.runtimeDir, 'bin', this.binName),
      path.join(this.runtimeDir, this.binName),
      ...this.resourceDirs().flatMap((d) => [path.join(d, this.binName), path.join(d, 'bin', this.binName)]),
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  isCoreInstalled() {
    return !!this.resolveBinaryPath();
  }

  /**
   * Return the installed core version (e.g. "1.9.3"), or null if not available.
   * The result is cached per binary path and refreshed after a download.
   */
  async getCoreVersion() {
    const bin = this.resolveBinaryPath();
    if (!bin) return null;
    if (this._versionCache && this._versionCache.bin === bin && this._versionCache.coreType === this.getCoreType()) {
      return this._versionCache.version;
    }
    try {
      const out = await this._runCapture(bin, this.getCoreType() === 'mihomo' ? ['-v'] : ['version']);
      const m = out.match(/version\s+v?(\S+)/i) || out.match(/\bv?(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
      const version = m ? m[1] : null;
      this._versionCache = { bin, coreType: this.getCoreType(), version };
      return version;
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolve the directory that holds the bundled rule-sets (geoip-cn.srs).
   * Prefers a user-downloaded copy, then the bundled one. Returns null if none,
   * in which case the converter falls back to remote rule-sets.
   */
  resolveRuleSetDir() {
    this.ensureSingBoxGeoData();
    const dirs = [
      this.coreDir('sing-box'),
      path.join(this.runtimeDir, 'bin'), // legacy fallback
      ...this.resourceDirs('sing-box'),
    ].filter((d, i, arr) => d && arr.indexOf(d) === i);
    for (const d of dirs) {
      if (this._validSrs(path.join(d, 'geoip-cn.srs')) && this._validSrs(path.join(d, 'geosite-cn.srs'))) {
        return d;
      }
    }
    return null;
  }

  _copyIfMissing(src, dest, validate = null) {
    try {
      if (!src || !fs.existsSync(src) || fs.existsSync(dest)) return;
      if (validate && !validate.call(this, src)) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      try {
        fs.chmodSync(dest, fs.statSync(src).mode);
      } catch (_) {}
    } catch (_) {
      /* best-effort migration */
    }
  }

  _migrateLegacyLayout() {
    const singboxDir = this.ensureCoreDir('sing-box');
    const mihomoDir = this.ensureCoreDir('mihomo');
    const legacyBin = path.join(this.runtimeDir, 'bin');
    const exe = process.platform === 'win32' ? '.exe' : '';
    this._copyIfMissing(path.join(legacyBin, 'sing-box' + exe), path.join(singboxDir, 'sing-box' + exe));
    this._copyIfMissing(path.join(this.runtimeDir, 'sing-box' + exe), path.join(singboxDir, 'sing-box' + exe));
    this._copyIfMissing(path.join(legacyBin, 'mihomo' + exe), path.join(mihomoDir, 'mihomo' + exe));
    this._copyIfMissing(path.join(this.runtimeDir, 'mihomo' + exe), path.join(mihomoDir, 'mihomo' + exe));
    this._copyIfMissing(path.join(this.runtimeDir, 'config.json'), path.join(singboxDir, 'config.json'));
    this._copyIfMissing(path.join(this.runtimeDir, 'config.yaml'), path.join(mihomoDir, 'config.yaml'));
    this._copyIfMissing(path.join(this.runtimeDir, 'mihomo-geodata-meta.json'), path.join(mihomoDir, 'geodata-meta.json'));

    for (const file of ['geoip.dat', 'geosite.dat', 'country.mmdb']) {
      this._copyIfMissing(path.join(this.runtimeDir, file), path.join(mihomoDir, file), this._validGeoFile);
    }
    try {
      for (const name of fs.readdirSync(legacyBin)) {
        if (
          name === 'geodata-meta.json' ||
          /\.srs$/i.test(name) ||
          /^rp-[a-f0-9]+\.json$/i.test(name)
        ) {
          this._copyIfMissing(path.join(legacyBin, name), path.join(singboxDir, name));
        }
      }
    } catch (_) {
      /* no legacy bin */
    }
  }

  /** A rule-set file is usable only if it exists, is non-empty, and starts with the SRS magic. */
  _validSrs(p) {
    try {
      if (!fs.existsSync(p) || fs.statSync(p).size < 8) return false;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(3);
      fs.readSync(fd, buf, 0, 3, 0);
      fs.closeSync(fd);
      return buf.toString('latin1') === 'SRS';
    } catch (e) {
      return false;
    }
  }

  _validGeoFile(p) {
    return validMihomoGeoFile(p);
  }

  _mihomoGeoDataKey(dir, bin) {
    try {
      const files = ['geoip.dat', 'geosite.dat', 'country.mmdb'];
      return [
        bin,
        ...files.map((file) => {
          const st = fs.statSync(path.join(dir, file));
          return `${file}:${st.size}:${st.mtimeMs}`;
        }),
      ].join('|');
    } catch (_) {
      return null;
    }
  }

  mihomoGeoDataReady() {
    const dir = this.ensureCoreDir('mihomo');
    this.ensureMihomoGeoData();
    const files = ['geoip.dat', 'geosite.dat', 'country.mmdb'];
    if (!files.every((file) => this._validGeoFile(path.join(dir, file)))) return false;

    const bin = this.getCoreType() === 'mihomo' ? this.resolveBinaryPath() : null;
    if (!bin) return false;
    const key = this._mihomoGeoDataKey(dir, bin);
    if (key && this._mihomoGeoValidation && this._mihomoGeoValidation.key === key) {
      return this._mihomoGeoValidation.ok;
    }

    const testConfig = path.join(dir, `.mihomo-geodata-check-${process.pid}.yaml`);
    try {
      fs.writeFileSync(testConfig, yaml.dump(mihomoGeoTestConfig(), { lineWidth: -1, noRefs: true }), 'utf-8');
      const result = spawnSync(bin, ['-t', '-f', testConfig, '-d', dir], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
      });
      const ok = result.status === 0;
      if (!ok) {
        const msg = String(result.stderr || result.stdout || result.error || '').trim().split(/\r?\n/).slice(-3).join(' | ');
        this.onLog('[gui] mihomo geodata validation failed; starting without GEOIP/GEOSITE rules' + (msg ? ': ' + msg : ''));
      }
      this._mihomoGeoValidation = { key, ok };
      return ok;
    } catch (e) {
      this.onLog('[gui] mihomo geodata validation failed; starting without GEOIP/GEOSITE rules: ' + e.message);
      this._mihomoGeoValidation = { key, ok: false };
      return false;
    } finally {
      try { fs.unlinkSync(testConfig); } catch (_) {}
    }
  }

  ensureSingBoxGeoData() {
    const dir = this.ensureCoreDir('sing-box');
    const sources = [
      ...this.resourceDirs('sing-box'),
      path.join(this.runtimeDir, 'bin'),
      this.resourcesDir,
    ].filter((d, i, arr) => d && arr.indexOf(d) === i);
    let ready = true;
    for (const file of ['geoip-cn.srs', 'geosite-cn.srs']) {
      const dest = path.join(dir, file);
      if (this._validSrs(dest)) continue;
      ready = false;
      if (fs.existsSync(dest)) {
        try {
          fs.unlinkSync(dest);
          this.onLog('[gui] removed invalid sing-box geodata: ' + dest);
        } catch (_) {}
      }
      for (const srcDir of sources) {
        const src = path.join(srcDir, file);
        if (!this._validSrs(src)) continue;
        try {
          fs.copyFileSync(src, dest);
          ready = true;
          this.onLog('[gui] restored sing-box geodata from bundled file: ' + file);
          break;
        } catch (_) {}
      }
    }
    return ready && ['geoip-cn.srs', 'geosite-cn.srs'].every((file) => this._validSrs(path.join(dir, file)));
  }

  ensureMihomoGeoData() {
    const dir = this.ensureCoreDir('mihomo');
    const sources = [
      ...this.resourceDirs('mihomo'),
      this.runtimeDir,
      this.resourcesDir,
    ].filter((d, i, arr) => d && arr.indexOf(d) === i);
    let ready = true;
    for (const file of ['geoip.dat', 'geosite.dat', 'country.mmdb']) {
      const dest = path.join(dir, file);
      if (this._validGeoFile(dest)) continue;
      ready = false;
      if (fs.existsSync(dest)) {
        try {
          fs.unlinkSync(dest);
          this._mihomoGeoValidation = null;
          this.onLog('[gui] removed invalid mihomo geodata: ' + dest);
        } catch (_) {}
      }
      for (const srcDir of sources) {
        const src = path.join(srcDir, file);
        if (!this._validGeoFile(src)) continue;
        try {
          fs.copyFileSync(src, dest);
          this._mihomoGeoValidation = null;
          ready = true;
          this.onLog('[gui] restored mihomo geodata from bundled file: ' + file);
          break;
        } catch (_) {}
      }
    }
    return ready && ['geoip.dat', 'geosite.dat', 'country.mmdb'].every((file) => this._validGeoFile(path.join(dir, file)));
  }

  isRunning() {
    return !!this.proc;
  }

  /** Write the selected core's config file. */
  writeConfig(config) {
    const text = this.getCoreType() === 'mihomo'
      ? yaml.dump(config, { lineWidth: -1, noRefs: true })
      : JSON.stringify(config, null, 2);
    fs.writeFileSync(this.configPath, text, 'utf-8');
    return this.configPath;
  }

  /** Validate the selected core config. */
  checkConfig() {
    return new Promise((resolve, reject) => {
      const bin = this.resolveBinaryPath();
      if (!bin) return reject(new Error(this.coreLabel + ' core not found'));
      const workDir = this.ensureCoreDir();
      const args = this.getCoreType() === 'mihomo'
        ? ['-t', '-f', this.configPath, '-d', workDir]
        : ['check', '-c', this.configPath];
      const p = spawn(bin, args, {
        cwd: workDir,
      });
      let err = '';
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('close', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error('config validation failed: ' + err));
      });
      p.on('error', reject);
    });
  }

  /** Start the core. */
  async start(config) {
    if (this.proc) {
      throw new Error('core is already running');
    }
    const bin = this.resolveBinaryPath();
    if (!bin) {
      throw new Error(this.coreLabel + ' core not found. Download or place the core under Settings first.');
    }
    if (config) this.writeConfig(config);

    this.onLog(`[gui] Starting ${this.coreLabel} core...`);
    const workDir = this.ensureCoreDir();
    const args = this.getCoreType() === 'mihomo'
      ? ['-f', this.configPath, '-d', workDir]
      : ['run', '-c', this.configPath, '-D', workDir];
    const proc = spawn(bin, args, {
      cwd: workDir,
    });
    this.proc = proc;

    const handleData = (buf) => {
      // sing-box emits ANSI color escape codes (e.g. "\x1b[36mINFO\x1b[0m").
      // Strip them so the log view shows plain text instead of garbage.
      const text = stripAnsi(buf.toString());
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.onLog(line);
      }
    };
    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('exit', (code, signal) => {
      this.onLog(`[gui] ${this.coreLabel} exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.onExit(code, signal);
    });
    proc.on('error', (err) => {
      this.onLog('[gui] core start error: ' + err.message);
      this.proc = null;
      this.onExit(-1, null);
    });

    // Wait briefly to confirm the process didn't crash immediately.
    await new Promise((r) => setTimeout(r, 600));
    if (!this.proc) {
      throw new Error('core exited immediately after start; check the logs and config');
    }
    return true;
  }

  /** Stop the core. */
  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    return new Promise((resolve) => {
      const done = () => resolve();
      proc.once('exit', done);
      try {
        if (process.platform === 'win32') {
          // SIGTERM is unreliable on Windows; use taskkill to kill the process tree.
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        } else {
          proc.kill('SIGTERM');
        }
      } catch (e) {
        resolve();
      }
      // Timeout fallback
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (_) {}
        resolve();
      }, 3000);
    });
  }

  /**
   * Download the selected core (from GitHub Releases).
   * @param {string} version like '1.9.3'; empty downloads the latest
   * @param {(p:number)=>void} onProgress progress callback 0~1
   * @param {object} [opts]
   *   - proxyPort: tunnel the download through the local proxy (falls back to direct)
   *   - beforeInstall: async hook run after the download, before extraction —
   *     used to stop a running core so the .exe is not locked during overwrite
   */
  async downloadCore(version, onProgress = () => {}, opts = {}) {
    const { proxyPort = 0, beforeInstall = null } = opts;
    const plat = process.platform; // win32 / linux / darwin
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const goos = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux';

    let tag = version;
    let release = null;
    if (!tag) {
      const latest = await this._latestVersion(proxyPort);
      tag = latest.tag;
      release = latest.release;
    }
    const ver = tag.replace(/^v/, '');
    const asset = this._coreAsset(ver, goos, arch, release);

    const binDir = this.ensureCoreDir();
    const archivePath = path.join(binDir, asset.fileName);

    this.onLog('[gui] Downloading core: ' + asset.url + (proxyPort ? ' (via proxy)' : ''));
    await fetch.downloadWithFallback(asset.url, archivePath, { proxyPort, onProgress, log: (m) => this.onLog(m) });
    this.onLog('[gui] Download complete, extracting...');
    if (beforeInstall) await beforeInstall();
    await this._extractCore(archivePath, binDir, goos);
    // Verify the executable actually landed in the selected core folder before
    // claiming success.
    const installed = path.join(binDir, this.binName);
    if (!fs.existsSync(installed)) {
      throw new Error('extraction finished but ' + this.binName + ' was not found in ' + binDir);
    }
    this.onLog('[gui] Core installed at ' + installed);
    // Invalidate the cached version so the next query reflects the new core.
    this._versionCache = null;
    return installed;
  }

  /**
   * Download/refresh the geoip-cn / geosite-cn rule-sets into the singbox core
   * folder so the bundled (or stale) geodata can be updated from within the app.
   */
  async updateGeoData(onProgress = () => {}, proxyPort = 0) {
    if (this.getCoreType() === 'mihomo') {
      return this.updateMihomoGeoData(onProgress, proxyPort);
    }
    const binDir = this.ensureCoreDir('sing-box');
    const files = [
      { file: 'geoip-cn.srs', repo: 'sing-geoip' },
      { file: 'geosite-cn.srs', repo: 'sing-geosite' },
    ];
    let done = 0;
    for (const f of files) {
      // Download to a temp file first, validate, then swap in — so a failed or
      // blocked download (e.g. an HTML error page) never replaces a good file.
      // Walk the candidate sources (raw + jsDelivr mirrors); each is tried
      // proxy-first then direct, and the first one yielding a valid .srs wins.
      const dest = path.join(binDir, f.file);
      const tmp = dest + '.tmp';
      let ok = false;
      let lastErr = null;
      for (const url of geoDataUrls(f.repo, f.file)) {
        this.onLog('[gui] Updating geodata: ' + url + (proxyPort ? ' (via proxy)' : ''));
        try {
          await fetch.downloadWithFallback(url, tmp, {
            proxyPort,
            log: (m) => this.onLog(m),
            onProgress: (p) => onProgress((done + p) / files.length),
          });
        } catch (e) {
          lastErr = e;
          try { fs.unlinkSync(tmp); } catch (_) {}
          continue; // try the next source
        }
        if (!this._validSrs(tmp)) {
          lastErr = new Error('not a valid rule-set (blocked/redirected)');
          try { fs.unlinkSync(tmp); } catch (_) {}
          continue;
        }
        fs.renameSync(tmp, dest);
        this.onLog('[gui] geodata source OK: ' + url);
        ok = true;
        break;
      }
      if (!ok) {
        throw new Error(
          'download failed for ' + f.file + ' from all sources' +
            (lastErr ? ': ' + lastErr.message : '') +
            (proxyPort ? '' : '. Start the core first so the download can go through the proxy.')
        );
      }
      done += 1;
      onProgress(done / files.length);
    }
    // Record the matching release tags (the repos tag releases by date, e.g.
    // 20250606...) and the update time, so the UI can show a version per file.
    // Best-effort: a failed API lookup still records the update date.
    const meta = this.geoMeta();
    for (const f of files) {
      let version = null;
      try {
        // GitHub API first, jsDelivr tag list as fallback (reachable in CN).
        version = (await github.latestReleaseTag(`SagerNet/${f.repo}`, proxyPort, (m) => this.onLog(m))).tag;
      } catch (e) {
        /* keep version null */
      }
      meta[f.file] = { version, updatedAt: Date.now() };
    }
    try {
      fs.writeFileSync(path.join(binDir, 'geodata-meta.json'), JSON.stringify(meta), 'utf-8');
    } catch (e) {
      /* non-fatal */
    }
    this.onLog('[gui] GeoData updated in ' + binDir);
    return binDir;
  }

  async updateMihomoGeoData(onProgress = () => {}, proxyPort = 0) {
    const dir = this.ensureCoreDir('mihomo');
    const files = ['geoip.dat', 'geosite.dat', 'country.mmdb'];
    let done = 0;
    for (const file of files) {
      const dest = path.join(dir, file);
      const tmp = dest + '.tmp';
      let ok = false;
      let lastErr = null;
      for (const url of mihomoGeoDataUrls(file)) {
        this.onLog('[gui] Updating mihomo geodata: ' + url + (proxyPort ? ' (via proxy)' : ''));
        try {
          await fetch.downloadWithFallback(url, tmp, {
            proxyPort,
            log: (m) => this.onLog(m),
            onProgress: (p) => onProgress((done + p) / files.length),
          });
        } catch (e) {
          lastErr = e;
          try { fs.unlinkSync(tmp); } catch (_) {}
          continue;
        }
        if (!this._validGeoFile(tmp)) {
          lastErr = new Error('not a valid geodata file (blocked/redirected)');
          try { fs.unlinkSync(tmp); } catch (_) {}
          continue;
        }
        fs.renameSync(tmp, dest);
        this.onLog('[gui] mihomo geodata source OK: ' + url);
        ok = true;
        break;
      }
      if (!ok) {
        throw new Error(
          'download failed for ' + file + ' from all sources' +
            (lastErr ? ': ' + lastErr.message : '') +
            (proxyPort ? '' : '. Start the core first so the download can go through the proxy.')
        );
      }
      done += 1;
      onProgress(done / files.length);
    }
    const meta = this.geoMeta();
    let version = null;
    try {
      version = (await github.latestReleaseTag('MetaCubeX/meta-rules-dat', proxyPort, (m) => this.onLog(m))).tag;
    } catch (_) {
      /* keep version null */
    }
    for (const file of files) meta[file] = { version, updatedAt: Date.now() };
    try {
      fs.writeFileSync(this.geoMetaPath(), JSON.stringify(meta), 'utf-8');
    } catch (_) {
      /* non-fatal */
    }
    this.onLog('[gui] Mihomo GeoData updated in ' + dir);
    return dir;
  }

  /** Read the stored geodata meta ({ file: { version, updatedAt } }), or {}. */
  geoMetaPath() {
    return path.join(this.coreDir(), 'geodata-meta.json');
  }

  geoMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.geoMetaPath(), 'utf-8'));
    } catch (e) {
      return {};
    }
  }

  /** Latest stable core release tag — GitHub API first, jsDelivr fallback. */
  async _latestVersion(proxyPort = 0) {
    const repo = this.getCoreType() === 'mihomo' ? 'MetaCubeX/mihomo' : 'SagerNet/sing-box';
    const { tag, release, source } = await github.latestReleaseTag(repo, proxyPort, (m) => this.onLog(m));
    if (source !== 'github') this.onLog('[gui] core version resolved via jsDelivr: ' + tag);
    return { tag, release };
  }

  _coreAsset(ver, goos, arch, release) {
    if (this.getCoreType() !== 'mihomo') {
      const ext = goos === 'windows' ? 'zip' : 'tar.gz';
      const fileName = `sing-box-${ver}-${goos}-${arch}.${ext}`;
      return { fileName, url: `https://github.com/SagerNet/sing-box/releases/download/v${ver}/${fileName}` };
    }
    const ext = goos === 'windows' ? 'zip' : 'gz';
    const assets = (release && release.assets) || [];
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
    if (candidates[0]) return { fileName: candidates[0].name, url: candidates[0].url };
    const fileName = `mihomo-${goos}-${arch}-v${ver}.${ext}`;
    return { fileName, url: `https://github.com/MetaCubeX/mihomo/releases/download/v${ver}/${fileName}` };
  }

  /** Extract the core archive (zip on Windows / tar.gz elsewhere), only the executable. */
  async _extractCore(archivePath, binDir, goos) {
    if (this.getCoreType() === 'mihomo') {
      return this._extractMihomoCore(archivePath, binDir, goos);
    }
    if (goos === 'windows') {
      // Use PowerShell to extract the zip (built into Windows).
      await this._run('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force`,
      ]);
    } else {
      await this._run('tar', ['-xzf', archivePath, '-C', binDir]);
    }
    // After extraction the executable sits in a subdir sing-box-x.y.z-os-arch/,
    // so move the executable to the root of binDir.
    const entries = fs.readdirSync(binDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith('sing-box-')) {
        const inner = path.join(binDir, e.name, this.binName);
        if (fs.existsSync(inner)) {
          const target = path.join(binDir, this.binName);
          fs.copyFileSync(inner, target);
          if (goos !== 'windows') fs.chmodSync(target, 0o755);
        }
      }
    }
    // Clean up the archive
    try {
      fs.unlinkSync(archivePath);
    } catch (_) {}
  }

  _findExtractedBinary(dir, name, depth = 2) {
    if (depth < 0) return null;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
      if (e.isFile() && /^mihomo/i.test(e.name) && (process.platform !== 'win32' || /\.exe$/i.test(e.name))) return p;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = this._findExtractedBinary(path.join(dir, e.name), name, depth - 1);
        if (p) return p;
      }
    }
    return null;
  }

  async _extractMihomoCore(archivePath, binDir, goos) {
    const target = path.join(binDir, this.binName);
    if (/\.gz$/i.test(archivePath)) {
      const data = zlib.gunzipSync(fs.readFileSync(archivePath));
      fs.writeFileSync(target, data);
      if (goos !== 'windows') fs.chmodSync(target, 0o755);
      try { fs.unlinkSync(archivePath); } catch (_) {}
      return;
    }
    if (goos === 'windows') {
      await this._run('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force`,
      ]);
    } else {
      await this._run('tar', ['-xzf', archivePath, '-C', binDir]);
    }
    const found = this._findExtractedBinary(binDir, this.binName);
    if (found) {
      if (path.resolve(found) !== path.resolve(target)) fs.copyFileSync(found, target);
      if (goos !== 'windows') fs.chmodSync(target, 0o755);
    }
    try { fs.unlinkSync(archivePath); } catch (_) {}
  }

  _run(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args);
      let err = '';
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || cmd + ' failed'))));
      p.on('error', reject);
    });
  }

  /** Run a command and resolve with its captured stdout. */
  _runCapture(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || cmd + ' failed'))));
      p.on('error', reject);
    });
  }
}

module.exports = { SingBoxManager, geoDataUrls };
