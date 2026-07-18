'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const os = require('os');
const tls = require('tls');
const { execFile } = require('child_process');
const yaml = require('js-yaml');

const fetch = require('./fetch');

const MAX_ERROR_TEXT = 16 * 1024;
const MAX_CONFIG_PREVIEW = 180 * 1024;
const DNS_TIMEOUT = 7000;
const APP_PROXY_GROUP = '🚀 Proxy';
const AUTO_PROXY_GROUP = '♻️ Auto';
const FALLBACK_PROXY_GROUP = '🛟 Fallback';
let diagnosticModeQueue = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error, max = MAX_ERROR_TEXT) {
  return String((error && (error.message || error.stderr)) || error || 'Unknown error').trim().slice(0, max);
}

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run one diagnostic request in a forced core mode. Calls are serialized and
 * the mode observed from the running core is restored even if the request fails.
 */
function queueDiagnostic(operation) {
  const task = diagnosticModeQueue.then(operation);
  diagnosticModeQueue = task.catch(() => {});
  return task;
}

async function setDiagnosticMode(context, mode) {
  const expected = String(mode).toLowerCase();
  await context.core.clashApi('PATCH', '/configs', { mode });

  // PATCH may return before the core has swapped its routing mode. A request
  // started in that window is especially visible in system-proxy mode, where
  // the direct and proxied probes can otherwise report the same route.
  for (let attempt = 0; attempt < 5; attempt++) {
    const config = await context.core.clashApi('GET', '/configs');
    const actual = String(config && config.mode || '').toLowerCase();
    if (!actual || actual === expected) return;
    await delay(35 * (attempt + 1));
  }
  throw new Error(`core mode did not switch to ${mode}`);
}

async function restoreDiagnosticMode(context, diagnosticMode, runtimeMode, modeRevision) {
  const userChangedMode = modeRevision !== null && context.core.getModeRevision() !== modeRevision;
  if (userChangedMode) return;
  let currentMode = diagnosticMode;
  try {
    const current = await context.core.clashApi('GET', '/configs');
    currentMode = String(current && current.mode || diagnosticMode).toLowerCase();
  } catch (_) {
    /* Restore when an older or temporarily unavailable API cannot report mode. */
  }
  if (currentMode === diagnosticMode) await setDiagnosticMode(context, runtimeMode);
}

function withDiagnosticMode(context, mode, operation) {
  return queueDiagnostic(async () => {
    const settings = context.state.store.getSettings();
    const proxyPort = context.core.currentProxyPort();
    if (!context.state.singbox.isRunning() || !proxyPort) return operation(0, false);
    if (!settings.enableClashApi) throw new Error('enable Clash API to run forced-mode diagnostics');

    let runtimeMode = settings.clashMode || 'rule';
    const modeRevision = typeof context.core.getModeRevision === 'function'
      ? context.core.getModeRevision()
      : null;
    try {
      const config = await context.core.clashApi('GET', '/configs');
      runtimeMode = String(config && config.mode || runtimeMode).toLowerCase();
    } catch (_) {
      /* PATCH below still works on cores that omit mode from GET /configs. */
    }
    const changedMode = runtimeMode !== mode;
    if (changedMode) {
      try {
        await setDiagnosticMode(context, mode);
      } catch (error) {
        try {
          await restoreDiagnosticMode(context, mode, runtimeMode, modeRevision);
        } catch (restoreError) {
          error.restoreError = restoreError;
        }
        throw error;
      }
    }
    let operationError = null;
    try {
      return await operation(proxyPort, true);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (changedMode) {
        try {
          await restoreDiagnosticMode(context, mode, runtimeMode, modeRevision);
        } catch (restoreError) {
          if (operationError) operationError.restoreError = restoreError;
          else throw restoreError;
        }
      }
    }
  });
}

async function withMihomoGlobalSelector(context, operation) {
  const manager = context.state.singbox;
  if (!manager || typeof manager.getCoreType !== 'function' || manager.getCoreType() !== 'mihomo') {
    return operation();
  }
  const path = '/proxies/' + encodeURIComponent('GLOBAL');
  const group = await context.core.clashApi('GET', path);
  const previous = group && group.now;
  const target = APP_PROXY_GROUP;
  if (!previous || (Array.isArray(group.all) && !group.all.includes(target))) {
    throw new Error('mihomo GLOBAL group does not expose the app proxy selector');
  }
  return withTemporarySelector(context, path, previous, target, operation);
}

async function restoreTemporarySelector(context, path, previous, target) {
  // Do not overwrite a user selection made from another panel while the
  // diagnostic was running; only undo the temporary value we still own.
  const current = await context.core.clashApi('GET', path);
  if (current && current.now === target) {
    await context.core.clashApi('PUT', path, { name: previous });
  }
}

async function withTemporarySelector(context, path, previous, target, operation) {
  if (previous === target) return operation();
  try {
    await context.core.clashApi('PUT', path, { name: target });
  } catch (error) {
    try {
      await restoreTemporarySelector(context, path, previous, target);
    } catch (restoreError) {
      error.restoreError = restoreError;
    }
    throw error;
  }

  let operationError = null;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await restoreTemporarySelector(context, path, previous, target);
    } catch (restoreError) {
      if (operationError) operationError.restoreError = restoreError;
      else throw restoreError;
    }
  }
}

function usableProxySelection(group, preferred) {
  const all = Array.isArray(group && group.all) ? group.all : [];
  const candidates = [preferred, AUTO_PROXY_GROUP, FALLBACK_PROXY_GROUP, ...all];
  return candidates.find((name) =>
    typeof name === 'string' &&
    !/^direct$/i.test(name) &&
    all.includes(name)
  ) || null;
}

async function withAppProxySelector(context, operation) {
  const path = '/proxies/' + encodeURIComponent(APP_PROXY_GROUP);
  const group = await context.core.clashApi('GET', path);
  if (!group || typeof group.now !== 'string' || !Array.isArray(group.all)) return operation();

  const previous = group.now;
  if (!/^direct$/i.test(previous)) return operation();

  const preferred = context.state.store.get('selected');
  const target = usableProxySelection(group, preferred);
  if (!target) throw new Error('the app proxy group has no usable proxy outbound');

  return withTemporarySelector(context, path, previous, target, operation);
}

function withForcedProxy(context, operation) {
  return withDiagnosticMode(context, 'global', (proxyPort, forced) => {
    if (!forced) return operation(proxyPort, false);
    return withAppProxySelector(context, () =>
      withMihomoGlobalSelector(context, () => operation(proxyPort, true))
    );
  });
}

