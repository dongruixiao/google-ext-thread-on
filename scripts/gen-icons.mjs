// 生成扩展图标（16/48/128）：手写 PNG 编码，避免为一个图标引入图像处理依赖。
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
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

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

/** 圆角矩形内部判定 */
function insideRoundedRect(x, y, width, height, radius) {
  const cx = Math.min(Math.max(x, radius), width - radius);
  const cy = Math.min(Math.max(y, radius), height - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
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

  // 背景渐变（靛蓝 → 紫罗兰）+ 三条白色面包屑横条
  const bars = [
    { y: 0.285, width: 0.55, alpha: 0.96 },
    { y: 0.455, width: 0.41, alpha: 0.82 },
    { y: 0.625, width: 0.28, alpha: 0.62 },
  ].map((bar) => ({
    top: bar.y * h,
    height: 0.105 * h,
    left: 0.225 * w,
    width: bar.width * w,
    alpha: bar.alpha,
  }));

  const accum = new Float64Array(size * size * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!insideRoundedRect(x + 0.5, y + 0.5, w, h, cardRadius)) continue;
      const t = (x * 0.25 + y * 0.75) / h;
      let r = mix(79, 139, t);
      let g = mix(70, 92, t);
      let b = mix(229, 246, t);

      for (const bar of bars) {
        const inBar =
          x >= bar.left &&
          x <= bar.left + bar.width &&
          y >= bar.top &&
          y <= bar.top + bar.height &&
          insideRoundedRect(
            x + 0.5 - bar.left,
            y + 0.5 - bar.top,
            bar.width,
            bar.height,
            bar.height / 2,
          );
        if (inBar) {
          r = mix(r, 255, bar.alpha);
          g = mix(g, 255, bar.alpha);
          b = mix(b, 255, bar.alpha);
        }
      }

      const target = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
      accum[target] += r;
      accum[target + 1] += g;
      accum[target + 2] += b;
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
