// Generates the extension's PNG icons (no dependencies): `node tools/make-icons.js`
//   icon-on    blue shield + check   — protecting this site
//   icon-off   gray shield + check   — default / not active on this site
//   icon-spot  gray shield + amber dot — "this page looks like an AI chat"
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "ai-privacy-guard", "icons");
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling per axis, for anti-aliased edges

const BLUE = [42, 120, 214];
const SLATE = [110, 116, 128];
const WHITE = [255, 255, 255];
const AMBER = [250, 178, 25];

// ---------- Geometry (unit square, y down) ----------

function quad(p0, c, p1, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps,
      u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return pts;
}

const right = [[0.5, 0.05], [0.88, 0.17], [0.88, 0.46], ...quad([0.88, 0.46], [0.87, 0.8], [0.5, 0.96], 16)];
const SHIELD = [
  ...right,
  ...right
    .slice(1, -1)
    .reverse()
    .map(([x, y]) => [1 - x, y]),
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const CHECK = [
  [0.31, 0.52],
  [0.45, 0.66],
  [0.7, 0.37],
];
function onCheck(x, y, width) {
  return distToSegment(x, y, CHECK[0], CHECK[1]) < width / 2 || distToSegment(x, y, CHECK[1], CHECK[2]) < width / 2;
}

const DOT = { cx: 0.8, cy: 0.22, r: 0.19, ring: 0.26 };

// Returns [r,g,b,a] (a in 0..1) for one sample point.
function sample(variant, x, y, size) {
  const checkWidth = size <= 16 ? 0.13 : size <= 32 ? 0.11 : 0.09;
  if (variant === "spot") {
    const d = Math.hypot(x - DOT.cx, y - DOT.cy);
    if (d < DOT.r) return [...AMBER, 1];
    if (d < DOT.ring) return [0, 0, 0, 0]; // transparent ring separates dot from shield
  }
  if (!inPolygon(x, y, SHIELD)) return [0, 0, 0, 0];
  if (onCheck(x, y, checkWidth)) return [...WHITE, 1];
  return [...(variant === "on" ? BLUE : SLATE), 1];
}

// ---------- Raster + PNG ----------

function render(variant, size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample(variant, (pxx + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, size);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (py * size + pxx) * 4;
      const n = SS * SS;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const variant of ["on", "off", "spot"]) {
  for (const size of SIZES) {
    const file = path.join(OUT, `icon-${variant}-${size}.png`);
    fs.writeFileSync(file, encodePng(size, render(variant, size)));
  }
}
console.log("icons written to", OUT);
