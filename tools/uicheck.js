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
    // 应用会把「上次会话」存进 localStorage，第二次运行时可能直接恢复到第 2 步。
    // 测试需要确定的初始状态，所以在导航前先清掉本地存储。
    try { await cdp.send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'local_storage' }); } catch { /* 忽略 */ }
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

      // 预览图必须真的能解码 —— 这里踩过坑：缩略图 base64 曾经因为把二进制当
      // UTF-8 字符串处理而损坏，<img> 解码失败后什么都不显示，预览一片黑，
      // 而"元素存在/有 src"这类断言完全发现不了。
      await step('预览图已解码成功（非 0 尺寸）', `(() => {
        const img = document.querySelector('#preview-img');
        return !!img && !img.hidden && img.complete && img.naturalWidth > 8 && img.naturalHeight > 8;
      })()`, true, 30000);
      await step('预览图不是一张全黑图', `(async () => {
        const img = document.querySelector('#preview-img');
        if (!img || !img.naturalWidth) return false;
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        return (sum / (d.length / 4)) > 12;
      })()`, true, 30000);
      await step('预览用的 dataURL 是合法 JPEG', `(() => {
        const src = document.querySelector('#preview-img')?.src || '';
        return src.startsWith('data:image/jpeg;base64,') && src.length > 800
          && atob(src.split(',')[1].slice(0, 8)).charCodeAt(0) === 0xFF;
      })()`, true);

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

      // ---------- 第三轮：自定义帧命名（手表写法 001.png） ----------
      console.log('\n=== 第三轮：自定义帧命名（手表 001.png 写法）===');
      await evalJs(`window.__baf.actions.goStep(2)`);
      await sleep(600);
      await evalJs(`window.__baf.actions.setFormat('classic')`);
      await sleep(400);
      await step('回到传统帧序列格式', `window.__baf.state.config.format`, 'classic');
      const namingBoxState = await evalJs(`(() => {
        const n = document.querySelector('#naming-box');
        const cs = n ? getComputedStyle(n) : null;
        return { fmt: window.__baf.state.config.format, hiddenProp: n ? n.hidden : 'no-el',
                 display: cs ? cs.display : null, rectH: n ? Math.round(n.getBoundingClientRect().height) : null };
      })()`);
      console.log(`  · 帧命名区状态：${JSON.stringify(namingBoxState)}`);
      await step('帧命名区可见', `(() => {
        const n = document.querySelector('#naming-box');
        return !!n && !n.hidden && getComputedStyle(n).display !== 'none';
      })()`, true);

      await evalJs(`(() => {
        const chip = [...document.querySelectorAll('[data-naming]')].find(c => c.dataset.naming === '|3|1');
        chip.click();
      })()`);
      await sleep(500);
      await step('命名预设已应用（前缀为空）', `window.__baf.state.config.framePrefix`, '');
      await step('补零位数 = 3', `window.__baf.state.config.padWidth`, 3);
      await step('起始编号 = 1', `window.__baf.state.config.startNumber`, 1);
      await step('命名预览里出现 001.png', `(() => {
        const t = document.querySelector('#naming-preview').textContent || '';
        return t.includes('001.png');
      })()`, true);

      const outDir3 = path.join(ROOT, '.work', 'uicheck-out').replace(/\\/g, '\\\\');
      await evalJs(`(() => {
        const s = window.__baf.state;
        s.config.outputDir = '${outDir3}';
        s.config.magisk = false;                    // 只做纯动画，才方便核对帧命名
        s.config.outputName = 'ui-watch.zip';
        s.config.width = 480; s.config.height = 480;
        s.config.fps = 12; s.config.quality = 'png-fast';
        s.config.parts = [];
        window.__baf.actions.computeValidation();
      })()`);
      await evalJs(`window.__baf.actions.goStep(3)`);
      await sleep(900);
      await step('预检无错误（手表命名）', `window.__baf.state.validation.errors.length`, 0);
      await step('打包清单写明了帧命名', `document.querySelector('#zip-plan').textContent.includes('.png')`, true);
      await evalJs(`document.querySelector('#btn-run').click()`);
      await step('手表命名转换完成', `window.__baf.state.result && window.__baf.state.result.output`, true, 180000);
      const watchZip = await evalJs(`window.__baf.state.result.output`);
      console.log('  手表命名产物：' + watchZip);
    }

    // ---------- 文档截图（--docshot） ----------
    // 用真实测试视频，这样截图里能看到真正可用的预览（假路径只会得到黑图）
    if (process.argv.includes('--docshot')) {
      const docDir = path.join(ROOT, 'docs');
      fs.mkdirSync(docDir, { recursive: true });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });

      const demoVideo = argOf('--video') || path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
      await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(demoVideo)})`);
      for (let i = 0; i < 60; i++) {
        if (await evalJs(`!!window.__baf.state.info && !!window.__baf.state.thumbnail`)) break;
        await sleep(300);
      }
      await sleep(800);
      // 设成竖屏目标分辨率，让「留边」这件事在预览里看得出来
      await evalJs(`window.__baf.actions.goStep(2)`);
      await sleep(600);
      await evalJs(`(() => {
        const s = window.__baf.state;
        s.config.width = 1080; s.config.height = 1920; s.config.presetId = 'h1080';
        s.config.fps = 30; s.config.parts = [];      // 故意清空，验证会回落到单段
        window.__baf.actions.renderConfigure();
        window.__baf.actions.computeValidation();
      })()`);
      await sleep(900);
      const summary = await evalJs(`({
        parts: window.__baf.state.plan.list.length,
        frames: window.__baf.state.plan.frames,
        railFrames: document.querySelector('#rail-frames').textContent,
        railSize: document.querySelector('#rail-size').textContent,
        errors: window.__baf.state.validation.errors.length,
      })`);
      console.log(`  · 摘要自愈检查：段数=${summary.parts} 帧数=${summary.frames} 侧栏帧=${summary.railFrames} 体积=${summary.railSize} 错误=${summary.errors}`);
      if (!(summary.parts >= 1 && summary.frames > 0 && summary.errors === 0)) {
        errors.push(`空分段时摘要未自愈：${JSON.stringify(summary)}`);
      }

      for (const [stepNo, name] of [[1, 'import'], [2, 'configure'], [3, 'export']]) {
        await evalJs(`window.__baf.actions.goStep(${stepNo})`);
        await sleep(stepNo === 2 ? 1600 : 900);
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
      await evalJs(`document.querySelector('.dialog-head .icon-btn').click()`);
      await sleep(500);

      // 输出格式 + Magisk 模块设置（滚到对应位置）
      await evalJs(`(()=>{const m=document.querySelector('#in-magisk');m.checked=true;m.dispatchEvent(new Event('change'));
        document.querySelector('#magisk-opts').hidden=false;})()`);
      await sleep(700);
      const scrolled = await evalJs(`(() => {
        const el = document.querySelector('#format-modes');
        const y = el.getBoundingClientRect().top + document.querySelector('#content').scrollTop - 90;
        document.querySelector('#content').scrollTo({ top: y, behavior: 'instant' });
        return document.querySelector('#content').scrollTop;
      })()`);
      await sleep(900);
      const fs2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(docDir, 'screenshot-output.png'), Buffer.from(fs2.data, 'base64'));
      console.log(`文档截图：docs/screenshot-output.png（scrollTop=${scrolled}）`);
    }

    // ---------- 动效验证（--anim） ----------
    if (process.argv.includes('--anim')) {
      console.log('\n=== 动效验证（MD3 运动系统）===');

      // 无头 Chromium 默认上报 prefers-reduced-motion: reduce，而本项目按无障碍要求
      // 为该偏好提供了「动画压到 1ms」的降级 —— 那会让动效完全测不到。
      // 所以这里用 CDP 显式声明用户在动画偏好上是 no-preference。
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      const reduced = await evalJs(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
      console.log(`  ${reduced === false ? '✓' : '✗'} 已声明 no-preference（当前 reduce=${reduced}）`);
      if (reduced !== false) errors.push('无法关闭 prefers-reduced-motion，动效测试不可靠');

      const anim = async (label, expr, expect = true) => {
        let val;
        try { val = await evalJs(expr); } catch (e) { val = 'ERR:' + e.message; }
        const good = expect === true ? !!val : val === expect;
        console.log(`  ${good ? '✓' : '✗'} ${label} → ${JSON.stringify(val)}`);
        if (!good) errors.push(`动效断言失败：${label} → ${JSON.stringify(val)}`);
        return val;
      };

      // 设计令牌确实定义了 MD3 强调曲线
      const easeVal = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue('--ease-emphasized').trim()`);
      const easeOk = /cubic-bezier\(\s*\.?0?\.?2\s*,\s*0\s*,\s*0\s*,\s*1\s*\)/.test(easeVal);
      console.log(`  ${easeOk ? '✓' : '✗'} emphasized 曲线令牌存在 → ${JSON.stringify(easeVal)}`);
      if (!easeOk) errors.push('--ease-emphasized 不是预期的 cubic-bezier(.2,0,0,1)');
      await anim('动效时长令牌存在（medium4=400ms）',
        `getComputedStyle(document.documentElement).getPropertyValue('--dur-medium4').trim()`, '400ms');

      // 前进方向：新视图应带 enter-forward，且过渡确实在跑
      // goStep(2/3) 需要已载入视频（否则按设计直接返回），所以先放一个测试视频进去。
      const animVideo = argOf('--video') || path.join(ROOT, '.work', 'selftest', 'src-1280x720-6s.mp4');
      await evalJs(`window.__baf.actions.loadVideo(${JSON.stringify(animVideo)})`);
      for (let i = 0; i < 40; i++) {
        if (await evalJs(`!!window.__baf.state.info`)) break;
        await sleep(250);
      }
      const hasInfo = await evalJs(`!!window.__baf.state.info`);
      console.log(`  ${hasInfo ? '✓' : '✗'} 测试视频已载入（后续步骤切换才有意义）`);
      if (!hasInfo) errors.push('动效测试无法载入测试视频');

      await evalJs(`window.__baf.actions.goStep(1)`);
      await sleep(700);
      const fromState = await evalJs(`(() => ({ view: window.__baf.state.step,
        importHidden: document.querySelector('#view-import').hidden,
        cfgHidden: document.querySelector('#view-configure').hidden }))()`);
      console.log(`  · 起始状态：step=${fromState.view} import隐藏=${fromState.importHidden} configure隐藏=${fromState.cfgHidden}`);

      const forward = await evalJs(`(() => {
        window.__baf.actions.goStep(2);
        const el = document.querySelector('#view-configure');
        const cs = getComputedStyle(el);
        return { step: window.__baf.state.step, cls: el.className, hidden: el.hidden,
                 anim: cs.animationName, dur: cs.animationDuration, tran: cs.transform };
      })()`);
      console.log(`  · 前进转场：step=${forward.step} hidden=${forward.hidden} class="${forward.cls}" animation=${forward.anim} ${forward.dur} transform=${forward.tran}`);
      const fwdOk = /enter-forward/.test(forward.cls) && forward.anim === 'shared-x-in-forward';
      console.log(`  ${fwdOk ? '✓' : '✗'} 前进时应用 shared-axis 入场动画`);
      if (!fwdOk) errors.push(`前进转场动画未应用（class="${forward.cls}" anim=${forward.anim}）`);
      const fwdDur = await anim('入场动画时长为 0.4s（MD3 medium4）', `getComputedStyle(document.querySelector('#view-configure')).animationDuration`, '0.4s');

      // 关键帧本身必须是从右侧（正 translateX）滑入；直接读 CSSOM，避免采样时机带来的抖动
      const kf = await evalJs(`(() => {
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch { continue; }
          for (const r of rules) {
            if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'shared-x-in-forward') {
              const from = [...r.cssRules].find(k => k.keyText === '0%' || k.keyText === 'from');
              return from ? from.style.transform : null;
            }
          }
        }
        return null;
      })()`);
      const kfOk = typeof kf === 'string' && /translateX\(\s*\d/.test(kf) && !/translateX\(\s*-/.test(kf);
      console.log(`  ${kfOk ? '✓' : '✗'} 关键帧从右侧滑入（from transform: ${JSON.stringify(kf)}）`);
      if (!kfOk) errors.push(`入场关键帧的起始位移不是正 X（${kf}）`);

      await sleep(600);
      // 动画结束后 transform 应为「无变换」：可能是 none，也可能是单位矩阵
      const settled = await evalJs(`getComputedStyle(document.querySelector('#view-configure')).transform`);
      const settledOk = settled === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(settled);
      console.log(`  ${settledOk ? '✓' : '✗'} 动画结束后复位为无变换 → ${JSON.stringify(settled)}`);
      if (!settledOk) errors.push(`动画结束后未复位（transform=${settled}）`);
      await anim('配置页此时可见', `document.querySelector('#view-configure').hidden`, false);

      // 后退方向：反向动画
      const back = await evalJs(`(() => {
        window.__baf.actions.goStep(1);
        const el = document.querySelector('#view-import');
        return { cls: el.className, anim: getComputedStyle(el).animationName };
      })()`);
      console.log(`  · 后退转场：class="${back.cls}" animation=${back.anim}`);
      const backOk = /enter-back/.test(back.cls) && back.anim === 'shared-x-in-back';
      console.log(`  ${backOk ? '✓' : '✗'} 后退时使用相反的 shared-axis 动画`);
      if (!backOk) errors.push('后退转场动画未应用');

      // 旧的视图应播放退出动画而不是直接消失
      const exiting = await evalJs(`(() => {
        window.__baf.actions.goStep(2);
        const old = document.querySelector('#view-import');
        return { hidden: old.hidden, cls: old.className };
      })()`);
      console.log(`  · 旧视图退出中：hidden=${exiting.hidden} class="${exiting.cls}"`);
      const exitOk = exiting.hidden === false && /exit-/.test(exiting.cls);
      console.log(`  ${exitOk ? '✓' : '✗'} 旧视图先播放退出动画（未立即消失）`);
      if (!exitOk) errors.push('旧视图退出动画缺失');

      // 数值变化时播放 pulse
      await sleep(700);
      await evalJs(`window.__baf.actions.demoFill()`);
      await sleep(400);
      const pulse = await evalJs(`(() => {
        const n = document.querySelector('#rail-size');
        const before = n.textContent;
        window.__baf.state.estimate = { bytes: 999999999, frames: 1, duration: 1 };
        window.__baf.actions.renderConfigure();
        const cs = getComputedStyle(n);
        return { before, after: n.textContent, cls: n.className, anim: cs.animationName };
      })()`);
      console.log(`  · 数值变化：${pulse.before} → ${pulse.after} class="${pulse.cls}" animation=${pulse.anim}`);
      const pulseOk = /pulse/.test(pulse.cls) && pulse.anim === 'pulse-once';
      console.log(`  ${pulseOk ? '✓' : '✗'} 数值变化时播放脉冲动效`);
      if (!pulseOk) errors.push('数值脉冲动效未生效');

      await anim('未变化时不会重复触发动画',
        `(() => { const n = document.querySelector('#rail-size'); n.classList.remove('pulse');
           window.__baf.actions.renderConfigure(); return n.className.includes('pulse'); })()`, false);

      // 尊重 prefers-reduced-motion
      const reduce = await evalJs(`(() => {
        const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
        return rules.some(r => r.conditionText && r.conditionText.includes('prefers-reduced-motion'));
      })()`);
      console.log(`  ${reduce ? '✓' : '✗'} 提供 prefers-reduced-motion 降级规则`);
      if (!reduce) errors.push('缺少 prefers-reduced-motion 支持');
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
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 文件可能仍被占用 */ }
  }

  // --docshot 用的是假视频路径，缩略图接口必然返回 400 —— 那是预期噪声，不算错误。
  const realErrors = process.argv.includes('--docshot')
    ? errors.filter((e) => !/api\/thumbnail/.test(e))
    : errors;
  if (process.argv.includes('--docshot') && realErrors.length !== errors.length) {
    console.log(`（已忽略 ${errors.length - realErrors.length} 条演示数据产生的缩略图请求错误）`);
  }
  if (realErrors.length) {
    console.log('\n--- 错误汇总 ---');
    console.log(realErrors.join('\n'));
  }
  process.exit(realErrors.length ? 1 : 0);
})().catch((e) => { console.error('检查失败：', e.message); process.exit(2); });
