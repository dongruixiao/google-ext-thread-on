// 生成扩展图标（16/48/128）：手写 PNG 编码，避免为一个图标引入图像处理依赖。
//
// 图形：深色圆角底座 + 拉丝金属胶囊 + 紫色阅读进度环。
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

function insideCircle(px, py, cx, cy, radius) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
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

  const simple = size <= 16;
  const pill = {
    x: w * 0.1,
    y: h * 0.3,
    width: w * 0.8,
    height: h * 0.4,
  };
  const pillInset = Math.max(1, w * 0.022);
  const badgeX = w * 0.29;
  const badgeY = h * 0.5;
  const badgeRadius = h * 0.23;
  const ringRadius = badgeRadius + w * 0.028;
  const ringWidth = Math.max(scale, w * 0.04);
  const titleBar = {
    x: w * 0.47,
    y: h * 0.43,
    width: w * (simple ? 0.31 : 0.34),
    height: h * 0.09,
  };
  const secondBar = {
    x: w * 0.47,
    y: h * 0.57,
    width: w * (simple ? 0.2 : 0.25),
    height: h * 0.07,
  };
  const progressEnd = Math.PI * 2 * 0.68;

  const accum = new Float64Array(size * size * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideRect(px, py, 0, 0, w, h, cardRadius)) continue;

      const bgT = (x * 0.22 + y * 0.78) / h;
      let color = [mix(55, 27, bgT), mix(56, 28, bgT), mix(62, 32, bgT)];

      if (!insideRect(px, py, w * 0.025, h * 0.025, w * 0.95, h * 0.95, cardRadius * 0.9)) {
        color = blend(color, WHITE, 0.26);
      }

      if (insideRect(px, py, pill.x, pill.y, pill.width, pill.height, pill.height / 2)) {
        const metalT = (py - pill.y) / pill.height;
        color = [
          mix(248, 155, metalT),
          mix(246, 153, metalT),
          mix(238, 149, metalT),
        ];
        if (
          !insideRect(
            px,
            py,
            pill.x + pillInset,
            pill.y + pillInset,
            pill.width - pillInset * 2,
            pill.height - pillInset * 2,
            pill.height / 2 - pillInset,
          )
        ) {
          color = blend(color, metalT < 0.5 ? WHITE : [46, 45, 42], 0.56);
        }
      }

      const dist = Math.hypot(px - badgeX, py - badgeY);
      if (dist <= badgeRadius) {
        const highlight = Math.max(0, 1 - dist / (badgeRadius * 1.7)) * 0.24;
        color = blend([20, 21, 24], WHITE, highlight);
      }

      if (dist <= ringRadius && dist >= ringRadius - ringWidth) {
        const angle = (Math.atan2(py - badgeY, px - badgeX) + Math.PI / 2 + Math.PI * 2) %
          (Math.PI * 2);
        color =
          angle <= progressEnd
            ? [128, 99, 255]
            : blend(color, WHITE, 0.18);
      }

      if (insideRect(px, py, titleBar.x, titleBar.y, titleBar.width, titleBar.height, titleBar.height / 2)) {
        color = [38, 38, 42];
      } else if (
        insideRect(px, py, secondBar.x, secondBar.y, secondBar.width, secondBar.height, secondBar.height / 2)
      ) {
        color = blend([38, 38, 42], [190, 188, 180], 0.46);
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
