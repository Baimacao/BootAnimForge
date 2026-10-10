'use strict';
/**
 * _icon-zoom.js — 以 4 倍设备像素比抓配置页，用于检查 20px 图标的细节质量。
 * 20px 下无法判断图标是否"糊成一块"，必须放大实测。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const URL_ = 'http://127.0.0.1:17321/';
const PORT = 9352;
const PROFILE = path.join(ROOT, '.work', 'cdp-zoom');
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
    '--no-first-run', '--window-size=700,500', 'about:blank',
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
    const ws = new WebSocket(target.webSocketDebuggerUrl);
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
    await send('Emulation.setDeviceMetricsOverride', { width: 620, height: 420, deviceScaleFactor: 5, mobile: false });
    await send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 40; i++) { if (await evalJs('document.readyState') === 'complete') break; await sleep(250); }
    await sleep(1200);

    const vid = path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
    await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(vid)})`);
    for (let i = 0; i < 60; i++) { if (await evalJs('!!window.__baf.state.info')) break; await sleep(300); }
    await evalJs(`window.__baf.actions.goStep(2)`);
    await sleep(1600);

    /* 把第一张卡片的图标区域滚到视口内并放大展示：直接放大 svg 的 CSS 尺寸便于观察 */
    await evalJs(`(() => {
      const s = document.createElement('style');
      s.textContent = '#view-configure .card-head .icon { width:120px !important; height:120px !important; }';
      document.head.appendChild(s);
    })()`);
    await sleep(600);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(ROOT, '.work', 'icons-zoom.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('已抓取（图标放大到 120px）: ' + out);
    ws.close();
  } finally {
    edge.kill();
  }
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
