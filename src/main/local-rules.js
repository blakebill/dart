'use strict';

const MATCH_TYPES = Object.freeze({
  domain: 'DOMAIN',
  domain_suffix: 'DOMAIN-SUFFIX',
  domain_keyword: 'DOMAIN-KEYWORD',
  ip_cidr: 'IP-CIDR',
  ip_asn: 'IP-ASN',
  process_name: 'PROCESS-NAME',
});
const VALID_MATCH_TYPES = Object.freeze(Object.keys(MATCH_TYPES));
const VALID_TARGETS = Object.freeze(['proxy', 'direct', 'reject']);
// Text mode accepts complete, commonly used Mihomo rules while keeping the
// destination constrained to the three targets exposed by the app. Logical
// AND/OR/NOT and SUB-RULE are deliberately excluded: commas inside their
// nested payload make line-level validation ambiguous and malformed input
// would otherwise only fail on the next core start.
const TEXT_RULE_TYPES = new Set([
  ...Object.values(MATCH_TYPES),
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'GEOIP',
  'SRC-GEOIP',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
  'SRC-IP-ASN',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'DSCP',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'NETWORK',
  'UID',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'REMATCH-NAME',
  'RULE-SET',
]);
const MAX_RULE_LINES = 10_000;
const MAX_RULE_TEXT = 1024 * 1024;
const MAX_RULE_LINE = 1024;

function localRuleMode(rule) {
  return rule && rule.mode === 'text' ? 'text' : 'structured';
}

function normalizeValues(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\r\n,]+/);
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    const item = String(raw || '').trim();
    if (!item || item.length > MAX_RULE_LINE || /[\r\n,\0]/.test(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_RULE_LINES) break;
  }
  return result;
}

function validAsn(value) {
  return /^\d{1,10}$/.test(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
}

function validateValues(matchType, values) {
  if (!VALID_MATCH_TYPES.includes(matchType)) throw new Error('invalid rule type');
  const normalized = normalizeValues(values);
  if (!normalized.length) throw new Error('no rule values provided');
  if (matchType === 'ip_asn' && normalized.some((value) => !validAsn(value))) {
    throw new Error('IP-ASN must be a numeric ASN between 1 and 4294967295');
  }
  return normalized;
}

function normalizeTarget(value) {
  const target = String(value || 'proxy').trim();
  if (/^(proxy|🚀 Proxy)$/i.test(target)) return 'proxy';
  if (/^direct$/i.test(target)) return 'direct';
  if (/^reject(?:-drop)?$/i.test(target)) return 'reject';
  throw new Error('invalid local rule target');
}

function targetToken(value) {
  const target = normalizeTarget(value);
  return target === 'direct' ? 'DIRECT' : target === 'reject' ? 'REJECT' : 'PROXY';
}

function normalizeTextRules(value) {
  const source = Array.isArray(value) ? value.join('\n') : String(value || '');
  if (source.length > MAX_RULE_TEXT) throw new Error('local rule text is too large');
  const rules = [];
  const seen = new Set();
  for (const raw of source.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^(#|;|\/\/)/.test(line)) continue;
    line = line.replace(/^[-+]\s+/, '').trim();
    if (!line || line.length > MAX_RULE_LINE || /[\r\n\0]/.test(line)) {
      throw new Error('invalid local rule line');
    }
    const parts = line.split(',').map((part) => part.trim());
    const type = String(parts[0] || '').toUpperCase();
    if (type === 'MATCH') {
      if (parts.length !== 2) throw new Error(`unsupported local rule: ${line}`);
      const normalized = `MATCH,${targetToken(parts[1])}`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        rules.push(normalized);
        if (rules.length > MAX_RULE_LINES) throw new Error('too many local rules');
      }
      continue;
    }
    const payload = parts[1] || '';
    if (!TEXT_RULE_TYPES.has(type) || !payload || parts.length < 3) {
      throw new Error(`unsupported local rule: ${line}`);
    }
    if ((type === 'IP-ASN' || type === 'SRC-IP-ASN') && !validAsn(payload)) {
      throw new Error(`invalid IP-ASN value: ${payload}`);
    }
    const target = targetToken(parts[2]);
    const params = parts.slice(3).filter(Boolean).map((param) => param.toLowerCase());
    const supportsParams = [
      'GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'RULE-SET',
    ].includes(type);
    if (params.some((param) => !supportsParams || (param !== 'no-resolve' && param !== 'src'))) {
      throw new Error(`unsupported local rule parameter: ${line}`);
    }
    const normalized = [type, payload, target, ...params].join(',');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      rules.push(normalized);
      if (rules.length > MAX_RULE_LINES) throw new Error('too many local rules');
    }
  }
  if (!rules.length) throw new Error('no rule values provided');
  return rules;
}

function buildLocalRuleLines(rule, proxyTarget = '🚀 Proxy') {
  if (!rule || rule.enabled === false) return [];
  if (localRuleMode(rule) === 'text') {
    return normalizeTextRules(rule.rules).map((line) => {
      const parts = line.split(',');
      const targetIndex = parts[0] === 'MATCH' ? 1 : 2;
      if (parts[targetIndex] === 'PROXY') parts[targetIndex] = proxyTarget;
      return parts.join(',');
    });
  }
  const type = MATCH_TYPES[rule.matchType];
  if (!type) return [];
  const values = validateValues(rule.matchType, rule.values);
  const token = targetToken(rule.target);
  const target = token === 'PROXY' ? proxyTarget : token;
  return values.map((value) => `${type},${value},${target}`);
}

function localRuleCount(rule) {
  return localRuleMode(rule) === 'text'
    ? (Array.isArray(rule && rule.rules) ? rule.rules.length : 0)
    : (Array.isArray(rule && rule.values) ? rule.values.length : 0);
}

module.exports = {
  MATCH_TYPES,
  VALID_MATCH_TYPES,
  VALID_TARGETS,
  MAX_RULE_LINES,
  localRuleMode,
  localRuleCount,
  normalizeValues,
  validateValues,
  normalizeTarget,
  normalizeTextRules,
  buildLocalRuleLines,
};
