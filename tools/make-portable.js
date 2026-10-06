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
const INCLUDE_DIRS = ['src', 'public', 'tools', 'docs', 'android'];
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

  // 安卓端 APK：一起塞进便携版，用户拿到就能两边用
  const apkDir = path.join(ROOT, 'dist', 'android');
  if (fs.existsSync(apkDir)) {
    const apks = fs.readdirSync(apkDir).filter((f) => f.endsWith('.apk'))
      .map((f) => ({ f, t: fs.statSync(path.join(apkDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (apks.length) {
      files.push({ abs: path.join(apkDir, apks[0].f), zip: `android-apk/${apks[0].f}` });
    }
  }
  // 引擎 + Node 运行时：便携版的目标是「解压即用、无任何前置」
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe', 'node.exe']) {
    const p = path.join(ROOT, 'runtime', exe);
    if (!fs.existsSync(p)) {
      if (exe === 'node.exe') {
        console.log('  · 注意：runtime/node.exe 不存在，将跳过打包 Node。');
        console.log('    这样便携版仍要求机器上已装 Node；要「无前置」请先运行：');
        console.log('    powershell -ExecutionPolicy Bypass -File tools\\fetch-node.ps1');
        continue;
      }
      throw new Error(`缺少 runtime/${exe}，请先运行 node tools/fetch-ffmpeg.js`);
    }
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
    `启幕 BootAnimForge ${VERSION}（便携版 · 无需任何前置）
================================================

这个包里已经带好：
  runtime\\node.exe    Node.js 运行时
  runtime\\ffmpeg.exe  视频引擎

所以解压后直接双击 启动.cmd 就能用，不需要安装 Node.js，也不需要联网下载。

用法
----
1. 解压到任意目录（不要放在需要管理员权限的目录）
2. 双击 启动.cmd
3. 拖入视频 → 设分辨率与循环 → 导出

界面会在一个独立的 Edge 窗口里打开（无地址栏、无标签）。
需要机器上有 Microsoft Edge 或 Google Chrome（Win10/11 基本都有）。

产出的 bootanimation.zip 可直接刷入；勾选「同时生成 Magisk 模块」
还能得到一个能在 Magisk App 里直接安装的模块 zip。

手表用户注意
------------
部分安卓手表的帧文件名是纯数字（如 001.png），而不是 frame_00000.png。
在「输出与打包 → 帧文件命名」里把前缀清空、补零位数设为 3、起始编号设为 1 即可。

更详细的说明见 README.md。
`, 'utf8'));

  const stat = zip.finish();
  const sizes = [out, ...[]].map((p) => fs.statSync(p).size);
  console.log(`已生成：${out}`);
  console.log(`  条目 ${stat.entries} 个，未压缩合计 ${(total / 1048576).toFixed(1)} MB，压缩后 ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error('打包失败：', e.message); process.exit(1); });
