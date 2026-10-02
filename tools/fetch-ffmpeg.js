'use strict';
/**
 * fetch-ffmpeg.js — 准备 ffmpeg / ffprobe 运行时
 *
 *   node tools/fetch-ffmpeg.js                 自动选源（默认 npm 镜像，最快）
 *   node tools/fetch-ffmpeg.js --from <zip>    从本地 zip 安装（gyan/BtbN 构建包）
 *   node tools/fetch-ffmpeg.js --source gyan   指定源：npm | gyan | btbn
 *
 * 关于源的选择（本机实测，2026-10-02）：
 *   gyan.dev     0.04 MB/s  → 109 MB 要 45 分钟，不可用
 *   GitHub BtbN  极慢
 *   npmmirror    25 MB/s    → 21 MB + 27 MB 共约 3 秒  ✅ 默认
 * 因此默认走 npmmirror 上的 @ffmpeg-installer / @ffprobe-installer 预编译二进制。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const WORK = path.join(ROOT, '.work', 'ffmpeg-dl');
const WIN = process.platform === 'win32';

const SOURCES = {
  npm: {
    label: 'npmmirror',
    files: [
      { url: 'https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz', entry: 'package/ffmpeg.exe', out: 'ffmpeg.exe' },
      { url: 'https://registry.npmmirror.com/@ffprobe-installer/win32-x64/-/win32-x64-5.1.0.tgz', entry: 'package/ffprobe.exe', out: 'ffprobe.exe' },
    ],
  },
  gyan: { label: 'gyan.dev', zip: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' },
  btbn: { label: 'BtbN/FFmpeg-Builds', api: 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest' },
};

function log(...a) { console.log('[ffmpeg]', ...a); }
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

async function download(url, dest, label) {
  const t0 = Date.now();
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'BootAnimForge' } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0, lastPct = -1;
  for await (const c of res.body) {
    chunks.push(Buffer.from(c));
    got += c.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`\r  ${label} ${pct}%  ${mb(got)}/${mb(total)}   `); }
    }
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  const buf = Buffer.concat(chunks);
  if (dest) await fsp.writeFile(dest, buf);
  const dt = (Date.now() - t0) / 1000;
  log(`${label}: ${mb(buf.length)} / ${dt.toFixed(1)}s (${(buf.length / 1048576 / dt).toFixed(1)} MB/s)`);
  return buf;
}

/* ------------------------------------------------------------------ */
/* 极简 tar 解析（只取普通文件）                                        */
/* ------------------------------------------------------------------ */

