'use strict';

/**
 * Generate the Dart icons from the designed source art (build/icon-source.webp,
 * a glassy crystal swift on a gradient-white rounded square).
 *
 *   - build/icon.ico  — app/installer icon, multi-size (16/32/48/256). A lightly
 *                       flattened version of the source (glassy micro-gradients
 *                       banded into flatter colour regions, blues nudged up),
 *                       with the corners rounded to transparency so it shows as
 *                       a rounded icon rather than a white square.
 *   - build/icon.png  — 256px PNG of the same (gitignored; a convenience copy).
 *   - tray data URL   — printed to stdout: a SOLID blue swift silhouette lifted
 *                       from the source (keyed by saturation, morphologically
 *                       closed, largest blob kept), so it stays legible on light
 *                       AND dark system trays. 32x32. Paste into src/main/tray.js.
 *
 * Needs `sharp` (a dev-only tool, not a runtime dependency). If it isn't
 * installed, run:  npm i -D sharp
 *
 * Run: node scripts/make-icon.js
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
const ICO_SIZES = [16, 32, 48, 256];
const WORK = 1024; // working resolution for the app icon
const MARGIN = 16; // rounded-mask inset (WORK space)
const RADIUS = 232; // rounded-mask corner radius (WORK space)

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

/**
 * The app icon: the source artwork (a vivid solid-blue swift with speed lines
 * on white) used as-is, with only a small saturation nudge, and a rounded-rect
 * alpha mask so the corners are transparent (the source is an opaque square)
 * and it shows as a proper rounded icon. Returns a WORK-sized RGBA PNG buffer.
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

// --- tiny morphology on a binary mask (Uint8Array, S×S) -------------------
function dilate(src, S, R) {
  const dst = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (let dy = -R; dy <= R && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= S) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= S) continue;
          if (src[yy * S + xx]) {
            v = 1;
            break;
          }
        }
      }
      dst[y * S + x] = v;
    }
  }
  return dst;
}
function erode(src, S, R) {
  const dst = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 1;
      for (let dy = -R; dy <= R && v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= S) {
          v = 0;
          break;
        }
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= S || !src[yy * S + xx]) {
            v = 0;
            break;
          }
        }
      }
      dst[y * S + x] = v;
    }
  }
  return dst;
}

/** Keep only the largest 4-connected blob of a binary mask. */
function largestBlob(src, S) {
  const lab = new Int32Array(S * S);
  const sizes = [0];
  const st = [];
  let cur = 0;
  for (let i = 0; i < S * S; i++) {
    if (src[i] && !lab[i]) {
      cur++;
      sizes.push(0);
      st.length = 0;
      st.push(i);
      lab[i] = cur;
      while (st.length) {
        const p = st.pop();
        sizes[cur]++;
        const x = p % S;
        const y = (p / S) | 0;
        if (x > 0 && src[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; st.push(p - 1); }
        if (x < S - 1 && src[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; st.push(p + 1); }
        if (y > 0 && src[p - S] && !lab[p - S]) { lab[p - S] = cur; st.push(p - S); }
        if (y < S - 1 && src[p + S] && !lab[p + S]) { lab[p + S] = cur; st.push(p + S); }
      }
    }
  }
  let best = 1;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[best]) best = c;
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = lab[i] === best ? 1 : 0;
  return out;
}

/** Fill interior holes: flood the background in from the border; unreached
 * background pixels are enclosed holes and get set. */
function fillHoles(src, S) {
  const reach = new Uint8Array(S * S);
  const st = [];
  const seed = (i) => {
    if (!src[i] && !reach[i]) {
      reach[i] = 1;
      st.push(i);
    }
  };
  for (let x = 0; x < S; x++) { seed(x); seed(x + (S - 1) * S); }
  for (let y = 0; y < S; y++) { seed(y * S); seed(y * S + S - 1); }
  while (st.length) {
    const p = st.pop();
    const x = p % S;
    const y = (p / S) | 0;
    if (x > 0) seed(p - 1);
    if (x < S - 1) seed(p + 1);
    if (y > 0) seed(p - S);
    if (y < S - 1) seed(p + S);
  }
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = src[i] || !reach[i] ? 1 : 0;
  return out;
}

/**
 * A solid swift silhouette, full-canvas at `S`×`S` and aligned to the source.
 * The bird is keyed by "blueness" (b − (r+g)/2): the near-neutral white panel
 * scores ~5–11 while every part of the bird — including the very pale upper
 * wing — scores ≥18, so a threshold of 20 captures the whole bird where a
 * saturation key dropped the pale wing. Keeping the largest connected blob
 * drops the detached speed-line dashes (a morphological close is deliberately
 * NOT applied first, since dilating would reconnect them); a close afterward
 * and a hole-fill tidy the bird's own edges and seams. Filled flat brand-blue.
 * Used as the app-icon overlay (at WORK) and, trimmed/centred, as the tray.
 */
async function swiftSilhouette(S = 512) {
  const { data } = await sharp(SRC)
    .resize(S, S)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bin = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    bin[i] = b - (r + g) / 2 > 20 ? 1 : 0;
  }

  let m = largestBlob(bin, S); // drop the disconnected speed-line dashes
  const R = Math.max(1, Math.round((2 * S) / 512));
  m = fillHoles(erode(dilate(m, S, R), S, R), S); // close seams, fill holes

  // Flat brand blue, identical for the app icon and the tray so they match
  // exactly. This is Display-P3 (50,150,250) converted to sRGB; that P3 blue
  // is outside the sRGB gamut, so R/B clamp and it lands on #0099ff.
  const FILL = [0, 153, 255];
  const out = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = FILL[0];
    out[i * 4 + 1] = FILL[1];
    out[i * 4 + 2] = FILL[2];
    out[i * 4 + 3] = m[i] ? 255 : 0;
  }
  return sharp(out, { raw: { width: S, height: S, channels: 4 } }).blur(0.7).png().toBuffer();
}

/** Trim transparent border, square with a little padding, resize to `size`. */
async function squareResize(png, size, pad = 1.12) {
  const trimmed = await sharp(png).trim({ threshold: 10 }).toBuffer();
  const m = await sharp(trimmed).metadata();
  const side = Math.round(Math.max(m.width, m.height) * pad);
  // Materialise the padded square before resizing: in a single sharp pipeline
  // resize runs BEFORE extend regardless of call order, which would pad the
  // already-shrunk icon and blow the dimensions out. Two passes avoid that.
  const padded = await sharp(trimmed)
    .extend({
      top: Math.floor((side - m.height) / 2),
      bottom: Math.ceil((side - m.height) / 2),
      left: Math.floor((side - m.width) / 2),
      right: Math.ceil((side - m.width) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp(padded).resize(size, size, { fit: 'fill' }).png({ compressionLevel: 9 }).toBuffer();
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing source art: ' + SRC);
    process.exit(1);
  }

  const icon = await appIcon();
  const entries = [];
  for (const size of ICO_SIZES) {
    entries.push({ size, png: await sharp(icon).resize(size, size).png({ compressionLevel: 9 }).toBuffer() });
  }
  const ico = wrapIco(entries);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);
  fs.writeFileSync(path.join(BUILD, 'icon.png'), entries.find((e) => e.size === 256).png);
  console.log('Wrote build/icon.ico (' + ico.length + ' bytes, ' + ICO_SIZES.join('/') + ') and build/icon.png');

  const tray = await squareResize(await swiftSilhouette(), 32);
  console.log('\nTray data URL (paste into src/main/tray.js):');
  console.log('data:image/png;base64,' + tray.toString('base64'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
