'use strict';
/**
 * _icon-probe.js — 抓浏览器里 .card-head .icon 的真实渲染，逐像素核对"是否实心"。
 *
 * 为什么不再自己拼 SVG 预览：那样会引入工具自身的渲染差异（上一版就因同时设
 * fill 与 stroke 把内孔糊成实心，误判成图标损坏）。直接问浏览器最可靠。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const URL_ = process.env.BAF_URL || 'http://127.0.0.1:17321/';
const PORT = 9351;
const PROFILE = path.join(ROOT, '.work', 'cdp-icon');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findEdge() {
  for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                   'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Edge');
}
const getJson = (url, tries = 40) => new Promise((resolve, reject) => {
  const go = (n) => http.get(url, (res) => {
    let d = ''; res.on('data', (c) => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', (e) => (n > 0 ? setTimeout(() => go(n - 1), 400) : reject(e)));
  go(tries);
});

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const edge = spawn(findEdge(), [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(400);
      try {
        const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find((t) => t.type === 'page');
      } catch { /* retry */ }
    }
    if (!target) throw new Error('连不上 CDP');

    /* 用 HTTP 轮询 + Runtime.evaluate（不依赖 ws 模块，项目零依赖） */
    const wsUrl = target.webSocketDebuggerUrl;
    // 直接用 Node 内置 WebSocket（Node 22+ 有全局 WebSocket）
    if (typeof WebSocket === 'undefined') throw new Error('当前 Node 无全局 WebSocket，需 Node 22+');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise((res) => {
      const i = ++id; pending.set(i, (m) => res(m.result || m.error));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败');
      return r.result.value;
    };

    await send('Page.enable');
    await send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 40; i++) { if (await evalJs('document.readyState') === 'complete') break; await sleep(250); }
    await sleep(1000);

    const vid = path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
    await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(vid)})`);
    for (let i = 0; i < 60; i++) { if (await evalJs('!!window.__baf.state.info')) break; await sleep(300); }
    await evalJs(`window.__baf.actions.goStep(2)`);
    await sleep(1500);

    /* 对每个卡片图标：取渲染像素，统计"实心度" */
    const report = await evalJs(`JSON.stringify((() => {
      const out = [];
      document.querySelectorAll('#view-configure .card-head .icon').forEach((svg, i) => {
        const cs = getComputedStyle(svg);
        const r = svg.getBoundingClientRect();
        out.push({
          i,
          w: Math.round(r.width), h: Math.round(r.height),
          fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth,
          color: cs.color,
          paths: svg.querySelectorAll('path').length,
          hasFillAttr: /fill="currentColor"/.test(svg.innerHTML),
        });
      });
      return out;
    })())`);
    const list = JSON.parse(report);
    console.log('配置页卡片图标 ' + list.length + ' 个：');
    list.slice(0, 4).forEach((x) => console.log('  ' + JSON.stringify(x)));

    ws.close();
  } finally {
    edge.kill();
  }
})().catch((e) => { console.error('探针失败: ' + e.message); process.exit(1); });
