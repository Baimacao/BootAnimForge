'use strict';
/**
 * server.js — 本地服务：静态界面 + 转换 API + SSE 进度
 *
 * 设计：无第三方依赖，监听 127.0.0.1 随机（或指定）端口。
 * 安全：仅绑定回环地址；静态文件做路径穿越校验；允许跨源（本应用自带窗口）。
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ffs = require('./ffmpeg');
const convert = require('./convert');
const { uid, ensureDir, num, int, bool, fmtBytes } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.gif': 'image/gif',
};

/* ------------------------------------------------------------------ */
/* 任务与进度                                                          */
/* ------------------------------------------------------------------ */

class Job extends EventEmitter {
  constructor(id, kind = 'convert') {
    super();
    this.id = id;
    this.kind = kind;
    this.state = 'running';
    this.createdAt = Date.now();
    this.progress = { stage: 'prepare', ratio: 0 };
    this.logs = [];
    this.result = null;
    this.error = null;
    this.controller = new AbortController();
    this.setMaxListeners(0);
  }

  push(patch) { this.progress = { ...this.progress, ...patch }; this.emit('progress', this.progress); }
  log(line) {
    const text = String(line);
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      const entry = { t: Date.now(), line: l };
      this.logs.push(entry);
      if (this.logs.length > 800) this.logs.splice(0, this.logs.length - 800);
      this.emit('log', entry);
    }
  }
  done(result) { this.state = 'done'; this.result = result; this.progress = { ...this.progress, ratio: 1, stage: 'done' }; this.emit('progress', this.progress); this.emit('done', result); }
  fail(error) { this.state = error?.cancelled ? 'cancelled' : 'error'; this.error = { message: error?.message || String(error), validation: error?.validation || null }; this.emit('error', this.error); this.emit('done', this.error); }
  cancel() { try { this.controller.abort(); } catch { /* ignore */ } this.state = 'cancelling'; this.emit('progress', { ...this.progress, stage: 'cancelling' }); }
}

const jobs = new Map();

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function readSettings() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { recentDirs: [], outputDir: '', presets: [], tutorialDone: false, locale: 'zh-CN' };
  }
}

