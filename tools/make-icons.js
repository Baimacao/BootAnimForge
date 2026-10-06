'use strict';
/**
 * make-icons.js — 生成应用图标（纯 Node，无依赖）
 *
 * 设计：「启幕」—— 一段升起的弧（帷幕/幕布）+ 中心一点光。
 *   弧留一个缺口，对应"开机动画会在系统起来前一直循环"。
 *
 * 只用两个形状，因为小尺寸下细节会糊；深色底 + 单一亮色，与 App 内 MD3 主题统一。
 *
 * 用法：
 *   node tools/make-icons.js                 生成到 android/res/mipmap-* 与 public/icon.png
 *   node tools/make-icons.js --preview       额外输出候选尺寸预览到 .work/icons
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
    raw[y * (size * 4 + 1)] = 0;                    // filter: None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                         // 8bit RGBA
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* ---------------- 带超采样的绘制 ---------------- */
/** @param size 输出边长；@param ss 超采样倍数（抗锯齿） */
function drawIcon(size, ss) {
  const S = size * ss;
  const buf = Buffer.alloc(S * S * 4);

  // 与 App 内 MD3 令牌一致
  const SURFACE = [0x0E, 0x14, 0x18];
  const PRIMARY = [0x4F, 0xC3, 0xF7];
  const LIGHT = [0xC8, 0xE7, 0xFF];

  // 圆角方形底（半径 = 22%，接近 Android 自适应图标的安全比例）
  const R = 0.22;
  function insideRoundedRect(x, y) {
    const dx = Math.abs(x - 0.5) - (0.5 - R);
    const dy = Math.abs(y - 0.5) - (0.5 - R);
    if (dx <= 0 || dy <= 0) return Math.abs(x - 0.5) <= 0.5 && Math.abs(y - 0.5) <= 0.5;
    return dx * dx + dy * dy <= R * R;
  }

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / S;
      const y = (py + 0.5) / S;
      const o = (py * S + px) * 4;
      if (!insideRoundedRect(x, y)) continue;        // 透明

      let c = SURFACE;
      const dx = x - 0.5, dy = y - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      // 从 -45° 起顺时针 270°，留 90° 缺口
      const a = (ang + Math.PI / 4 + Math.PI * 2) % (Math.PI * 2);
      const inArc = a <= Math.PI * 1.5;

      if (d <= 0.375 && d > 0.305 && inArc) c = PRIMARY;   // 弧
      else if (d < 0.105) c = LIGHT;                       // 中心光点

      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
    }
  }

  // 超采样降采样
  const out = Buffer.alloc(size * size * 4);
  const f = ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < f; sy++) {
        for (let sx = 0; sx < f; sx++) {
          const i = ((y * f + sy) * S + (x * f + sx)) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al; g += buf[i + 1] * al; b += buf[i + 2] * al; a += al;
        }
      }
      const n = f * f;
      const ii = (y * size + x) * 4;
      if (a > 0) {
        out[ii] = Math.round(r / a);
        out[ii + 1] = Math.round(g / a);
        out[ii + 2] = Math.round(b / a);
      }
      out[ii + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ---------------- 输出 ---------------- */
const DENSITIES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

for (const [dir, size] of Object.entries(DENSITIES)) {
  const out = path.join(ROOT, 'android', 'res', dir);
  fs.mkdirSync(out, { recursive: true });
  writePng(path.join(out, 'ic_launcher.png'), size, drawIcon(size, 6));
}
console.log(`已生成 Android 图标（${Object.keys(DENSITIES).length} 个密度）`);

// Web 端图标（PC 界面顶栏与页面图标用）
const pubDir = path.join(ROOT, 'public');
fs.mkdirSync(pubDir, { recursive: true });
writePng(path.join(pubDir, 'icon-192.png'), 192, drawIcon(192, 6));
writePng(path.join(pubDir, 'icon-96.png'), 96, drawIcon(96, 6));
console.log('已生成 public/icon-192.png 与 public/icon-96.png');

if (process.argv.includes('--preview')) {
  const prev = path.join(ROOT, '.work', 'icons');
  fs.mkdirSync(prev, { recursive: true });
  for (const s of [512, 192, 96, 48]) {
    writePng(path.join(prev, `qimu-${s}.png`), s, drawIcon(s, 6));
  }
  console.log(`预览：${prev}`);
}
