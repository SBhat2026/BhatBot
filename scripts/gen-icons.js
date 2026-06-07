'use strict';
// Dependency-free PNG icon generator for the Bhatbot phone PWA.
// Cyan particle-cloud disc on #090d13 — matches the boot hero. Built-in zlib only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const cd = Buffer.concat([t, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd)); return Buffer.concat([len, cd, crc]); }

function makePNG(size) {
  const w = size, h = size, cx = w / 2, cy = h / 2;
  const px = Buffer.alloc(w * h * 4);
  // deterministic particle field
  let seed = 1337; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const stars = []; for (let i = 0; i < Math.round(size / 3); i++) { const a = rnd() * Math.PI * 2, r = (0.18 + rnd() * 0.32) * size; stars.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, s: 0.6 + rnd() * 1.8 * (size / 192) }); }
  const R = size * 0.40;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
    // base
    let r = 0x09, g = 0x0d, b = 0x13;
    // outer glow + disc ring
    const ring = Math.max(0, 1 - Math.abs(d - R) / (size * 0.10));
    const glow = Math.max(0, 1 - d / (R * 1.25)) * 0.55;
    const core = Math.max(0, 1 - d / (size * 0.13));
    let t = Math.min(1, glow + ring * 0.9 + core * 1.2);
    r = Math.round(r + (0x39 - r) * t * 0.7);
    g = Math.round(g + (0xd7 - g) * t);
    b = Math.round(b + (0xff - b) * t);
    const i = (y * w + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  // stars
  for (const st of stars) { const ss = Math.ceil(st.s); for (let oy = -ss; oy <= ss; oy++) for (let ox = -ss; ox <= ss; ox++) { const X = Math.round(st.x + ox), Y = Math.round(st.y + oy); if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const fall = Math.max(0, 1 - Math.sqrt(ox * ox + oy * oy) / (ss + 0.5)); if (fall <= 0) continue; const i = (Y * w + X) * 4; px[i] = Math.min(255, px[i] + 180 * fall); px[i + 1] = Math.min(255, px[i + 1] + 220 * fall); px[i + 2] = Math.min(255, px[i + 2] + 255 * fall); } }
  // scanline filtering (filter byte 0 per row)
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'src', 'mobile');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [192, 512]) { fs.writeFileSync(path.join(outDir, `icon-${s}.png`), makePNG(s)); console.log('wrote icon-' + s + '.png'); }