function normalizeTarget(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2048) throw new Error('invalid domain or IP');
  let host = raw;
  let port = null;
  if (!net.isIP(host.replace(/^\[|\]$/g, ''))) {
    try {
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
      const url = new URL(hasScheme ? raw : 'http://' + raw);
      host = url.hostname.replace(/^\[|\]$/g, '');
      const defaultPort = { 'http:': 80, 'https:': 443, 'socks:': 1080, 'socks5:': 1080 }[url.protocol];
      port = url.port ? Number(url.port) : hasScheme && defaultPort ? defaultPort : null;
    } catch (_) {
      throw new Error('invalid domain or IP');
    }
  } else {
    host = host.replace(/^\[|\]$/g, '');
  }
  host = host.replace(/\.$/, '').toLowerCase();
  const ipVersion = net.isIP(host);
  if (!ipVersion) {
    if (host.length > 253 || !host.includes('.') && host !== 'localhost') throw new Error('invalid domain');
    const labels = host.split('.');
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/i.test(label) || /^-|-$/.test(label))) {
      throw new Error('invalid domain');
    }
  }
  return { input: raw, host, port, ipVersion };
}

function ipv6Groups(address) {
  let value = String(address).split('%')[0].toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const octets = value.slice(lastColon + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    value = value.slice(0, lastColon) + ':' + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
}

function ipToBigInt(address) {
  const version = net.isIP(address);
  if (version === 4) {
    return { version, bits: 32, value: address.split('.').reduce((out, octet) => (out << 8n) | BigInt(octet), 0n) };
  }
  if (version === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return null;
    return { version, bits: 128, value: groups.reduce((out, group) => (out << 16n) | BigInt(group), 0n) };
  }
  return null;
}

function cidrContains(address, cidr) {
  const [network, prefixText] = String(cidr || '').split('/');
  const ip = ipToBigInt(address);
  const base = ipToBigInt(network);
  if (!ip || !base || ip.version !== base.version) return false;
  const prefix = prefixText === undefined ? ip.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return false;
  if (prefix === 0) return true;
  const shift = BigInt(ip.bits - prefix);
  return (ip.value >> shift) === (base.value >> shift);
}

function isPrivateIp(address) {
  const privateCidrs = net.isIP(address) === 6
    ? ['::1/128', 'fc00::/7', 'fe80::/10']
    : ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];
  return privateCidrs.some((cidr) => cidrContains(address, cidr));
}

function normalizeRuleType(type) {
  const normalized = String(type || '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toUpperCase();
  return {
    DOMAINSUFFIX: 'DOMAIN-SUFFIX',
    DOMAINKEYWORD: 'DOMAIN-KEYWORD',
    IPCIDR: 'IP-CIDR',
    IPCIDR6: 'IP-CIDR6',
    RULESET: 'RULE-SET',
  }[normalized.replace(/-/g, '')] || normalized;
}

function normalizeClashRule(rule) {
  if (typeof rule === 'string') {
    const parts = rule.split(',').map((part) => part.trim());
    const type = normalizeRuleType(parts[0]);
    if (type === 'MATCH' || type === 'FINAL') {
      return { type, payload: '', target: parts[1] || '', raw: rule };
    }
    return { type, payload: parts[1] || '', target: parts[2] || '', raw: rule };
  }
  if (!rule || typeof rule !== 'object') return null;
  return {
    type: normalizeRuleType(rule.type),
    payload: String(rule.payload || ''),
    target: String(rule.proxy || rule.outbound || (rule.action === 'reject' ? 'REJECT' : '')),
    raw: rule,
  };
}

function domainSuffixMatch(host, value) {
  const suffix = String(value || '').replace(/^\+?\.?/, '').toLowerCase();
  return !!suffix && (host === suffix || host.endsWith('.' + suffix));
}

function matchClashRule(rule, target, addresses) {
  const item = normalizeClashRule(rule);
  if (!item) return false;
  const value = item.payload.toLowerCase();
  switch (item.type) {
    case 'DOMAIN': return target.host === value;
    case 'DOMAIN-SUFFIX': return domainSuffixMatch(target.host, value);
    case 'DOMAIN-KEYWORD': return !!value && target.host.includes(value);
    case 'IP-CIDR':
    case 'IP-CIDR6': return addresses.length ? addresses.some((address) => cidrContains(address, item.payload)) : null;
    case 'DST-PORT': return target.port !== null && Number(value) === target.port;
    case 'MATCH':
    case 'FINAL': return true;
    case 'GEOIP':
    case 'GEOSITE':
    case 'RULE-SET':
    case 'DOMAIN-REGEX': return null;
    case 'PROCESS-NAME':
    case 'PROCESS-PATH':
    case 'SRC-IP-CIDR':
    case 'SRC-PORT': return false;
    default: return item.type ? null : false;
  }
}

function arrayValue(value) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

const SINGBOX_RULE_KEYS = new Set([
  'action', 'outbound', 'invert', 'type', 'mode', 'rules', 'clash_mode',
  'domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'ip_is_private',
  'port', 'protocol', 'rule_set',
]);

function matchSingboxRule(rule, target, addresses, clashMode) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.type === 'logical') {
    const results = arrayValue(rule.rules).map((child) => matchSingboxRule(child, target, addresses, clashMode));
    if (!results.length) return false;
    const result = String(rule.mode).toLowerCase() === 'or'
      ? (results.includes(true) ? true : results.includes(null) ? null : false)
      : (results.includes(false) ? false : results.includes(null) ? null : true);
    return result === null ? null : rule.invert ? !result : result;
  }
  if (rule.action && rule.action !== 'reject' && !rule.outbound) return false;
  const checks = [];
  if (rule.clash_mode !== undefined) checks.push(String(rule.clash_mode).toLowerCase() === String(clashMode).toLowerCase());
  if (rule.domain !== undefined) checks.push(arrayValue(rule.domain).some((v) => target.host === String(v).toLowerCase()));
  if (rule.domain_suffix !== undefined) checks.push(arrayValue(rule.domain_suffix).some((v) => domainSuffixMatch(target.host, v)));
  if (rule.domain_keyword !== undefined) checks.push(arrayValue(rule.domain_keyword).some((v) => target.host.includes(String(v).toLowerCase())));
  if (rule.ip_cidr !== undefined) checks.push(addresses.length
    ? addresses.some((address) => arrayValue(rule.ip_cidr).some((cidr) => cidrContains(address, cidr)))
    : null);
  if (rule.ip_is_private !== undefined) checks.push(addresses.length ? addresses.some(isPrivateIp) === !!rule.ip_is_private : null);
  if (rule.port !== undefined) checks.push(target.port !== null && arrayValue(rule.port).map(Number).includes(target.port));
  if (rule.protocol !== undefined) checks.push(null);
  if (rule.rule_set !== undefined) checks.push(null);
  if (Object.keys(rule).some((key) => !SINGBOX_RULE_KEYS.has(key))) checks.push(null);
  if (!checks.length) return false;
  if (checks.includes(false)) return rule.invert ? true : false;
  if (checks.includes(null)) return null;
  return rule.invert ? false : true;
}

