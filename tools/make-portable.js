'use strict';
/**
 * make-portable.js — 打包「便携版」：代码 + ffmpeg 引擎，解压即用
 *
 *   node tools/make-portable.js [版本号]
 *
 * 产物：dist/BootAnimForge-<版本>-portable.zip
 * 与仓库版（不含引擎）的区别：这个 zip 里带 runtime/ffmpeg.exe、ffprobe.exe，
 * 用户不必联网下载引擎。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createZipWriter } = require('../src/zip.js');

const ROOT = path.resolve(__dirname, '..');
const VERSION = process.argv[2] || require('../package.json').version;
const DIST = path.join(ROOT, 'dist');

/** 需要进便携版的目录与文件 */
const INCLUDE_DIRS = ['src', 'public', 'tools', 'docs'];
const INCLUDE_ROOT = ['README.md', 'LICENSE', 'package.json', '启动.cmd'];
const EXCLUDE = new Set(['node_modules', '.work', 'output', 'dist', 'config', '.git']);
const EXCLUDE_FILES = new Set(['gh-probe.js', 'publish.js']);   // 发布脚本对用户无用

async function collect() {
  const files = [];
  for (const name of INCLUDE_ROOT) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push({ abs: p, zip: name });
  }
  async function walk(dir, prefix) {
    let items = [];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (EXCLUDE.has(it.name)) continue;
      const abs = path.join(dir, it.name);
      const zp = `${prefix}/${it.name}`;
      if (it.isDirectory()) await walk(abs, zp);
      else if (it.isFile() && !EXCLUDE_FILES.has(it.name)) files.push({ abs, zip: zp });
    }
  }
  for (const d of INCLUDE_DIRS) await walk(path.join(ROOT, d), d);

  // 引擎
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const p = path.join(ROOT, 'runtime', exe);
    if (!fs.existsSync(p)) throw new Error(`缺少 runtime/${exe}，请先运行 node tools/fetch-ffmpeg.js`);
    files.push({ abs: p, zip: `runtime/${exe}` });
  }
  const lic = path.join(ROOT, 'runtime', 'FFMPEG-LICENSE.txt');
  if (fs.existsSync(lic)) files.push({ abs: lic, zip: 'runtime/FFMPEG-LICENSE.txt' });

  return files;
}

async function main() {
  const files = await collect();
  await fsp.mkdir(DIST, { recursive: true });
  const out = path.join(DIST, `BootAnimForge-${VERSION}-portable.zip`);
  await fsp.rm(out, { force: true });

  // 便携版用 DEFLATE（解压即用，不追求 zip -0 —— 那是 bootanimation.zip 的要求）
  const zip = createZipWriter({ file: out, compress: true });
  let total = 0;
  for (const f of files) {
    const buf = await fsp.readFile(f.abs);
    total += buf.length;
    zip.add(f.zip, buf);
  }

  // 附一份「先看这个」
  zip.add('使用说明.txt', Buffer.from(
    `开机动画工坊 BootAnimForge ${VERSION}（便携版）
================================================

这个包里已经带好视频引擎，解压后双击 启动.cmd 即可用，不需要联网下载。

需要：Windows 10/11 + Node.js 18 或更高版本 + Edge（或 Chrome）
      Node.js 下载：https://nodejs.org/

用法
----
1. 解压到任意目录（不要放在需要管理员权限的目录）
2. 双击 启动.cmd
3. 拖入视频 → 设分辨率与循环 → 导出

产出的 bootanimation.zip 可直接刷入，或在界面里勾选「同时生成 Magisk 模块」
得到一个能直接在 Magisk App 里安装的模块 zip。

更详细的说明见 README.md。
`, 'utf8'));

  const stat = zip.finish();
  const sizes = [out, ...[]].map((p) => fs.statSync(p).size);
  console.log(`已生成：${out}`);
  console.log(`  条目 ${stat.entries} 个，未压缩合计 ${(total / 1048576).toFixed(1)} MB，压缩后 ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error('打包失败：', e.message); process.exit(1); });
