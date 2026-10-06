'use strict';
/** probe-naming.js — 检查 #naming-box 的显隐到底怎么了 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.work', 'probe2-profile');
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')].find((c) => fs.existsSync(c));
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(findEdge(), ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  try {
    let targets = [];
    for (let i = 0; i < 40; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch { /* wait */ }
      await sleep(250);
    }
    const t = targets.find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:17321', storageTypes: 'local_storage' });
    await send('Page.navigate', { url: 'http://127.0.0.1:17321/' });
    for (let i = 0; i < 40; i++) { if (await evalJs(`!!document.querySelector('.step-chip')`)) break; await sleep(250); }
    await sleep(1500);

    const video = path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
    await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(video)})`);
    for (let i = 0; i < 40; i++) { if (await evalJs(`!!window.__baf.state.info`)) break; await sleep(250); }
    await sleep(800);

    const dump = () => evalJs(`(() => {
      const n = document.querySelector('#naming-box');
      const cs = n ? getComputedStyle(n) : null;
      return {
        exists: !!n,
        hiddenProp: n ? n.hidden : null,
        hasAttr: n ? n.hasAttribute('hidden') : null,
        display: cs ? cs.display : null,
        visibility: cs ? cs.visibility : null,
        rectH: n ? Math.round(n.getBoundingClientRect().height) : null,
        offParent: n ? n.offsetParent === null : null,
        fmt: window.__baf.state.config.format,
      };
    })()`);

    console.log('① 载入后（classic）:', await dump());
    await evalJs(`window.__baf.actions.setFormat('video')`);
    await sleep(300);
    console.log('② setFormat(video):', await dump());
    await evalJs(`window.__baf.actions.setFormat('classic')`);
    await sleep(300);
    console.log('③ setFormat(classic):', await dump());
    await evalJs(`window.__baf.actions.goStep(3)`); await sleep(500);
    await evalJs(`window.__baf.actions.goStep(2)`); await sleep(800);
    console.log('④ 来回切页后:', await dump());
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
