'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_PROXY_PROVIDERS = 4096;
const MAX_PROVIDER_NODES = 20000;
const MAX_CONFIG_DEPTH = 24;
const MAX_ARRAY_ITEMS = 100000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function cleanProviderName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 256 && !/[\r\n,\0]/.test(name) ? name : '';
}

function cloneConfigValue(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= MAX_CONFIG_DEPTH) throw new Error('proxy-provider nesting is too deep');
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new Error('proxy-provider array is too large');
    return value.map((item) => cloneConfigValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const cloned = cloneConfigValue(item, depth + 1);
    if (cloned !== undefined) out[key] = cloned;
  }
  return out;
}

function safeHttpUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 16384 || /[\r\n\0]/.test(text)) return '';
  try {
    const protocol = new URL(text).protocol;
    return protocol === 'http:' || protocol === 'https:' ? text : '';
  } catch (_) {
    return '';
  }
}

/**
 * Provider cache files are resolved by Mihomo relative to its own HomeDir.
 * Never carry an imported absolute path, drive path, UNC path or traversal
 * into Dart's generated runtime config. HTTP providers can safely omit an
 * unsafe path because Mihomo derives a cache filename from the URL.
 */
function safeProviderPath(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 1024 || /[\r\n\0]/.test(text)) return '';
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(text)) return '';
  // Colons are path separators for Windows alternate data streams. Provider
  // paths are portable relative paths, so there is no legitimate reason to
  // retain one on any platform.
  if (text.includes(':')) return '';
  const parts = text.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) return '';
  return parts.filter((part) => part && part !== '.').join('/');
}

/**
 * Preserve native Mihomo provider definitions while enforcing the only
 * boundaries Dart must own: supported provider transports, fetch URL scheme,
 * prototype-safe data and paths confined to Mihomo's working directory.
 */
function normalizeProxyProviders(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [rawName, rawDefinition] of Object.entries(input)) {
    if (count >= MAX_PROXY_PROVIDERS) break;
    const name = cleanProviderName(rawName);
    if (!name || FORBIDDEN_KEYS.has(name) || !rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) {
      continue;
    }
    let definition;
    try {
      definition = cloneConfigValue(rawDefinition);
    } catch (_) {
      continue;
    }
    const type = String(definition.type || '').trim().toLowerCase();
    if (!['http', 'file', 'inline'].includes(type)) continue;
    definition.type = type;

    const providerPath = safeProviderPath(definition.path);
    if (type === 'http') {
      const url = safeHttpUrl(definition.url);
      if (!url) continue;
      definition.url = url;
      if (providerPath) definition.path = providerPath;
      else delete definition.path;
    } else if (type === 'file') {
      // A local provider outside HomeDir would either fail validation or make
      // SAFE_PATHS broader than the application owns. Do neither silently.
      if (!providerPath) continue;
      definition.path = providerPath;
      delete definition.url;
    } else {
      if (!Array.isArray(definition.payload) || !definition.payload.length) continue;
      delete definition.url;
      delete definition.path;
    }
    out[name] = definition;
    count += 1;
  }
  return out;
}

function proxyProviderNames(value) {
  return Object.keys(normalizeProxyProviders(value));
}

function hasProxyProviders(value) {
  return Object.keys(normalizeProxyProviders(value)).length > 0;
}

/**
 * A file provider can only work when its source is already inside Mihomo's
 * HomeDir. Dart cannot infer or safely copy an arbitrary relative path from a
 * pasted/remote profile. Preserve the definition for editing and backups, but
 * fail startup explicitly instead of letting Mihomo fail later with a vague
 * missing-file error.
 */
