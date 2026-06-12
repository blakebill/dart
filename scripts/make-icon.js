'use strict';

/**
 * Generate the Dart app icon (build/icon.ico) with no external deps.
 *
 * Draws a rounded-rectangle with a blue/indigo gradient and a white dart
 * (a sharp arrow streaking to the upper-right — "to dart"), encodes it as
 * PNG, and wraps the PNG in an ICO container (PNG-in-ICO, Windows Vista+).
 * Also prints a 32px tray PNG as a data URL for src/main/tray.js.
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// CRC32 (for PNG chunks)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// The dart: a sharp arrow, defined pointing right in a unit space centered at
// the origin, then rotated 45° to streak toward the upper-right. The notched
// tail gives it a thrown-dart silhouette rather than a plain arrow.
const DART = [
  [1.0, 0.0], // tip
  [0.16, -0.62], // upper barb
  [0.16, -0.24], // upper neck
  [-0.96, -0.24], // upper tail
  [-0.66, 0.0], // tail notch
  [-0.96, 0.24], // lower tail
  [0.16, 0.24], // lower neck
  [0.16, 0.62], // lower barb
];
const ANG = -Math.PI / 4; // rotate to point up-right
const COS = Math.cos(ANG);
const SIN = Math.sin(ANG);

/** Map the unit dart polygon into pixel space for a given canvas size. */
function dartPolygon(size) {
  const scale = size * 0.36;
  const cx = size / 2;
  const cy = size / 2;
  return DART.map(([x, y]) => [cx + (x * COS - y * SIN) * scale, cy + (x * SIN + y * COS) * scale]);
}

/** Even-odd ray cast: is point (px,py) inside polygon? */
function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Build a size×size RGBA pixel buffer: gradient rounded-rect + white dart. */
function renderPixels(size) {
  const px = Buffer.alloc(size * size * 4);
  const top = [96, 165, 250]; // #60a5fa
  const bottom = [99, 102, 241]; // #6366f1
  const radius = Math.round(size * 0.2);
  const poly = dartPolygon(size);
  const SS = 3; // supersampling factor for dart-edge anti-aliasing

  for (let y = 0; y < size; y++) {
    const tg = y / (size - 1);
    const bgR = lerp(top[0], bottom[0], tg);
    const bgG = lerp(top[1], bottom[1], tg);
    const bgB = lerp(top[2], bottom[2], tg);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Rounded-rect mask: alpha 0 outside the rounded corners.
      let alpha = 255;
      const rx = Math.min(x, size - 1 - x);
      const ry = Math.min(y, size - 1 - y);
      if (rx < radius && ry < radius) {
        const dx = radius - rx;
        const dy = radius - ry;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) alpha = 0;
        else if (dist > radius - 1.5) alpha = Math.round(((radius - dist) / 1.5) * 255);
      }

      // Dart coverage via supersampling, then blend white over the gradient.
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inPolygon(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, poly)) hits++;
        }
      }
      const mix = hits / (SS * SS);
      px[i] = lerp(bgR, 255, mix);
      px[i + 1] = lerp(bgG, 255, mix);
      px[i + 2] = lerp(bgB, 255, mix);
      px[i + 3] = alpha;
    }
  }
  return px;
}

/** Encode a size×size RGBA buffer as a PNG buffer. */
function encodePng(rgba, size) {
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Add a filter byte (0 = none) at the start of each scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Wrap a PNG buffer into an ICO container (single image). */
function wrapIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 => 256
  entry[1] = 0; // height 0 => 256
  entry[2] = 0; // colors in palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image size
  entry.writeUInt32LE(6 + 16, 12); // offset to image data

  return Buffer.concat([header, entry, png]);
}

function main() {
  const buildDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  const png = encodePng(renderPixels(SIZE), SIZE);
  const ico = wrapIco(png);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
  console.log('Wrote build/icon.ico (' + ico.length + ' bytes) and build/icon.png');

  // The tray icon is embedded in src/main/tray.js as a 32px data URL; print it
  // here so a future icon change can be copied straight in.
  const tray = encodePng(renderPixels(32), 32);
  console.log('\nTray data URL (paste into src/main/tray.js):');
  console.log('data:image/png;base64,' + tray.toString('base64'));
}

main();
