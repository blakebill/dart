'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

/**
 * sing-box core process manager
 *
 * Responsible for: locating the core binary, writing the config, starting/stopping
 * the process, forwarding logs, and (optionally) downloading the core.
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
    this.proc = null;
    this.configPath = path.join(this.runtimeDir, 'config.json');
    if (!fs.existsSync(this.runtimeDir)) {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
    }
  }

  /** Core executable file name. */
  get binName() {
    return process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  }

  /**
   * Resolve the core path. A user-downloaded core (runtimeDir) takes precedence
   * over the bundled one (resourcesDir) so "Download core" can update it.
   */
  resolveBinaryPath() {
    const candidates = [
      path.join(this.runtimeDir, 'bin', this.binName),
      path.join(this.runtimeDir, this.binName),
      this.resourcesDir && path.join(this.resourcesDir, this.binName),
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
    if (this._versionCache && this._versionCache.bin === bin) {
      return this._versionCache.version;
    }
    try {
      const out = await this._runCapture(bin, ['version']);
      const m = out.match(/version\s+(\S+)/i);
      const version = m ? m[1] : null;
      this._versionCache = { bin, version };
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
    const dirs = [
      path.join(this.runtimeDir, 'bin'),
      this.resourcesDir,
    ].filter(Boolean);
    for (const d of dirs) {
      if (this._validSrs(path.join(d, 'geoip-cn.srs')) && this._validSrs(path.join(d, 'geosite-cn.srs'))) {
        return d;
      }
    }
    return null;
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

  isRunning() {
    return !!this.proc;
  }

  /** Write the sing-box config file. */
  writeConfig(config) {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    return this.configPath;
  }

  /** Validate the config (sing-box check). */
  checkConfig() {
    return new Promise((resolve, reject) => {
      const bin = this.resolveBinaryPath();
      if (!bin) return reject(new Error('sing-box core not found'));
      const p = spawn(bin, ['check', '-c', this.configPath], {
        cwd: this.runtimeDir,
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
      throw new Error('sing-box core not found. Download or place the core under Settings first.');
    }
    if (config) this.writeConfig(config);

    this.onLog('[gui] Starting sing-box core...');
    const proc = spawn(bin, ['run', '-c', this.configPath, '-D', this.runtimeDir], {
      cwd: this.runtimeDir,
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
      this.onLog(`[gui] sing-box exited (code=${code}, signal=${signal})`);
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
   * Download the sing-box core (from GitHub Releases).
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
    if (!tag) {
      tag = await this._latestVersion(proxyPort);
    }
    const ver = tag.replace(/^v/, '');
    const ext = goos === 'windows' ? 'zip' : 'tar.gz';
    const fileName = `sing-box-${ver}-${goos}-${arch}.${ext}`;
    const url = `https://github.com/SagerNet/sing-box/releases/download/v${ver}/${fileName}`;

    const binDir = path.join(this.runtimeDir, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    const archivePath = path.join(binDir, fileName);

    this.onLog('[gui] Downloading core: ' + url + (proxyPort ? ' (via proxy)' : ''));
    await fetch.downloadWithFallback(url, archivePath, { proxyPort, onProgress, log: (m) => this.onLog(m) });
    this.onLog('[gui] Download complete, extracting...');
    if (beforeInstall) await beforeInstall();
    await this._extractCore(archivePath, binDir, goos);
    // Verify the executable actually landed in runtimeDir/bin before claiming success.
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
   * Download/refresh the geoip-cn / geosite-cn rule-sets into runtimeDir/bin so
   * the bundled (or stale) geodata can be updated from within the app.
   */
  async updateGeoData(onProgress = () => {}, proxyPort = 0) {
    const binDir = path.join(this.runtimeDir, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
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

  /** Read the stored geodata meta ({ file: { version, updatedAt } }), or {}. */
  geoMeta() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.runtimeDir, 'bin', 'geodata-meta.json'), 'utf-8'));
    } catch (e) {
      return {};
    }
  }

  /** Latest stable core release tag — GitHub API first, jsDelivr fallback. */
  async _latestVersion(proxyPort = 0) {
    const { tag, source } = await github.latestReleaseTag('SagerNet/sing-box', proxyPort, (m) => this.onLog(m));
    if (source !== 'github') this.onLog('[gui] core version resolved via jsDelivr: ' + tag);
    return tag;
  }

  /** Extract the core archive (zip on Windows / tar.gz elsewhere), only the executable. */
  async _extractCore(archivePath, binDir, goos) {
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
