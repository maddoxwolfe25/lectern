// Generates icon.png (512px) and icon.ico (256/128/64/48/32/16, PNG-compressed) without any dependencies.
// The mark: an amber rounded square carrying three dark "voice" bars — the same equaliser the app shows while reading.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AMBER = [240, 182, 74];
const INK = [23, 28, 36];

function drawIcon(size) {
  const ss = 4;                                 // supersampling factor for smooth edges
  const S = size * ss;
  const px = new Float32Array(S * S);           // coverage of INK over AMBER (0..1); -1 = transparent
  const radius = S * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), S - radius);
    const cy = Math.min(Math.max(y, radius), S - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };
  const bars = [
    { cx: 0.32, h: 0.30 },
    { cx: 0.50, h: 0.56 },
    { cx: 0.68, h: 0.40 },
  ];
  const bw = S * 0.10;
  const inBar = (x, y) => {
    for (const b of bars) {
      const left = b.cx * S - bw / 2, right = b.cx * S + bw / 2;
      const top = S / 2 - (b.h * S) / 2, bottom = S / 2 + (b.h * S) / 2;
      const r = bw / 2;
      if (x >= left && x <= right && y >= top + r && y <= bottom - r) return true;
      if ((x - (left + r)) ** 2 + (y - (top + r)) ** 2 <= r * r || (x - (left + r)) ** 2 + (y - (bottom - r)) ** 2 <= r * r) return true;
    }
    return false;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = x + 0.5, fy = y + 0.5;
    px[y * S + x] = !inRounded(fx, fy) ? -1 : inBar(fx, fy) ? 1 : 0;
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let alpha = 0, ink = 0;
    for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) {
      const v = px[(y * ss + dy) * S + (x * ss + dx)];
      if (v >= 0) { alpha++; ink += v; }
    }
    const n = ss * ss;
    const a = alpha / n;
    const k = alpha ? ink / alpha : 0;
    const o = (y * size + x) * 4;
    out[o] = Math.round(AMBER[0] * (1 - k) + INK[0] * k);
    out[o + 1] = Math.round(AMBER[1] * (1 - k) + INK[1] * k);
    out[o + 2] = Math.round(AMBER[2] * (1 - k) + INK[2] * k);
    out[o + 3] = Math.round(a * 255);
  }
  return out;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'icon.png'), encodePng(512, drawIcon(512)));
const icoSizes = [256, 128, 64, 48, 32, 16];
fs.writeFileSync(path.join(root, 'icon.ico'), encodeIco(icoSizes.map((s) => ({ size: s, data: encodePng(s, drawIcon(s)) }))));
console.log('wrote icon.png and icon.ico');
