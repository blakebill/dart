'use strict';

/**
 * Generate the Dart icons from the designed source art (build/icon-source.webp,
 * a full-bleed graphite canvas with a simplified cyan route/dart mark).
 *
 *   - build/icon.ico  — app/installer icon, multi-size (16/32/48/256), with a
 *                       Windows-friendly transparent rounded mask applied to
 *                       the platform-neutral square source.
 *   - build/icon.png  — 256px PNG of the same (gitignored; a convenience copy).
 *   - src/main/assets/tray-stopped.png — 32px app icon for the stopped state.
 *   - src/main/assets/tray-running.png — the same icon with a green subject.
 *
 * Needs `sharp` (a dev-only tool, not a runtime dependency). If it isn't
 * installed, run:  npm i -D sharp
 *
 * Run: node scripts/make-icon.js
 * Tray only: node scripts/make-icon.js --tray-only
 */

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('This script needs sharp to process the source art.');
  console.error('Install it with:  npm i -D sharp');
  process.exit(1);
}

const BUILD = path.join(__dirname, '..', 'build');
const SRC = path.join(BUILD, 'icon-source.webp');
const TRAY_DIR = path.join(__dirname, '..', 'src', 'main', 'assets');
const ICO_SIZES = [16, 32, 48, 256];
const TRAY_SIZE = 32;
const WORK = 1024; // working resolution for the app icon
const MARGIN = 16; // rounded-mask inset (WORK space)
const RADIUS = 232; // rounded-mask corner radius (WORK space)
const TRAY_ONLY = process.argv.includes('--tray-only');

/** Wrap PNG buffers into a multi-image ICO container (PNG-in-ICO, Vista+). */
function wrapIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + 16 * entries.length;
  for (const { png, size } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 => 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(e);
  }
  return Buffer.concat([header, ...dirs, ...entries.map((x) => x.png)]);
}

/** Read one PNG layer from the existing app ICO. */
function readIcoPng(file, wantedSize = 256) {
  const ico = fs.readFileSync(file);
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    if (size !== wantedSize) continue;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    return ico.subarray(offset, offset + length);
  }
  throw new Error(`Missing ${wantedSize}px layer in ${file}`);
}

/**
 * The app icon uses the opaque, full-bleed source as-is with a small saturation
 * nudge. The rounded alpha mask is applied only to the Windows ICO output, so
 * the source stays reusable on platforms that provide their own icon mask.
 * Returns a WORK-sized RGBA PNG buffer.
 */
async function appIcon() {
  const mask = Buffer.from(
    `<svg width="${WORK}" height="${WORK}"><rect x="${MARGIN}" y="${MARGIN}" ` +
      `width="${WORK - 2 * MARGIN}" height="${WORK - 2 * MARGIN}" ` +
      `rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`
  );
  return sharp(SRC)
    .resize(WORK, WORK)
    .modulate({ saturation: 1.06 })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/** Re-hue only the cyan/blue subject while preserving its highlights/shadows. */
async function runningIcon(icon) {
  const { data, info } = await sharp(icon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (b - (r + g) / 2 <= 14 || max - min <= 20) continue;

    const value = max / 255;
    const saturation = Math.max(0.62, Math.min(0.9, max ? (max - min) / max : 0));
    const chroma = value * saturation;
    const x = chroma * 0.28; // hue 137° lies 28% into the green→cyan sector
    const m = value - chroma;
    data[i] = Math.round(m * 255);
    data[i + 1] = Math.round((chroma + m) * 255);
    data[i + 2] = Math.round((x + m) * 255);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing source art: ' + SRC);
    process.exit(1);
  }

  let icon;
  if (TRAY_ONLY) {
    icon = readIcoPng(path.join(BUILD, 'icon.ico'));
  } else {
    icon = await appIcon();
    const entries = [];
    for (const size of ICO_SIZES) {
      entries.push({ size, png: await sharp(icon).resize(size, size).png({ compressionLevel: 9 }).toBuffer() });
    }
    const ico = wrapIco(entries);
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);
    fs.writeFileSync(path.join(BUILD, 'icon.png'), entries.find((e) => e.size === 256).png);
    console.log('Wrote build/icon.ico (' + ico.length + ' bytes, ' + ICO_SIZES.join('/') + ') and build/icon.png');
  }

  fs.mkdirSync(TRAY_DIR, { recursive: true });
  const stoppedTray = await sharp(icon).resize(TRAY_SIZE, TRAY_SIZE).png({ compressionLevel: 9 }).toBuffer();
  const runningTray = await sharp(await runningIcon(icon)).resize(TRAY_SIZE, TRAY_SIZE).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(path.join(TRAY_DIR, 'tray-stopped.png'), stoppedTray);
  fs.writeFileSync(path.join(TRAY_DIR, 'tray-running.png'), runningTray);
  console.log('Wrote matching stopped/running tray icons to src/main/assets');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
