'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SENSITIVE_KEYS = /^(?:password|passwd|uuid|secret|token|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|age[-_]?secret[-_]?key|private[-_]?key|client[-_]?secret|psk|auth|username)$/i;
const MAX_SECRET_VALUES = 4_000;
const MAX_CRASH_CHARS = 512 * 1024;
const MAX_LOG_ENTRIES = 800;

function collectSecrets(value, output = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value) || output.size >= MAX_SECRET_VALUES) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, output, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(key)) {
        const pending = [item];
        let visited = 0;
        while (pending.length && output.size < MAX_SECRET_VALUES && visited < MAX_SECRET_VALUES) {
          const secretValue = pending.pop();
          visited += 1;
          if (typeof secretValue === 'string' || typeof secretValue === 'number') {
            const secret = String(secretValue);
            if (secret.length >= 4) output.add(secret);
          } else if (secretValue && typeof secretValue === 'object') {
            const children = Array.isArray(secretValue) ? secretValue : Object.values(secretValue);
            for (let index = 0; index < children.length && pending.length < MAX_SECRET_VALUES; index += 1) {
              pending.push(children[index]);
            }
          }
        }
      } else if (item && typeof item === 'object') {
        collectSecrets(item, output, seen);
      }
      if (output.size >= MAX_SECRET_VALUES) break;
    }
  }
  return output;
}

function redactUrl(raw) {
  try {
    const value = new URL(raw);
    if (!['http:', 'https:', 'socks:', 'socks5:', 'ss:', 'trojan:', 'vmess:', 'vless:', 'hysteria2:', 'tuic:'].includes(value.protocol)) {
      return raw;
    }
    if (value.protocol !== 'http:' && value.protocol !== 'https:' && value.protocol !== 'socks:' && value.protocol !== 'socks5:') {
      return value.protocol + '//<redacted>';
    }
    if (value.username) value.username = '<redacted>';
    if (value.password) value.password = '<redacted>';
    if (value.search) value.search = '?<redacted>';
    return value.toString();
  } catch (_) {
    return raw;
  }
}

function collectUrlSecrets(raw, output) {
  try {
    const value = new URL(raw);
    for (const secret of [value.username, value.password, ...value.searchParams.values()]) {
      if (secret && secret.length >= 4) output.add(secret);
    }
  } catch (_) {}
}

