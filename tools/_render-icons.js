'use strict';
/**
 * _render-icons.js — 把 index.html 里 28 个内联 SVG 图标渲染成一张对照表。
 *
 * 为什么：图标在 20px 下看不出对错，"看着还行"不可靠。渲染成大图逐个检查，
 * 并把 viewBox 尺寸与路径是否为 fill 语义一并列出（fill 路径画 stroke 图标会变形）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/* 提取所有内联 svg.icon 的完整标签 */
const svgs = [];
const re = /<svg class="icon[^"]*"[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/g;
let m;
while ((m = re.exec(html)) !== null) {
  const line = html.slice(0, m.index).split('\n').length;
  const inner = m[2];
  const fillPaths = (inner.match(/fill="(?!none)/g) || []).length;
  const strokePaths = (inner.match(/stroke="/g) || []).length;
  const currentColor = (inner.match(/fill="currentColor"/g) || []).length;
  svgs.push({ line, viewBox: m[1], inner, fillPaths, strokePaths, currentColor, raw: m[0] });
}

console.log('提取到 ' + svgs.length + ' 个图标');
const noFill = svgs.filter((s) => s.currentColor === 0 && s.strokePaths === 0);
console.log('既非 currentColor 填充、也无 stroke 的图标（会不可见）: ' + noFill.length + ' 个');
noFill.forEach((s) => console.log('   L' + s.line + '  viewBox=' + s.viewBox));

const oddViewBox = svgs.filter((s) => s.viewBox !== '0 0 24 24');
console.log('viewBox 非 24×24 的图标: ' + oddViewBox.length + ' 个');
oddViewBox.forEach((s) => console.log('   L' + s.line + '  viewBox=' + s.viewBox));

/* 生成一张 SVG 预览页：每行 1 个，48px 显示，黑色描边便于看清形状 */
let page = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="' + (svgs.length * 64 + 20) + '" viewBox="0 0 960 ' + (svgs.length * 64 + 20) + '">';
page += '<rect width="100%" height="100%" fill="#F5F2ED"/>';
svgs.forEach((s, i) => {
  const y = i * 64 + 8;
  // 必须显式写 fill/stroke：SVG 不继承 HTML 的 color 属性，currentColor 会解析为黑，
  // 导致所有图标糊成黑块（这是本预览工具踩过的坑，不是图标本身的问题）
  const inner = s.inner.split('currentColor').join('#1A1A1A');
  page += '<g transform="translate(8,' + y + ')">';
  page += '<svg width="48" height="48" viewBox="' + s.viewBox + '" fill="#1A1A1A" stroke="#1A1A1A">' + inner + '</svg>';
  page += '</g>';
  page += '<text x="72" y="' + (y + 32) + '" font-family="monospace" font-size="13" fill="#1A1A1A">L' + s.line + '</text>';
});
page += '</svg>';

const dir = path.join(ROOT, '.work');
fs.mkdirSync(dir, { recursive: true });
const svgFile = path.join(dir, 'icons-check.svg');
fs.writeFileSync(svgFile, page, 'utf8');
console.log('\n预览页: ' + svgFile);

/* 用 Edge 无头渲染成 PNG */
const { execFileSync } = require('child_process');
function findEdge() {
  for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                   'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const edge = findEdge();
if (!edge) { console.log('未找到 Edge'); process.exit(0); }
const outPng = path.join(dir, 'icons-check.png');
try {
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=960,' + (svgs.length * 64 + 20),
    '--screenshot=' + outPng,
    'file:///' + svgFile.replace(/\\/g, '/')], { stdio: 'pipe', timeout: 60000 });
  console.log('渲染完成: ' + outPng);
} catch (e) {
  console.log('渲染失败: ' + (e.stderr || e.message).toString().slice(0, 200));
}
