// Generate 16/48/128 extension icons with a dependency-free PNG encoder.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Point-in-rounded-rectangle test. */
function insideRect(px, py, x, y, width, height, radius) {
  if (px < x || py < y || px > x + width || py > y + height) return false;
  const r = Math.min(radius, width / 2, height / 2);
  const cx = Math.min(Math.max(px, x + r), x + width - r);
  const cy = Math.min(Math.max(py, y + r), y + height - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function mix(from, to, t) {
  return Math.round(from + (to - from) * t);
}

function drawIcon(size) {
  const scale = SUPERSAMPLE;
  const w = size * scale;
  const h = size * scale;
  const buffer = Buffer.alloc(size * size * 4);
  const cardRadius = w * 0.235;

  const lineHeight = h * 0.11;
  const lineX = w * 0.22;
  const lines = [
    { y: h * 0.26, width: w * 0.56 },
    { y: h * 0.445, width: w * 0.4 },
    { y: h * 0.63, width: w * 0.25 },
  ];

  const accum = new Float64Array(size * size * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideRect(px, py, 0, 0, w, h, cardRadius)) continue;

      const bgT = (x * 0.22 + y * 0.78) / h;
      let color = [mix(122, 72, bgT), mix(89, 53, bgT), mix(252, 211, bgT)];

      const line = lines.find(({ y, width }) =>
        insideRect(px, py, lineX, y, width, lineHeight, lineHeight / 2),
      );
      if (line) {
        color = [255, 253, 248];
      }

      const target = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
      accum[target] += color[0];
      accum[target + 1] += color[1];
      accum[target + 2] += color[2];
      accum[target + 3] += 255;
    }
  }

  const samples = scale * scale;
  for (let i = 0; i < size * size; i += 1) {
    buffer[i * 4] = Math.round(accum[i * 4] / samples);
    buffer[i * 4 + 1] = Math.round(accum[i * 4 + 1] / samples);
    buffer[i * 4 + 2] = Math.round(accum[i * 4 + 2] / samples);
    buffer[i * 4 + 3] = Math.round(accum[i * 4 + 3] / samples);
  }
  return encodePng(size, size, buffer);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`generated ${file}`);
}
