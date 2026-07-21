'use strict';

const RESERVED_NAMES = new Set([
  '🚀 Proxy', '♻️ Auto', '🧠 Smart', '🛟 Fallback',
  'direct', 'DIRECT', 'REJECT', 'REJECT-DROP', 'GLOBAL',
]);
const RESERVED_NAMES_LOWER = new Set([...RESERVED_NAMES].map((name) => name.toLowerCase()));
const GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance']);
const LOAD_BALANCE_STRATEGIES = new Set(['consistent-hashing', 'round-robin', 'sticky-sessions']);
const MAX_POLICY_GROUPS = 4096;
const MAX_POLICY_GROUP_INPUTS = 16384;
const MAX_GROUP_MEMBERS = 10000;
const MAX_POLICY_MEMBERS = 100000;

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 256 && !/[\r\n,]/.test(name) ? name : '';
}

function uniqueNames(values, limit = Number.MAX_SAFE_INTEGER) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = cleanName(value);
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 0x7fffffff
    ? Math.max(1, Math.round(number))
    : undefined;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 0x7fffffff
    ? Math.round(number)
    : undefined;
}

function durationSeconds(value) {
  const numeric = positiveNumber(value);
  if (numeric !== undefined && typeof value !== 'string') return Math.round(numeric);
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) return undefined;
  const scale = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[(match[2] || 's').toLowerCase()];
  return positiveNumber(Number(match[1]) * scale);
}

function normalizedType(value) {
  const type = String(value || '').toLowerCase().replace(/_/g, '-');
  if (type === 'selector') return 'select';
  if (type === 'urltest') return 'url-test';
  return GROUP_TYPES.has(type) ? type : '';
}

function safeHttpUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  try {
    const protocol = new URL(text).protocol;
    return protocol === 'http:' || protocol === 'https:' ? text : '';
  } catch (_) {
    return '';
  }
}

function filteredNodeNames(group, nodeNames) {
  if (!group || (!group['include-all'] && !group['include-all-proxies'])) return [];
  let include = null;
  let exclude = null;
  try {
    if (group.filter) include = new RegExp(String(group.filter));
    if (group['exclude-filter']) exclude = new RegExp(String(group['exclude-filter']));
  } catch (_) {
    return [];
  }
  const result = [];
  for (const name of nodeNames) {
    if ((!include || include.test(name)) && (!exclude || !exclude.test(name))) result.push(name);
    if (result.length >= MAX_GROUP_MEMBERS) break;
  }
  return result;
}

function canonicalGroup(group, memberLimit = MAX_GROUP_MEMBERS) {
  const result = {
    name: cleanName(group && group.name),
    type: normalizedType(group && group.type),
    members: uniqueNames(group && group.members, memberLimit),
  };
  const defaultMember = cleanName(group && group.default);
  const url = safeHttpUrl(group && group.url);
  const interval = durationSeconds(group && group.interval);
  const idleTimeout = durationSeconds(group && group.idleTimeout);
  const timeout = positiveNumber(group && group.timeout);
  const tolerance = nonNegativeNumber(group && group.tolerance);
  const strategy = String(group && group.strategy || '').trim().toLowerCase();
  if (defaultMember) result.default = defaultMember;
  if (url) result.url = url;
  if (interval !== undefined) result.interval = interval;
  if (idleTimeout !== undefined) result.idleTimeout = idleTimeout;
  if (timeout !== undefined) result.timeout = timeout;
  if (tolerance !== undefined) result.tolerance = tolerance;
  if (group && typeof group.lazy === 'boolean') result.lazy = group.lazy;
  if (group && typeof group.interrupt === 'boolean') result.interrupt = group.interrupt;
  if (LOAD_BALANCE_STRATEGIES.has(strategy)) result.strategy = strategy;
  return result;
}

