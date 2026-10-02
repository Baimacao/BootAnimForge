'use strict';
/**
 * main.js — 入口
 *
 *   node src/main.js                 启动服务并打开应用窗口
 *   node src/main.js --no-open       只启动服务（打印地址）
 *   node src/main.js --port 17321    固定端口
 *   node src/main.js --browser       强制用默认浏览器打开标签页
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'BootAnimForge';
const DEFAULT_PORT = 17321;

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, open: true, mode: 'app', force: false, quiet: false, reuse: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--open') { out.open = true; out.force = true; }
    else if (a === '--browser' || a === '--tab') out.mode = 'tab';
    else if (a === '--app') out.mode = 'app';
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--reuse') out.reuse = true;
    else if (a === '--port') out.port = parseInt(argv[++i], 10) || DEFAULT_PORT;
    else if (a.startsWith('--port=')) out.port = parseInt(a.slice(7), 10) || DEFAULT_PORT;
  }
  return out;
}

/** 静默模式：ffmpeg 的进度与日志只在界面的日志面板里显示，控制台保持干净 */
function muteConsole() {
  const noop = () => {};
  console.log = noop;
  process.stdout.write = () => true;
}

/** 找 Chromium 系浏览器（用于 --app 独立窗口） */
function findChromium() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf, 'Vivaldi', 'Application', 'vivaldi.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function openAppWindow(url, opts) {
  const profileDir = path.join(ROOT, '.work', 'ui-profile');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,860',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--allow-file-access-from-files',
  ];
  const bin = findChromium();
  if (!bin) return null;
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { bin, pid: child.pid, profileDir };
}

function openDefaultBrowser(url) {
  const plat = process.platform;
  try {
    if (plat === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (plat === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  delete require.cache[require.resolve('./server')];
  const { createServer, listen, portAlive } = require('./server');

  // 已有实例在跑 → 直接复用（再点一次启动不会开出第二个服务）
  if (!args.force) {
    const existing = await portAlive(args.port);
    if (existing?.ok) {
      const url = `http://127.0.0.1:${args.port}/`;
      if (args.reuse) {
        // 只负责把界面窗口打开，不再起第二个服务
        if (args.open) {
          if (args.mode === 'tab') openDefaultBrowser(url);
          else { const r = openAppWindow(url, args); if (!r) openDefaultBrowser(url); }
        }
        console.log(`${APP_NAME} 复用已在运行的实例（pid ${existing.pid}）：${url}`);
      } else {
        console.log(`${APP_NAME} 已在运行（pid ${existing.pid}）：${url}`);
        if (args.open) {
          if (args.mode === 'tab') openDefaultBrowser(url);
          else { const r = openAppWindow(url, args); if (!r) openDefaultBrowser(url); }
        }
      }
      process.exit(0);
    }
  }

  const server = createServer();
  let port;
  try {
    port = await listen(server, args.port);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      port = await listen(server, 0);
    } else throw e;
  }
  const url = `http://127.0.0.1:${port}/`;

  console.log('');
  console.log(`  ${APP_NAME}  已启动`);
  console.log(`  地址：${url}`);
  console.log('  关闭此窗口或按 Ctrl+C 退出。');
  console.log('');

  if (args.open) {
    let opened = null;
    if (args.mode === 'tab') opened = openDefaultBrowser(url);
    else {
      const r = openAppWindow(url, args);
      if (r) opened = true;
      else opened = openDefaultBrowser(url);
    }
    if (!opened) console.log('  未能自动打开窗口，请手动访问上面的地址。');
  }

  // 界面已经在应用窗口里，控制台再刷 ffmpeg 日志只会干扰用户
  if (args.quiet) muteConsole();

  const bye = () => { console.log('\n  正在退出…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 800); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error(`${APP_NAME} 启动失败：`, e);
  process.exit(1);
});
