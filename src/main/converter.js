'use strict';

const {
  normalizePolicyGroups,
  mihomoPolicyGroups,
} = require('./policy-groups');
const { smartRegionMembers } = require('./node-region');

const AUTO_GROUP = '♻️ Auto';
const SMART_GROUP = '🧠 Smart';
const FALLBACK_GROUP = '🛟 Fallback';
const APP_PROXY_GROUP = '🚀 Proxy';
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
const AUTO_TEST_INTERVAL_SECONDS = 60;
const AUTO_TEST_TIMEOUT_MS = 5000;
const SMART_MODES = new Set(['balanced', 'latency', 'stable']);

function normalizeSmartMode(value) {
  return SMART_MODES.has(value) ? value : 'balanced';
}

const APP_SELECTOR_ANCHORS = [APP_PROXY_GROUP, AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP];

function cleanOutboundName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 256 && !/[\r\n,]/.test(name) ? name : '';
}

function uniqueOutboundNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = cleanOutboundName(value);
    if (!name || seen.has(name)) continue;
    // Normalize built-ins to the tags used in generated configs.
    let key = name;
    if (name === 'DIRECT' || /^direct$/i.test(name)) key = 'direct';
    else if (name === 'REJECT' || name === 'REJECT-DROP' || /^reject(-drop)?$/i.test(name)) key = 'reject';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isBareDirectOutbound(name) {
  const n = cleanOutboundName(name);
  return !!(n && (n === 'direct' || n === 'DIRECT' || /^direct$/i.test(n)));
}

function isBareRejectOutbound(name) {
  const n = cleanOutboundName(name);
  return !!(n && (n === 'reject' || n === 'REJECT' || n === 'REJECT-DROP' || /^reject(-drop)?$/i.test(n)));
}

function isPreferDirectOrRejectMember(name) {
  const n = cleanOutboundName(name);
  if (!n) return false;
  if (isBareDirectOutbound(n)) return true;
  if (isBareRejectOutbound(n)) return true;
  return n.includes('直连') || n.includes('拦截') || n.includes('拒绝') || n.includes('广告')
    || n.toLowerCase().includes('direct');
}

/** Options that must not appear in the "选择出站" picker (bare direct / 全球直连-style). */
function isExcludedSourcePick(name) {
  const n = cleanOutboundName(name);
  if (!n) return true;
  if (isBareDirectOutbound(n)) return true;
  // Subscription "global direct" style labels — not the same as app 🚀 Proxy picks.
  if (n.includes('直连')) return true;
  return false;
}

/**
 * Normalize subscription policy groups for runtime generation. Source select
 * groups stay as real selectors so the UI can pick an outbound from the app
 * node list.
 */
function prepareSourcePolicyGroups(policyGroups, nodeNames = []) {
  return normalizePolicyGroups(policyGroups, nodeNames);
}

/**
 * Expand each select-type source group so the Clash API / UI picker can choose
 * the app main selector, strategy groups, every node, or residual original
 * members (nested groups, direct, …). Applies persisted `ruleGroupSelections`.
 *
 * Proxy-first groups default to 🚀 Proxy (follow the Nodes tab pick) when the
 * user has not chosen yet; prefer-direct groups keep their original first
 * member.
 */
