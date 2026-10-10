'use strict';
/** 读 .opt .tick svg 的计算样式，定位 5×5 的真实来源 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 9355;
const PROFILE = path.join(ROOT, '.work', 'cdp-tick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findEdge() {
  for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                   'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Edge');
}
const getJson = (url, tries = 40) => new Promise((resolve, reject) => {
  const go = (n) => http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); })
    .on('error', (e) => (n > 0 ? setTimeout(() => go(n - 1), 400) : reject(e)));
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
    await evalJs(`window.__baf.actions.goStep(2)`);
    await sleep(1500);

    const rep = await evalJs(`JSON.stringify((() => {
      const svg = document.querySelector('#scale-modes .opt .tick svg');
      if (!svg) return { err: '找不到 .opt .tick svg' };
      const cs = getComputedStyle(svg);
      const tick = svg.parentElement;
      const tcs = getComputedStyle(tick);
      const opt = tick.parentElement;
      const or_ = opt.getBoundingClientRect(), tr = tick.getBoundingClientRect(), sr = svg.getBoundingClientRect();
      return {
        svg: { w: cs.width, h: cs.height, flex: cs.flex, minW: cs.minWidth, box: Math.round(sr.width) + 'x' + Math.round(sr.height),
               cls: svg.getAttribute('class'),
               matched: Array.from(svg.getClientRects()).length },
        tick: { w: tcs.width, h: tcs.height, display: tcs.display, box: Math.round(tr.width) + 'x' + Math.round(tr.height),
                pos: tcs.position, transform: tcs.transform, opacity: tcs.opacity },
        opt: { box: Math.round(or_.width) + 'x' + Math.round(or_.height), display: getComputedStyle(opt).display,
               pressed: opt.getAttribute('aria-pressed') },
      };
    })())`);
    console.log(JSON.stringify(JSON.parse(rep), null, 2));
    ws.close();
  } finally { edge.kill(); }
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
