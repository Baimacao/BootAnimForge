'use strict';
/** anim-probe.js — 单独探针：观察视图切换时的 class 变化 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.work', 'probe-profile');
const PORT = 9334;

function findEdge() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')].find((c) => fs.existsSync(c));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(findEdge(), ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

  try {
    let targets = [];
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await r.json(); if (targets.length) break; } catch { /* wait */ }
      await sleep(250);
    }
    const t = targets.find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res, { once: true }));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Page.navigate', { url: 'http://127.0.0.1:17321/' });
    for (let i = 0; i < 40; i++) { if (await evalJs(`!!document.querySelector('.step-chip')`)) break; await sleep(250); }
    await sleep(1200);

    console.log('reduce =', await evalJs(`matchMedia('(prefers-reduced-motion: reduce)').matches`));

    // 在页面内部挂钩，记录 class 变化
    await evalJs(`
      window.__log = [];
      const target = document.querySelector('#view-configure');
      const mo = new MutationObserver((muts) => {
        for (const m of muts) if (m.attributeName === 'class') window.__log.push('class=' + target.className + ' hidden=' + target.hidden);
      });
      mo.observe(target, { attributes: true, attributeFilter: ['class', 'hidden'] });
      window.__mo = mo;
    `);

    console.log('\n--- 直接调用 goStep(2) ---');
    console.log('同步观察 :', await evalJs(`(() => {
        const before = document.querySelector('#view-configure').className;
        window.__baf.actions.goStep(2);
        const el = document.querySelector('#view-configure');
        return { before, after: el.className, hidden: el.hidden,
                 anim: getComputedStyle(el).animationName, dur: getComputedStyle(el).animationDuration };
      })()`));
    await sleep(120);
    console.log('120ms 后 :', await evalJs(`(() => { const el=document.querySelector('#view-configure');
        return { cls: el.className, anim: getComputedStyle(el).animationName, tf: getComputedStyle(el).transform }; })()`));
    await sleep(600);
    console.log('720ms 后 :', await evalJs(`(() => { const el=document.querySelector('#view-configure');
        return { cls: el.className, anim: getComputedStyle(el).animationName }; })()`));
    console.log('class 变化记录:', await evalJs(`window.__log`));

    // 该元素命中了哪些 CSS 规则？
    console.log('\n--- 命中 .enter-forward 的规则 ---');
    console.log(await evalJs(`(() => {
      const out = [];
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('enter-forward')) out.push(r.selectorText + ' { ' + r.style.cssText + ' }');
          if (r.cssRules) for (const rr of r.cssRules) {
            if (rr.selectorText && rr.selectorText.includes('enter-forward')) out.push('[in @media ' + (r.conditionText||'') + '] ' + rr.selectorText + ' { ' + rr.style.cssText + ' }');
          }
        }
      }
      return out;
    })()`));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }
})();
