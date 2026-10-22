/**
 * 临时工具：把 media/sidebar.svg 光栅化成 PNG，用来目视检查图标在 16px 与
 * 大尺寸下的形态和可辨识度（VS Code 无法预览活动栏图标，只能这样看）。
 *
 * 直接解析 SVG 的 circle / path，几何改动后重跑即可，不需要手工同步参数。
 * 只支持本图标用到的最小指令集：M / L / H / V。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SS = 4; // 每像素 4×4 子采样
const OUT_DIR = new URL('../.workbuddy/preview/', import.meta.url);

/** 解析 sidebar.svg → 圆环 + 若干圆头线段。 */
function parseSvg() {
  const svg = readFileSync(new URL('../media/sidebar.svg', import.meta.url), 'utf8');
  const circles = [];
  const segments = [];

  for (const m of svg.matchAll(/<circle\b([^>]*)\/>/g)) {
    const attrs = attrsOf(m[1]);
    circles.push({
      cx: Number(attrs.cx),
      cy: Number(attrs.cy),
      r: Number(attrs.r),
      w: Number(attrs['stroke-width'] ?? 2),
    });
  }

  for (const m of svg.matchAll(/<path\b([^>]*)\/>/g)) {
    const attrs = attrsOf(m[1]);
    const w = Number(attrs['stroke-width'] ?? 2);
    const tokens = attrs.d.replace(/([MLHV])/g, ' $1 ').trim().split(/[\s,]+/);
    let cursor = [0, 0];
    for (let i = 0; i < tokens.length; i += 1) {
      const cmd = tokens[i];
      if (cmd === 'M' || cmd === 'L') {
        const p = [Number(tokens[i + 1]), Number(tokens[i + 2])];
        if (cmd === 'L') segments.push({ a: cursor, b: p, w });
        cursor = p;
        i += 2;
      } else if (cmd === 'H') {
        const p = [Number(tokens[i + 1]), cursor[1]];
        segments.push({ a: cursor, b: p, w });
        cursor = p;
        i += 1;
      } else if (cmd === 'V') {
        const p = [cursor[0], Number(tokens[i + 1])];
        segments.push({ a: cursor, b: p, w });
        cursor = p;
        i += 1;
      }
    }
  }
  return { circles, segments };
}

function attrsOf(source) {
  const attrs = {};
  for (const m of source.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

const { circles, segments } = parseSvg();

/** 距离场判定：命中返回 1。 */
function ink(px, py) {
  for (const c of circles) {
    if (Math.abs(Math.hypot(px - c.cx, py - c.cy) - c.r) <= c.w / 2) return 1;
  }
  for (const { a, b, w } of segments) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t)) <= w / 2) return 1;
  }
  return 0;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const unit = size / 24;
  const samples = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          hits += ink((x + (sx + 0.5) / SS) / unit, (y + (sy + 0.5) / SS) / unit);
        }
      }
      const v = Math.round(255 * (1 - hits / samples));
      const i = (y * size + x) * 4;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/** 最近邻放大，还原真实小尺寸在屏幕上的观感。 */
function upscale(buf, size, factor) {
  const out = size * factor;
  const res = Buffer.alloc(out * out * 4);
  for (let y = 0; y < out; y += 1) {
    for (let x = 0; x < out; x += 1) {
      const src = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 4;
      buf.copy(res, (y * out + x) * 4, src, src + 4);
    }
  }
  return res;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
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

function writePng(name, buf, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(new URL(name, OUT_DIR), png);
}

writePng('sidebar-check-big.png', render(192), 192);
writePng('sidebar-check-24.png', upscale(render(24), 24, 6), 144);
writePng('sidebar-check-16.png', upscale(render(16), 16, 9), 144);
console.log(`ok: ${circles.length} circle, ${segments.length} segment`);
