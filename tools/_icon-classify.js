'use strict';
/**
 * _icon-classify.js — 判定每个图标是「实心填充」还是「细轮廓」，并输出其 path 全文。
 *
 * 判定依据（实测观察）：
 *   细轮廓图标的 path 里会出现大量 "2" 厚度偏移（如 h2v10h2、v-2H5），
 *   或本身就是单笔画（X、⌄、→）。实心图标的 path 由"外框 + 无内孔"的大块组成。
 * 这里用可量化的启发式：轮廓图标通常含 ≥1 处 "h2"/"v2"/"-2" 这类 2 单位描边纹样。
 */
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split('\n');

const rows = [];
h.forEach((line, i) => {
  const m = line.match(/<svg class="icon[^"]*"[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) return;
  const inner = m[1];
  const d = (inner.match(/d="([^"]+)"/) || [])[1] || '';
  // 描边纹样：2 单位厚的边（h2 / v2 / -2 / 2v / 2h）或 Z 后接挖孔
  const thinStrokes = (d.match(/[hv]-?2(?![0-9.])/gi) || []).length;
  const hasHole = /Z\s*[Mm][^Z]*Z/.test(d) || (d.match(/Z/gi) || []).length >= 2;
  let label = '';
  for (let j = i; j < Math.min(i + 4, h.length); j++) {
    const t = h[j].match(/<h2>([^<]+)<\/h2>/);
    if (t) { label = t[1]; break; }
  }
  rows.push({
    line: i + 1, label: label.slice(0, 22),
    kind: thinStrokes >= 2 ? '轮廓' : (hasHole ? '轮廓?' : '实心'),
    thinStrokes, holes: (d.match(/Z/gi) || []).length,
    d,
  });
});

const solid = rows.filter((r) => r.kind === '实心');
console.log('可能为实心块（需改写为轮廓）: ' + solid.length + ' 个');
solid.forEach((r) => console.log('  L' + r.line + '  ' + r.label.padEnd(24) + ' d="' + r.d.slice(0, 70) + '"'));

console.log('\n判为轮廓: ' + (rows.length - solid.length) + ' 个');
console.log('\n--- 全部 path（供改写时参考）---');
rows.forEach((r) => console.log('L' + r.line + '\t' + r.kind + '\t' + r.d));
