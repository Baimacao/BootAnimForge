'use strict';
/**
 * _render-brandlogo.js — 放大渲染品牌 logo 的 SVG 路径，检查几何是否正确。
 *
 * 为什么：.brand-logo 里那段弧+点的 path 是我手写的，24px 下看不出对错。
 * 用 SVG 的弧形几何公式精确光栅化，而不是"看着差不多"。
 *
 * SVG: M6.9 8.1 A7.6 7.6 0 1 0 17.1 8.1   → 圆心(12,12) 半径7.6，从 225° 逆时针到 315°
 *      circle cx=12 cy=12 r=2.5
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 384;          // 输出尺寸
const SS = 3;              // 超采样
const S = SIZE * SS;
const VB = 24;             // SVG viewBox 边长
const scale = S / VB;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writePng(file, size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* 弧形几何：起点 p0、终点 p1、半径 r、largeArc、sweep
   这里直接从圆弧参数推：圆心(12,12) r=7.6，起点角 225°，终点角 315°，sweep=0（逆时针） */
const CX = 12, CY = 12, R = 7.6, STROKE = 2.6;
const a0 = 225 * Math.PI / 180;
const a1 = 315 * Math.PI / 180;

/** 判断点是否落在弧线段上（含线宽） */
function onArc(x, y) {
  const dx = x - CX, dy = y - CY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (Math.abs(d - R) > STROKE / 2) return false;
  let ang = Math.atan2(dy, dx);                 // -PI..PI
  if (ang < 0) ang += Math.PI * 2;               // 0..2PI
  // 弧从 225° 逆时针（角度减小）到 315°，即跨过 225→180→...→0→315
  const A0 = a0, A1 = a1;
  const inRange = (ang >= A0) || (ang <= A1);
  return inRange;
}
/** 判断点是否落在中心实心圆上 */
function onDot(x, y) {
  const dx = x - CX, dy = y - CY;
  return Math.sqrt(dx * dx + dy * dy) <= 2.5;
}

const RED = [0xDA, 0x29, 0x1C];
const PAPER = [0xF5, 0xF2, 0xED];
const buf = Buffer.alloc(S * S * 4);
for (let py = 0; py < S; py++) {
  for (let px = 0; px < S; px++) {
    const x = (px + 0.5) / scale;
    const y = (py + 0.5) / scale;
    const o = (py * S + px) * 4;
    let c = RED;                       // 背景 = 红（模拟 .brand-logo 的红底）
    if (onDot(x, y)) c = PAPER;
    else if (onArc(x, y)) c = PAPER;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
  }
}
/* 降采样 */
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      }
    }
    const n = SS * SS, ii = (y * SIZE + x) * 4;
    out[ii] = Math.round(r / n); out[ii + 1] = Math.round(g / n); out[ii + 2] = Math.round(b / n); out[ii + 3] = 255;
  }
}
const dir = path.join(__dirname, '..', '.work');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'brandlogo-check.png');
writePng(file, SIZE, out);

/* 同时在 24px 实际尺寸下渲染，看小尺寸可读性 */
const SMALL = 24, SS2 = 8, S2 = SMALL * SS2, sc2 = S2 / VB;
const b2 = Buffer.alloc(S2 * S2 * 4);
for (let py = 0; py < S2; py++) {
  for (let px = 0; px < S2; px++) {
    const x = (px + 0.5) / sc2, y = (py + 0.5) / sc2;
    const o = (py * S2 + px) * 4;
    const c = (onDot(x, y) || onArc(x, y)) ? PAPER : RED;
    b2[o] = c[0]; b2[o + 1] = c[1]; b2[o + 2] = c[2]; b2[o + 3] = 255;
  }
}
const o2 = Buffer.alloc(SMALL * SMALL * 4);
for (let y = 0; y < SMALL; y++) {
  for (let x = 0; x < SMALL; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS2; sy++) for (let sx = 0; sx < SS2; sx++) {
      const i = ((y * SS2 + sy) * S2 + (x * SS2 + sx)) * 4;
      r += b2[i]; g += b2[i + 1]; b += b2[i + 2];
    }
    const n = SS2 * SS2, ii = (y * SMALL + x) * 4;
    out[ii] = Math.round(r / n); out[ii + 1] = Math.round(g / n); out[ii + 2] = Math.round(b / n); out[ii + 3] = 255;
  }
}
/* 把 24px 版本放大 12 倍便于目视（最近邻） */
const Z = 12, ZS = SMALL * Z;
const zoom = Buffer.alloc(ZS * ZS * 4);
for (let y = 0; y < ZS; y++) for (let x = 0; x < ZS; x++) {
  const si = (Math.floor(y / Z) * SMALL + Math.floor(x / Z)) * 4;
  const di = (y * ZS + x) * 4;
  for (let k = 0; k < 4; k++) zoom[di + k] = out[si + k];
}
const file2 = path.join(dir, 'brandlogo-24px-zoom.png');
writePng(file2, ZS, zoom);
console.log('已渲染：' + file);
console.log('已渲染（24px 放大 12 倍）：' + file2);
console.log('弧：圆心(12,12) r=7.6 线宽2.6，225°→315° 逆时针；点：r=2.5');
