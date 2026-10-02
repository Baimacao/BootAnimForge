'use strict';
/**
 * server-ctl.js — 开发辅助：启停本地服务
 *
 *   node tools/server-ctl.js start [port]   后台启动（PID 写入 .work/server.pid）
 *   node tools/server-ctl.js stop [port]    停止：先杀 PID 记录的进程，再检查端口占用者
 *   node tools/server-ctl.js status [port]
 *   node tools/server-ctl.js open [port]    复用已运行实例，只打开应用窗口
 *
 * 之所以还要检查端口：如果服务是被别的终端启动的（比如用户双击了 启动.cmd），
 * PID 文件里没有它。只按 PID 杀会留下「僵尸占着端口」，后续测试就会跑到旧代码上
 * —— 这个坑真踩过：UI 自检连的其实是十几分钟前启动的旧进程。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT, '.work', 'server.pid');
const cmd = process.argv[2] || 'status';
const port = Number(process.argv[3]) || 17321;

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function health(p = port, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** 谁在监听这个端口（Windows） */
function listenerPids(p) {
  const pids = new Set();
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const m = line.trim().split(/\s+/);
      // 协议 本地地址 外部地址 状态 PID
      if (m.length >= 5 && m[1] && m[1].endsWith(`:${p}`)) pids.add(Number(m[m.length - 1]));
    }
  } catch { /* netstat 不可用时忽略 */ }
  return [...pids].filter((n) => Number.isFinite(n) && n > 0);
}

async function killPid(pid, label) {
  if (!pid || !alive(pid)) return false;
  try { process.kill(pid); } catch { /* ignore */ }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(120);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  console.log(`已停止${label || ''} pid=${pid}`);
  return true;
}

async function main() {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

  if (cmd === 'start') {
    const h = await health();
    if (h) {
      // 端口已被占用：记录它的 PID，避免以后找不到
      fs.writeFileSync(PID_FILE, String(h.pid));
      console.log(`已在运行 pid=${h.pid}（端口 ${port} 已被占用，已记入 PID 文件）`);
      return;
    }
    const out = fs.openSync(path.join(ROOT, '.work', 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js'), '--no-open', '--port', String(port)], {
      cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    fs.writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const hh = await health();
      if (hh) {
        if (hh.pid !== child.pid) {
          console.log(`警告：端口 ${port} 由 pid=${hh.pid} 响应，而本次启动的是 pid=${child.pid}。`);
          console.log('      可能有旧实例没退干净，建议执行 stop 后再 start。');
        } else {
          console.log(`已启动 pid=${child.pid} ffmpeg=${hh.ffmpeg}`);
        }
        fs.writeFileSync(PID_FILE, String(hh.pid));
        return;
      }
    }
    console.log(`已启动 pid=${child.pid}（端口未确认，日志见 .work/server.log）`);
    return;
  }

  if (cmd === 'stop') {
    const pid = readPid();
    await killPid(pid, '（记录）');
    // 兜底：谁还占着端口就一并清掉
    for (const p of listenerPids(port)) {
      if (p !== pid) await killPid(p, '（占用端口的旧实例）');
    }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    const still = await health();
    console.log(still ? `警告：端口 ${port} 仍有服务响应（pid ${still.pid}）` : '端口已释放');
    return;
  }

  if (cmd === 'open') {
    const h = await health();
    if (!h) { console.log('服务未运行，请先 start'); return; }
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js'), '--reuse', '--port', String(port)], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    console.log(`已请求打开应用窗口（服务 pid=${h.pid}）`);
    return;
  }

  const h = await health();
  const pid = readPid();
  if (h) console.log(`运行中：pid=${h.pid} ffmpeg=${h.ffmpeg}（PID 文件记录 ${pid || '无'}）`);
  else console.log('未运行');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
