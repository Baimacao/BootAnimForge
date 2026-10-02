'use strict';
/**
 * uicheck.js — 用 Edge 无头模式 + CDP 检查前端是否能正常渲染
 *   node tools/uicheck.js [url]
 * 输出：控制台错误、未捕获异常、关键 DOM 状态、截图路径
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const argOf = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const positional = process.argv.slice(2).find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));
const URL_ = positional || 'http://127.0.0.1:17321/';
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.work', 'cdp-profile');
const SHOT = path.join(ROOT, '.work', 'ui-shot.png');
const PORT = 9333;

function findEdge() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const cands = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return cands.find((c) => fs.existsSync(c));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 DevTools：' + url);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', (e) => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of c.handlers) h(msg);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
}

(async () => {
  const bin = findEdge();
  if (!bin) { console.error('找不到 Edge/Chrome'); process.exit(2); }
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const child = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const errors = [];
  const warnings = [];
  const logs = [];

  try {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let targets = [];
    for (let i = 0; i < 30; i++) {
      targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      if (targets.some((t) => t.type === 'page' && String(t.url).startsWith('http'))) break;
      await sleep(300);
    }
    const pages = targets.filter((t) => t.type === 'page');
    const target = pages.find((t) => String(t.url).startsWith('http')) || pages[0];
    if (!target) throw new Error('没有可用页面目标');
    console.log('目标页面：' + target.url);

    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        if (msg.params.type === 'error') errors.push('console.error: ' + text);
        else if (msg.params.type === 'warning') warnings.push(text);
        else logs.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push('未捕获异常: ' + (d.exception?.description || d.text));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error') errors.push(`[${e.source}] ${e.text}${e.url ? ' @ ' + e.url : ''}`);
        else if (e.level === 'warning') warnings.push(`[${e.source}] ${e.text}`);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_ });

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval 失败');
      return r.result.value;
    };

    // 等文档加载完成
    for (let i = 0; i < 60; i++) {
      try {
        const ready = await evalJs('document.readyState');
        if (ready === 'complete') break;
      } catch { /* 导航中 */ }
      await sleep(200);
    }
    // 等首屏渲染（视图切换 + 健康检查返回）
    for (let i = 0; i < 40; i++) {
      try {
        const ok = await evalJs(`!!document.querySelector('.step-chip')`);
        if (ok) break;
      } catch { /* ignore */ }
      await sleep(250);
    }
    await sleep(500);

    const report = await evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      const vis = (s) => { const n = q(s); return !!n && !n.hidden; };
      return {
        title: document.title,
        theme: document.documentElement.dataset.theme,
        hasApp: !!q('.app'),
        activeView: ['welcome','import','configure','export','progress','done'].find(v => vis('#view-'+v)) || null,
        stepperChips: document.querySelectorAll('.step-chip').length,
        engineTag: q('#engine-tag')?.textContent || null,
        engineBodyLen: (q('#engine-body')?.textContent || '').trim().length,
        dropVisible: vis('#drop'),
        railRes: q('#rail-res')?.textContent,
        descMini: (q('#desc-mini')?.textContent || '').slice(0, 80),
        railMsgs: document.querySelectorAll('#rail-msgs .msg').length,
        scaleModes: document.querySelectorAll('#scale-modes .opt').length,
        presetOptions: document.querySelectorAll('#preset-select option').length,
        tutorialsBound: !!q('#btn-tutorial'),
        cssLoaded: getComputedStyle(document.body).fontFamily.includes('Segoe') || getComputedStyle(document.documentElement).getPropertyValue('--md-primary').trim().length > 0,
        primaryVar: getComputedStyle(document.documentElement).getPropertyValue('--md-primary').trim(),
      };
    })()`);

    console.log('--- DOM 状态 ---');
    console.log(JSON.stringify(report, null, 2));

    // 截图
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('截图：' + SHOT);

    // ---------- 端到端流程（--flow） ----------
    if (process.argv.includes('--flow')) {
      const testVideo = argOf('--video') || path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
      console.log('\n=== 端到端流程测试 ===');
      console.log('测试视频：' + testVideo);

      const step = async (label, expr, expect = true, timeoutMs = 30000) => {
        const t0 = Date.now();
        let val;
        while (Date.now() - t0 < timeoutMs) {
          try { val = await evalJs(expr); } catch { val = undefined; }
          if (expect === true ? val : val === expect) break;
          await sleep(400);
        }
        const good = expect === true ? !!val : val === expect;
        console.log(`  ${good ? '✓' : '✗'} ${label} → ${JSON.stringify(val)}`);
        if (!good) errors.push(`流程断言失败：${label} → ${JSON.stringify(val)}`);
        return val;
      };

      // 1. 载入视频
      await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(testVideo)})`);
      await step('载入视频后进入配置页', `document.querySelector('#in-width').value`, true);
      await step('分辨率已填充', `(()=>{const w=document.querySelector('#in-width').value;return w && Number(w)>0;})()`, true);
      await step('源视频摘要已显示', `!document.querySelector('#import-info').hidden`, true);
      await step('时间轴分段已渲染', `document.querySelectorAll('#tl-overlay .tl-part').length >= 1`, true);

      // 2. 配置页交互
      await evalJs(`window.__baf.actions.goStep(2)`);
      await sleep(1200);
      await step('适配模式按钮已生成', `document.querySelectorAll('#scale-modes .opt').length === 3`, true);
      await step('设备预设已填充', `document.querySelectorAll('#preset-select option').length > 10`, true);
      await step('分段编辑器已渲染', `document.querySelectorAll('#parts-list .part-row').length >= 1`, true);
      await step('desc 预览已生成', `document.querySelector('#desc-mini').textContent.trim().length > 0`, true);
      await step('校验消息已生成', `document.querySelectorAll('#rail-msgs .msg').length >= 1`, true);

      // 改一下参数：切到「铺满」再切回，改帧率
      await evalJs(`document.querySelectorAll('#scale-modes .opt')[1].click()`);
      await sleep(400);
      await step('切换到铺满模式', `window.__baf.state.config.scaleMode`, 'fill');
      await evalJs(`document.querySelectorAll('#scale-modes .opt')[0].click()`);
      await evalJs(`(()=>{const i=document.querySelector('#in-fps-num');i.value='24';i.dispatchEvent(new Event('change'));})()`);
      await sleep(400);
      await step('帧率改为 24', `window.__baf.state.config.fps`, 24);

      // 时间轴切分
      await evalJs(`window.__baf.state.playhead = 2; window.__baf.actions.renderConfigure();`);
      await sleep(400);
      await evalJs(`document.querySelector('#btn-split').click()`);
      await sleep(600);
      await step('切分后变两段', `window.__baf.state.config.parts.length`, 2);

      // 3. 导出页
      await evalJs(`window.__baf.actions.goStep(3)`);
      await sleep(1200);
      await step('导出页 desc 预览非空', `document.querySelector('#desc-full').textContent.trim().length > 0`, true);
      await step('预检统计已生成', `document.querySelectorAll('#preflight-stats .stat').length >= 4`, true);
      await step('预检无错误', `window.__baf.state.validation.errors.length`, 0);

      // 配置页截图（供人工检查视觉）
      if (process.argv.includes('--shots')) {
        const shots = [
          ['configure', 2, 1400],
          ['export', 3, 900],
        ];
        for (const [name, stepNo, wait] of shots) {
          await evalJs(`window.__baf.actions.goStep(${stepNo})`);
          await sleep(wait);
          const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          const p = path.join(ROOT, '.work', `ui-${name}.png`);
          fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
          console.log('  截图：' + p);
        }
        await evalJs(`window.__baf.actions.goStep(3)`);
        await sleep(600);
      }

      // 4. 真跑一次转换（写到 .work/uicheck-out）
      const outDir = path.join(ROOT, '.work', 'uicheck-out').replace(/\\/g, '\\\\');
      await evalJs(`(()=>{ window.__baf.state.config.outputDir='${outDir}'; window.__baf.state.config.outputName='ui-test.zip'; window.__baf.state.config.fps=12; window.__baf.state.config.quality='mjpeg'; })()`);
      await evalJs(`document.querySelector('#btn-run').click()`);
      await step('进入进度页', `!document.querySelector('#view-progress').hidden`, true);
      const done = await step('转换完成', `window.__baf.state.result && window.__baf.state.result.output`, true, 180000);
      await step('结果页可见', `!document.querySelector('#view-done').hidden`, true);
      await step('产物已生成且尺寸>0', `(()=>{const r=window.__baf.state.result;return r && r.size>0;})()`, true);
      await step('zip 自检通过', `window.__baf.state.result.verify.ok`, true);
      await step('总帧数 = 6s*12fps', `(()=>{const r=window.__baf.state.result;return Math.abs(r.frames-72)<=2;})()`, true);
      console.log('  产物：' + done);

      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shot2Path = path.join(ROOT, '.work', 'ui-shot-done.png');
      fs.writeFileSync(shot2Path, Buffer.from(shot2.data, 'base64'));
      console.log('完成页截图：' + shot2Path);

      // ---------- 第二轮：视频版 + Magisk 模块 ----------
      console.log('\n=== 第二轮：视频版（Android 12+）+ Magisk 模块 ===');
      await evalJs(`window.__baf.actions.goStep(2)`);
      await sleep(700);
      await evalJs(`window.__baf.actions.setFormat('video')`);
      await sleep(500);
      await step('切换到视频版格式', `window.__baf.state.config.format`, 'video');
      await step('视频参数卡已显示', `!document.querySelector('#video-card').hidden`, true);
      await step('帧图片格式选项已隐藏', `document.querySelector('#frame-opts').hidden`, true);
      await step('视频版参数可用', `!!document.querySelector('#in-crf') && !!document.querySelector('#in-preset')`, true);

      await evalJs(`(()=>{const m=document.querySelector('#in-magisk');m.checked=true;m.dispatchEvent(new Event('change'));})()`);
      await sleep(400);
      await step('Magisk 选项已展开', `!document.querySelector('#magisk-opts').hidden`, true);
      await step('Magisk 设置项齐全', `!!document.querySelector('#in-magisk-id') && !!document.querySelector('#in-magisk-path') && !!document.querySelector('#in-magisk-allpaths')`, true);
      await evalJs(`(()=>{const i=document.querySelector('#in-magisk-id');i.value='baimacao_ui_video';i.dispatchEvent(new Event('change'));})()`);
      await sleep(300);

      await evalJs(`window.__baf.actions.goStep(3)`);
      await sleep(900);
      await step('导出页识别为视频版', `window.__baf.state.config.format`, 'video');
      await step('预检无错误（视频版）', `window.__baf.state.validation.errors.length`, 0);

      const outDir2 = path.join(ROOT, '.work', 'uicheck-out').replace(/\\/g, '\\\\');
      await evalJs(`(()=>{ window.__baf.state.config.outputDir='${outDir2}'; window.__baf.state.config.fps=15; window.__baf.state.config.crf=28; window.__baf.state.config.preset='veryfast'; window.__baf.state.config.audio=true; })()`);
      await evalJs(`document.querySelector('#btn-run').click()`);
      await step('视频版转换完成', `window.__baf.state.result && window.__baf.state.result.output`, true, 240000);
      await step('结果是视频版', `window.__baf.state.result.format`, 'video');
      await step('结果是 Magisk 模块', `window.__baf.state.result.magisk`, true);
      await step('moov 前置', `window.__baf.state.result.faststart`, true);
      await step('模块 ID 正确', `window.__baf.state.result.module.id`, 'baimacao_ui_video');
      await step('结果是有效 zip', `window.__baf.state.result.verify.ok`, true);
      const modulePath = await evalJs(`window.__baf.state.result.output`);
      console.log('  模块产物：' + modulePath);

      const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ROOT, '.work', 'ui-shot-video-done.png'), Buffer.from(shot3.data, 'base64'));
      console.log('视频版完成页截图：.work/ui-shot-video-done.png');
    }

    // ---------- 文档截图（--docshot，用假数据，不依赖视频文件） ----------
    if (process.argv.includes('--docshot')) {
      const docDir = path.join(ROOT, 'docs');
      fs.mkdirSync(docDir, { recursive: true });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
      for (const [stepNo, name] of [[1, 'import'], [2, 'configure'], [3, 'export']]) {
        await evalJs(`window.__baf.actions.demoFill()`);
        if (stepNo !== 2) await evalJs(`window.__baf.actions.goStep(${stepNo})`);
        await sleep(stepNo === 2 ? 2200 : 900);
        const p = path.join(docDir, `screenshot-${name}.png`);
        const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
        console.log('文档截图：' + p);
      }
      // 教程弹窗
      await evalJs(`document.querySelector('#btn-tutorial').click()`);
      await sleep(900);
      const ts = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(docDir, 'screenshot-tutorial.png'), Buffer.from(ts.data, 'base64'));
      console.log('文档截图：docs/screenshot-tutorial.png');
    }

    console.log('\n--- 控制台错误 ---');
    console.log(errors.length ? errors.join('\n') : '（无）');
    if (warnings.length) {
      console.log('\n--- 警告 ---');
      console.log(warnings.slice(0, 10).join('\n'));
    }
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('检查失败：', e.message); process.exit(2); });