function describeSingboxRule(rule) {
  if (rule.type === 'logical') {
    return {
      type: 'LOGICAL',
      payload: `${String(rule.mode || 'and').toUpperCase()} (${arrayValue(rule.rules).length})`,
      target: rule.action === 'reject' ? 'REJECT' : String(rule.outbound || rule.action || ''),
      raw: rule,
    };
  }
  const fields = ['clash_mode', 'domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'ip_is_private', 'rule_set', 'port'];
  const field = fields.find((key) => rule[key] !== undefined) || 'rule';
  return {
    type: field.replace(/_/g, '-').toUpperCase(),
    payload: arrayValue(rule[field]).map(String).join(', '),
    target: rule.action === 'reject' ? 'REJECT' : String(rule.outbound || rule.action || ''),
    raw: rule,
  };
}

async function resolveHost(target) {
  if (target.ipVersion) return { addresses: [target.host], error: null };
  try {
    const rows = await withTimeout(dns.promises.lookup(target.host, { all: true, verbatim: true }), 5000, 'DNS lookup');
    return { addresses: [...new Set(rows.map((row) => row.address))], error: null };
  } catch (error) {
    return { addresses: [], error: errorText(error) };
  }
}

function modePolicy(mode) {
  if (mode === 'direct') return 'DIRECT';
  if (mode === 'global') return '🚀 Proxy';
  if (mode === 'block') return 'REJECT';
  return null;
}

async function resolveOutboundChain(policy, context) {
  const normalized = /^(DIRECT|REJECT)$/i.test(policy || '') ? String(policy).toUpperCase() : String(policy || '🚀 Proxy');
  const chain = [normalized];
  if (!context.state.singbox.isRunning() || /^(DIRECT|REJECT)$/.test(normalized)) return chain;
  let current = normalized;
  for (let i = 0; i < 8; i++) {
    try {
      const info = await context.core.clashApi('GET', '/proxies/' + encodeURIComponent(current));
      const next = info && typeof info.now === 'string' ? info.now : null;
      if (!next || next === current || chain.includes(next)) break;
      chain.push(next);
      current = next;
    } catch (_) {
      break;
    }
  }
  return chain;
}

function dnsPathFor(config, settings, policy, target) {
  if (target.ipVersion) {
    return { resolver: 'none', server: null, detour: null, skipped: true, confidence: 'exact' };
  }
  const direct = /^DIRECT$/i.test(policy || '') || settings.clashMode === 'direct';
  if (settings.coreType === 'mihomo') {
    if (!settings.enableTun || !config.dns) {
      return { resolver: 'system', server: 'System DNS', detour: 'system', confidence: 'exact' };
    }
    const servers = direct ? config.dns['direct-nameserver'] : config.dns.nameserver;
    return {
      resolver: direct ? 'direct-nameserver' : 'nameserver',
      server: arrayValue(servers)[0] || (direct ? settings.dnsLocal : settings.dnsRemote),
      detour: direct ? 'DIRECT' : '🚀 Proxy',
      confidence: 'estimated',
    };
  }
  return {
    resolver: direct ? 'local-dns' : 'proxy-dns',
    server: direct ? settings.dnsLocal : settings.dnsRemote,
    detour: direct ? 'direct' : '🚀 Proxy',
    confidence: settings.clashMode === 'rule' ? 'estimated' : 'exact',
  };
}

async function inspectRoute(value, context) {
  const target = normalizeTarget(value);
  const resolved = await resolveHost(target);
  const built = context.core.buildCurrentConfig();
  const { config } = built;
  let settings = built.settings;
  if (context.state.singbox.isRunning() && settings.enableClashApi) {
    try {
      const runtime = await context.core.clashApi('GET', '/configs');
      const runtimeMode = String(runtime && runtime.mode || '').toLowerCase();
      if (['rule', 'global', 'direct', 'block'].includes(runtimeMode)) {
        settings = { ...settings, clashMode: runtimeMode };
      }
    } catch (_) {
      /* Persisted mode is the best available fallback. */
    }
  }
  const forcedPolicy = modePolicy(settings.clashMode);
  let source = 'generated';
  let entries = [];
  // Mihomo exposes structured Clash rules. sing-box flattens route rules into
  // `DEFAULT: field=value` entries, which cannot be matched reliably; its
  // generated config below retains the original structured matcher fields.
  if (!forcedPolicy && settings.coreType === 'mihomo' && context.state.singbox.isRunning() && settings.enableClashApi) {
    try {
      const live = await context.core.clashApi('GET', '/rules');
      if (Array.isArray(live.rules) && live.rules.length) {
        source = 'live';
        entries = live.rules.map((rule) => ({ kind: 'clash', rule }));
      }
    } catch (_) {
      /* use the generated config */
    }
  }
  if (!entries.length && !forcedPolicy) {
    entries = settings.coreType === 'mihomo'
      ? (config.rules || []).map((rule) => ({ kind: 'clash', rule }))
      : (((config.route || {}).rules) || []).map((rule) => ({ kind: 'sing-box', rule }));
  }

  const unresolved = [];
  let matched = null;
  let policy = forcedPolicy;
  if (forcedPolicy) {
    matched = { type: 'MODE', payload: settings.clashMode, target: forcedPolicy, index: -1 };
  } else {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const normalized = entry.kind === 'clash' ? normalizeClashRule(entry.rule) : describeSingboxRule(entry.rule);
      const result = entry.kind === 'clash'
        ? matchClashRule(entry.rule, target, resolved.addresses)
        : matchSingboxRule(entry.rule, target, resolved.addresses, settings.clashMode);
      if (result === null) {
        if (unresolved.length < 8) unresolved.push({ index, type: normalized.type, payload: normalized.payload });
        continue;
      }
      if (result && normalized.target) {
        matched = { ...normalized, raw: undefined, index };
        policy = normalized.target;
        break;
      }
    }
  }
  if (!policy) policy = settings.coreType === 'sing-box' ? ((config.route || {}).final || '🚀 Proxy') : '🚀 Proxy';
  if (!matched) matched = { type: 'FINAL', payload: '', target: policy, index: entries.length };
  const chain = await resolveOutboundChain(policy, context);
  return {
    target,
    addresses: resolved.addresses,
    dnsError: resolved.error,
    source,
    matchedRule: matched,
    policy,
    chain,
    finalOutbound: chain[chain.length - 1],
    dnsPath: dnsPathFor(config, settings, policy, target),
    confidence: unresolved.length || resolved.error ? 'estimated' : 'exact',
    unresolvedBeforeMatch: unresolved,
  };
}