function untar(buf) {
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) { off += 512; continue; }
    const sizeStr = buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = buf.toString('utf8', off + 156, off + 157);
    const dataStart = off + 512;
    if (type === '0' || type === '\0' || type === '') {
      files.set(name.replace(/^\.\//, ''), buf.subarray(dataStart, dataStart + size));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** 从 npm tarball 里取一个文件 */
async function extractFromTgz(tgz, absEntry, outName) {
  const tar = zlib.gunzipSync(tgz);
  const files = untar(tar);
  const key = [...files.keys()].find((k) => k === absEntry || k.endsWith('/' + path.basename(absEntry)));
  if (!key) throw new Error(`tarball 中找不到 ${absEntry}（实际内容：${[...files.keys()].slice(0, 8).join(', ')}）`);
  const out = path.join(RUNTIME, outName);
  await fsp.writeFile(out, files.get(key));
  return { out, size: files.get(key).length };
}

/* ------------------------------------------------------------------ */
/* gyan / BtbN 的 zip 安装                                             */
/* ------------------------------------------------------------------ */

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${c}\n${err.slice(-1500)}`))));
  });
}

async function findFiles(dir, names, depth = 6) {
  const found = {};
  const want = new Set(names.map((n) => n.toLowerCase()));
  async function walk(d, lvl) {
    if (lvl > depth) return;
    let items = [];
    try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await walk(p, lvl + 1);
      else if (want.has(it.name.toLowerCase()) && !found[it.name.toLowerCase()]) found[it.name.toLowerCase()] = p;
    }
  }
  await walk(dir, 0);
  return found;
}

async function installFromZip(zipPath) {
  const ex = path.join(WORK, 'extract');
  await fsp.rm(ex, { recursive: true, force: true });
  await fsp.mkdir(ex, { recursive: true });
  const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (WIN && fs.existsSync(tarExe)) await run(tarExe, ['-xf', zipPath, '-C', ex]);
  else await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${ex.replace(/'/g, "''")}' -Force`]);

  const found = await findFiles(ex, ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE', 'COPYING.GPLv3', 'COPYING.LGPLv3']);
  if (!found['ffmpeg.exe'] || !found['ffprobe.exe']) throw new Error('压缩包内缺少 ffmpeg.exe / ffprobe.exe');
  await fsp.copyFile(found['ffmpeg.exe'], path.join(RUNTIME, 'ffmpeg.exe'));
  await fsp.copyFile(found['ffprobe.exe'], path.join(RUNTIME, 'ffprobe.exe'));
  const lic = found['license'] || found['copying.gplv3'] || found['copying.lgplv3'];
  if (lic) await fsp.copyFile(lic, path.join(RUNTIME, 'FFMPEG-LICENSE.txt'));
  await fsp.rm(ex, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function installFromNpm() {
  const src = SOURCES.npm;
  await fsp.mkdir(RUNTIME, { recursive: true });
  for (const f of src.files) {
    const tgz = await download(f.url, null, path.basename(f.url));
    const r = await extractFromTgz(tgz, f.entry, f.out);
    log(`→ runtime/${f.out} (${mb(r.size)})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const argVal = (name) => {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(name + '='));
    return eq ? eq.slice(name.length + 1) : null;
  };

  await fsp.mkdir(RUNTIME, { recursive: true });
  await fsp.mkdir(WORK, { recursive: true });

  if (!WIN) {
    log('非 Windows 平台：请用系统包管理器安装 ffmpeg/ffprobe（本工具的界面部分仍可用）。');
    return;
  }

  const from = argVal('--from');
  if (from) {
    log('从本地压缩包安装：', path.resolve(from));
    await installFromZip(path.resolve(from));
  } else {
    const order = argVal('--source') ? [argVal('--source')] : ['npm', 'gyan', 'btbn'];
    let lastErr = null;
    for (const key of order) {
      try {
        if (key === 'npm') await installFromNpm();
        else if (key === 'gyan') {
          const zip = path.join(WORK, 'ffmpeg-gyan.zip');
          await download(SOURCES.gyan.zip, zip, 'gyan release-essentials');
          await installFromZip(zip);
          await fsp.rm(zip, { force: true });
        } else if (key === 'btbn') {
          const rel = await (await fetch(SOURCES.btbn.api, { headers: { 'User-Agent': 'BootAnimForge' } })).json();
          const asset = (rel.assets || []).find((a) => /win64-gpl\.zip$/.test(a.name));
          if (!asset) throw new Error('找不到 Windows 构建产物');
          const zip = path.join(WORK, 'ffmpeg-btbn.zip');
          await download(asset.browser_download_url, zip, asset.name);
          await installFromZip(zip);
          await fsp.rm(zip, { force: true });
        } else throw new Error(`未知源：${key}`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log(`源 ${key} 失败：${e.message}`);
      }
    }
    if (lastErr) throw lastErr;
  }

  // 记录来源，便于排查
  const ver = await probeVersion();
  const meta = { installedAt: new Date().toISOString(), ffmpeg: ver.ffmpeg, ffprobe: ver.ffprobe, source: argVal('--source') || (from ? 'local-zip' : 'auto') };
  await fsp.writeFile(path.join(RUNTIME, 'SOURCE.json'), JSON.stringify(meta, null, 2), 'utf8');
  log(`完成 ✓ ffmpeg ${ver.ffmpeg}`);
}

function probeVersion() {
  const run1 = (exe, args) => new Promise((resolve) => {
    try {
      const p = spawn(exe, args, { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('error', () => resolve(null));
      p.on('close', () => resolve(out.split(/\r?\n/)[0] || null));
    } catch { resolve(null); }
  });
  return (async () => ({
    ffmpeg: await run1(path.join(RUNTIME, 'ffmpeg.exe'), ['-hide_banner', '-version']),
    ffprobe: await run1(path.join(RUNTIME, 'ffprobe.exe'), ['-hide_banner', '-version']),
  }))();
}

main().catch((e) => { console.error('[ffmpeg] 失败：', e.message); process.exit(1); });