async function writeSettings(patch) {
  const cur = await readSettings();
  const next = { ...cur, ...patch };
  await ensureDir(CONFIG_DIR);
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 打开系统资源管理器 / 用默认程序打开文件 */
function openWithShell(target, reveal = false) {
  const plat = process.platform;
  try {
    if (plat === 'win32') {
      spawn('explorer.exe', [reveal ? `/select,${target}` : target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [reveal ? '-R' : '-a', target].filter(Boolean), { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [reveal ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method || 'GET';

  /* --- 环境 / 运行时 --- */
  if (p === '/api/health') {
    const b = ffs.resolveBinaries(true);
    const v = await ffs.version();
    return json(res, 200, {
      ok: !!b.ffmpeg && !!b.ffprobe,
      platform: process.platform,
      node: process.version,
      ffmpeg: v ? v.version : null,
      ffmpegPath: b.ffmpeg,
      ffprobePath: b.ffprobe,
      runtimeDir: b.runtimeDir,
      pid: process.pid,
      version: require('../package.json').version,
    });
  }

  if (p === '/api/runtime/fetch' && method === 'POST') {
    const job = new Job(uid('rt'), 'runtime');
    jobs.set(job.id, job);
    (async () => {
      const script = path.join(ROOT, 'tools', 'fetch-ffmpeg.js');
      const child = spawn(process.execPath, [script], { cwd: ROOT, windowsHide: true });
      child.stdout.on('data', (d) => job.log(d.toString('utf8')));
      child.stderr.on('data', (d) => job.log(d.toString('utf8')));
      child.on('close', async (code) => {
        ffs.resolveBinaries(true);
        const ok = !!ffs.resolveBinaries().ffmpeg;
        if (code === 0 && ok) job.done({ ok: true, ffmpeg: (await ffs.version())?.version });
        else job.fail(new Error(`下载失败（退出码 ${code}）`));
      });
      child.on('error', (e) => job.fail(e));
    })();
    return json(res, 202, { jobId: job.id });
  }

  /* --- 文件系统辅助（仅本机，用于目录/文件选择） --- */
  if (p === '/api/fs/list') {
    const dir = q.get('dir') || '';
    const wantFiles = q.get('files') === '1';
    const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.ts', '.m2ts', '.wmv', '.m4v', '.mpg', '.mpeg', '.3gp', '.gif', '.vob', '.rmvb', '.rm', '.asf', '.ogv'];
    const target = dir ? path.resolve(dir) : '';
    if (!target) {
      // 列出盘符
      const drives = [];
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const d = `${letter}:\\`;
        try { if (fs.existsSync(d)) drives.push({ name: d, path: d, dir: true }); } catch { /* ignore */ }
      }
      const home = process.env.USERPROFILE || process.cwd();
      const quick = [
        { name: '桌面', path: path.join(home, 'Desktop'), dir: true },
        { name: '下载', path: path.join(home, 'Downloads'), dir: true },
        { name: '视频', path: path.join(home, 'Videos'), dir: true },
        { name: '文档', path: path.join(home, 'Documents'), dir: true },
        { name: '本程序输出目录', path: path.join(ROOT, 'output'), dir: true },
      ].filter((x) => fs.existsSync(x.path));
      return json(res, 200, { cwd: process.cwd(), parent: null, drives, quick, entries: [], files: [] });
    }
    let st;
    try { st = await fsp.stat(target); } catch { return json(res, 404, { error: '目录不存在：' + target }); }
    if (!st.isDirectory()) return json(res, 400, { error: '不是目录' });
    let items = [];
    let files = [];
    try {
      const all = await fsp.readdir(target, { withFileTypes: true });
      items = all
        .filter((d) => d.isDirectory() && !d.name.startsWith('$') && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(target, d.name), dir: true }))
        .slice(0, 500);
      if (wantFiles) {
        files = all
          .filter((d) => d.isFile() && VIDEO_EXT.includes(path.extname(d.name).toLowerCase()))
          .map((d) => ({ name: d.name, path: path.join(target, d.name), dir: false }))
          .slice(0, 500);
      }
    } catch (e) {
      return json(res, 403, { error: '无法读取目录：' + e.message });
    }
    const parent = path.dirname(target);
    return json(res, 200, {
      cwd: target,
      parent: parent === target ? null : parent,
      entries: items.sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      files: files.sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    });
  }

  if (p === '/api/fs/mkdir' && method === 'POST') {
    const body = await readBody(req);
    if (!body.dir) return json(res, 400, { error: '缺少 dir' });
    await ensureDir(String(body.dir));
    return json(res, 200, { ok: true, dir: String(body.dir) });
  }

  /* --- 分析 --- */
  if (p === '/api/probe' && method === 'POST') {
    const body = await readBody(req);
    if (!body.input) return json(res, 400, { error: '缺少 input' });
    try {
      const info = await ffs.probe(String(body.input));
      return json(res, 200, { ok: true, info });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/analyze' && method === 'POST') {
    const body = await readBody(req);
    if (!body.input) return json(res, 400, { error: '缺少 input' });
    try {
      const r = await convert.analyze(body);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/thumbnail' && method === 'POST') {
    const body = await readBody(req);
    try {
      // duration 给了就用「挑一张有代表性的帧」的逻辑，避免片头黑场导致预览全黑
      if (num(body.duration, 0) > 0) {
        const r = await ffs.previewThumbnail({
          input: String(body.input), time: num(body.time, 0),
          duration: num(body.duration, 0), width: int(body.width, 360),
        });
        return json(res, 200, { ok: true, data: r.data, time: r.time, luma: r.luma, allBlack: r.allBlack });
      }
      const data = await ffs.thumbnail({ input: String(body.input), time: num(body.time, 0), width: int(body.width, 360) });
      return json(res, 200, { ok: true, data });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  /* --- 源视频流（内置预览用，支持 Range） --- */
  if (p === '/api/media') {
    const file = q.get('path');
    if (!file) return json(res, 400, { error: '缺少 path' });
    return serveFile(req, res, file, true);
  }

  /* --- 转换 --- */
  if (p === '/api/extract' && method === 'POST') {
    const body = await readBody(req);
    if (!body.input) return json(res, 400, { error: '缺少 input' });
    const job = new Job(uid('j'));
    jobs.set(job.id, job);
    (async () => {
      try {
        job.push({ stage: 'prepare', ratio: 0 });
        const result = await convert.run({ ...body, jobId: job.id }, {
          signal: job.controller.signal,
          onProgress: (pr) => job.push(pr),
          onStage: (s) => job.push({ stage: s }),
          onLog: (l) => job.log(l),
        });
        job.done(result);
      } catch (e) {
        job.fail(e);
      }
    })();
    return json(res, 202, { ok: true, jobId: job.id });
  }

  const jobMatch = p.match(/^\/api\/job\/([A-Za-z0-9_-]+)(\/events|\/cancel)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: '任务不存在' });
    const sub = jobMatch[2];

    if (sub === '/cancel') { job.cancel(); return json(res, 200, { ok: true }); }

    if (sub === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
      };
      send('progress', job.progress);
      for (const l of job.logs.slice(-200)) send('log', l);
      const onProgress = (pr) => send('progress', pr);
      const onLog = (l) => send('log', l);
      const onDone = (d) => { send('done', d); cleanup(); try { res.end(); } catch { /* ignore */ } };
      const cleanup = () => {
        job.off('progress', onProgress); job.off('log', onLog); job.off('done', onDone);
      };
      job.on('progress', onProgress);
      job.on('log', onLog);
      job.on('done', onDone);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(ka); cleanup(); });
      if (job.state !== 'running' && job.state !== 'cancelling') onDone(job.result || job.error);
      return undefined;
    }

    return json(res, 200, {
      ok: true,
      id: job.id,
      state: job.state,
      progress: job.progress,
      logs: job.logs.slice(-300),
      result: job.result,
      error: job.error,
    });
  }

  /* --- 设置 / 预设 --- */
  if (p === '/api/settings') {
    if (method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await writeSettings(body));
    }
    return json(res, 200, await readSettings());
  }

  /* --- 打开资源管理器 --- */
  if (p === '/api/reveal' && method === 'POST') {
    const body = await readBody(req);
    const target = String(body.path || '');
    if (!target || !fs.existsSync(target)) return json(res, 404, { error: '路径不存在' });
    const ok = openWithShell(target, !!body.select);
    return json(res, 200, { ok });
  }

  if (p === '/api/open' && method === 'POST') {
    const body = await readBody(req);
    const target = String(body.path || '');
    if (!target || !fs.existsSync(target)) return json(res, 404, { error: '路径不存在' });
    return json(res, 200, { ok: openWithShell(target, false) });
  }

  if (p === '/api/shutdown' && method === 'POST') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 120);
    return undefined;
  }

  return json(res, 404, { error: '未知接口 ' + p });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

async function serveFile(req, res, filePath, allowRange = false) {
  let st;
  try { st = await fsp.stat(filePath); } catch { return json(res, 404, { error: '文件不存在' }); }
  if (st.isDirectory()) return json(res, 400, { error: '是目录' });

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // 用 mtime+size 做 ETag：改了代码立刻生效，没改则走 304，不必手动清缓存。
  // （不能让浏览器按 max-age 缓存，否则前端改了而浏览器还在用旧文件——这个坑真踩过。）
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'ETag': etag,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': allowRange ? 'bytes' : 'none',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  let start = 0;
  let end = st.size - 1;
  let code = 200;
  if (allowRange && req.headers.range) {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (m) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
  stream.pipe(res);
  return undefined;
}

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return json(res, 403, { error: '禁止访问' });
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return serveFile(req, res, path.join(target, 'index.html'));
  }
  return serveFile(req, res, target);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await handleStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
      else try { res.end(); } catch { /* ignore */ }
      return undefined;
    }
  });
}

/** 找一个可用端口 */
function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function portAlive(port, timeoutMs = 900) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return j;
  } catch { return null; }
}

module.exports = { createServer, listen, portAlive, jobs, readSettings, writeSettings, ROOT, PUBLIC_DIR };