function tcpProbe(host, port, timeout = 1800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (open, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, error, durationMs: Date.now() - started });
    };
    socket.setTimeout(timeout, () => done(false, 'timeout'));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => done(false, error.code || error.message));
  });
}

function execFileText(command, args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim()));
      resolve(String(stdout || '').trim());
    });
  });
}

async function portOwner(port) {
  try {
    if (process.platform === 'win32') {
      const script = [
        `$c=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
        'if($c){',
        '$n=(Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName',
        'Write-Output ($c.OwningProcess.ToString()+"|"+$n)',
        '}',
      ].join(';');
      const out = await execFileText('powershell', ['-NoProfile', '-Command', script]);
      if (!out) return null;
      const [pid, name] = out.split('|');
      return { pid: Number(pid) || null, name: name || '' };
    }
    if (process.platform === 'darwin') {
      const out = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpct']);
      const pid = Number((out.match(/^p(\d+)/m) || [])[1]) || null;
      const name = (out.match(/^c(.+)/m) || [])[1] || '';
      return pid || name ? { pid, name } : null;
    }
    const out = await execFileText('ss', ['-ltnp', `sport = :${port}`]);
    const match = out.match(/users:\(\("([^"]+)",pid=(\d+)/);
    return match ? { pid: Number(match[2]), name: match[1] } : null;
  } catch (_) {
    return null;
  }
}

function parsePorts(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const ports = [...new Set(raw.filter((v) => String(v).trim()).map(Number))];
  if (!ports.length || ports.length > 20 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('enter 1 to 20 valid ports');
  }
  return ports;
}

async function inspectPorts(value, context) {
  const ports = parsePorts(value);
  const settings = context.state.store.getSettings();
  const running = context.state.singbox.isRunning();
  const corePid = context.state.singbox.proc && context.state.singbox.proc.pid;
  return Promise.all(ports.map(async (port) => {
    const probe = await tcpProbe('127.0.0.1', port);
    const owner = probe.open ? await portOwner(port) : null;
    const role = port === settings.mixedPort ? 'mixed' : port === settings.clashApiPort ? 'clash-api' : 'custom';
    const expected = running && (role === 'mixed' || (role === 'clash-api' && settings.enableClashApi));
    const ours = !!(owner && corePid && owner.pid === corePid);
    return {
      port,
      role,
      listening: probe.open,
      expected,
      conflict: probe.open && !ours && (!expected || !!owner),
      owner,
      durationMs: probe.durationMs,
    };
  }));
}

function encodeDnsName(host) {
  const chunks = [];
  let wireLength = 1;
  for (const label of host.split('.')) {
    const bytes = Buffer.from(label, 'ascii');
    if (!bytes.length || bytes.length > 63) throw new Error('invalid DNS name');
    wireLength += bytes.length + 1;
    if (wireLength > 255) throw new Error('DNS name is too long');
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function buildDnsQuery(host, type = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(crypto.randomInt(0, 65536), 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeDnsName(host), tail]);
}

function readDnsName(buffer, start, depth = 0) {
  if (depth > 12) throw new Error('invalid DNS compression');
  if (!Number.isInteger(start) || start < 0 || start >= buffer.length) throw new Error('invalid DNS name offset');
  const labels = [];
  let offset = start;
  let next = start;
  let jumped = false;
  let terminated = false;
  while (offset < buffer.length) {
    const length = buffer[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) throw new Error('truncated DNS name');
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      const nested = readDnsName(buffer, pointer, depth + 1);
      labels.push(nested.name);
      if (!jumped) next = offset + 2;
      jumped = true;
      terminated = true;
      break;
    }
    offset += 1;
    if (length === 0) {
      if (!jumped) next = offset;
      terminated = true;
      break;
    }
    if (offset + length > buffer.length) throw new Error('truncated DNS label');
    labels.push(buffer.slice(offset, offset + length).toString('ascii'));
    offset += length;
    if (!jumped) next = offset;
  }
  if (!terminated) throw new Error('unterminated DNS name');
  return { name: labels.filter(Boolean).join('.'), next };
}

function formatIpv6(buffer) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(buffer.readUInt16BE(i).toString(16));
  return groups.join(':');
}

function parseDnsMessage(buffer, expectedId = null) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('invalid DNS response');
  if (expectedId !== null && buffer.readUInt16BE(0) !== expectedId) throw new Error('DNS response id mismatch');
  const flags = buffer.readUInt16BE(2);
  if (!(flags & 0x8000)) throw new Error('DNS packet is not a response');
  const rcode = flags & 0x000f;
  if (rcode !== 0) throw new Error('DNS server returned code ' + rcode);
  const questions = buffer.readUInt16BE(4);
  const answers = buffer.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i++) {
    offset = readDnsName(buffer, offset).next + 4;
    if (offset > buffer.length) throw new Error('truncated DNS question');
  }
  const records = [];
  for (let i = 0; i < answers; i++) {
    const owner = readDnsName(buffer, offset);
    offset = owner.next;
    if (offset + 10 > buffer.length) throw new Error('truncated DNS answer');
    const type = buffer.readUInt16BE(offset);
    const ttl = buffer.readUInt32BE(offset + 4);
    const length = buffer.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    if (dataOffset + length > buffer.length) throw new Error('truncated DNS data');
    let value = null;
    if (type === 1 && length === 4) value = [...buffer.slice(dataOffset, dataOffset + 4)].join('.');
    else if (type === 28 && length === 16) value = formatIpv6(buffer.slice(dataOffset, dataOffset + 16));
    else if (type === 5) value = readDnsName(buffer, dataOffset).name;
    if (value) records.push({ type: type === 1 ? 'A' : type === 28 ? 'AAAA' : 'CNAME', value, ttl });
    offset = dataOffset + length;
  }
  return records;
}

function dnsEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('DNS server is empty');
  const rawIpVersion = net.isIP(raw);
  if (rawIpVersion) {
    const endpointUrl = rawIpVersion === 6 ? `udp://[${raw}]:53` : `udp://${raw}:53`;
    return { raw, scheme: 'udp', host: raw, port: 53, url: new URL(endpointUrl) };
  }
  const unbracketed = raw.match(/^([a-z0-9]+):\/\/(.+)$/i);
  const unbracketedRest = unbracketed && unbracketed[2];
  const unbracketedSlash = unbracketedRest ? unbracketedRest.indexOf('/') : -1;
  const unbracketedHost = unbracketedRest
    ? unbracketedRest.slice(0, unbracketedSlash < 0 ? undefined : unbracketedSlash)
    : '';
  if (unbracketed && net.isIP(unbracketedHost) === 6) {
    const scheme = unbracketed[1].toLowerCase();
    const port = ({ udp: 53, tcp: 53, tls: 853, https: 443, h3: 443, http3: 443 }[scheme] || 0);
    const suffix = unbracketedSlash < 0 ? '' : unbracketedRest.slice(unbracketedSlash);
    return { raw, scheme, host: unbracketedHost, port, url: new URL(`${scheme}://[${unbracketedHost}]:${port}${suffix}`) };
  }
  const url = new URL(raw.includes('://') ? raw : 'udp://' + raw);
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  return {
    raw,
    scheme,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || ({ udp: 53, tcp: 53, tls: 853, https: 443, h3: 443, http3: 443 }[scheme] || 0),
    url,
  };
}

function udpDnsQuery(endpoint, packet) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIP(endpoint.host) === 6 ? 'udp6' : 'udp4');
    let settled = false;
    const finish = (error, message = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      if (error) reject(error);
      else resolve(message);
    };
    const timer = setTimeout(() => {
      finish(new Error('DNS query timed out'));
    }, DNS_TIMEOUT);
    socket.once('error', (error) => finish(error));
    socket.on('message', (message) => {
      if (message.length < 2 || message.readUInt16BE(0) !== packet.readUInt16BE(0)) return;
      finish(null, message);
    });
    socket.send(packet, endpoint.port, endpoint.host);
  });
}

