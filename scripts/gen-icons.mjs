// 生成扩展图标（16/48/128）：手写 PNG 编码，避免为一个图标引入图像处理依赖。
//
// 图形：圆角方形渐变底 + 一枚「曲别针」（TopClip 的 clip），
// 16px 版本只保留外圈（放大线宽），否则缩到 16px 会糊成一团。
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

/** 圆角矩形内部判定（含圆角半径） */
function insideRect(px, py, x, y, width, height, radius) {
  if (px < x || py < y || px > x + width || py > y + height) return false;
  const r = Math.min(radius, width / 2, height / 2);
  const cx = Math.min(Math.max(px, x + r), x + width - r);
  const cy = Math.min(Math.max(py, y + r), y + height - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 圆角矩形描边：外圈内、内圈外 */
function inStroke(px, py, x, y, width, height, stroke, radius) {
  if (!insideRect(px, py, x, y, width, height, radius)) return false;
  return !insideRect(
    px,
    py,
    x + stroke,
    y + stroke,
    width - stroke * 2,
    height - stroke * 2,
    Math.max(0, radius - stroke),
  );
}

function mix(from, to, t) {
  return Math.round(from + (to - from) * t);
}

function blend(base, color, alpha) {
  return [
    mix(base[0], color[0], alpha),
    mix(base[1], color[1], alpha),
    mix(base[2], color[2], alpha),
  ];
}

const WHITE = [255, 255, 255];

function drawIcon(size) {
  const scale = SUPERSAMPLE;
  const w = size * scale;
  const h = size * scale;
  const buffer = Buffer.alloc(size * size * 4);
  const cardRadius = w * 0.235;

  // 图形：一枚「夹子」（Π，两条腿一长一短，亮白）夹住一条半透明标题线，下面再跟一条更淡的短标题
  const simple = size <= 16;
  const stroke = w * (simple ? 0.105 : 0.085);
  const clipLeft = w * 0.33;
  const clipRight = w * 0.67;
  const clipTop = h * 0.18;
  const longLegBottom = h * 0.64;
  const shortLegBottom = h * (simple ? 0.52 : 0.48);
  const bar = {
    x: w * 0.13,
    y: h * 0.38,
    width: w * 0.74,
    height: h * (simple ? 0.17 : 0.15),
  };
  const secondBar = {
    x: w * 0.13,
    y: h * 0.72,
    width: w * 0.44,
    height: h * (simple ? 0.14 : 0.12),
  };

  const accum = new Float64Array(size * size * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideRect(px, py, 0, 0, w, h, cardRadius)) continue;

      const t = (x * 0.25 + y * 0.75) / h;
      let color = [mix(79, 139, t), mix(70, 92, t), mix(229, 246, t)];

      const inClip =
        // 左腿（长）
        inStroke(px, py, clipLeft, clipTop, stroke, longLegBottom - clipTop, stroke, stroke / 2) ||
        // 右腿（短）
        inStroke(
          px,
          py,
          clipRight - stroke,
          clipTop,
          stroke,
          shortLegBottom - clipTop,
          stroke,
          stroke / 2,
        ) ||
        // 顶部横梁
        inStroke(px, py, clipLeft, clipTop, clipRight - clipLeft, stroke, stroke, stroke / 2);

      if (inClip) color = blend(color, WHITE, 0.98);
      else if (insideRect(px, py, bar.x, bar.y, bar.width, bar.height, bar.height / 2)) {
        color = blend(color, WHITE, 0.62);
      } else if (
        insideRect(px, py, secondBar.x, secondBar.y, secondBar.width, secondBar.height, secondBar.height / 2)
      ) {
        color = blend(color, WHITE, 0.34);
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