function unavailableProviderFiles(value, homeDir) {
  const definitions = normalizeProxyProviders(value);
  const requestedBase = path.resolve(String(homeDir || ''));
  let base = requestedBase;
  try {
    // macOS exposes /var through /private/var; canonicalizing the base before
    // comparing candidate realpaths avoids treating that system symlink as an
    // escape from HomeDir.
    base = fs.realpathSync(requestedBase);
  } catch (_) {
    // A missing HomeDir makes every file provider unavailable below.
  }
  const unavailable = [];
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.type !== 'file') continue;
    const relativePath = safeProviderPath(definition.path);
    const candidate = path.resolve(base, relativePath);
    const relative = path.relative(base, candidate);
    let available = !!relativePath && relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    try {
      if (available) {
        const stat = fs.statSync(candidate);
        available = stat.isFile();
        if (available) {
          const real = fs.realpathSync(candidate);
          const realRelative = path.relative(base, real);
          available = !!realRelative && !realRelative.startsWith('..' + path.sep) && !path.isAbsolute(realRelative);
        }
      }
    } catch (_) {
      available = false;
    }
    if (!available) unavailable.push({ name, path: relativePath || String(definition.path || '') });
  }
  return unavailable;
}

function providerNodeId(profileId, providerName, runtimeName) {
  return 'provider:' + crypto.createHash('sha256')
    .update(String(profileId || ''))
    .update('\0')
    .update(providerName)
    .update('\0')
    .update(runtimeName)
    .digest('hex')
    .slice(0, 32);
}

function cleanRuntimeToken(value, max = 256) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max && !/[\r\n\0]/.test(text) ? text : '';
}

/**
 * Convert `/providers/proxies` into a bounded, credential-free inventory.
 * Inline nodes win collisions, followed by provider order from the config.
 * Mihomo selectors address members by runtime name, so duplicate names cannot
 * be selected independently; collapsing them is safer than showing two cards
 * that would operate on an ambiguous global name.
 */
function runtimeProviderInventory(configured, response, inlineNodes = [], profileId = '') {
  const definitions = normalizeProxyProviders(configured);
  const providerMap = response && response.providers && typeof response.providers === 'object'
    ? response.providers
    : {};
  const seen = new Set(
    (Array.isArray(inlineNodes) ? inlineNodes : [])
      .map((node) => cleanRuntimeToken(node && node.name))
      .filter(Boolean)
  );
  const nodes = [];
  const providers = [];
  const collisions = [];

  for (const providerName of Object.keys(definitions)) {
    const runtime = providerMap[providerName];
    const source = Array.isArray(runtime && runtime.proxies) ? runtime.proxies : [];
    let accepted = 0;
    for (const proxy of source) {
      if (nodes.length >= MAX_PROVIDER_NODES) break;
      if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) continue;
      const name = cleanRuntimeToken(proxy.name);
      if (!name) continue;
      if (seen.has(name)) {
        if (collisions.length < 256) collisions.push({ name, provider: providerName });
        continue;
      }
      seen.add(name);
      accepted += 1;
      nodes.push({
        id: providerNodeId(profileId, providerName, name),
        name,
        type: cleanRuntimeToken(proxy.type, 64).toLowerCase(),
        provider: providerName,
        providerNode: true,
        alive: typeof proxy.alive === 'boolean' ? proxy.alive : undefined,
      });
    }
    providers.push({
      name: providerName,
      state: source.length ? 'ready' : (runtime ? 'loading' : 'loading'),
      nodeCount: accepted,
      updatedAt: cleanRuntimeToken(runtime && runtime.updatedAt, 128),
    });
  }

  const ready = providers.filter((provider) => provider.state === 'ready').length;
  return {
    nodes,
    status: {
      configured: providers.length,
      ready,
      loading: providers.length - ready,
      nodeCount: nodes.length,
      collisionCount: collisions.length,
      collisions,
      providers,
    },
  };
}

module.exports = {
  MAX_PROXY_PROVIDERS,
  MAX_PROVIDER_NODES,
  cleanProviderName,
  cloneConfigValue,
  safeProviderPath,
  normalizeProxyProviders,
  proxyProviderNames,
  hasProxyProviders,
  unavailableProviderFiles,
  providerNodeId,
  runtimeProviderInventory,
};