function redactText(input, options = {}) {
  let text = String(input === undefined || input === null ? '' : input);
  const explicit = new Set(options.secrets || []);
  for (const value of options.subscriptionUrls || []) {
    if (typeof value === 'string' && value.length >= 4) explicit.add(value);
  }
  const secrets = [...explicit].filter((value) => typeof value === 'string' && value.length >= 4)
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_SECRET_VALUES);
  for (const secret of secrets) text = text.split(secret).join('<redacted>');
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>');
  text = text.replace(/\b(authorization|password|passwd|secret|token|private[-_]?key|client[-_]?secret)\b(\s*[:=]\s*)([^\s,;"']+)/gi, '$1$2<redacted>');
  text = text.replace(/(?:https?|socks5?|ss|trojan|vmess|vless|hysteria2|tuic):\/\/[^\s"'<>]+/gi, (value) => redactUrl(value));
  return text;
}

function safeSettings(settings) {
  const source = settings || {};
  return {
    mixedPort: source.mixedPort,
    clashApiPort: source.clashApiPort,
    logLevel: source.logLevel,
    enableTun: !!source.enableTun,
    systemProxyOnStart: !!source.autoSetSystemProxy,
    enableIpv6: !!source.enableIpv6,
    enableDnsOverride: !!source.enableDnsOverride,
    dnsStrategy: source.dnsStrategy,
    clashMode: source.clashMode,
    smartMode: source.smartMode,
    smartRegionCount: Array.isArray(source.smartRegions) ? source.smartRegions.length : 0,
    useBuiltinRules: !!source.useBuiltinRules,
    theme: source.theme,
    language: source.language,
  };
}

function profileRevision(profile) {
  if (!profile) return '';
  const providers = profile.clashProxyProviders && typeof profile.clashProxyProviders === 'object'
    ? Object.keys(profile.clashProxyProviders).length
    : 0;
  return [
    profile.configHash || '',
    Number(profile.updatedAt) || 0,
    Array.isArray(profile.nodes) ? profile.nodes.length : 0,
    providers,
  ].join(':');
}

function redactValue(value, redact, depth = 0) {
  if (depth > 24) return '<truncated>';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => redactValue(item, redact, depth + 1));
  if (!value || typeof value !== 'object') return String(value || '');
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 10_000)) {
    output[key] = SENSITIVE_KEYS.test(key) ? '<redacted>' : redactValue(item, redact, depth + 1);
  }
  return output;
}

async function readCrashLogs(userData) {
  const logs = {};
  for (const name of ['crash.log', 'crash.log.old']) {
    const file = path.join(userData, name);
    try {
      const stat = await fs.promises.stat(file);
      const handle = await fs.promises.open(file, 'r');
      try {
        const bytes = Math.min(MAX_CRASH_CHARS, stat.size);
        const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
        logs[name] = buffer.toString('utf-8');
      } finally {
        await handle.close();
      }
    } catch (_) {}
  }
  return logs;
}

async function buildDiagnosticBundle(options) {
  const store = options.state.store;
  const summaries = store.listSubscriptions();
  const activeId = options.core.getActiveSubId();
  const secretSet = new Set();
  let hydratedProfiles = 0;
  let active = null;
  // Hydrate one payload at a time. Diagnostic export is explicit, but it still
  // should not retain every large profile simultaneously just to learn its
  // credentials.
  for (const summary of summaries) {
    try {
      const profile = store.getSubscription(summary.id);
      if (!profile) continue;
      hydratedProfiles += 1;
      collectSecrets(profile, secretSet);
      if (profile.id === activeId) active = profile;
    } catch (_) {}
  }
  const allProfilesLoaded = hydratedProfiles === summaries.length;
  let redactionComplete = allProfilesLoaded;
  if (!active && activeId) {
    try { active = store.getSubscription(activeId); } catch (_) {}
  }
  const activeRevision = profileRevision(active);
  const subscriptionUrls = summaries.map((item) => item.url).filter(Boolean);
  if (active) collectSecrets(active, secretSet);
  for (const value of subscriptionUrls) collectUrlSecrets(value, secretSet);
  const secrets = [...secretSet];
  for (const privateValue of [
    options.state.clashApiSecret,
    options.userData,
    os.homedir(),
    process.env.USERNAME,
    process.env.USER,
  ]) {
    if (typeof privateValue === 'string' && privateValue.length >= 4) secrets.push(privateValue);
  }
  const redact = (value) => redactText(value, { secrets, subscriptionUrls });
  const recent = options.getRecentLogs();
  // If a damaged profile payload could not be hydrated, omit unstructured
  // logs rather than claim that unknown inactive credentials were removed.
  const crashLogs = allProfilesLoaded ? await readCrashLogs(options.userData) : {};
  let network = null;
  let config = null;
  try {
    network = await options.toolbox.networkDiagnostics(options.toolContext);
  } catch (error) {
    network = { error: String(error && error.message || error) };
  }
  try {
    const check = await options.toolbox.checkMihomoConfig(options.toolContext);
    config = {
      source: check && check.source ? {
        format: check.source.format,
        nodes: check.source.nodes,
        rules: check.source.rules,
        truncated: !!check.source.truncated,
      } : null,
      result: check && check.result ? check.result : null,
    };
  } catch (error) {
    config = { error: String(error && error.message || error) };
  }
  const sanitizeJson = (value) => value === undefined ? null : redactValue(value, redact);
  const coreVersion = options.state.coreManager.isCoreInstalled()
    ? await options.state.coreManager.getCoreVersion().catch(() => null)
    : null;
  const activeAfter = options.core.getActiveSubId();
  let activeProfileAfter = null;
  try { activeProfileAfter = activeAfter ? store.getSubscription(activeAfter) : null; } catch (_) {}
  const changedDuringCollection = activeAfter !== activeId ||
    profileRevision(activeProfileAfter) !== activeRevision;
  if (changedDuringCollection) {
    // A profile switch/update can overtake the network checks. Refresh only
    // the redaction vocabulary (not the expensive diagnostics) so the mixed
    // report remains private and clearly marks that its state changed.
    let latestSummaries = [];
    try { latestSummaries = store.listSubscriptions(); } catch (_) {}
    let latestHydrated = 0;
    for (const summary of latestSummaries) {
      try {
        const profile = store.getSubscription(summary.id);
        if (!profile) continue;
        latestHydrated += 1;
        const discovered = collectSecrets(profile);
        for (const secret of discovered) {
          if (!secretSet.has(secret)) {
            secretSet.add(secret);
            secrets.push(secret);
          }
        }
        if (summary.url && !subscriptionUrls.includes(summary.url)) {
          subscriptionUrls.push(summary.url);
          const urlSecrets = new Set();
          collectUrlSecrets(summary.url, urlSecrets);
          for (const secret of urlSecrets) {
            if (!secretSet.has(secret)) {
              secretSet.add(secret);
              secrets.push(secret);
            }
          }
        }
      } catch (_) {}
    }
    redactionComplete = redactionComplete && latestHydrated === latestSummaries.length;
  }
  const bundle = {
    kind: 'dart-diagnostic-bundle',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      version: String(options.appVersion || ''),
      electron: process.versions.electron || null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
    },
    runtime: {
      core: 'Mihomo',
      coreVersion,
      running: options.state.coreManager.isRunning(),
      systemProxy: !!options.state.systemProxyOn,
      activeProfile: active ? {
        format: String(active.format || ''),
        nodeCount: Array.isArray(active.nodes) ? active.nodes.length : 0,
        providerCount: active.clashProxyProviders && typeof active.clashProxyProviders === 'object'
          ? Object.keys(active.clashProxyProviders).length
          : 0,
      } : null,
      profileCount: summaries.length,
    },
    settings: safeSettings(store.getSettings()),
    network: sanitizeJson(network),
    config: sanitizeJson(config),
    logs: (redactionComplete && recent && Array.isArray(recent.entries) ? recent.entries : []).slice(-MAX_LOG_ENTRIES).map((entry) => ({
      sequence: Number(entry.sequence) || 0,
      line: redact(entry.line),
    })),
    crashLogs: redactionComplete
      ? Object.fromEntries(Object.entries(crashLogs).map(([name, value]) => [name, redact(value)]))
      : {},
    privacy: {
      subscriptionUrlsRemoved: true,
      credentialsRemoved: redactionComplete,
      logsOmittedForSafety: !redactionComplete,
      generatedProxyDefinitionsIncluded: false,
      changedDuringCollection,
    },
  };
  // Keep the final object behind one redaction boundary so future free-text
  // fields cannot accidentally bypass the privacy guarantees above.
  return redactValue(bundle, redact);
}

module.exports = {
  buildDiagnosticBundle,
  collectSecrets,
  redactText,
  redactValue,
  safeSettings,
};