function pruneInvalidGroups(groups, nodeNames) {
  const names = new Set(groups.map((group) => group.name));
  const reverseRefs = new Map([...names].map((name) => [name, []]));
  const valid = new Set();
  const queue = [];
  const prepared = groups.map((group) => {
    const members = [];
    const seen = new Set();
    for (const value of group.members) {
      let member = value;
      if (/^direct$/i.test(value)) member = 'direct';
      else if (/^reject(-drop)?$/i.test(value) || value === 'REJECT' || value === 'REJECT-DROP') member = 'reject';
      if (
        !seen.has(member) && member !== group.name &&
        (member === 'direct' || member === 'reject' || nodeNames.has(member) || names.has(member))
      ) {
        seen.add(member);
        members.push(member);
      }
    }
    return { ...group, members };
  });

  for (const group of prepared) {
    for (const member of group.members) {
      if (member === 'direct' || member === 'reject' || nodeNames.has(member)) {
        if (!valid.has(group.name)) {
          valid.add(group.name);
          queue.push(group.name);
        }
      } else {
        reverseRefs.get(member).push(group.name);
      }
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    for (const parent of reverseRefs.get(queue[index]) || []) {
      if (valid.has(parent)) continue;
      valid.add(parent);
      queue.push(parent);
    }
  }

  return prepared
    .filter((group) => valid.has(group.name))
    .map((group) => ({
      ...group,
      members: group.members.filter((member) => (
        member === 'direct' || member === 'reject' || nodeNames.has(member) || valid.has(member)
      )),
    }));
}

function breakReferenceCycles(groups) {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const state = new Map();
  const blocked = new Map();
  for (const root of groups) {
    if (state.has(root.name)) continue;
    state.set(root.name, 1);
    const stack = [{ group: root, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.group.members.length) {
        state.set(frame.group.name, 2);
        stack.pop();
        continue;
      }
      const member = frame.group.members[frame.index++];
      const child = byName.get(member);
      if (!child) continue;
      const childState = state.get(member) || 0;
      if (childState === 1) {
        if (!blocked.has(frame.group.name)) blocked.set(frame.group.name, new Set());
        blocked.get(frame.group.name).add(member);
      } else if (childState === 0) {
        state.set(member, 1);
        stack.push({ group: child, index: 0 });
      }
    }
  }
  return groups.map((group) => ({
    ...group,
    members: blocked.has(group.name)
      ? group.members.filter((member) => !blocked.get(group.name).has(member))
      : group.members,
  }));
}

/** Validate group names/members and break reference cycles before generation. */
function normalizePolicyGroups(input, nodes = []) {
  const nodeValues = Array.isArray(nodes) ? nodes : [];
  const nodeNames = new Set(uniqueNames(nodeValues.map((node) => typeof node === 'string' ? node : node && node.name)));
  const used = new Set();
  const groups = [];
  let remainingMembers = MAX_POLICY_MEMBERS;
  const values = Array.isArray(input) ? input : [];
  const inputLimit = Math.min(values.length, MAX_POLICY_GROUP_INPUTS);
  for (let index = 0; index < inputLimit && groups.length < MAX_POLICY_GROUPS && remainingMembers > 0; index += 1) {
    const group = canonicalGroup(values[index], Math.min(MAX_GROUP_MEMBERS, remainingMembers));
    if (
      !group.name || !group.type || !group.members.length ||
      RESERVED_NAMES_LOWER.has(group.name.toLowerCase()) || nodeNames.has(group.name) || used.has(group.name)
    ) continue;
    used.add(group.name);
    groups.push(group);
    remainingMembers -= group.members.length;
  }

  const pruned = pruneInvalidGroups(groups, nodeNames);
  return pruneInvalidGroups(breakReferenceCycles(pruned), nodeNames).map((group) => {
    const normalized = { ...group };
    if (normalized.default && !normalized.members.includes(normalized.default)) delete normalized.default;
    return normalized;
  });
}

function clashPolicyGroups(input, nodes = []) {
  const nodeValues = Array.isArray(nodes) ? nodes : [];
  const nodeNames = uniqueNames(nodeValues.map((node) => typeof node === 'string' ? node : node && node.name));
  const values = Array.isArray(input) ? input.slice(0, MAX_POLICY_GROUP_INPUTS) : [];
  const groups = values.map((group) => ({
    name: group && group.name,
    type: group && group.type,
    members: [
      ...(group && Array.isArray(group.proxies) ? group.proxies : []),
      ...filteredNodeNames(group, nodeNames),
    ],
    url: group && group.url,
    interval: group && group.interval,
    timeout: group && group.timeout,
    tolerance: group && group.tolerance,
    lazy: group && group.lazy,
    strategy: group && group.strategy,
  }));
  return normalizePolicyGroups(groups, nodeNames);
}

function singboxPolicyGroups(outbounds, nodes = []) {
  const groups = [];
  for (const outbound of Array.isArray(outbounds) ? outbounds : []) {
    const type = String(outbound && outbound.type || '').toLowerCase();
    if (type !== 'selector' && type !== 'urltest') continue;
    groups.push({
      name: outbound.tag,
      type: outbound.type,
      members: outbound.outbounds,
      default: outbound.default,
      url: outbound.url,
      interval: outbound.interval,
      idleTimeout: outbound.idle_timeout,
      tolerance: outbound.tolerance,
      interrupt: outbound.interrupt_exist_connections,
    });
    if (groups.length >= MAX_POLICY_GROUP_INPUTS) break;
  }
  return normalizePolicyGroups(groups, nodes);
}

function singboxPolicyOutbounds(groups, defaultUrl, defaultInterval) {
  return (groups || []).map((group) => {
    if (group.type === 'select') {
      return {
        type: 'selector',
        tag: group.name,
        outbounds: group.members,
        ...(group.default ? { default: group.default } : {}),
        ...(group.interrupt !== undefined ? { interrupt_exist_connections: group.interrupt } : {}),
      };
    }
    // Clash intervals are often large (e.g. 3600). sing-box requires
    // interval <= idle_timeout; a fixed 30m idle would FATAL on start.
    const intervalSec = Math.max(1, Number(group.interval) || Number(defaultInterval) || 60);
    const idleSec = Math.max(
      Math.max(1, Number(group.idleTimeout) || 30 * 60),
      intervalSec
    );
    return {
      type: 'urltest',
      tag: group.name,
      outbounds: group.members,
      url: group.url || defaultUrl,
      interval: `${intervalSec}s`,
      tolerance: group.tolerance !== undefined
        ? group.tolerance
        : group.type === 'fallback' ? 10000 : 50,
      idle_timeout: `${idleSec}s`,
      interrupt_exist_connections: group.interrupt === true,
    };
  });
}

function mihomoPolicyGroups(groups, defaultUrl, defaults = {}) {
  return (groups || []).map((group) => {
    const type = group.type === 'url-test' ? 'url-test' : group.type;
    const members = group.members.map((member) => {
      if (member === 'direct') return 'DIRECT';
      if (member === 'reject') return 'REJECT';
      return member;
    });
    const output = { name: group.name, type, proxies: members };
    if (type !== 'select') {
      output.url = group.url || defaultUrl;
      output.interval = group.interval || defaults.interval;
      output.timeout = group.timeout || defaults.timeout;
      if (group.lazy !== undefined) output.lazy = group.lazy;
      if (group.tolerance !== undefined && type === 'url-test') output.tolerance = group.tolerance;
      if (group.strategy && type === 'load-balance') output.strategy = group.strategy;
    }
    return output;
  });
}

module.exports = {
  normalizePolicyGroups,
  clashPolicyGroups,
  singboxPolicyGroups,
  singboxPolicyOutbounds,
  mihomoPolicyGroups,
};