function applySourceGroupSelections(groups, nodeNames = [], selections = null) {
  const nodes = (Array.isArray(nodeNames) ? nodeNames : [])
    .map((value) => (typeof value === 'string' ? value : value && value.name))
    .map(cleanOutboundName)
    .filter(Boolean);
  const picks = selections && typeof selections === 'object' && !Array.isArray(selections)
    ? selections
    : {};
  return (Array.isArray(groups) ? groups : []).map((group) => {
    if (!group || (group.type !== 'select' && group.type !== 'selector')) return group;
    const original = uniqueOutboundNames(group.members);
    const firstOriginal = original[0] || '';
    const preferDirect = !!(firstOriginal && isPreferDirectOrRejectMember(firstOriginal));
    const hasReject = original.some((member) => isBareRejectOutbound(member));
    // Drop bare direct / 全球直连-style entries from the selectable list, except
    // keep bare `direct` when this group itself is prefer-direct (needs a default).
    // Keep bare `reject` only when the subscription group already offered it.
    const originalKept = original.filter((member) => {
      if (isBareRejectOutbound(member)) return hasReject;
      if (isBareDirectOutbound(member)) return preferDirect;
      if (isExcludedSourcePick(member)) return false;
      return true;
    });
    const members = uniqueOutboundNames([
      ...APP_SELECTOR_ANCHORS,
      ...originalKept,
      ...nodes,
      ...(preferDirect ? ['direct'] : []),
      ...(hasReject ? ['reject'] : []),
    ]);
    if (!members.length) return group;

    const saved = cleanOutboundName(picks[group.name]);
    const norm = (name) => {
      if (name === 'DIRECT') return 'direct';
      if (name === 'REJECT' || name === 'REJECT-DROP') return 'reject';
      return name;
    };
    let chosen = saved && members.includes(norm(saved)) ? norm(saved) : '';
    if (!chosen) {
      const preferred = norm(cleanOutboundName(group.default) || original[0] || '');
      if (preferred && isPreferDirectOrRejectMember(preferred) && members.includes(preferred)) {
        chosen = preferred;
      } else if (members.includes(APP_PROXY_GROUP)) {
        chosen = APP_PROXY_GROUP;
      } else if (preferred && members.includes(preferred)) {
        chosen = preferred;
      } else {
        chosen = members[0];
      }
    }
    // Put the active pick first so Mihomo (no selector default field) starts on it.
    const ordered = [chosen, ...members.filter((name) => name !== chosen)];
    return { ...group, type: 'select', members: ordered, default: chosen };
  });
}

/**
 * UI picker list for one wired source group. Hides bare direct / 全球直连-style
 * labels; includes reject only when that group actually has a reject strategy.
 */
function sourcePicksForWiredGroup(group) {
  return uniqueOutboundNames(group && group.members || []).filter((name) => {
    if (isBareDirectOutbound(name)) return false;
    if (isExcludedSourcePick(name)) return false;
    return true;
  });
}

/** Flat picker options (anchors + nodes + non-direct extras). Used as a fallback. */
function sourceGroupPickOptions(nodes = [], groups = []) {
  const nodeNames = (Array.isArray(nodes) ? nodes : [])
    .map((value) => (typeof value === 'string' ? value : value && value.name))
    .map(cleanOutboundName)
    .filter(Boolean);
  const extras = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const member of group && group.members || []) {
      const name = cleanOutboundName(member);
      if (!name || isExcludedSourcePick(name)) continue;
      if (isBareRejectOutbound(name)) continue; // reject is per-group only
      extras.push(name);
    }
  }
  return uniqueOutboundNames([
    ...APP_SELECTOR_ANCHORS,
    ...nodeNames,
    ...extras,
  ]).filter((name) => !isExcludedSourcePick(name) && !isBareRejectOutbound(name));
}

/**
 * Conservative version fallback for callers that cannot execute the core.
 * Runtime config generation probes a minimal type:smart config instead.
 * Stock upstream builds never do. Mihomo Dart builds added kernel Smart in
 * `-dart.4`.
 */
function coreSupportsKernelSmart(coreType, version) {
  const text = String(version || '');
  const match = text.match(/-dart\.(\d+)/i);
  if (!match) return false;
  const rev = Number(match[1]);
  if (!Number.isFinite(rev)) return false;
  return coreType === 'mihomo' && rev >= 4;
}

/** Build the 🧠 Smart proxy-group for Mihomo (kernel smart or app-managed fallback). */
function buildMihomoSmartGroup(proxyNames, opts = {}) {
  const {
    kernelSmart = false,
    kernelSmartMode = false,
    latencyUrl = DEFAULT_TEST_URL,
    smartMode = 'balanced',
  } = opts;
  if (kernelSmart) {
    const group = {
      name: SMART_GROUP,
      type: 'smart',
      proxies: proxyNames,
      url: latencyUrl,
      interval: AUTO_TEST_INTERVAL_SECONDS,
      timeout: AUTO_TEST_TIMEOUT_MS,
      lazy: true,
    };
    if (kernelSmartMode) group.mode = normalizeSmartMode(smartMode);
    return group;
  }
  return { name: SMART_GROUP, type: 'select', proxies: proxyNames };
}

function cleanObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** Convert an internal node object back into a Clash/Mihomo proxy object. */
function nodeToClashProxy(node) {
  if (!node || !node.type) return null;
  const base = { name: node.name, server: node.server, port: node.port };
  switch (node.type) {
    case 'ss':
      return cleanObject({
        ...base,
        type: 'ss',
        cipher: node.cipher,
        password: node.password,
        plugin: node.plugin,
        'plugin-opts': node.pluginOpts,
        udp: node.udp,
      });
    case 'vmess':
      return cleanObject({
        ...base,
        type: 'vmess',
        uuid: node.uuid,
        alterId: node.alterId || 0,
        cipher: node.cipher || 'auto',
        network: node.network || 'tcp',
        tls: !!node.tls,
        servername: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        'ws-opts': node.wsOpts,
        'h2-opts': node.h2Opts,
        'grpc-opts': node.grpcOpts,
        udp: node.udp,
      });
    case 'vless':
      return cleanObject({
        ...base,
        type: 'vless',
        uuid: node.uuid,
        flow: node.flow || undefined,
        network: node.network || 'tcp',
        tls: !!node.tls,
        servername: node.servername || undefined,
        alpn: node.alpn,
        'client-fingerprint': node.clientFingerprint,
        'skip-cert-verify': node.skipCertVerify,
        'reality-opts': node.reality
          ? cleanObject({ 'public-key': node.reality.publicKey, 'short-id': node.reality.shortId })
          : undefined,
        'ws-opts': node.wsOpts,
        'h2-opts': node.h2Opts,
        'grpc-opts': node.grpcOpts,
        udp: node.udp,
      });
    case 'trojan':
      return cleanObject({
        ...base,
        type: 'trojan',
        password: node.password,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        network: node.network || 'tcp',
        'ws-opts': node.wsOpts,
        'grpc-opts': node.grpcOpts,
        udp: node.udp,
      });
    case 'hysteria2':
      return cleanObject({
        ...base,
        type: 'hysteria2',
        password: node.password,
        obfs: node.obfs,
        'obfs-password': node.obfsPassword,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        up: node.up,
        down: node.down,
      });
    case 'hysteria':
      return cleanObject({
        ...base,
        type: 'hysteria',
        auth: node.authStr,
        obfs: node.obfs,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
        up: node.up,
        down: node.down,
      });
    case 'anytls':
      return cleanObject({
        ...base,
        type: 'anytls',
        password: node.password,
        sni: node.servername || undefined,
        alpn: node.alpn,
        'client-fingerprint': node.clientFingerprint,
        'skip-cert-verify': node.skipCertVerify,
        'idle-session-check-interval': node.idleCheck,
        'idle-session-timeout': node.idleTimeout,
        'min-idle-session': node.minIdleSession,
        udp: node.udp,
      });
    case 'tuic':
      return cleanObject({
        ...base,
        type: 'tuic',
        uuid: node.uuid,
        password: node.password,
        'congestion-control': node.congestionControl || 'bbr',
        'udp-relay-mode': node.udpRelayMode || 'native',
        sni: node.servername || undefined,
        alpn: node.alpn,
        'skip-cert-verify': node.skipCertVerify,
      });
    case 'socks':
      return cleanObject({ ...base, type: 'socks5', username: node.username, password: node.password, udp: node.udp });
    case 'http':
      return cleanObject({
        ...base,
        type: node.tls ? 'https' : 'http',
        username: node.username,
        password: node.password,
        tls: node.tls,
        sni: node.servername || undefined,
        'skip-cert-verify': node.skipCertVerify,
      });
    default:
      return null;
  }
}

function mapClashTarget(name, overrides, availableTargets = null) {
  const n = String(name || '').trim();
  if (/^DIRECT$/i.test(n)) return 'direct';
  if (/^REJECT/i.test(n)) return 'reject'; // handled as an action below
  if (overrides) {
    const ov = overrides[n];
    if (ov === 'direct') return 'direct';
    if (ov === 'reject') return 'reject';
    if (ov === 'proxy') return '🚀 Proxy';
  }
  // Keep a source group/node target when the generated config contains it.
  if (availableTargets instanceof Set && availableTargets.has(n)) return n;
  return '🚀 Proxy';
}

/**
 * Parse one Clash `rules:` line into { type, value, target }. The line shape is
 * `TYPE,VALUE,TARGET` (e.g. DOMAIN-SUFFIX,x.com,Proxy); MATCH/FINAL carry the
 * target in the second field. Returns null for non-strings / blank types. This
 * is the single place that knows the rule-line layout — every extractor and the
 * converter route through it.
 */