async function streamDnsQuery(endpoint, packet, secure, proxyPort = 0) {
  const tunneledSocket = proxyPort
    ? await fetch.connectTunnel(endpoint.host, endpoint.port, proxyPort, DNS_TIMEOUT)
    : null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let expected = null;
    let settled = false;
    const options = tunneledSocket
      ? { socket: tunneledSocket }
      : { host: endpoint.host, port: endpoint.port };
    if (secure && !net.isIP(endpoint.host)) options.servername = endpoint.host;
    if (secure && net.isIP(endpoint.host)) {
      options.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(endpoint.host, cert);
    }
    const socket = secure ? tls.connect(options) : (tunneledSocket || net.connect(options));
    const timer = setTimeout(() => socket.destroy(new Error('DNS query timed out')), DNS_TIMEOUT);
    const connected = secure ? 'secureConnect' : 'connect';
    const send = () => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(packet.length, 0);
      socket.write(Buffer.concat([length, packet]));
    };
    if (tunneledSocket && !secure) queueMicrotask(send);
    else socket.once(connected, send);
    socket.on('data', (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (expected === null && data.length >= 2) expected = data.readUInt16BE(0);
      if (expected !== null && data.length >= expected + 2) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(data.slice(2, expected + 2));
      }
    });
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error('DNS connection closed before a complete response'));
    });
  });
}

async function dohDnsQuery(endpoint, packet, proxyPort) {
  const url = new URL(endpoint.url.toString());
  if (endpoint.scheme === 'h3' || endpoint.scheme === 'http3') url.protocol = 'https:';
  url.searchParams.set('dns', packet.toString('base64url'));
  const response = await fetch.getBuffer(url.toString(), {
    proxyPort,
    timeout: DNS_TIMEOUT,
    maxBytes: 64 * 1024,
    headers: { Accept: 'application/dns-message' },
  });
  return response.body;
}

async function queryDnsType(address, host, type, proxyPort) {
  const endpoint = dnsEndpoint(address);
  const packet = buildDnsQuery(host, type);
  let response;
  // HTTP CONNECT cannot carry UDP. The same DNS resolver must also support
  // TCP/53, so use that transport when the remote comparison is forced proxy.
  if (endpoint.scheme === 'udp') {
    response = proxyPort
      ? await streamDnsQuery(endpoint, packet, false, proxyPort)
      : await udpDnsQuery(endpoint, packet);
  } else if (endpoint.scheme === 'tcp') response = await streamDnsQuery(endpoint, packet, false, proxyPort);
  else if (endpoint.scheme === 'tls') response = await streamDnsQuery(endpoint, packet, true, proxyPort);
  else if (['https', 'h3', 'http3'].includes(endpoint.scheme)) response = await dohDnsQuery(endpoint, packet, proxyPort);
  else throw new Error(endpoint.scheme + ' DNS diagnostics are not supported');
  return parseDnsMessage(response, packet.readUInt16BE(0));
}

async function queryConfiguredDns(address, host, proxyPort = 0) {
  const started = Date.now();
  const settled = await Promise.allSettled([
    queryDnsType(address, host, 1, proxyPort),
    queryDnsType(address, host, 28, proxyPort),
  ]);
  const records = settled.filter((item) => item.status === 'fulfilled').flatMap((item) => item.value);
  if (!records.length && settled.every((item) => item.status === 'rejected')) {
    throw settled[0].reason;
  }
  const answers = [...new Set(records.filter((record) => record.type !== 'CNAME').map((record) => record.value))];
  if (!answers.length) throw new Error('DNS returned no address records');
  return {
    answers,
    records,
    durationMs: Date.now() - started,
  };
}

