'use strict';
/** 列出 index.html 里每个内联图标的语义上下文，便于逐一判断该换成什么 */
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split('\n');

const rows = [];
h.forEach((line, i) => {
  if (!/<svg class="icon/.test(line)) return;
  let label = '(未知)';
  // 向后找标题
  for (let j = i; j < Math.min(i + 4, h.length); j++) {
    const m = h[j].match(/<h2>([^<]+)<\/h2>/) || h[j].match(/aria-label="([^"]+)"/) || h[j].match(/<b>([^<]+)<\/b>/);
    if (m) { label = m[1]; break; }
  }
  // 向前找 data-help / id
  for (let j = i; j > Math.max(0, i - 3); j--) {
    const m = h[j].match(/data-help="([^"]+)"/) || h[j].match(/id="([^"]+)"/);
    if (m) { label = '#' + m[1] + ' → ' + label; break; }
  }
  // 判断该图标是"实心"还是"轮廓"：轮廓字符通常只有一个细 path
  const d = (line.match(/d="([^"]+)"/) || [])[1] || '';
  const segs = (d.match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length;
  rows.push({ line: i + 1, label: label.slice(0, 42), segs, d: d.slice(0, 40) });
});

rows.forEach((r) => {
  console.log('L' + String(r.line).padStart(4) + '  段数=' + String(r.segs).padStart(3) + '  ' + r.label.padEnd(44) + r.d);
});
console.log('\n共 ' + rows.length + ' 个图标');
