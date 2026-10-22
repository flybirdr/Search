/**
 * 生成扩展图标 media/icon.png（128×128）。
 *
 * 图形语义：放大镜 + 镜片内两行文本，第二行加粗并染成暖色，表示「命中的那一行」——
 * 这比单纯的放大镜更贴近插件实际做的事（在文本里找东西）。
 *
 * 绘制方式：4×4 超采样 + 有符号距离场，边缘自带抗锯齿；
 * 只用 node:zlib 手写 PNG，不引入图形库。
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 4; // 每个像素 4×4 个子采样点

const BG_FROM = [18, 184, 134]; // #12b886 左上
const BG_TO = [5, 70, 54]; // #054636 右下
const FG = [255, 255, 255];
const HIT = [253, 230, 138]; // #fde68a 命中行

const BOX = { x: 4, y: 4, w: 120, h: 120, r: 27 };
const LENS = { cx: 57, cy: 57, r: 39, w: 10.8 };
const HANDLE = [
  [83, 83],
  [108, 108],
];
const HANDLE_W = 13;
const TEXT_TOP = [
  [36, 45],
  [79, 45],
];
const TEXT_TOP_W = 8.4;
const TEXT_HIT = [
  [36, 69],
  [66, 69],
];
const TEXT_HIT_W = 11.4;

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 点到线段的距离，用于画圆头粗线。 */
function capsule(px, py, [[x1, y1], [x2, y2]], width) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t)) <= width / 2;
}

/** 圆角矩形内部判定。 */
function insideBox(px, py) {
  const cx = BOX.x + BOX.w / 2;
  const cy = BOX.y + BOX.h / 2;
  const qx = Math.abs(px - cx) - (BOX.w / 2 - BOX.r);
  const qy = Math.abs(py - cy) - (BOX.h / 2 - BOX.r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - BOX.r <= 0;
}

/** 单个采样点的颜色，按图层顺序叠加。 */
function shade(px, py) {
  const t = (px + py) / (2 * SIZE);
  let color = mix(BG_FROM, BG_TO, t);

  const d = Math.hypot(px - LENS.cx, py - LENS.cy);
  if (Math.abs(d - LENS.r) <= LENS.w / 2 || capsule(px, py, HANDLE, HANDLE_W)) {
    color = FG;
  }
  if (capsule(px, py, TEXT_TOP, TEXT_TOP_W)) {
    color = FG;
  }
  if (capsule(px, py, TEXT_HIT, TEXT_HIT_W)) {
    color = HIT;
  }
  return color;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const samples = SS * SS;

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!insideBox(px, py)) {
          continue;
        }
        const color = shade(px, py);
        r += color[0];
        g += color[1];
        b += color[2];
        hits += 1;
      }
    }
    const i = (y * SIZE + x) * 4;
    if (hits > 0) {
      pixels[i] = Math.round(r / hits);
      pixels[i + 1] = Math.round(g / hits);
      pixels[i + 2] = Math.round(b / hits);
      pixels[i + 3] = Math.round((hits / samples) * 255);
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(new URL('../media/icon.png', import.meta.url), png);
console.log(`icon.png ${png.length} bytes`);