async function querySystemDns(host) {
  const started = Date.now();
  // dns.resolve* uses c-ares and sends its own UDP packets. On Windows those
  // packets can be blocked by strict-route while TUN is active even though the
  // Windows DNS Client is healthy. dns.lookup delegates to GetAddrInfoW, which
  // is the actual system-resolver path this row is intended to measure.
  const records = await withTimeout(
    dns.promises.lookup(host, { all: true, verbatim: true }),
    DNS_TIMEOUT,
    'system DNS'
  );
  const answers = [...new Set((records || []).map((record) => record.address).filter((address) => net.isIP(address)))];
  if (!answers.length) throw new Error('system DNS returned no addresses');
  return { answers, durationMs: Date.now() - started };
}

function assessDnsResults(results) {
  const successful = results.filter((result) => result.status === 'pass' && result.answers.length);
  const suspicious = [...new Set(successful.flatMap((result) => result.answers).filter((address) => {
    if (!net.isIP(address)) return false;
    return isPrivateIp(address) || cidrContains(address, '0.0.0.0/8') || cidrContains(address, '224.0.0.0/4') || address === '::';
  }))];
  if (suspicious.length) {
    return { status: 'warn', result: 'suspicious-private', values: suspicious };
  }
  if (successful.length < 2) return { status: 'skip', result: 'inconclusive', values: [] };

  const baseline = successful.find((result) => result.id === 'remote') || successful[0];
  const baselineSet = new Set(baseline.answers);
  const comparable = successful.filter((result) => result !== baseline);
  const divergent = comparable.filter((result) => !result.answers.some((answer) => baselineSet.has(answer)));
  if (divergent.length) {
    return { status: 'warn', result: 'divergent', values: divergent.map((result) => result.id) };
  }
  return { status: 'pass', result: 'no-anomaly', values: [] };
}

async function dnsComparison(value, context) {
  const target = normalizeTarget(value);
  if (target.ipVersion) throw new Error('enter a domain name for DNS comparison');
  const settings = context.state.store.getSettings();
  const proxyPort = context.core.currentProxyPort();
  const systemProbe = { id: 'system', address: 'System DNS', via: 'system', run: () => querySystemDns(target.host) };
  const localProbe = { id: 'local', address: settings.dnsLocal, via: 'direct', run: () => queryConfiguredDns(settings.dnsLocal, target.host, 0) };
  const remoteProbe = {
    id: 'remote',
    address: settings.dnsRemote,
    via: proxyPort ? 'proxy' : 'direct',
    run: () => proxyPort
      ? withForcedProxy(context, (forcedPort, forced) => {
          if (!forced) throw new Error('core stopped before the proxy DNS probe');
          return queryConfiguredDns(settings.dnsRemote, target.host, forcedPort);
        })
      : queryConfiguredDns(settings.dnsRemote, target.host, 0),
  };
  const runProbe = async (probe) => {
    try {
      return { id: probe.id, address: probe.address, via: probe.via, status: 'pass', ...(await probe.run()) };
    } catch (error) {
      return { id: probe.id, address: probe.address, via: probe.via, status: 'fail', answers: [], error: errorText(error) };
    }
  };
  let results;
  if (proxyPort && settings.enableTun) {
    // Keep the system resolver in the user's current mode. Forcing it to Direct
    // can make a blocked public resolver time out in mainland China. The local
    // and remote comparisons still run in explicit Direct/Global modes, and all
    // three are serialized so one temporary mode cannot leak into another.
    const systemResultPromise = queueDiagnostic(() => runProbe(systemProbe));
    const localResultPromise = withDiagnosticMode(context, 'direct', () => runProbe(localProbe));
    const remoteResultPromise = runProbe(remoteProbe);
    results = await Promise.all([systemResultPromise, localResultPromise, remoteResultPromise]);
  } else {
    results = await Promise.all([systemProbe, localProbe, remoteProbe].map(runProbe));
  }
  return { host: target.host, results, assessment: assessDnsResults(results) };
}