function parseClashRule(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((s) => s.trim());
  const type = (parts[0] || '').toUpperCase();
  if (!type) return null;
  const isMatch = type === 'MATCH' || type === 'FINAL';
  return { type, value: parts[1], target: isMatch ? parts[1] : parts[2] };
}

/**
 * Expand one-level Clash logical rules (AND/OR/NOT) into plain rule lines or a
 * single AND descriptor. Deeper nesting and unsupported matchers are skipped
 * rather than mis-routed.
 * @returns {null|Array<string|object>} null when `raw` is not a logical rule
 */
function expandLogicalClashRule(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const head = text.match(/^(AND|OR|NOT)\s*,/i);
  if (!head) return null;
  const kind = head[1].toUpperCase();
  const rest = text.slice(head[0].length).trim();
  if (!rest.startsWith('(')) return [];
  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const payload = rest.slice(0, end + 1);
  const after = rest.slice(end + 1).replace(/^\s*,\s*/, '').trim();
  const target = after.split(',')[0].trim();
  if (!target || /[\r\n]/.test(target)) return [];

  const inner = payload.slice(1, -1);
  const children = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === ',' || /\s/.test(inner[i]))) i += 1;
    if (i >= inner.length) break;
    if (inner[i] !== '(') return [];
    let d = 0;
    let j = i;
    for (; j < inner.length; j++) {
      if (inner[j] === '(') d += 1;
      else if (inner[j] === ')') {
        d -= 1;
        if (d === 0) {
          j += 1;
          break;
        }
      }
    }
    if (d !== 0) return [];
    const child = inner.slice(i + 1, j - 1).trim();
    if (!child) return [];
    children.push(child);
    i = j;
  }
  if (!children.length) return [];

  if (kind === 'OR') {
    return children.map((child) => `${child},${target}`);
  }
  if (kind === 'AND') {
    return [{ logical: 'AND', parts: children, target }];
  }
  // NOT cannot be expressed losslessly with the matchers we emit; drop it.
  return [];
}

/** Flatten logical Clash rules so converters always see plain lines or AND descriptors. */
function flattenClashRules(clashRules) {
  const out = [];
  for (const raw of clashRules || []) {
    const expanded = expandLogicalClashRule(raw);
    if (expanded === null) {
      out.push(raw);
      continue;
    }
    for (const item of expanded) out.push(item);
  }
  return out;
}

/** Preserve Clash/Mihomo AND semantics while applying the selected target override. */
function andDescriptorToMihomoRule(descriptor, overrides, availableTargets) {
  if (!descriptor || descriptor.logical !== 'AND' || !Array.isArray(descriptor.parts)) return null;
  if (!descriptor.parts.length || descriptor.parts.some((part) => !String(part || '').trim())) return null;
  const target = clashTargetName(mapClashTarget(descriptor.target, overrides, availableTargets));
  const children = descriptor.parts.map((part) => `(${String(part).trim()})`).join(',');
  return `AND,(${children}),${target}`;
}

/**
 * Distinct subscription policy-group names referenced by proxy-bound rules
 * (including MATCH/FINAL targets, excluding DIRECT/REJECT). These are the groups the user
 * can remap via `overrides`. Returned sorted for a stable UI.
 */
function extractRuleGroups(clashRules) {
  const groups = new Set();
  for (const raw of flattenClashRules(clashRules)) {
    if (raw && typeof raw === 'object' && raw.logical === 'AND') {
      const n = String(raw.target || '').trim();
      if (n && !/^DIRECT$/i.test(n) && !/^REJECT/i.test(n)) groups.add(n);
      continue;
    }
    const r = parseClashRule(raw);
    if (!r) continue;
    const n = String(r.target || '').trim();
    if (!n || /^DIRECT$/i.test(n) || /^REJECT/i.test(n)) continue;
    groups.add(n);
  }
  return Array.from(groups).sort();
}

/** Distinct rule-provider names referenced by `RULE-SET,<name>,...` rules. */
function extractRuleSetRefs(clashRules) {
  const names = new Set();
  for (const raw of flattenClashRules(clashRules)) {
    if (raw && typeof raw === 'object') continue;
    const r = parseClashRule(raw);
    if (r && r.type === 'RULE-SET' && r.value) names.add(r.value);
  }
  return names;
}
/**
 * Parse a remote Clash-style rule list (classical/domain/ipcidr, or a plain
 * domain list) into normalized matcher arrays.
 */
