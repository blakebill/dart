'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function normalizeSha256(value) {
  const digest = String(value || '').trim().replace(/^sha256:/i, '');
  return SHA256_PATTERN.test(digest) ? digest.toLowerCase() : null;
}

function assetSha256(asset) {
  return normalizeSha256(asset && asset.digest);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFileSha256(filePath, expected, label = path.basename(filePath)) {
  const normalized = normalizeSha256(expected);
  if (!normalized) throw new Error(`missing SHA-256 digest for ${label}`);
  const actual = await sha256File(filePath);
  if (actual !== normalized) {
    throw new Error(`SHA-256 mismatch for ${label} (expected ${normalized}, got ${actual})`);
  }
  return actual;
}

function parseSha256Sums(text) {
  const sums = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let match = line.match(/^([a-f0-9]{64})\s+[*]?(.+)$/i);
    if (!match) match = line.match(/^SHA256\s*\((.+)\)\s*=\s*([a-f0-9]{64})$/i);
    if (!match) continue;
    const digestFirst = SHA256_PATTERN.test(match[1]);
    const file = path.basename(String(digestFirst ? match[2] : match[1]).trim());
    const digest = normalizeSha256(digestFirst ? match[1] : match[2]);
    if (file && digest) sums.set(file, digest);
  }
  return sums;
}

module.exports = {
  assetSha256,
  normalizeSha256,
  parseSha256Sums,
  sha256File,
  verifyFileSha256,
};
