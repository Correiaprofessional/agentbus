#!/usr/bin/env node
/**
 * Draws the agentbus mark and writes every size macOS wants.
 *
 * Zero dependencies: the shapes are rasterised with 4x supersampling and encoded
 * as PNG with node:zlib, so the icon can be rebuilt anywhere Node runs.
 *
 * The mark is three agents on one line — a bus — in the same colours the board
 * uses for tools, on a dark rounded tile.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const ICONSET = path.join(DESKTOP, 'AgentBus.iconset');

const BG = [15, 19, 26, 255];
const LINE = [59, 71, 96, 255];
const DOTS = [
  [139, 123, 255, 255], // violet
  [45, 212, 191, 255], // teal
  [251, 191, 36, 255], // amber
];

/* ------------------------------------------------------------------ geometry */

const insideCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function insideRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const rx = Math.min(Math.max(x, radius), size - radius);
  const ry = Math.min(Math.max(y, radius), size - radius);
  return (x - rx) ** 2 + (y - ry) ** 2 <= radius * radius;
}

function insideCapsule(x, y, x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy || 1;
  let t = ((x - x1) * dx + (y - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return (x - px) ** 2 + (y - py) ** 2 <= r * r;
}

/* ------------------------------------------------------------------ raster */

const SS = 4; // supersampling factor per axis

/** Paint `size`x`size` RGBA by testing shapes at SSxSS subpixel positions. */
function render(size, paint) {
  const out = Buffer.alloc(size * size * 4, 0);
  const step = 1 / SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const color = paint(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          if (!color) continue;
          r += color[0] * (color[3] / 255);
          g += color[1] * (color[3] / 255);
          b += color[2] * (color[3] / 255);
          a += color[3];
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const index = (y * size + x) * 4;
      if (alpha > 0) {
        const weight = a / 255 || 1;
        out[index] = Math.round(r / weight);
        out[index + 1] = Math.round(g / weight);
        out[index + 2] = Math.round(b / weight);
      }
      out[index + 3] = Math.round(alpha);
    }
  }
  return out;
}

/** The app tile: a dark rounded square with three agents on one bus line. */
function paintIcon(x, y, size) {
  const radius = size * 0.225;
  if (!insideRoundedRect(x, y, size, radius)) return null;

  const cy = size / 2;
  const centers = [size * 0.26, size * 0.5, size * 0.74];
  const dotR = size * 0.086;
  const gap = size * 0.013;
  const lineR = size * 0.03;

  if (insideCapsule(x, y, centers[0], cy, centers[2], cy, lineR)) {
    // Dots sit on the line, separated by a ring in the background colour so the
    // shapes stay legible at 16px.
    for (let i = 0; i < centers.length; i += 1) {
      if (!insideCircle(x, y, centers[i], cy, dotR + gap)) continue;
      return insideCircle(x, y, centers[i], cy, dotR) ? DOTS[i] : BG;
    }
    return LINE;
  }

  for (let i = 0; i < centers.length; i += 1) {
    if (insideCircle(x, y, centers[i], cy, dotR)) return DOTS[i];
  }
  return BG;
}

/** Menu bar template: a solid silhouette the system tints for light and dark. */
function paintTemplate(x, y, size) {
  const cy = size / 2;
  const centers = [size * 0.15, size * 0.5, size * 0.85];
  const dotR = size * 0.15;

  if (insideCapsule(x, y, centers[0], cy, centers[2], cy, size * 0.05)) return [0, 0, 0, 255];
  for (const cx of centers) {
    if (insideCircle(x, y, cx, cy, dotR)) return [0, 0, 0, 255];
  }
  return null;
}

/* ---------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------------- main */

fs.mkdirSync(ICONSET, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const cache = new Map();
for (const size of sizes) {
  const buffer = png(size, render(size, paintIcon));
  cache.set(size, buffer);
  if (size !== 1024) fs.writeFileSync(path.join(DESKTOP, `icon-${size}.png`), buffer);
}
fs.writeFileSync(path.join(DESKTOP, 'icon-1024.png'), cache.get(1024));

const iconsetFiles = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
for (const [name, size] of iconsetFiles) {
  fs.writeFileSync(path.join(ICONSET, name), cache.get(size));
}

const iconset = spawnSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(DESKTOP, 'AgentBus.icns')], {
  encoding: 'utf8',
});
if (iconset.status !== 0) {
  console.error(`iconutil failed: ${iconset.stderr || iconset.stdout}`);
  process.exitCode = 1;
}

// Menu bar template images (the system tints black + alpha).
for (const [name, size] of [['MenuBarTemplate.png', 18], ['MenuBarTemplate@2x.png', 36]]) {
  fs.writeFileSync(path.join(DESKTOP, name), png(size, render(size, paintTemplate)));
}

// One copy for the README.
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.copyFileSync(path.join(DESKTOP, 'icon-1024.png'), path.join(ROOT, 'docs', 'icon.png'));

console.log(`icon written: desktop/AgentBus.icns, desktop/icon-*.png, docs/icon.png`);