function parseRuleList(text) {
  const m = { domain: [], domain_suffix: [], domain_keyword: [], ip_cidr: [], process_name: [] };
  for (let raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^(#|;|\/\/|payload\s*:)/i.test(line)) continue;
    // strip YAML list dash + surrounding quotes + trailing inline comments
    line = line.replace(/^-\s*/, '').replace(/\s+#.*$/, '').trim();
    line = line.replace(/^['"]|['"]$/g, '').trim();
    if (!line) continue;
    if (line.includes(',')) {
      const parts = line.split(',').map((s) => s.trim());
      const type = (parts[0] || '').toUpperCase().replace(/\s+/g, '');
      const val = parts[1];
      if (!val) continue;
      switch (type) {
        case 'DOMAIN':
        case 'HOST':
          m.domain.push(val);
          break;
        case 'DOMAIN-SUFFIX':
        case 'HOST-SUFFIX':
          m.domain_suffix.push(val);
          break;
        case 'DOMAIN-KEYWORD':
        case 'HOST-KEYWORD':
          m.domain_keyword.push(val);
          break;
        case 'IP-CIDR':
        case 'IP-CIDR6':
        case 'IP6-CIDR':
          m.ip_cidr.push(val);
          break;
        case 'PROCESS-NAME':
          m.process_name.push(val);
          break;
        default:
          break; // USER-AGENT / GEOIP / URL-REGEX / etc. skipped
      }
    } else {
      // Bare entry: domain list. '+.x'/'.x' -> suffix; CIDR -> ip_cidr; else suffix.
      if (line.startsWith('+.')) m.domain_suffix.push(line.slice(2));
      else if (line.startsWith('.')) m.domain_suffix.push(line.slice(1));
      else if (/\/\d{1,3}$/.test(line)) m.ip_cidr.push(line);
      else m.domain_suffix.push(line);
    }
  }
  return m;
}

function ruleListToClashRules(text, target = 'proxy') {
  const matchers = parseRuleList(text);
  const ruleTarget = target === 'direct' ? 'DIRECT' : target === 'reject' ? 'REJECT' : APP_PROXY_GROUP;
  const typeByField = {
    domain: 'DOMAIN',
    domain_suffix: 'DOMAIN-SUFFIX',
    domain_keyword: 'DOMAIN-KEYWORD',
    ip_cidr: 'IP-CIDR',
    process_name: 'PROCESS-NAME',
  };
  const rules = [];
  for (const [field, values] of Object.entries(matchers)) {
    const type = typeByField[field];
    if (!type) continue;
    for (const value of values) rules.push(`${type},${value},${ruleTarget}`);
  }
  return { rules, count: rules.length };
}

function dedupeNames(items, key, reserved = []) {
  const used = new Set(reserved);
  const nextSuffix = new Map();
  for (const item of items) {
    const base = String(item[key] || 'node');
    let name = base;
    if (used.has(name)) {
      let suffix = nextSuffix.get(base) || 2;
      while (used.has(`${base} ${suffix}`)) suffix += 1;
      name = `${base} ${suffix}`;
      nextSuffix.set(base, suffix + 1);
    } else {
      nextSuffix.set(base, 2);
    }
    used.add(name);
    item[key] = name;
  }
  return items;
}

function dedupeProxyNames(proxies) {
  return dedupeNames(proxies, 'name', ['🚀 Proxy', AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, 'direct', 'DIRECT', 'REJECT', 'GLOBAL']);
}

function clashTargetName(target) {
  if (target === 'direct') return 'DIRECT';
  if (target === 'reject') return 'REJECT';
  return target || '🚀 Proxy';
}

function routeObjectToClashRules(rule, options = {}) {
  if (!rule || typeof rule !== 'object' || ['sniff', 'hijack-dns'].includes(rule.action)) return [];
  const rawOutbound = String(rule.outbound || '').trim();
  const outbound = rawOutbound.toLowerCase();
  const preservedOutbound = options.preserveOutbound && rawOutbound && !/[\r\n,]/.test(rawOutbound)
    ? rawOutbound
    : '🚀 Proxy';
  const target = rule.action === 'reject' || ['block', 'reject'].includes(outbound)
    ? 'REJECT'
    : outbound === 'direct' ? 'DIRECT' : preservedOutbound;
  const out = [];
  const add = (type, vals) => {
    const values = Array.isArray(vals) ? vals : vals === undefined ? [] : [vals];
    for (const v of values) out.push(`${type},${v},${target}`);
  };
  add('DOMAIN', rule.domain);
  add('DOMAIN-SUFFIX', rule.domain_suffix);
  add('DOMAIN-KEYWORD', rule.domain_keyword);
  add('IP-CIDR', rule.ip_cidr);
  add('PROCESS-NAME', rule.process_name);
  add('DST-PORT', rule.port);
  if (rule.ip_is_private === true) {
    add('IP-CIDR', ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8']);
    add('IP-CIDR6', ['fc00::/7', 'fe80::/10', '::1/128']);
  }
  if (options.includeRuleSets !== false) {
    const ruleSets = Array.isArray(rule.rule_set) ? rule.rule_set : rule.rule_set ? [rule.rule_set] : [];
    for (const tag of ruleSets) out.push(`RULE-SET,${tag},${target}`);
  }
  if (rule.type === 'logical' && rule.mode === 'or' && Array.isArray(rule.rules)) {
    for (const child of rule.rules) {
      for (const converted of routeObjectToClashRules(
        { ...child, outbound: rule.outbound, action: rule.action },
        options
      )) out.push(converted);
    }
  }
  return out;
}

function clashRuleToMihomo(raw, overrides, availableRuleProviders = null, availableTargets = null) {
  const parts = String(raw || '').split(',').map((s) => s.trim());
  const type = (parts[0] || '').toUpperCase();
  if (!type) return null;
  const parsed = parseClashRule(raw);
  if (!parsed) return null;
  const target = clashTargetName(mapClashTarget(parsed.target, overrides, availableTargets));
  if (type === 'MATCH' || type === 'FINAL') return `MATCH,${target}`;
  if (!parsed.value) return null;
  if (type === 'RULE-SET' && availableRuleProviders && !availableRuleProviders.has(parsed.value)) {
    return null;
  }
  const extra = parts.slice(3).filter(Boolean);
  return [type, parsed.value, target, ...extra].join(',');
}

/**
 * Imported subscriptions cannot supply files next to the generated runtime
 * config, and the parser intentionally does not retain arbitrary local paths
 * or inline payloads. Keep only remote providers Mihomo can fetch by itself.
 */
function normalizeMihomoRuleProviders(ruleProviders) {
  const normalized = {};
  if (!ruleProviders || typeof ruleProviders !== 'object') return normalized;
  const behaviors = new Set(['domain', 'ipcidr', 'classical']);
  const formats = new Set(['yaml', 'text', 'mrs']);
  for (const [name, provider] of Object.entries(ruleProviders)) {
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') continue;
    if (!name || name.length > 256 || /[\r\n,]/.test(name)) continue;
    if (!provider || typeof provider !== 'object') continue;
    if (String(provider.type || 'http').toLowerCase() !== 'http') continue;
    const behavior = String(provider.behavior || 'classical').toLowerCase();
    const format = String(provider.format || 'yaml').toLowerCase();
    if (!behaviors.has(behavior) || !formats.has(format)) continue;
    if (format === 'mrs' && behavior === 'classical') continue;
    const url = String(provider.url || '').trim();
    try {
      const protocol = new URL(url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') continue;
    } catch (_) {
      continue;
    }
    normalized[name] = { type: 'http', behavior, url, format };
  }
  return normalized;
}

function buildMihomoConfig(nodes, opts = {}) {
  const {
    mixedPort = 7890,
    clashApiPort = 9090,
    clashApiSecret = '',
    logLevel = 'info',
    selected = null,
    clashMode = 'rule',
    clashRules = [],
    policyGroups = [],
    ruleOverrides = null,
    ruleGroupSelections = null,
    ruleProviders = {},
    enableIpv6 = true,
    enableTun = false,
    tunInterfaceName = 'Dart',
    enableDnsOverride = false,
    dnsRemote = 'https://1.1.1.1/dns-query',
    dnsLocal = 'https://223.5.5.5/dns-query',
    testUrl = DEFAULT_TEST_URL,
    externalUiDir = '',
    externalUiDownloadUrl = '',
    extraRules = [],
    hasGeoData = true,
  } = opts;

  const nodeEntries = nodes
    .map((node) => ({ node, proxy: nodeToClashProxy(node) }))
    .filter((entry) => !!entry.proxy);
  const proxies = dedupeProxyNames(nodeEntries.map((entry) => entry.proxy));
  const proxyNames = proxies.map((p) => p.name);
  if (!proxyNames.length) throw new Error('No supported proxy nodes are available.');
  const smartProxyNames = smartRegionMembers(
    nodeEntries.map((entry) => entry.node),
    proxyNames,
    opts.smartRegions
  );
  const sourceGroups = applySourceGroupSelections(
    prepareSourcePolicyGroups(policyGroups, proxyNames),
    proxyNames,
    ruleGroupSelections
  );
  const sourceGroupNames = sourceGroups.map((group) => group.name);
  const availableTargets = new Set([AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, ...proxyNames, ...sourceGroupNames]);
  const mihomoRuleProviders = normalizeMihomoRuleProviders(ruleProviders);
  const availableRuleProviders = new Set(Object.keys(mihomoRuleProviders));
  const latencyUrl = String(testUrl || '').trim() || DEFAULT_TEST_URL;
  // Keep the main selector acyclic: 🚀 Proxy must not list source policy groups. Those groups
  // already include 🚀 Proxy for "follow main selection"; nesting both ways is a
  // cycle (Mihomo may accept it, but selection/routing becomes undefined).
  const proxyMembers = [AUTO_GROUP, SMART_GROUP, FALLBACK_GROUP, ...proxyNames, 'DIRECT'];
  const defaultProxy =
    selected && (proxyMembers.includes(selected) || selected === 'direct')
      ? (selected === 'direct' ? 'DIRECT' : selected)
      : AUTO_GROUP;
  const manualProxies = [];
  const manualSeen = new Set();
  const addManual = (name) => {
    if (name && !manualSeen.has(name)) {
      manualSeen.add(name);
      manualProxies.push(name);
    }
  };
  addManual(defaultProxy);
  for (const name of proxyMembers) addManual(name);

  const autoGroup = { name: AUTO_GROUP, type: 'select', proxies: proxyNames };
  const smartGroup = buildMihomoSmartGroup(smartProxyNames, {
    kernelSmart: !!opts.kernelSmart,
    kernelSmartMode: !!opts.kernelSmartMode,
    latencyUrl,
    smartMode: opts.smartMode,
  });

  const rules = [];
  let finalRule = 'MATCH,🚀 Proxy';
  if (clashMode === 'block') {
    rules.push('MATCH,REJECT');
  } else {
    // Always prepend private-LAN direct,
    // ip_is_private rule — even when the subscription ships its own rules.
    const privateDirect = [
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
      'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
      'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
      'IP-CIDR6,::1/128,DIRECT,no-resolve',
    ];
    for (const rule of privateDirect) rules.push(rule);
    for (const r of extraRules) {
      if (typeof r === 'string') {
        const converted = clashRuleToMihomo(r, ruleOverrides, availableRuleProviders, availableTargets);
        if (converted && !/^MATCH,/i.test(converted)) rules.push(converted);
        continue;
      }
      for (const converted of routeObjectToClashRules(r)) rules.push(converted);
    }
    for (const raw of flattenClashRules(clashRules)) {
      if (raw && typeof raw === 'object' && raw.logical === 'AND') {
        const combined = andDescriptorToMihomoRule(raw, ruleOverrides, availableTargets);
        if (combined) rules.push(combined);
        continue;
      }
      const rule = clashRuleToMihomo(raw, ruleOverrides, availableRuleProviders, availableTargets);
      if (!hasGeoData && /^(GEOIP|GEOSITE),/i.test(rule || '')) continue;
      if (/^MATCH,/i.test(rule || '')) finalRule = rule;
      else if (rule) rules.push(rule);
    }
    // CN direct fallback, after subscription rules and before MATCH — same
    // relative order as the remaining subscription rules.
    if (hasGeoData) rules.push('GEOIP,CN,DIRECT');
    rules.push(finalRule);
  }

  const sourceProxyGroups = mihomoPolicyGroups(sourceGroups, latencyUrl, {
    interval: AUTO_TEST_INTERVAL_SECONDS,
    timeout: AUTO_TEST_TIMEOUT_MS,
  });

  const config = {
    'mixed-port': mixedPort,
    'allow-lan': false,
    mode: clashMode === 'global' ? 'global' : clashMode === 'direct' ? 'direct' : 'rule',
    'log-level': logLevel,
    ipv6: !!enableIpv6,
    // Race every address returned for a hostname and keep the first successful
    // TCP connection. Mihomo otherwise dials addresses within each IP family
    // serially, so a stale/unreachable address can stall even DIRECT traffic
    // for seconds before the next address is attempted.
    'tcp-concurrent': true,
    'geodata-mode': true,
    'geodata-loader': 'memconservative',
    'geo-auto-update': false,
    proxies,
    'proxy-groups': [
      { name: '🚀 Proxy', type: 'select', proxies: manualProxies },
      autoGroup,
      smartGroup,
      {
        name: FALLBACK_GROUP,
        type: 'fallback',
        proxies: proxyNames,
        url: latencyUrl,
        interval: AUTO_TEST_INTERVAL_SECONDS,
        timeout: AUTO_TEST_TIMEOUT_MS,
        'max-failed-times': 2,
        lazy: true,
      },
      ...sourceProxyGroups,
    ],
    rules,
  };
  if (enableDnsOverride) {
    // Resolve proxy server hostnames through the local resolver to avoid a
    // bootstrap loop, while regular queries follow the proxy rules.
    config.dns = {
      enable: true,
      ipv6: !!enableIpv6,
      'enhanced-mode': enableTun ? 'fake-ip' : 'redir-host',
      ...(enableTun ? {
        'fake-ip-range': '198.18.0.1/16',
        'fake-ip-filter': ['*.lan', '*.local', 'localhost', 'localhost.*'],
      } : {}),
      'default-nameserver': ['223.5.5.5', '1.1.1.1'],
      nameserver: [dnsRemote],
      'proxy-server-nameserver': [dnsLocal],
      'direct-nameserver': [dnsLocal],
      'respect-rules': true,
    };
  } else {
    // A TUN adapter's synthetic Windows DNS address cannot safely delegate
    // back to `system` without recursion. Pure system-proxy mode can retain the
    // system resolver; TUN mode instead uses the configured direct resolver.
    const defaultResolver = enableTun ? dnsLocal : 'system';
    config.dns = {
      enable: true,
      ipv6: !!enableIpv6,
      'enhanced-mode': 'redir-host',
      'use-hosts': true,
      'use-system-hosts': true,
      'default-nameserver': ['223.5.5.5', '1.1.1.1'],
      nameserver: [defaultResolver],
      'proxy-server-nameserver': [dnsLocal],
      'direct-nameserver': [defaultResolver],
    };
  }
  if (enableTun) {
    config.tun = {
      enable: true,
      ...(tunInterfaceName ? { device: tunInterfaceName } : {}),
      stack: 'mixed',
      mtu: 9000,
      'auto-route': true,
      'strict-route': true,
      'auto-detect-interface': true,
      // strict-route blocks Windows' alternate DNS paths. Feed both UDP and
      // TCP DNS into Mihomo even when custom DNS override is disabled.
      'dns-hijack': ['any:53', 'tcp://any:53'],
    };
  }
  config['external-controller'] = `127.0.0.1:${clashApiPort}`;
  if (clashApiSecret) config.secret = clashApiSecret;
  if (externalUiDir) {
    config['external-ui'] = externalUiDir;
    if (externalUiDownloadUrl) config['external-ui-url'] = externalUiDownloadUrl;
  }
  if (availableRuleProviders.size) config['rule-providers'] = mihomoRuleProviders;
  return config;
}

module.exports = {
  DEFAULT_TEST_URL,
  SMART_GROUP,
  APP_PROXY_GROUP,
  coreSupportsKernelSmart,
  buildMihomoSmartGroup,
  prepareSourcePolicyGroups,
  applySourceGroupSelections,
  sourceGroupPickOptions,
  sourcePicksForWiredGroup,
  nodeToClashProxy,
  buildMihomoConfig,
  extractRuleGroups,
  extractRuleSetRefs,
  parseRuleList,
  routeObjectToClashRules,
  ruleListToClashRules,
};
