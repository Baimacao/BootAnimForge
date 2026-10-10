'use strict';
/**
 * _icon-size.js — 量浏览器里每个图标的真实渲染尺寸与所在元素，定位尺寸不一致问题。
 * 同时核对 --font-mono 是否指向本机不存在的字体（会静默回退，未必是问题，但要记录）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 9353;
const PROFILE = path.join(ROOT, '.work', 'cdp-size');
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
  const edge = spawn(findEdge(), ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(400);
      try { const l = await getJson(`http://127.0.0.1:${PORT}/json/list`); target = l.find((t) => t.type === 'page'); } catch { }
    }
    if (!target) throw new Error('连不上 CDP');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, (m) => res(m.result || m.error)); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败');
      return r.result.value;
    };

    await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:17321/' });
    for (let i = 0; i < 40; i++) { if (await evalJs('document.readyState') === 'complete') break; await sleep(250); }
    await sleep(1000);
    const vid = path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
    await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(vid)})`);
    for (let i = 0; i < 60; i++) { if (await evalJs('!!window.__baf.state.info')) break; await sleep(300); }
    await evalJs(`window.__baf.actions.goStep(2)`);
    await sleep(1200);

    const rep = await evalJs(`JSON.stringify((() => {
      const buckets = {};
      document.querySelectorAll('svg').forEach((s) => {
        const r = s.getBoundingClientRect();
        const cls = s.getAttribute('class') || '(无类名)';
        const w = Math.round(r.width), h = Math.round(r.height);
        if (!w) return;                       // 隐藏的不计
        const key = cls + '  ' + w + '×' + h;
        buckets[key] = (buckets[key] || 0) + 1;
      });
      return buckets;
    })())`);
    const b = JSON.parse(rep);
    console.log('图标渲染尺寸分布（类名 + 尺寸 → 个数）:');
    Object.entries(b).sort((a, c) => c[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(3) + ' ×  ' + k));

    const mono = await evalJs(`getComputedStyle(document.querySelector('.mono') || document.body).fontFamily`);
    console.log('\n.mono 计算字体: ' + mono);
    ws.close();
  } finally { edge.kill(); }
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
