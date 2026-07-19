'use strict';

const { dnsServerFromAddress } = require('./converter');

const VALID_TARGETS = ['proxy', 'direct', 'reject'];
const VALID_CRS_FORMATS = ['clash', 'sing-box'];
const VALID_SUBSCRIPTION_UA_MODES = ['auto', 'sing-box', 'clash'];
const VALID_MODES = ['rule', 'global', 'direct', 'block'];
const MAX_IPC_CONNECTIONS = 300;
const MAX_CONFIG_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_AUTO_UPDATE_MINUTES = 365 * 24 * 60;

const SETTING_KEYS = new Set([
  'mixedPort', 'clashApiPort', 'enableClashApi', 'logLevel',
  'autoSetSystemProxy', 'autoLaunch', 'silentStart', 'notifications', 'enableIpv6',
  'dnsRemote', 'dnsLocal', 'dnsStrategy', 'language', 'theme', 'clashMode',
  'testUrl', 'testConcurrency', 'useBuiltinRules', 'ruleOverrides', 'coreType',
]);

const CORE_CONFIG_SETTINGS = new Set([
  'mixedPort', 'clashApiPort', 'enableClashApi', 'logLevel', 'autoSetSystemProxy',
  'enableIpv6', 'dnsRemote', 'dnsLocal', 'dnsStrategy', 'useBuiltinRules',
  'ruleOverrides', 'coreType', 'testUrl',
]);

function reqStr(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid ' + name);
  return value;
}

function reqUrl(value, name) {
  reqStr(value, name);
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('invalid ' + name);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(name + ' must be an http(s) URL');
  }
  return value;
}

function reqEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error('invalid ' + name);
  return value;
}

function reqBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error('invalid ' + name);
  return value;
}

function reqAutoUpdateMinutes(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_AUTO_UPDATE_MINUTES) {
    throw new Error('invalid autoUpdateMinutes');
  }
  return value;
}

function reqConfigText(value) {
  reqStr(value, 'content');
  if (Buffer.byteLength(value, 'utf-8') > MAX_CONFIG_INPUT_BYTES) {
    throw new Error('config content exceeds 32 MB');
  }
  return value;
}

function recentConnections(items, limit) {
  const keyEntry = (item) => ({ item, key: String(item.start || '') + '\0' + String(item.id || '') });
  if (items.length <= limit) {
    return items.map(keyEntry).sort((a, b) => b.key.localeCompare(a.key)).map((entry) => entry.item);
  }
  const heap = [];
  const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; };
  const siftUp = (index) => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].key.localeCompare(heap[index].key) <= 0) break;
      swap(parent, index);
      index = parent;
    }
  };
  const siftDown = (index) => {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && heap[left].key.localeCompare(heap[smallest].key) < 0) smallest = left;
      if (right < heap.length && heap[right].key.localeCompare(heap[smallest].key) < 0) smallest = right;
      if (smallest === index) return;
      swap(index, smallest);
      index = smallest;
    }
  };
  for (const item of items) {
    const entry = keyEntry(item);
    if (heap.length < limit) {
      heap.push(entry);
      siftUp(heap.length - 1);
    } else if (entry.key.localeCompare(heap[0].key) > 0) {
      heap[0] = entry;
      siftDown(0);
    }
  }
  return heap.sort((a, b) => b.key.localeCompare(a.key)).map((entry) => entry.item);
}

function validateSettingsPatch(patch, current) {
  for (const key of ['mixedPort', 'clashApiPort']) {
    if (!(key in patch)) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 65535) {
      throw new Error(`invalid ${key}`);
    }
  }
  for (const key of [
    'enableClashApi', 'autoSetSystemProxy', 'autoLaunch', 'silentStart', 'enableTun',
    'notifications', 'enableIpv6', 'useBuiltinRules',
  ]) {
    if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`invalid ${key}`);
  }
  if ('coreType' in patch) reqEnum(patch.coreType, ['sing-box', 'mihomo'], 'coreType');
  if ('logLevel' in patch) reqEnum(patch.logLevel, ['trace', 'debug', 'info', 'warn', 'error'], 'logLevel');
  if ('dnsStrategy' in patch) {
    reqEnum(patch.dnsStrategy, ['prefer_ipv4', 'prefer_ipv6', 'ipv4_only', 'ipv6_only'], 'dnsStrategy');
  }
  if ('language' in patch) reqEnum(patch.language, ['zh', 'en'], 'language');
  if ('theme' in patch) reqEnum(patch.theme, ['dark', 'light', 'system'], 'theme');
  if ('clashMode' in patch) reqEnum(patch.clashMode, VALID_MODES, 'clashMode');
  for (const key of ['dnsRemote', 'dnsLocal']) {
    if (!(key in patch)) continue;
    const value = reqStr(patch[key], key).trim();
    const allowedScheme = /^(?:https|tls|quic|h3|http3|tcp|udp):\/\//i.test(value);
    if (
      /\s/.test(value) ||
      (value.includes('://') && !allowedScheme) ||
      !/^(?:(?:https|tls|quic|h3|http3|tcp|udp):\/\/)?[^/]+(?:\/\S*)?$/i.test(value)
    ) throw new Error('invalid ' + key);
    patch[key] = value;
    dnsServerFromAddress(value, 'validate');
  }
  if ('testUrl' in patch && patch.testUrl) reqUrl(patch.testUrl, 'testUrl');
  if ('testConcurrency' in patch && (
    !Number.isInteger(patch.testConcurrency) || patch.testConcurrency < 1 || patch.testConcurrency > 32
  )) throw new Error('invalid testConcurrency');
  if ('ruleOverrides' in patch) {
    if (!patch.ruleOverrides || typeof patch.ruleOverrides !== 'object' || Array.isArray(patch.ruleOverrides)) {
      throw new Error('invalid ruleOverrides');
    }
    for (const value of Object.values(patch.ruleOverrides)) reqEnum(value, VALID_TARGETS, 'ruleOverrides');
  }
  const next = { ...current, ...patch };
  if (next.enableClashApi && next.mixedPort === next.clashApiPort) {
    throw new Error('mixedPort and clashApiPort must be different');
  }
}

module.exports = {
  CORE_CONFIG_SETTINGS,
  MAX_IPC_CONNECTIONS,
  SETTING_KEYS,
  VALID_CRS_FORMATS,
  VALID_MODES,
  VALID_SUBSCRIPTION_UA_MODES,
  VALID_TARGETS,
  recentConnections,
  reqAutoUpdateMinutes,
  reqBoolean,
  reqConfigText,
  reqEnum,
  reqStr,
  reqUrl,
  validateSettingsPatch,
};
