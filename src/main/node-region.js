'use strict';

const OTHER_REGION = 'ZZ';

// Names from subscriptions are the only portable region signal shared by both
// cores. Keep aliases deliberately specific: short, ambiguous fragments such
// as "IN" or "CA" are accepted only as standalone upper-case tokens.
const REGION_ALIASES = Object.freeze({
  HK: ['香港', 'hong kong', 'hongkong'],
  TW: ['台湾', '台灣', 'taiwan', 'taipei', '台北'],
  JP: ['日本', 'japan', 'tokyo', 'osaka', '东京', '東京', '大阪'],
  SG: ['新加坡', '狮城', '獅城', 'singapore'],
  US: ['美国', '美國', 'united states', 'los angeles', 'san jose', 'seattle', 'new york'],
  KR: ['韩国', '韓國', '南韩', '南韓', 'korea', 'seoul', '首尔', '首爾'],
  CN: ['中国', '中國', 'mainland china', 'beijing', 'shanghai', '北京', '上海'],
  GB: ['英国', '英國', 'united kingdom', 'london', '伦敦', '倫敦'],
  DE: ['德国', '德國', 'germany', 'frankfurt', '法兰克福', '法蘭克福'],
  FR: ['法国', '法國', 'france', 'paris', '巴黎'],
  CA: ['加拿大', 'canada', 'toronto', 'vancouver', '多伦多', '多倫多', '温哥华', '溫哥華'],
  AU: ['澳大利亚', '澳大利亞', '澳洲', 'australia', 'sydney', '悉尼'],
  RU: ['俄罗斯', '俄羅斯', 'russia', 'moscow', '莫斯科'],
  IN: ['印度', 'india', 'mumbai', '孟买', '孟買'],
  NL: ['荷兰', '荷蘭', 'netherlands', 'amsterdam', '阿姆斯特丹'],
  CH: ['瑞士', 'switzerland', 'zurich', '苏黎世', '蘇黎世'],
  SE: ['瑞典', 'sweden', 'stockholm', '斯德哥尔摩', '斯德哥爾摩'],
  FI: ['芬兰', '芬蘭', 'finland', 'helsinki', '赫尔辛基', '赫爾辛基'],
  TR: ['土耳其', 'turkey', 'türkiye', 'istanbul', '伊斯坦布尔', '伊斯坦布爾'],
  BR: ['巴西', 'brazil', 'sao paulo', 'são paulo', '圣保罗', '聖保羅'],
});

const KNOWN_REGION_CODES = new Set(Object.keys(REGION_ALIASES));
const REGION_CODE_ALIASES = Object.freeze({ UK: 'GB' });
const REGION_TOKEN_RE = /(?:^|[^\p{L}\p{N}])([A-Z]{2})(?=\d|$|[^\p{L}\p{N}])/gu;
const FLAG_RE = /\p{Regional_Indicator}{2}/u;

function normalizeSmartRegions(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const code = String(item || '').trim().toUpperCase();
    if ((code === OTHER_REGION || /^[A-Z]{2}$/.test(code)) && !seen.has(code)) {
      seen.add(code);
      result.push(code);
    }
  }
  return result.sort().slice(0, 64);
}

function flagRegion(text) {
  const match = String(text || '').match(FLAG_RE);
  if (!match) return '';
  const points = [...match[0]].map((char) => char.codePointAt(0) - 0x1F1E6);
  if (points.length !== 2 || points.some((point) => point < 0 || point > 25)) return '';
  return String.fromCharCode(65 + points[0], 65 + points[1]);
}

function aliasRegion(text) {
  const value = String(text || '').toLocaleLowerCase('en-US');
  for (const [code, aliases] of Object.entries(REGION_ALIASES)) {
    if (aliases.some((alias) => value.includes(alias))) return code;
  }
  return '';
}

function tokenRegion(text) {
  REGION_TOKEN_RE.lastIndex = 0;
  const value = String(text || '');
  let match;
  while ((match = REGION_TOKEN_RE.exec(value))) {
    if (KNOWN_REGION_CODES.has(match[1])) return match[1];
    if (REGION_CODE_ALIASES[match[1]]) return REGION_CODE_ALIASES[match[1]];
  }
  return '';
}

function serverRegion(server) {
  const value = String(server || '').trim().toLowerCase().replace(/\.$/, '');
  if (!value || /^[\d.:]+$/.test(value)) return '';
  const match = value.match(/\.([a-z]{2})$/);
  if (!match) return '';
  const code = match[1].toUpperCase();
  if (REGION_CODE_ALIASES[code]) return REGION_CODE_ALIASES[code];
  return KNOWN_REGION_CODES.has(code) ? code : '';
}

function detectNodeRegion(node) {
  const name = typeof node === 'string' ? node : node && node.name;
  return flagRegion(name)
    || aliasRegion(name)
    || tokenRegion(name)
    || serverRegion(node && typeof node === 'object' ? node.server : '')
    || OTHER_REGION;
}

function smartRegionMembers(nodes, names, selectedRegions) {
  const regions = normalizeSmartRegions(selectedRegions);
  if (!regions.length) return names.slice();
  const allowed = new Set(regions);
  const filtered = names.filter((_name, index) => allowed.has(detectNodeRegion(nodes[index])));
  // Subscription renames/updates must not leave Smart empty and prevent the
  // core from starting. Treat a now-unavailable preference as "all regions".
  return filtered.length ? filtered : names.slice();
}

function nodeRegionSummary(nodes) {
  const counts = new Map();
  for (const node of nodes || []) {
    const code = detectNodeRegion(node);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

module.exports = {
  OTHER_REGION,
  detectNodeRegion,
  nodeRegionSummary,
  normalizeSmartRegions,
  smartRegionMembers,
};
