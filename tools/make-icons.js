'use strict';
/**
 * make-icons.js — 生成应用图标（纯 Node，无依赖）
 *
 * 设计：「启幕」—— 一段升起的弧（帷幕）+ 中心一点光，缺口朝下。
 *   缺口朝下使图形读作"升起的拱"，同时避免"缺口朝上 + 中心点"看起来像一张脸
 *   （本轮把原几何渲染出来实测后才发现该问题）。
 *
 * 几何必须与 public/index.html 的 .brand-logo SVG 完全一致，否则应用图标与界面
 * 品牌标记不是同一个形状（本轮实测发现过该不一致）。
 *   弧：r=0.30 线宽0.10，缺口 45°–135°（屏幕坐标 y 向下 → 下方）
 *   点：r=0.1125 位于中心
 *
 * 用法：
 *   node tools/make-icons.js                 生成到 android/res/mipmap-* 与 public/icon-*.png
 *   node tools/make-icons.js --preview       额外输出各尺寸预览到 .work/icons
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

/* ---------------- 极简 PNG 写入（RGBA） ---------------- */
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

/* ---------------- 配色（与 App 内三色一致） ---------------- */
const RED = [0xDA, 0x29, 0x1C];
const PAPER = [0xF5, 0xF2, 0xED];

/* ---------------- 几何（归一化到 0..1） ---------------- */
const R_ARC = 0.30;
const W_ARC = 0.10;
const R_DOT = 0.1125;
const GAP_FROM = 45 * Math.PI / 180;
const GAP_TO = 135 * Math.PI / 180;

/** 圆角方形底（Android 自适应图标安全比例） */
function insideRoundedRect(x, y, radius) {
  const dx = Math.abs(x - 0.5) - (0.5 - radius);
  const dy = Math.abs(y - 0.5) - (0.5 - radius);
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

function drawIcon(size, ss, transparentBg) {
  const S = size * ss;
  const buf = Buffer.alloc(S * S * 4);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / S;
      const y = (py + 0.5) / S;
      const o = (py * S + px) * 4;

      if (!transparentBg && !insideRoundedRect(x, y, 0.22)) continue;   // 透明

      let c = RED;
      const dx = x - 0.5, dy = y - 0.5;
      const d = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI * 2;
      const inGap = ang > GAP_FROM && ang < GAP_TO;
      if ((Math.abs(d - R_ARC) <= W_ARC / 2 && !inGap) || d <= R_DOT) c = PAPER;

      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
    }
  }

  /* 超采样降采样 */
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al; g += buf[i + 1] * al; b += buf[i + 2] * al; a += al;
        }
      }
      const n = ss * ss, ii = (y * size + x) * 4;
      if (a > 0) {
        out[ii] = Math.round(r / a); out[ii + 1] = Math.round(g / a); out[ii + 2] = Math.round(b / a);
      }
      out[ii + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ---------------- 输出 ---------------- */
const DENSITIES = {
  'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192,
};
for (const [dir, size] of Object.entries(DENSITIES)) {
  const out = path.join(ROOT, 'android', 'res', dir);
  fs.mkdirSync(out, { recursive: true });
  writePng(path.join(out, 'ic_launcher.png'), size, drawIcon(size, 6, false));
}
console.log('已生成 Android 图标（' + Object.keys(DENSITIES).length + ' 个密度）');

const pubDir = path.join(ROOT, 'public');
fs.mkdirSync(pubDir, { recursive: true });
writePng(path.join(pubDir, 'icon-192.png'), 192, drawIcon(192, 6, false));
writePng(path.join(pubDir, 'icon-96.png'), 96, drawIcon(96, 6, false));
console.log('已生成 public/icon-192.png 与 public/icon-96.png');

if (process.argv.includes('--preview')) {
  const prev = path.join(ROOT, '.work', 'icons');
  fs.mkdirSync(prev, { recursive: true });
  for (const s of [512, 192, 96, 48, 24]) writePng(path.join(prev, 'qimu-' + s + '.png'), s, drawIcon(s, 6, false));
  console.log('预览：' + prev);
}
