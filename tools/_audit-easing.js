'use strict';
/**
 * _audit-easing.js — 审计 app.css 的过渡声明，按「是否含形变属性」分类。
 *
 * 为什么需要：弹性缓动 cubic-bezier(.34,1.56,.64,1) 有 overshoot，
 * 只有作用在 transform / scale / translate 这类**形变**上才有"重量感"；
 * 套在 opacity / color 上会显得迟滞怪异。所以必须先分清再改。
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
const lines = css.split('\n');

let cur = '(root)';
const shape = [];   // 含形变属性
const plain = [];   // 纯颜色/透明度

lines.forEach((l, i) => {
  const sel = l.match(/^([.#a-zA-Z\[][^{]*)\{/);
  if (sel) cur = sel[1].trim();
  if (!/transition\s*:/.test(l)) return;
  // 收集该 transition 声明（可能跨行）直到分号
  let decl = l;
  let j = i;
  while (!/;/.test(decl) && j < lines.length - 1) { j++; decl += ' ' + lines[j]; }
  const hasTransform = /transform|scale|translate/i.test(decl);
  const ease = (decl.match(/var\(--ease-[a-z-]+\)/) || ['(无)'])[0];
  const dur = (decl.match(/var\(--dur-[a-z0-9]+\)/) || ['(无)'])[0];
  const item = { line: i + 1, sel: cur, ease, dur, snippet: decl.replace(/\s+/g, ' ').trim().slice(0, 92) };
  (hasTransform ? shape : plain).push(item);
});

console.log('含形变的过渡: ' + shape.length + ' 处');
const byEase = {};
shape.forEach((s) => { byEase[s.ease] = (byEase[s.ease] || 0) + 1; });
Object.entries(byEase).sort((a, b) => b[1] - a[1]).forEach(([e, n]) => console.log('    ' + e + ' × ' + n));

console.log('\n纯颜色/透明度的过渡: ' + plain.length + ' 处');
const byEase2 = {};
plain.forEach((s) => { byEase2[s.ease] = (byEase2[s.ease] || 0) + 1; });
Object.entries(byEase2).sort((a, b) => b[1] - a[1]).forEach(([e, n]) => console.log('    ' + e + ' × ' + n));

console.log('\n--- 形变过渡明细（这些是弹性缓动的目标） ---');
shape.slice(0, 24).forEach((s) => console.log('  L' + s.line + '  ' + s.ease.padEnd(26) + '  ' + s.sel));
