'use strict';
/**
 * _brandlogo-compare.js — 双路对照品牌 logo，避免"我以为的路径"与"浏览器实际渲染"不一致。
 *
 * 路径 A：按 SVG 弧参数精确光栅化（修正后的区间判断）
 * 路径 B：用无头浏览器渲染同一段 SVG，导出 PNG
 * 两者应当一致；不一致说明我对弧参数的理解有误。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/* ---------- PNG 编码（零依赖） ---------- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
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
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

/* ---------- 路径 A：精确光栅化 ---------- */
const VB = 24, CX = 12, CY = 12, R = 7.6, SW = 2.6;
const A0 = 225 * Math.PI / 180;   // 起点角
const A1 = 315 * Math.PI / 180;   // 终点角
const RED = [0xDA, 0x29, 0x1C], PAPER = [0xF5, 0xF2, 0xED];

function render(size, ss) {
  const S = size * ss, sc = S / VB;
  const big = Buffer.alloc(S * S * 4);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / sc, y = (py + 0.5) / sc;
      const dx = x - CX, dy = y - CY;
      const d = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI * 2;
      // 大弧且 sweep=0（逆时针）：从 225° 递减到 315°，即 ang<=225° 或 ang>=315°
      const onArc = Math.abs(d - R) <= SW / 2 && (ang <= A0 || ang >= A1);
      const onDot = d <= 2.5;
      const c = (onArc || onDot) ? PAPER : RED;
      const o = (py * S + px) * 4;
      big[o] = c[0]; big[o + 1] = c[1]; big[o + 2] = c[2]; big[o + 3] = 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
      r += big[i]; g += big[i + 1]; b += big[i + 2];
    }
    const n = ss * ss, ii = (y * size + x) * 4;
    out[ii] = Math.round(r / n); out[ii + 1] = Math.round(g / n); out[ii + 2] = Math.round(b / n); out[ii + 3] = 255;
  }
  return out;
}
const dir = path.join(__dirname, '..', '.work');
fs.mkdirSync(dir, { recursive: true });
writePng(path.join(dir, 'logo-A-math.png'), 256, render(256, 3));
console.log('A 路（精确光栅化）→ .work/logo-A-math.png');

/* ---------- 路径 B：浏览器渲染 ---------- */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24">
<rect width="24" height="24" fill="#DA291C"/>
<path fill="none" stroke="#F5F2ED" stroke-width="2.6" stroke-linecap="round" d="M6.9 8.1A7.6 7.6 0 1 0 17.1 8.1"/>
<circle cx="12" cy="12" r="2.5" fill="#F5F2ED"/>
</svg>`;
const svgPath = path.join(dir, 'logo-b.svg');
fs.writeFileSync(svgPath, svg, 'utf8');

/* 用 Edge 无头渲染 SVG 截图 */
function findEdge() {
  for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                   'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const edge = findEdge();
if (!edge) { console.log('未找到 Edge，跳过 B 路'); process.exit(0); }
const outPng = path.join(dir, 'logo-B-browser.png');
try {
  execFileSync(edge, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=256,256',
    `--screenshot=${outPng}`,
    '--default-background-color=00000000',
    'file:///' + svgPath.replace(/\\/g, '/'),
  ], { stdio: 'pipe', timeout: 60000 });
  console.log('B 路（浏览器渲染）→ ' + outPng);
} catch (e) {
  console.log('B 路失败: ' + (e.stderr || e.message).toString().slice(0, 200));
}
