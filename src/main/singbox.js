'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib');
const yaml = require('js-yaml');
const fetch = require('./fetch');
const github = require('./github');
const { getCoreAdapter, hasCoreAdapter, normalizeCoreType } = require('./core-adapters');
const { verifyFileSha256 } = require('./integrity');
const { uniqueSibling, replaceFileSync, replaceFileBatchSync, writeJsonAtomicSync } = require('./file-utils');

const CORE_START_MIN_ALIVE_MS = 600;
const CORE_START_MAX_WAIT_MS = 8000;
const CORE_START_POLL_MS = 100;

/** TCP probe for 127.0.0.1:port — used to confirm the mixed inbound is accepting. */
function probeLocalPort(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port: numeric }, () => {
      socket.destroy();
      resolve(true);
    });
    const finish = (ok) => {
      try { socket.destroy(); } catch (_) {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Mixed inbound port from a generated sing-box or mihomo config, if present. */
function listenPortFromConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const mixed = Number(config['mixed-port']);
  if (Number.isInteger(mixed) && mixed > 0 && mixed <= 65535) return mixed;
  const inbound = Array.isArray(config.inbounds)
    ? config.inbounds.find((item) => item && item.type === 'mixed')
    : null;
  const port = inbound && Number(inbound.listen_port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// Matches ANSI CSI escape sequences (e.g. color codes like "\x1b[38;5;74m").
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const MIHOMO_GEO_VALIDATION_SCHEMA = 2;

function operationAbortedError() {
  const error = new Error('operation aborted');
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw operationAbortedError();
}

/** Remove ANSI escape sequences from a string. */
function stripAnsi(str) {
  return str.replace(ANSI_PATTERN, '');
}

/** Run a short-lived helper process and wait for its pipes to close. */
function runCapturedProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    timeout = 5000,
    timeoutMessage = command + ' timed out',
    outputLimit = 1024 * 1024,
    cleanAnsi = false,
    signal = null,
  } = options;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(operationAbortedError());
      return;
    }
    let proc;
    try {
      proc = spawn(command, args, { cwd, env, windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationError = null;
    let killDeadline = null;
    const append = (current, data) => {
      const text = cleanAnsi ? stripAnsi(data.toString()) : data.toString();
      return (current + text).slice(-outputLimit);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killDeadline) clearTimeout(killDeadline);
      if (signal) signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try {
        proc.kill('SIGKILL');
      } catch (killError) {
        terminationError.killError = killError;
        finish(terminationError);
        return;
      }
      // Normally `close` follows immediately and proves all handles are gone.
      // Keep a finite escape hatch for a broken platform process implementation.
      killDeadline = setTimeout(() => finish(terminationError), 2000);
    };
    const abort = () => terminate(operationAbortedError());
    const timer = setTimeout(() => terminate(new Error(timeoutMessage)), timeout);
    if (signal) signal.addEventListener('abort', abort, { once: true });

    proc.stdout.on('data', (data) => { stdout = append(stdout, data); });
    proc.stderr.on('data', (data) => { stderr = append(stderr, data); });
    proc.once('close', (code, signal) => {
      if (terminationError) finish(terminationError);
      else finish(null, { code, signal, stdout, stderr });
    });
    proc.once('error', (error) => finish(error));
  });
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

function statFingerprint(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino || 0}`;
}

function parseCoreVersion(output) {
  const text = String(output || '');
  const match = text.match(/version\s+v?(\S+)/i) || text.match(/\bv?(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
  return match ? match[1] : null;
}

function baseVersionParts(version) {
  const match = String(version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareBaseVersions(left, right) {
  const a = baseVersionParts(left);
  const b = baseVersionParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function validMihomoGeoFile(filePath, knownStat = null) {
  try {
    const st = knownStat || fs.statSync(filePath);
    if (st.size < 1024) return false;
    const head = Buffer.alloc(Math.min(st.size, 4096));
    const tailSize = Math.min(st.size, 65536);
    const tail = Buffer.alloc(tailSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, head, 0, head.length, 0);
      fs.readSync(fd, tail, 0, tailSize, st.size - tailSize);
    } finally {
      fs.closeSync(fd);
    }

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
    'geodata-loader': 'memconservative',
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
class CoreManager {
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
    this._coreDownloadPromise = null;
    this._coreDownloadController = null;
    this._geoUpdatePromises = new Map();
    this._versionRequests = new Map();
    this._fileValidationCache = new Map();
    this._mihomoValidationPromise = null;
    this._bundledSingBoxPatchPromise = null;
    this._bundledSingBoxPatchChecked = false;
    if (!fs.existsSync(this.runtimeDir)) {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
    }
    this._migrateLegacyLayout();
  }

  setCoreType(type) {
    const nextType = normalizeCoreType(type);
    if (this._coreDownloadPromise && nextType !== this.getCoreType()) {
      throw new Error('wait for the core update to finish before switching cores');
    }
    this.coreType = nextType;
    this._versionCache = null;
    this.ensureCoreDir();
  }

  isCoreDownloadInProgress() {
    return !!this._coreDownloadPromise;
  }

  cancelCoreDownload() {
    if (this._coreDownloadController) this._coreDownloadController.abort();
  }

  waitForCoreDownload() {
    return this._coreDownloadPromise || Promise.resolve();
  }

  invalidateVersionCache() {
    this._versionCache = null;
  }

  getCoreType() {
    return normalizeCoreType(this.coreType);
  }

  get coreLabel() {
    return this.coreLabelFor();
  }

  coreLabelFor(type = this.getCoreType()) {
    return getCoreAdapter(type).label;
  }

  coreFolderName(type = this.getCoreType()) {
    return getCoreAdapter(type).folderName;
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
    const adapter = getCoreAdapter(type);
    return [
      ...adapter.resourceFolders.map((folder) => path.join(this.resourcesDir, folder)),
      this.resourcesDir,
    ].filter((d, i, arr) => d && arr.indexOf(d) === i);
  }

  get configPath() {
    return this.configPathFor();
  }

  configPathFor(type = this.getCoreType()) {
    return path.join(this.ensureCoreDir(type), getCoreAdapter(type).configFile);
  }

  /** Selected core executable file name. */
  get binName() {
    return this.binNameFor();
  }

  binNameFor(type = this.getCoreType()) {
    return getCoreAdapter(type).binaryName();
  }

  /**
   * Resolve the core path. A user-downloaded core (runtimeDir) takes precedence
   * over the bundled one (resourcesDir) so "Download core" can update it.
   */
  resolveBinaryPath(type = this.getCoreType()) {
    const binName = this.binNameFor(type);
    const candidates = [
      path.join(this.coreDir(type), binName),
      path.join(this.coreDir(type), 'bin', binName),
      // Legacy layout from older builds. Kept as a fallback, but new installs
      // and updates write to the per-core folders above.
      path.join(this.runtimeDir, 'bin', binName),
      path.join(this.runtimeDir, binName),
      ...this.resourceDirs(type).flatMap((d) => [path.join(d, binName), path.join(d, 'bin', binName)]),
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  resolveBundledBinaryPath(type = this.getCoreType()) {
    const binName = this.binNameFor(type);
    for (const dir of this.resourceDirs(type)) {
      for (const candidate of [path.join(dir, binName), path.join(dir, 'bin', binName)]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  isCoreInstalled(type = this.getCoreType()) {
    return !!this.resolveBinaryPath(type);
  }

  /**
   * Return the installed core version (e.g. "1.9.3"), or null if not available.
   * The result is cached per binary path and refreshed after a download.
   */
  /**
   * Synchronous version of the last successful probe for this binary, or null.
   * Used by sync config builders; call getCoreVersion() first on start paths.
   */
  peekCoreVersion(type = this.getCoreType()) {
    const bin = this.resolveBinaryPath(type);
    if (!bin || !this._versionCache) return null;
    if (this._versionCache.bin !== bin || this._versionCache.coreType !== type) return null;
    try {
      const fingerprint = statFingerprint(fs.statSync(bin));
      if (this._versionCache.fingerprint !== fingerprint) return null;
    } catch (_) {
      return null;
    }
    return this._versionCache.version;
  }

  async getCoreVersion(type = this.getCoreType()) {
    const bin = this.resolveBinaryPath(type);
    if (!bin) return null;
    let fingerprint;
    try {
      const stat = fs.statSync(bin);
      fingerprint = statFingerprint(stat);
    } catch (_) {
      return null;
    }
    if (
      this._versionCache &&
      this._versionCache.bin === bin &&
      this._versionCache.coreType === type &&
      this._versionCache.fingerprint === fingerprint
    ) {
      return this._versionCache.version;
    }
    const requestKey = `${type}:${bin}:${fingerprint}`;
    if (this._versionRequests.has(requestKey)) return this._versionRequests.get(requestKey);
    const request = this._probeCoreVersion(bin, type)
      .then((version) => {
        this._versionCache = { bin, coreType: type, fingerprint, version };
        return version;
      })
      .catch(() => {
        // Cache a failed probe for this exact binary too. Otherwise every state
        // refresh respawns a broken or incompatible executable.
        this._versionCache = { bin, coreType: type, fingerprint, version: null };
        return null;
      })
      .finally(() => this._versionRequests.delete(requestKey));
    this._versionRequests.set(requestKey, request);
    return request;
  }

  async _probeCoreVersion(bin, type) {
    const output = await this._runCapture(bin, getCoreAdapter(type).versionArgs);
    return parseCoreVersion(output);
  }

  /** Replace an older official sing-box runtime override with the bundled Dart build. */
  ensureBundledSingBoxPatch() {
    if (this._bundledSingBoxPatchChecked || this.getCoreType() !== 'sing-box') return Promise.resolve(false);
    if (this._bundledSingBoxPatchPromise) return this._bundledSingBoxPatchPromise;
    this._bundledSingBoxPatchPromise = this._ensureBundledSingBoxPatch()
      .catch((error) => {
        this.onLog('[gui] bundled sing-box upgrade skipped: ' + error.message);
        return false;
      })
      .then((changed) => {
        this._bundledSingBoxPatchChecked = true;
        return changed;
      })
      .finally(() => { this._bundledSingBoxPatchPromise = null; });
    return this._bundledSingBoxPatchPromise;
  }

  async _ensureBundledSingBoxPatch() {
    if (this.proc) return false;
    const runtimeBin = this.resolveBinaryPath('sing-box');
    const bundledBin = this.resolveBundledBinaryPath('sing-box');
    if (!runtimeBin || !bundledBin || path.resolve(runtimeBin) === path.resolve(bundledBin)) {
      return false;
    }

    let runtimeVersion;
    let bundledVersion;
    try {
      [runtimeVersion, bundledVersion] = await Promise.all([
        this._probeCoreVersion(runtimeBin, 'sing-box'),
        this._probeCoreVersion(bundledBin, 'sing-box'),
      ]);
    } catch (_) {
      return false;
    }
    const comparison = compareBaseVersions(bundledVersion, runtimeVersion);
    if (
      !runtimeVersion ||
      /-dart\.\d+$/i.test(runtimeVersion) ||
      !/-dart\.\d+$/i.test(bundledVersion) ||
      comparison === null ||
      comparison < 0
    ) return false;

    const staged = uniqueSibling(runtimeBin, 'bundled-patch');
    try {
      await fs.promises.copyFile(bundledBin, staged);
      if (process.platform !== 'win32') await fs.promises.chmod(staged, fs.statSync(bundledBin).mode);
      replaceFileSync(staged, runtimeBin);
      this.invalidateVersionCache();
      this.onLog(`[gui] upgraded sing-box ${runtimeVersion} to bundled ${bundledVersion}`);
      return true;
    } finally {
      try { await fs.promises.unlink(staged); } catch (_) {}
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
      const stat = fs.statSync(p);
      if (stat.size < 8) return false;
      const cacheKey = `srs:${p}:${statFingerprint(stat)}`;
      if (this._fileValidationCache.has(cacheKey)) return this._fileValidationCache.get(cacheKey);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(3);
      try {
        fs.readSync(fd, buf, 0, 3, 0);
      } finally {
        fs.closeSync(fd);
      }
      const valid = buf.toString('latin1') === 'SRS';
      this._rememberFileValidation(cacheKey, valid);
      return valid;
    } catch (e) {
      return false;
    }
  }

  _validGeoFile(p) {
    try {
      const stat = fs.statSync(p);
      const cacheKey = `geo:${p}:${statFingerprint(stat)}`;
      if (this._fileValidationCache.has(cacheKey)) return this._fileValidationCache.get(cacheKey);
      const valid = validMihomoGeoFile(p, stat);
      this._rememberFileValidation(cacheKey, valid);
      return valid;
    } catch (_) {
      return false;
    }
  }

  _rememberFileValidation(key, value) {
    if (this._fileValidationCache.size >= 64) {
      this._fileValidationCache.delete(this._fileValidationCache.keys().next().value);
    }
    this._fileValidationCache.set(key, value);
  }

  _mihomoGeoDataKey(dir, bin) {
    try {
      const files = ['geoip.dat', 'geosite.dat', 'country.mmdb'];
      const binStat = fs.statSync(bin);
      return [
        `schema:${MIHOMO_GEO_VALIDATION_SCHEMA}`,
        `${bin}:${statFingerprint(binStat)}`,
        ...files.map((file) => {
          const st = fs.statSync(path.join(dir, file));
          return `${file}:${statFingerprint(st)}`;
        }),
      ].join('|');
    } catch (_) {
      return null;
    }
  }

  _cacheMihomoGeoValidation(dir, key, ok) {
    const file = path.join(dir, '.mihomo-geodata-validation.json');
    try {
      writeJsonAtomicSync(file, { key, ok });
    } catch (_) {}
  }

  _mihomoGeoValidationContext() {
    const dir = this.ensureCoreDir('mihomo');
    this.ensureMihomoGeoData();
    const files = ['geoip.dat', 'geosite.dat', 'country.mmdb'];
    if (!files.every((file) => this._validGeoFile(path.join(dir, file)))) return { ready: false };

    const bin = this.resolveBinaryPath('mihomo');
    if (!bin) return { ready: false };
    const key = this._mihomoGeoDataKey(dir, bin);
    if (key && this._mihomoGeoValidation && this._mihomoGeoValidation.key === key) {
      return { ready: this._mihomoGeoValidation.ok, dir, bin, key };
    }
    const cacheFile = path.join(dir, '.mihomo-geodata-validation.json');
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached && cached.key === key && typeof cached.ok === 'boolean') {
        this._mihomoGeoValidation = { key, ok: cached.ok };
        return { ready: cached.ok, dir, bin, key };
      }
    } catch (_) {
      /* no reusable validation result */
    }

    return key ? { ready: null, dir, bin, key } : { ready: false };
  }

  _rememberMihomoGeoValidation(dir, key, ok, error = null, cache = true) {
    if (!ok) {
      const detail = error ? ': ' + String(error.message || error).trim() : '';
      this.onLog('[gui] mihomo geodata validation failed; starting without GEOIP/GEOSITE rules' + detail);
    }
    if (cache) {
      this._mihomoGeoValidation = { key, ok };
      this._cacheMihomoGeoValidation(dir, key, ok);
    } else {
      // A timeout, spawn failure or temporary file lock says nothing about the
      // GeoData itself. Let the next start retry instead of persisting a false
      // result for unchanged files forever.
      this._mihomoGeoValidation = null;
      try { fs.unlinkSync(path.join(dir, '.mihomo-geodata-validation.json')); } catch (_) {}
    }
    return ok;
  }

  _mihomoValidationFailureIsDeterministic(error) {
    return /^config validation failed:/i.test(String(error && error.message || error || ''));
  }

  /** Synchronous compatibility check; startup uses validateMihomoGeoData(). */
  mihomoGeoDataReady(verify = true) {
    const context = this._mihomoGeoValidationContext();
    if (context.ready !== null) return context.ready;
    if (!verify) return false;

    const { dir, bin, key } = context;
    const testConfig = uniqueSibling(path.join(dir, '.mihomo-geodata-check.yaml'), 'tmp');
    try {
      fs.writeFileSync(testConfig, yaml.dump(mihomoGeoTestConfig(), { lineWidth: -1, noRefs: true }), 'utf-8');
      const result = spawnSync(bin, ['-t', '-f', testConfig, '-d', dir], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (typeof result.status !== 'number') throw new Error('mihomo validation process did not return an exit code');
      const ok = result.status === 0;
      const output = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ');
      return this._rememberMihomoGeoValidation(dir, key, ok, output || null);
    } catch (e) {
      return this._rememberMihomoGeoValidation(dir, key, false, e, false);
    } finally {
      try { fs.unlinkSync(testConfig); } catch (_) {}
    }
  }

  /** Validate Mihomo GeoData without blocking Electron's main thread. */
  validateMihomoGeoData() {
    const context = this._mihomoGeoValidationContext();
    if (context.ready !== null) return Promise.resolve(context.ready);
    if (this._mihomoValidationPromise && this._mihomoValidationPromise.key === context.key) {
      return this._mihomoValidationPromise.promise;
    }
    const { dir, key } = context;
    const testConfig = uniqueSibling(path.join(dir, '.mihomo-geodata-check.yaml'), 'tmp');
    const operation = (async () => {
      try {
        await fs.promises.writeFile(
          testConfig,
          yaml.dump(mihomoGeoTestConfig(), { lineWidth: -1, noRefs: true }),
          'utf-8'
        );
        await this._checkConfigPath('mihomo', testConfig);
        return this._rememberMihomoGeoValidation(dir, key, true);
      } catch (error) {
        return this._rememberMihomoGeoValidation(
          dir,
          key,
          false,
          error,
          this._mihomoValidationFailureIsDeterministic(error)
        );
      } finally {
        try { await fs.promises.unlink(testConfig); } catch (_) {}
      }
    })();
    const promise = operation.finally(() => {
      if (this._mihomoValidationPromise && this._mihomoValidationPromise.promise === promise) {
        this._mihomoValidationPromise = null;
      }
    });
    this._mihomoValidationPromise = { key, promise };
    return promise;
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
    const text = getCoreAdapter(this.getCoreType()).serializeConfig(config);
    const tmp = uniqueSibling(this.configPath, 'tmp');
    try {
      fs.writeFileSync(tmp, text, 'utf-8');
      replaceFileSync(tmp, this.configPath);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return this.configPath;
  }

  /** Validate the selected core config. */
  checkConfig() {
    return this._checkConfigPath(this.getCoreType(), this.configPath).then(() => true);
  }

  /** Validate an in-memory config with either installed core, without switching. */
  async checkConfigFor(type, config) {
    type = normalizeCoreType(type);
    const adapter = getCoreAdapter(type);
    const workDir = this.ensureCoreDir(type);
    const file = path.join(
      workDir,
      `.dart-check-${process.pid}-${crypto.randomBytes(4).toString('hex')}${adapter.configExtension}`
    );
    const text = adapter.serializeConfig(config);
    try {
      await fs.promises.writeFile(file, text, 'utf-8');
      return await this._checkConfigPath(type, file);
    } finally {
      try { await fs.promises.unlink(file); } catch (_) {}
    }
  }

  _checkConfigPath(type, configPath) {
    const adapter = getCoreAdapter(type);
    const bin = this.resolveBinaryPath(type);
    if (!bin) return Promise.reject(new Error(adapter.label + ' core not found'));
    const workDir = this.ensureCoreDir(type);
    const args = adapter.checkArgs(configPath, workDir);
    return runCapturedProcess(bin, args, {
      cwd: workDir,
      env: this._coreEnv(type),
      timeout: 15000,
      timeoutMessage: 'config validation timed out',
      outputLimit: 2 * 1024 * 1024,
      cleanAnsi: true,
    }).then(({ code, stdout, stderr }) => {
      const output = (stderr || stdout).trim();
      if (code === 0) return { output };
      throw new Error('config validation failed: ' + output);
    });
  }

  /** Start the core. */
  async start(config) {
    if (this.proc) {
      throw new Error('core is already running');
    }
    const coreType = this.getCoreType();
    const adapter = getCoreAdapter(coreType);
    const coreLabel = adapter.label;
    const bin = this.resolveBinaryPath(coreType);
    if (!bin) {
      throw new Error(coreLabel + ' core not found. Download or place the core under Settings first.');
    }
    if (config) this.writeConfig(config);

    this.onLog(`[gui] Starting ${coreLabel} core...`);
    const workDir = this.ensureCoreDir(coreType);
    const configPath = this.configPathFor(coreType);
    const args = adapter.runArgs(configPath, workDir);
    const proc = spawn(bin, args, {
      cwd: workDir,
      env: this._coreEnv(coreType),
    });
    this.proc = proc;

    const remainders = { stdout: '', stderr: '' };
    const decoders = { stdout: new StringDecoder('utf-8'), stderr: new StringDecoder('utf-8') };
    const startupLines = [];
    let startupConfirmed = false;
    const emitLogLine = (line) => {
      if (!line.trim()) return;
      if (!startupConfirmed) {
        startupLines.push(line.slice(0, 1000));
        if (startupLines.length > 8) startupLines.shift();
      }
      this.onLog(line);
    };
    const handleData = (stream, buf) => {
      // sing-box emits ANSI color escape codes (e.g. "\x1b[36mINFO\x1b[0m").
      // Strip them so the log view shows plain text instead of garbage.
      const lines = stripAnsi(remainders[stream] + decoders[stream].write(buf)).split(/\r?\n/);
      remainders[stream] = lines.pop() || '';
      for (const line of lines) emitLogLine(line);
      if (remainders[stream].length > 64 * 1024) {
        emitLogLine(remainders[stream].slice(0, 64 * 1024));
        remainders[stream] = '';
      }
    };
    proc.stdout.on('data', (data) => handleData('stdout', data));
    proc.stderr.on('data', (data) => handleData('stderr', data));

    let stateFinalized = false;
    let streamsFinalized = false;
    let exitInfo = null;
    const finalizeState = (code, signal, error = null) => {
      if (stateFinalized) return;
      stateFinalized = true;
      exitInfo = { code, signal, error };
      if (this.proc !== proc) return;
      this.proc = null;
      this.onExit(code, signal);
    };
    const finalizeStreams = (code, signal) => {
      if (streamsFinalized) return;
      streamsFinalized = true;
      emitLogLine(stripAnsi(remainders.stdout + decoders.stdout.end()));
      emitLogLine(stripAnsi(remainders.stderr + decoders.stderr.end()));
      const info = exitInfo || { code, signal, error: null };
      if (info.error) this.onLog('[gui] core start error: ' + info.error.message);
      else this.onLog(`[gui] ${coreLabel} exited (code=${info.code}, signal=${info.signal})`);
    };
    // `exit` updates lifecycle state promptly, while `close` is the point at
    // which stdout/stderr are guaranteed drained. Ending the decoders at
    // `exit` can truncate or corrupt a final multibyte log line.
    proc.once('exit', (code, signal) => finalizeState(code, signal));
    proc.once('error', (error) => finalizeState(-1, null, error));
    proc.once('close', (code, signal) => {
      finalizeState(code, signal);
      finalizeStreams(code, signal);
    });

    // Wait until the process has stayed alive long enough to catch fast
    // crashes, and (when known) until the mixed inbound accepts TCP. A fixed
    // 600ms sleep alone misses slower bind/TUN failures that exit later.
    const probePort = listenPortFromConfig(config);
    const startedAt = Date.now();
    let portReady = !probePort;
    while (true) {
      if (this.proc !== proc) {
        const detail = startupLines.slice(-4).join(' | ');
        throw new Error('core exited immediately after start' + (detail ? ': ' + detail : '; check the logs and config'));
      }
      const elapsed = Date.now() - startedAt;
      if (probePort && !portReady) {
        portReady = await probeLocalPort(probePort);
      }
      if (elapsed >= CORE_START_MIN_ALIVE_MS && portReady) break;
      if (elapsed >= CORE_START_MAX_WAIT_MS) {
        if (probePort && !portReady) {
          try { await this.stop(); } catch (_) {}
          throw new Error(
            `core process stayed up but proxy port ${probePort} did not open; check the logs and config`
          );
        }
        break;
      }
      await new Promise((r) => setTimeout(r, CORE_START_POLL_MS));
    }
    if (this.proc !== proc) {
      const detail = startupLines.slice(-4).join(' | ');
      throw new Error('core exited immediately after start' + (detail ? ': ' + detail : '; check the logs and config'));
    }
    startupConfirmed = true;
    startupLines.length = 0;
    return true;
  }

  _coreEnv(type = this.getCoreType()) {
    return getCoreAdapter(type).processEnv(process.env, { runtimeDir: this.runtimeDir });
  }

  /** Stop the core. */
  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    return new Promise((resolve, reject) => {
      let terminateTimer = null;
      let deadlineTimer = null;
      let settled = false;
      const settle = (error = null) => {
        if (settled) return;
        settled = true;
        if (terminateTimer) clearTimeout(terminateTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        proc.removeListener('exit', done);
        if (error) reject(error);
        else resolve();
      };
      const done = () => settle();
      proc.once('exit', done);
      try {
        if (process.platform === 'win32') {
          // SIGTERM is unreliable on Windows; use taskkill to kill the process tree.
          const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
          killer.once('error', () => {});
        } else {
          proc.kill('SIGTERM');
        }
      } catch (e) {
        settle(e);
        return;
      }
      // Escalate once, then fail rather than starting a second core while the
      // previous process may still own ports or a TUN adapter.
      terminateTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (error) {
          settle(error);
          return;
        }
        deadlineTimer = setTimeout(() => settle(new Error('core did not stop after SIGKILL')), 1000);
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
    if (this._coreDownloadPromise) throw new Error('core download already in progress');
    const controller = new AbortController();
    const operation = this._downloadCore(version, onProgress, { ...opts, signal: controller.signal });
    this._coreDownloadController = controller;
    this._coreDownloadPromise = operation;
    try {
      return await operation;
    } finally {
      if (this._coreDownloadPromise === operation) {
        this._coreDownloadPromise = null;
        this._coreDownloadController = null;
      }
    }
  }

  async _downloadCore(version, onProgress, opts) {
    const { proxyPort = 0, beforeInstall = null, signal = null } = opts;
    throwIfAborted(signal);
    const coreType = opts.coreType === undefined
      ? this.getCoreType()
      : hasCoreAdapter(opts.coreType)
        ? opts.coreType
        : null;
    if (!coreType) throw new Error('invalid core type');
    const adapter = getCoreAdapter(coreType);
    const coreLabel = adapter.label;
    const plat = process.platform; // win32 / linux / darwin
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const goos = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux';

    let tag = String(version || '').trim();
    if (tag && !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
      throw new Error('invalid core version');
    }
    let release = null;
    if (!tag) {
      const latest = await this._latestVersion(proxyPort, coreType, signal);
      tag = latest.tag;
      release = latest.release;
    } else {
      const releaseTag = typeof adapter.releaseTag === 'function'
        ? adapter.releaseTag(tag)
        : tag.startsWith('v') ? tag : 'v' + tag;
      tag = releaseTag;
      try {
        release = await github.releaseByTag(
          adapter.repo,
          releaseTag,
          proxyPort,
          (message) => this.onLog(message),
          { signal }
        );
      } catch (error) {
        if (signal && signal.aborted) throw error;
        this.onLog(`[gui] release metadata unavailable for ${coreLabel} ${releaseTag}: ${error.message}`);
      }
    }
    const ver = tag.replace(/^v/, '');
    const asset = adapter.releaseAsset(ver, goos, arch, release);

    const binDir = this.ensureCoreDir(coreType);
    const archivePath = path.join(binDir, asset.fileName);

    this.onLog('[gui] Downloading core: ' + asset.url + (proxyPort ? ' (via proxy)' : ''));
    try {
      await fetch.downloadWithFallback(asset.url, archivePath, {
        proxyPort,
        onProgress,
        signal,
        log: (m) => this.onLog(m),
      });
      throwIfAborted(signal);
      if (asset.sha256) {
        const digest = await verifyFileSha256(archivePath, asset.sha256, asset.fileName);
        this.onLog('[gui] core archive SHA-256 verified: ' + digest);
      } else {
        this.onLog('[gui] warning: upstream release metadata did not provide a core SHA-256 digest');
      }
      throwIfAborted(signal);
      this.onLog('[gui] Download complete, extracting...');
      if (beforeInstall) await beforeInstall();
      throwIfAborted(signal);
      await this._extractCore(archivePath, binDir, goos, coreType, signal);
      throwIfAborted(signal);
    } finally {
      try { fs.unlinkSync(archivePath); } catch (_) {}
    }
    // Verify the executable actually landed in the selected core folder before
    // claiming success.
    const binName = this.binNameFor(coreType);
    const installed = path.join(binDir, binName);
    if (!fs.existsSync(installed)) {
      throw new Error('extraction finished but ' + binName + ' was not found in ' + binDir);
    }
    this.onLog(`[gui] ${coreLabel} core installed at ${installed}`);
    // Invalidate the cached version so the next query reflects the new core.
    this.invalidateVersionCache();
    return installed;
  }

  /**
   * Download/refresh the geoip-cn / geosite-cn rule-sets into the singbox core
   * folder so the bundled (or stale) geodata can be updated from within the app.
   */
  async updateGeoData(onProgress = () => {}, proxyPort = 0) {
    return getCoreAdapter(this.getCoreType()).updateGeoData(this, onProgress, proxyPort);
  }

  async _downloadAndInstallGeoFiles(dir, files, options) {
    const { proxyPort, onProgress, validator, updateLabel, successLabel } = options;
    const staged = [];
    let done = 0;
    try {
      for (const item of files) {
        const dest = path.join(dir, item.file);
        const tmp = uniqueSibling(dest, 'tmp');
        let accepted = false;
        let lastError = null;
        for (const url of item.urls) {
          this.onLog(`[gui] ${updateLabel}: ${url}${proxyPort ? ' (via proxy)' : ''}`);
          try {
            await fetch.downloadWithFallback(url, tmp, {
              proxyPort,
              log: (message) => this.onLog(message),
              onProgress: (progress) => onProgress((done + progress) / files.length),
            });
          } catch (error) {
            lastError = error;
            try { fs.unlinkSync(tmp); } catch (_) {}
            continue;
          }
          if (!validator(tmp)) {
            lastError = new Error('downloaded file failed validation (blocked or redirected)');
            try { fs.unlinkSync(tmp); } catch (_) {}
            continue;
          }
          this.onLog(`[gui] ${successLabel}: ${url}`);
          accepted = true;
          break;
        }
        if (!accepted) {
          throw new Error(
            'download failed for ' + item.file + ' from all sources' +
              (lastError ? ': ' + lastError.message : '') +
              (proxyPort ? '' : '. Start the core first so the download can go through the proxy.')
          );
        }
        staged.push({ source: tmp, target: dest });
        done += 1;
        try { onProgress(done / files.length); } catch (_) {}
      }
      replaceFileBatchSync(staged);
    } finally {
      for (const entry of staged) {
        try { fs.unlinkSync(entry.source); } catch (_) {}
      }
    }
  }

  async _updateSingBoxGeoData(onProgress, proxyPort) {
    const binDir = this.ensureCoreDir('sing-box');
    const files = [
      { file: 'geoip-cn.srs', urls: geoDataUrls('sing-geoip', 'geoip-cn.srs') },
      { file: 'geosite-cn.srs', urls: geoDataUrls('sing-geosite', 'geosite-cn.srs') },
    ];
    await this._downloadAndInstallGeoFiles(binDir, files, {
      proxyPort,
      onProgress,
      validator: (file) => this._validSrs(file),
      updateLabel: 'Updating geodata',
      successLabel: 'geodata source OK',
    });
    const meta = this.geoMeta('sing-box');
    const updatedAt = Date.now();
    for (const f of files) meta[f.file] = { updatedAt };
    try {
      writeJsonAtomicSync(this.geoMetaPath('sing-box'), meta);
    } catch (e) {
      /* non-fatal */
    }
    this.onLog('[gui] GeoData updated in ' + binDir);
    return binDir;
  }

  updateMihomoGeoData(onProgress = () => {}, proxyPort = 0) {
    return this._coalesceGeoUpdate('mihomo', () => this._updateMihomoGeoData(onProgress, proxyPort));
  }

  async _updateMihomoGeoData(onProgress, proxyPort) {
    const dir = this.ensureCoreDir('mihomo');
    const files = ['geoip.dat', 'geosite.dat', 'country.mmdb'].map((file) => ({
      file,
      urls: mihomoGeoDataUrls(file),
    }));
    await this._downloadAndInstallGeoFiles(dir, files, {
      proxyPort,
      onProgress,
      validator: (file) => this._validGeoFile(file),
      updateLabel: 'Updating mihomo geodata',
      successLabel: 'mihomo geodata source OK',
    });
    const meta = this.geoMeta('mihomo');
    const updatedAt = Date.now();
    for (const file of files) meta[file] = { updatedAt };
    try {
      writeJsonAtomicSync(this.geoMetaPath('mihomo'), meta);
    } catch (_) {
      /* non-fatal */
    }
    this.onLog('[gui] Mihomo GeoData updated in ' + dir);
    return dir;
  }

  _coalesceGeoUpdate(type, factory) {
    const active = this._geoUpdatePromises.get(type);
    if (active) return active;
    let tracked;
    tracked = Promise.resolve().then(factory).finally(() => {
      if (this._geoUpdatePromises.get(type) === tracked) this._geoUpdatePromises.delete(type);
    });
    this._geoUpdatePromises.set(type, tracked);
    return tracked;
  }

  /** Read the stored geodata update times ({ file: { updatedAt } }), or {}. */
  geoMetaPath(type = this.getCoreType()) {
    return path.join(this.coreDir(type), 'geodata-meta.json');
  }

  geoMeta(type = this.getCoreType()) {
    try {
      return JSON.parse(fs.readFileSync(this.geoMetaPath(type), 'utf-8'));
    } catch (e) {
      return {};
    }
  }

  /** Latest stable core release tag — GitHub API first, jsDelivr fallback. */
  async _latestVersion(proxyPort = 0, type = this.getCoreType(), signal = null) {
    const repo = getCoreAdapter(type).repo;
    const { tag, release, source } = await github.latestReleaseTag(
      repo,
      proxyPort,
      (m) => this.onLog(m),
      { signal }
    );
    if (source !== 'github') this.onLog('[gui] core version resolved via jsDelivr: ' + tag);
    return { tag, release };
  }

  _coreAsset(ver, goos, arch, release, type = this.getCoreType()) {
    return getCoreAdapter(type).releaseAsset(ver, goos, arch, release);
  }

  /** Extract a core into an isolated staging directory, then atomically install it. */
  async _extractCore(archivePath, binDir, goos, type = this.getCoreType(), signal = null) {
    throwIfAborted(signal);
    const adapter = getCoreAdapter(type);
    const binName = adapter.binaryName();
    const target = path.join(binDir, binName);
    const stage = path.join(binDir, `.extract-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(stage, { recursive: true });
    try {
      if (adapter.singleGzip && /\.gz$/i.test(archivePath) && !/\.tar\.gz$/i.test(archivePath)) {
        await pipeline(
          fs.createReadStream(archivePath),
          zlib.createGunzip(),
          fs.createWriteStream(path.join(stage, binName)),
          ...(signal ? [{ signal }] : [])
        );
      } else if (goos === 'windows') {
        const quote = (value) => String(value).replace(/'/g, "''");
        await this._run('powershell', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${quote(archivePath)}' -DestinationPath '${quote(stage)}' -Force`,
        ], { signal });
      } else {
        await this._run('tar', ['-xzf', archivePath, '-C', stage], { signal });
      }

      throwIfAborted(signal);
      const found = this._findExtractedBinary(stage, binName, 4, !!adapter.allowBinaryPrefix);
      if (!found) throw new Error(`${binName} was not found in the downloaded archive`);
      if (goos !== 'windows') fs.chmodSync(found, 0o755);
      const versionOutput = await this._runCapture(found, adapter.versionArgs, { signal });
      if (!/\b(?:version\s+v?|v?)\d+\.\d+/i.test(versionOutput)) {
        throw new Error(`downloaded ${binName} did not report a valid version`);
      }
      throwIfAborted(signal);
      replaceFileSync(found, target);
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
      try { fs.unlinkSync(archivePath); } catch (_) {}
    }
  }

  _findExtractedBinary(dir, name, depth = 2, allowMihomoPrefix = false) {
    const find = (root, remaining, predicate) => {
      if (remaining < 0) return null;
      let entries;
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch (_) {
        return null;
      }
      for (const entry of entries) {
        if (entry.isFile() && predicate(entry.name)) return path.join(root, entry.name);
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = find(path.join(root, entry.name), remaining - 1, predicate);
        if (found) return found;
      }
      return null;
    };

    // Prefer the canonical filename across the entire archive. Some releases
    // include helper binaries whose names also begin with `mihomo`.
    const exact = find(dir, depth, (file) => file.toLowerCase() === name.toLowerCase());
    if (exact || !allowMihomoPrefix) return exact;
    const wantsExe = /\.exe$/i.test(name);
    return find(dir, depth, (file) =>
      /^mihomo/i.test(file) && (wantsExe ? /\.exe$/i.test(file) : !/\.exe$/i.test(file))
    );
  }

  async _run(cmd, args, options = {}) {
    const { code, stderr } = await runCapturedProcess(cmd, args, { ...options, timeout: 120000 });
    if (code !== 0) throw new Error(stderr || cmd + ' failed');
  }

  /** Run a command and resolve with its captured stdout. */
  async _runCapture(cmd, args, options = {}) {
    const { code, stdout, stderr } = await runCapturedProcess(cmd, args, options);
    if (code !== 0) throw new Error(stderr || cmd + ' failed');
    return stdout || stderr;
  }
}

module.exports = { CoreManager, geoDataUrls };