async function externalIp(proxyPort) {
  const started = Date.now();
  const urls = ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json'];
  let lastError;
  for (const url of urls) {
    try {
      const { body } = await fetch.getBuffer(url, { proxyPort, timeout: 8000, maxBytes: 4096 });
      const text = body.toString('utf-8').trim();
      let ip = text;
      try { ip = JSON.parse(text).ip || text; } catch (_) {}
      if (!net.isIP(ip)) throw new Error('invalid IP response');
      return { ip, durationMs: Date.now() - started };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('external IP check failed');
}

function tunInterfaces() {
  return Object.keys(os.networkInterfaces()).filter((name) => /(?:^|\b)(?:utun|tun|wintun|mihomo|sing-box|dart|meta)/i.test(name));
}

async function networkDiagnostics(context) {
  const settings = context.state.store.getSettings();
  const running = context.state.singbox.isRunning();
  const server = `127.0.0.1:${settings.mixedPort}`;
  const dnsCheck = running && settings.enableTun
    ? queueDiagnostic(() => querySystemDns('www.gstatic.com'))
    : querySystemDns('www.gstatic.com');
  const [mixed, apiPort, dnsProbe, directIp, proxiedIp, apiProbe, systemProxy, admin] = await Promise.all([
    tcpProbe('127.0.0.1', settings.mixedPort),
    tcpProbe('127.0.0.1', settings.clashApiPort),
    dnsCheck.catch((error) => ({ error: errorText(error) })),
    (running && settings.enableTun
      ? withDiagnosticMode(context, 'direct', () => externalIp(0))
      : externalIp(0)
    ).catch((error) => ({ error: errorText(error) })),
    running
      ? withForcedProxy(context, (proxyPort, forced) => {
          if (!forced) throw new Error('core stopped before the proxy egress probe');
          return externalIp(proxyPort);
        }).catch((error) => ({ error: errorText(error) }))
      : Promise.resolve({ skipped: true }),
    running && settings.enableClashApi
      ? context.core.clashApi('GET', '/version').then((value) => ({ value })).catch((error) => ({ error: errorText(error) }))
      : Promise.resolve({ skipped: true }),
    process.platform === 'win32' ? context.proxy.isSystemProxyActive(server).catch(() => false) : Promise.resolve(null),
    context.isAdmin().catch(() => false),
  ]);

  const checks = [];
  const add = (id, status, detail, durationMs = null, data = null) => checks.push({ id, status, detail, durationMs, data });
  const installed = context.state.singbox.isCoreInstalled();
  const version = installed ? await context.state.singbox.getCoreVersion().catch(() => null) : null;
  add('coreInstalled', installed ? 'pass' : 'fail', installed ? `${context.state.singbox.coreLabel} ${version ? 'v' + version : ''}`.trim() : 'core not installed');
  add('coreRunning', running ? 'pass' : 'warn', running ? 'running' : 'stopped');
  add('mixedPort', running ? (mixed.open ? 'pass' : 'fail') : (mixed.open ? 'warn' : 'skip'), mixed.open ? `127.0.0.1:${settings.mixedPort} listening` : `127.0.0.1:${settings.mixedPort} closed`, mixed.durationMs);
  add('apiPort', settings.enableClashApi ? (running ? (apiPort.open ? 'pass' : 'fail') : 'skip') : 'skip', settings.enableClashApi ? (apiPort.open ? `127.0.0.1:${settings.clashApiPort} listening` : `127.0.0.1:${settings.clashApiPort} closed`) : 'disabled', apiPort.durationMs);
  add('clashApi', apiProbe.skipped ? 'skip' : apiProbe.error ? 'fail' : 'pass', apiProbe.skipped ? 'not running or disabled' : apiProbe.error || 'API authenticated');
  add('systemProxy', process.platform !== 'win32' ? 'skip' : stateStatus(systemProxy, stateExpected(context.state.systemProxyOn)), process.platform !== 'win32' ? 'Windows only' : systemProxy ? server : 'not active');

  const interfaces = tunInterfaces();
  if (!settings.enableTun) add('tun', 'skip', 'disabled');
  else add('tun', running && interfaces.length ? 'pass' : running ? 'warn' : 'fail', interfaces.length ? interfaces.join(', ') : `configured; adapter not detected; admin=${admin}`);
  add('dns', dnsProbe.error ? 'fail' : 'pass', dnsProbe.error || (dnsProbe.answers || []).join(', '), dnsProbe.durationMs || null);
  add('directIp', directIp.error ? 'fail' : 'pass', directIp.error || directIp.ip, directIp.durationMs || null, directIp.ip ? { ip: directIp.ip } : null);
  add('proxyIp', proxiedIp.skipped ? 'skip' : proxiedIp.error ? 'fail' : 'pass', proxiedIp.skipped ? 'core stopped' : proxiedIp.error || proxiedIp.ip, proxiedIp.durationMs || null, proxiedIp.ip ? { ip: proxiedIp.ip } : null);
  if (directIp.ip && proxiedIp.ip && directIp.ip === proxiedIp.ip) add('egressCompare', 'warn', 'direct and proxy egress IPs are identical');
  else if (directIp.ip && proxiedIp.ip) add('egressCompare', 'pass', `${directIp.ip} → ${proxiedIp.ip}`);

  const summary = checks.reduce((out, check) => {
    out[check.status] = (out[check.status] || 0) + 1;
    return out;
  }, {});
  return { generatedAt: new Date().toISOString(), coreType: settings.coreType, checks, summary };
}

function stateExpected(expected) {
  return !!expected;
}

function stateStatus(actual, expected) {
  if (actual === expected) return 'pass';
  return expected ? 'fail' : actual ? 'warn' : 'pass';
}

function configText(coreType, config) {
  return coreType === 'mihomo'
    ? yaml.dump(config, { lineWidth: -1, noRefs: true })
    : JSON.stringify(config, null, 2);
}

function configSummary(coreType, config, sourceNodes, sourceRules, text) {
  const generatedNodes = coreType === 'mihomo'
    ? (config.proxies || []).length
    : (config.outbounds || []).filter((item) => !['selector', 'urltest', 'direct'].includes(item.type)).length;
  const rules = coreType === 'mihomo' ? (config.rules || []).length : (((config.route || {}).rules) || []).length;
  return {
    format: coreType === 'mihomo' ? 'YAML' : 'JSON',
    sourceNodes,
    generatedNodes,
    droppedNodes: Math.max(0, sourceNodes - generatedNodes),
    sourceRules,
    generatedRules: rules,
    tun: coreType === 'mihomo' ? !!(config.tun && config.tun.enable) : (config.inbounds || []).some((item) => item.type === 'tun'),
    dns: !!config.dns,
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').length,
  };
}

function extractErrorLocation(message) {
  const text = errorText(message);
  const line = Number((text.match(/\bline\s+(\d+)/i) || text.match(/\((\d+):(\d+)\)/) || [])[1]) || null;
  const column = Number((text.match(/\bcol(?:umn)?\s+(\d+)/i) || text.match(/\(\d+:(\d+)\)/) || [])[1]) || null;
  const pathMatch =
    text.match(/(?:path|field)\s*[=:]\s*([^\s,;]+)/i) ||
    text.match(/\b((?:route|dns|inbounds|outbounds|experimental|rules|proxies|proxy-groups)(?:\.[\w-]+|\[\d+\])+)/i) ||
    text.match(/\b((?:rules|proxies|proxy-groups)\[\d+\])/i);
  return { line, column, path: pathMatch ? pathMatch[1] : null };
}

async function checkAllConfigs(context) {
  const active = context.state.store.getSubscription(context.core.getActiveSubId(), { includeRaw: true });
  const sourceNodes = active && Array.isArray(active.nodes) ? active.nodes.length : 0;
  const sourceRules = active && Array.isArray(active.clashRules) ? active.clashRules.length : 0;
  const sourceText = active && typeof active.raw === 'string' ? active.raw : '';
  const results = [];
  for (const coreType of ['sing-box', 'mihomo']) {
    try {
      if (coreType === 'mihomo') await context.state.singbox.validateMihomoGeoData();
      const { config } = context.core.buildCurrentConfig(coreType);
      const text = configText(coreType, config);
      const installed = context.state.singbox.isCoreInstalled(coreType);
      let validation = { status: 'missing', message: coreType + ' core not installed', location: null };
      if (installed) {
        try {
          const checked = await context.state.singbox.checkConfigFor(coreType, config);
          validation = { status: 'pass', message: checked.output || 'configuration is valid', location: null };
        } catch (error) {
          const message = errorText(error);
          validation = { status: 'fail', message, location: extractErrorLocation(message) };
        }
      }
      results.push({
        coreType,
        installed,
        validation,
        summary: configSummary(coreType, config, sourceNodes, sourceRules, text),
        preview: text.slice(0, MAX_CONFIG_PREVIEW),
        truncated: text.length > MAX_CONFIG_PREVIEW,
      });
    } catch (error) {
      const message = errorText(error);
      results.push({ coreType, installed: context.state.singbox.isCoreInstalled(coreType), validation: { status: 'fail', message, location: extractErrorLocation(message) }, summary: null, preview: '', truncated: false });
    }
  }
  return {
    source: {
      name: active ? active.name : '',
      format: active ? active.format : '',
      nodes: sourceNodes,
      rules: sourceRules,
      preview: sourceText.slice(0, MAX_CONFIG_PREVIEW),
      truncated: sourceText.length > MAX_CONFIG_PREVIEW,
    },
    results,
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildBackup(store, appVersion) {
  return {
    kind: 'dart-network-control-backup',
    schemaVersion: 1,
    appVersion: String(appVersion || ''),
    createdAt: new Date().toISOString(),
    data: {
      settings: store.getSettings(),
      subscriptions: store.getSubscriptions({ includeRaw: true }),
      activeSub: store.get('activeSub'),
      selected: store.get('selected'),
      customRuleSets: store.get('customRuleSets') || [],
      localRules: store.get('localRules') || [],
    },
  };
}

function validateBackupDocument(document) {
  if (!isPlainObject(document) || document.kind !== 'dart-network-control-backup' || document.schemaVersion !== 1 || !isPlainObject(document.data)) {
    throw new Error('unsupported or invalid Dart backup');
  }
  const data = document.data;
  if (!isPlainObject(data.settings)) throw new Error('backup settings are invalid');
  const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : null;
  const customRuleSets = Array.isArray(data.customRuleSets) ? data.customRuleSets : null;
  const localRules = Array.isArray(data.localRules) ? data.localRules : null;
  if (!subscriptions || !customRuleSets || !localRules) throw new Error('backup lists are invalid');
  if (subscriptions.length > 500 || customRuleSets.length > 2000 || localRules.length > 10000) throw new Error('backup exceeds supported item limits');
  const ids = new Set();
  let nodeCount = 0;
  let policyMemberCount = 0;
  for (const sub of subscriptions) {
    if (!isPlainObject(sub) || typeof sub.id !== 'string' || !sub.id || sub.id.length > 256 || ids.has(sub.id)) {
      throw new Error('backup contains an invalid or duplicate config id');
    }
    ids.add(sub.id);
    if (sub.userAgentMode !== undefined && !['auto', 'sing-box', 'clash'].includes(sub.userAgentMode)) {
      throw new Error('backup config User-Agent mode is invalid');
    }
    if (sub.nodes !== undefined && !Array.isArray(sub.nodes)) throw new Error('backup config nodes are invalid');
    if (Array.isArray(sub.nodes)) {
      nodeCount += sub.nodes.length;
      if (nodeCount > 100000 || sub.nodes.some((node) => !isPlainObject(node))) throw new Error('backup config nodes are invalid');
    }
    if (sub.policyGroups !== undefined) {
      if (!Array.isArray(sub.policyGroups) || sub.policyGroups.length > 10000) {
        throw new Error('backup config policy groups are invalid');
      }
      for (const group of sub.policyGroups) {
        if (
          !isPlainObject(group) || typeof group.name !== 'string' ||
          !['select', 'url-test', 'fallback', 'load-balance'].includes(group.type) ||
          !Array.isArray(group.members) || group.members.some((member) => typeof member !== 'string')
        ) {
          throw new Error('backup config policy groups are invalid');
        }
        policyMemberCount += group.members.length;
        if (policyMemberCount > 100000) throw new Error('backup config policy groups are invalid');
      }
    }
  }
  const ruleIds = new Set();
  for (const item of customRuleSets) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id || item.id.length > 256 || ruleIds.has(item.id)) {
      throw new Error('backup contains an invalid or duplicate remote rule id');
    }
    ruleIds.add(item.id);
    if (item.target !== undefined && !['proxy', 'direct', 'reject'].includes(item.target)) throw new Error('backup remote rule target is invalid');
    if (item.format !== undefined && !['clash', 'sing-box'].includes(item.format)) throw new Error('backup remote rule format is invalid');
    if (item.kind !== undefined && !['inline', 'ruleset'].includes(item.kind)) throw new Error('backup remote rule kind is invalid');
    if (item.rules !== undefined && (!Array.isArray(item.rules) || item.rules.length > 100000 || item.rules.some((rule) => !isPlainObject(rule)))) {
      throw new Error('backup remote rule payload is invalid');
    }
  }
  const localIds = new Set();
  for (const item of localRules) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id || item.id.length > 256 || localIds.has(item.id)) {
      throw new Error('backup contains an invalid or duplicate local rule id');
    }
    localIds.add(item.id);
    if (item.matchType !== undefined && !['domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'process_name'].includes(item.matchType)) {
      throw new Error('backup local rule type is invalid');
    }
    if (item.target !== undefined && !['proxy', 'direct', 'reject'].includes(item.target)) throw new Error('backup local rule target is invalid');
    if (item.values !== undefined && (!Array.isArray(item.values) || item.values.length > 100000 || item.values.some((value) => typeof value !== 'string'))) {
      throw new Error('backup local rule values are invalid');
    }
  }
  const activeSub = ids.has(data.activeSub) ? data.activeSub : subscriptions[0] ? subscriptions[0].id : null;
  return {
    settings: { ...data.settings },
    subscriptions,
    activeSub,
    selected: typeof data.selected === 'string' ? data.selected : null,
    customRuleSets,
    localRules,
  };
}

function backupSummary(document, normalized) {
  const nodeCount = normalized.subscriptions.reduce((count, sub) => count + (Array.isArray(sub.nodes) ? sub.nodes.length : Number(sub.nodeCount) || 0), 0);
  return {
    appVersion: String(document.appVersion || ''),
    createdAt: String(document.createdAt || ''),
    configs: normalized.subscriptions.length,
    nodes: nodeCount,
    remoteRules: normalized.customRuleSets.length,
    localRules: normalized.localRules.length,
    coreType: normalized.settings.coreType || 'sing-box',
  };
}

module.exports = {
  normalizeTarget,
  cidrContains,
  matchClashRule,
  matchSingboxRule,
  parsePorts,
  buildDnsQuery,
  parseDnsMessage,
  dnsEndpoint,
  assessDnsResults,
  withForcedProxy,
  extractErrorLocation,
  inspectRoute,
  inspectPorts,
  dnsComparison,
  networkDiagnostics,
  checkAllConfigs,
  buildBackup,
  validateBackupDocument,
  backupSummary,
};
