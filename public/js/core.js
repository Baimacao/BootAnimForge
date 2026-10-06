/**
 * core.js — 状态、API、通用工具
 */

import { DEVICE_PRESETS, QUALITY_MODES, STAGE_LABEL } from './data.js';

/* ================================================================== */
/* 工具                                                               */
/* ================================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素：el('div', {class:'x'}, [child, 'text']) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export const svgIcon = (path, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;

export const ICON = {
  check: 'M9 16.2 3.5 10.7 5 9.2l4 4 10-10L20.5 4.6 9 16.2z',
  close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z',
  warn: 'M12 2 1 21h22L12 2Zm1 14h-2v2h2v-2Zm0-7h-2v5h2V9Z',
  info: 'M11 7h2v2h-2V7Zm0 4h2v6h-2v-6Zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6V5Zm8 0h4v14h-4V5Z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z',
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 2.5L17.5 8H14V4.5Z',
  zoom: 'M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z',
  up: 'M12 3 6.5 8.5 8 10l3-3V16h2V7l3 3 1.5-1.5L12 3Z',
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};
export const fmtBytes = (b) => {
  const n = Math.max(0, Number(b) || 0);
  if (n < 1024) return `${n.toFixed(0)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};
export const fmtDur = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s.toFixed(2)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${(s - m * 60).toFixed(1)} 秒`;
};
export const debounce = (fn, ms = 200) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
export const ext = (p) => {
  const m = String(p || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0].toLowerCase() : '';
};
export const baseName = (p) => String(p || '').split(/[\\/]/).pop() || '';
export const dirName = (p) => {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : s;
};
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 更新文本节点，并在内容真的变化时播放一次轻量动效。
 * 直接 textContent = x 会让"数值在变"这件事被忽略，加一帧动画可读性更好。
 */
export function setText(node, text, { pulse = false } = {}) {
  if (!node) return false;
  const next = String(text);
  if (node.textContent === next) return false;
  node.textContent = next;
  if (pulse) {
    node.classList.remove('pulse');
    void node.offsetWidth;
    node.classList.add('pulse');
  }
  return true;
}

/* ================================================================== */
/* 状态                                                               */
/* ================================================================== */

const LS_KEY = 'bootanimforge.v1';

export function defaultConfig() {
  return {
    target: 'boot',      // boot = 开机动画；shutdown = 关机动画
    format: 'classic',   // classic = 传统帧序列；video = Android 12+ 视频版
    width: 1080,
    height: 1920,
    presetId: 'h1080',
    fps: 30,
    start: 0,
    end: 0,              // 0 = 到视频结尾
    scaleMode: 'fit',
    background: '#000000',
    keepAlpha: true,
    quality: 'png-fast',
    jpegQuality: 4,
    // 帧文件命名（厂商差异大：通用是 frame_00000.png，很多手表是 001.png）
    framePrefix: 'frame_',
    padWidth: 5,
    startNumber: 0,
    zipCompress: false,
    audio: false,
    progress: false,
    // 视频版参数
    crf: 20,
    preset: 'medium',
    audioBitrate: 128,
    // Magisk 模块
    magisk: false,
    magiskOpts: {
      id: 'bootanimforge_bootanimation',
      name: '开机动画',
      version: '1.0.0',
      versionCode: 0,
      author: 'BootAnimForge',
      description: '',
      pathKey: 'system/media',
      allPaths: true,
      withReadme: true,
    },
    outputDir: '',
    outputName: 'bootanimation.zip',
    parts: [],           // 空 = 单段无限循环（由 ensureParts 生成）
  };
}

export const state = {
  step: 1,
  booted: false,
  engine: null,
  info: null,            // ffprobe 结果
  input: '',
  thumbnail: '',
  config: defaultConfig(),
  validation: { errors: [], warnings: [], notes: [] },
  estimate: { frames: 0, bytes: 0, duration: 0 },
  job: null,
  result: null,
  settings: {},
  playing: false,
  playhead: 0,
  theme: 'dark',
};

export function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      config: state.config,
      theme: state.theme,
      input: state.input,
    }));
  } catch { /* 忽略隐私模式等写入失败 */ }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.config) state.config = { ...defaultConfig(), ...saved.config };
    if (saved.theme) state.theme = saved.theme;
    if (saved.input) state.input = saved.input;
  } catch { /* ignore */ }
}

/* ================================================================== */
/* 计算：分段 / 帧数 / 体积                                            */
/* ================================================================== */

export const frameCount = (start, end, fps) =>
  Math.max(1, Math.round(Math.max(0, (Number(end) || 0) - (Number(start) || 0)) * clamp(Math.round(fps) || 30, 1, 240)));

/** 依据视频时长补齐 / 裁剪分段配置。没有分段时会生成「单段无限循环」这一默认。 */
export function ensureParts(info) {
  const c = state.config;
  const dur = info?.duration || 0;
  const total = c.end > c.start ? c.end : (dur || 1);
  if (!Array.isArray(c.parts) || c.parts.length === 0) {
    c.parts = [{
      dir: 'part0', name: '主循环', start: Number(c.start) || 0, end: total,
      count: 0, pause: 0, fade: 0, background: '', clock: '', audio: false,
    }];
  }
  c.parts.forEach((p, i) => {
    if (!p.dir) p.dir = `part${i}`;
    if (!p.name) p.name = `第 ${i + 1} 段`;
    // 这里**不能**补一个默认 type='p'：一旦写死，就无法区分
    // 「用户明确要 p」和「没指定」，关机动画需要的 c 会被它盖掉。
    // 默认值只在 buildDescPreview / 后端按 target 取。
    if (p.count === undefined) p.count = 0;
    if (p.pause === undefined) p.pause = 0;
    if (p.fade === undefined) p.fade = 0;
    p.start = clamp(Number(p.start) || 0, 0, Math.max(0, dur));
    p.end = clamp(Number(p.end) || dur, 0, dur || p.start + 1);
    if (p.end <= p.start) p.end = Math.min(dur || p.start + 1, p.start + 0.1);
  });
  return c.parts;
}

/**
 * 算出分段列表。**永不返回空数组**：没有分段时按「整段无限循环」补一段。
 * 之前这里会对空数组原样返回，导致界面出现「0 段 / 0 帧 / ≈0 B」和一个
 * 莫名其妙的校验错误 —— 一个空数组不该让整个摘要变成无意义的状态。
 */
export function planParts() {
  const c = state.config;
  const fps = clamp(Math.round(c.fps) || 30, 1, 240);
  if (!Array.isArray(c.parts) || c.parts.length === 0) {
    // 不调用 ensureParts（那需要 info），这里只保证「至少一段」这一不变量
    if (state.info) ensureParts(state.info);
    else {
      // 注意：**不要**给 type 一个默认值 'p'。
      // 否则 buildDescPreview 无法区分「用户明确要 p」和「没指定」，
      // 关机动画需要的 c 就永远覆盖不上（PC 端与安卓端都踩过这个坑）。
      // type 留空，由 target 决定，默认由后端/预览兜底为 'p'。
      c.parts = [{
        dir: 'part0', name: '主循环', start: 0, end: Math.max(0.1, Number(c.end) || 1),
        count: 0, pause: 0, fade: 0, background: '', clock: '', audio: false,
      }];
    }
  }
  const list = c.parts.map((p, i) => {
    const start = Math.max(0, Number(p.start) || 0);
    const end = Math.max(start + 0.001, Number(p.end) || start + 1);
    const frames = frameCount(start, end, fps);
    // rawType 保留"用户是否显式指定过类型"这个信息（见 buildDescPreview）
    return { ...p, rawType: p.type, index: i, dir: p.dir || `part${i}`, start, end, frames };
  });
  const frames = list.reduce((a, p) => a + p.frames, 0);
  return { fps, list, frames, naming: naming() };
}

/* ---------------- 帧命名 ---------------- */

export const DEFAULT_PREFIX = 'frame_';

/** 规范化帧命名（与后端 desc.js 的 normalizeNaming 同规则） */
export function naming(cfg = state.config) {
  const prefix = String(cfg.framePrefix ?? DEFAULT_PREFIX).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  const padWidth = clamp(Math.round(Number(cfg.padWidth)) || 5, 1, 8);
  const startNumber = clamp(Math.round(Number(cfg.startNumber)) || 0, 0, 10000000);
  const nameOf = (seq) => `${prefix}${String(startNumber + seq).padStart(padWidth, '0')}`;
  return {
    prefix, padWidth, startNumber,
    index: (file) => {
      const base = String(file).replace(/\.[a-z0-9]+$/i, '');
      const m = base.match(/(\d+)(?!.*\d)/);
      return m ? Number(m[1]) : null;
    },
    nameOf,
    first: nameOf(0),
    sample: `${nameOf(0)}.png`,
    pattern: `${prefix}%0${padWidth}d`,
  };
}

/** 播放一遍动画需要的时间（含暂停） */
export function estimateDuration() {
  const { fps, list } = planParts();
  let t = 0;
  for (const p of list) {
    t += p.frames / fps;
    t += (Number(p.pause) || 0) / fps;
  }
  return t;
}

export function estimateBytes() {
  const c = state.config;
  if (c.format === 'video') {
    // 经验值：H.264 CRF 20 下约 0.06 bit/像素/帧；音轨按 128kbps
    const { list, fps } = planParts();
    const dur = list.reduce((a, p) => a + Math.max(0, p.end - p.start), 0);
    const area = Math.max(1, (Number(c.width) || 1080) * (Number(c.height) || 1920));
    const bpp = 0.055 * Math.pow(2, (20 - (Number(c.crf) || 20)) / 6);   // CRF 每差 6 约差一倍
    let bytes = area * fps * Math.max(0, dur) * bpp / 8;
    if (c.audio) bytes += ((Number(c.audioBitrate) || 128) * 1000 / 8) * dur;
    return { bytes, frames: Math.round(dur * fps) };
  }
  const { frames } = planParts();
  const q = QUALITY_MODES[c.quality] || QUALITY_MODES.png;
  const area = Math.max(1, (Number(c.width) || 1080) * (Number(c.height) || 1920));
  const perPixel = q.approxBytes / (1080 * 1920);        // 由经验值换算到每像素
  let bytes = frames * area * perPixel;
  if (!c.zipCompress) bytes *= 1.02;
  return { bytes, frames };
}

/** 生成 desc.txt 文本（与后端 desc.js 同规则；前端只做预览） */
export function buildDescPreview() {
  const c = state.config;
  const { fps, list } = planParts();
  const head = [Math.round(c.width), Math.round(c.height), fps];
  if (c.progress) head.push(1);
  const lines = [head.join(' ')];
  // 关机动画默认用 c（必须播完）—— 与后端 targets.js 的 partType 一致
  const targetType = c.target === 'shutdown' ? 'c' : 'p';
  for (const p of list) {
    const explicit = p.rawType !== undefined && p.rawType !== null && String(p.rawType).trim() !== '';
    const type = explicit ? (p.type || 'p') : targetType;
    const f = [type, Number(p.count) || 0, Number(p.pause) || 0, p.dir];
    if (type === 'f') f.push(Number(p.fade) || 0);
    if (p.background) f.push(p.background);
    if (p.clock) f.push(p.clock);
    lines.push(f.join(' '));
  }
  return lines;
}

/** 帧命名预览：首帧、末帧文件名与帧数 */
export function namingPreview() {
  const nm = naming();
  const { frames } = planParts();
  const last = nm.nameOf(Math.max(0, frames - 1));
  return { ...nm, frames, last: `${last}.png` };
}

export function describeLine(line, index) {
  const parts = String(line).trim().split(/\s+/);
  if (index === 0) return `宽 ${parts[0]} · 高 ${parts[1]} · ${parts[2]} 帧/秒${parts[3] ? ' · 显示进度条' : ''}`;
  const [type, count, pause, dir] = parts;
  const typeText = { p: '可被打断（开机结束即停）', c: '必须播完', f: '被打断时淡出' }[type] || type;
  return `${dir} · ${count === '0' ? '无限循环' : `循环 ${count} 次`} · 暂停 ${pause} 帧 · ${typeText}`;
}

export function validate() {
  const errors = [];
  const warnings = [];
  const notes = [];
  const c = state.config;
  const isVideo = c.format === 'video';
  const w = Math.round(Number(c.width) || 0);
  const h = Math.round(Number(c.height) || 0);
  const fps = Math.round(Number(c.fps) || 0);

  if (w < 2 || h < 2) errors.push('分辨率无效：宽高都要 ≥ 2');
  if (w % 2 || h % 2) {
    const msg = '宽或高是奇数：H.264/JPEG 编码要求偶数';
    if (isVideo) errors.push(msg); else warnings.push(msg + '，建议改成偶数');
  }
  if (isVideo) {
    if (w > 1920 || h > 1920) warnings.push(`视频版建议不超过 1920×1080：当前 ${w}×${h} 在部分设备上可能无法解码`);
    if (w > 4096 || h > 4096) errors.push('视频版分辨率上限 4096');
  } else if (w > 7680 || h > 7680) {
    errors.push('分辨率过大：单边不能超过 7680');
  }
  if (fps < 1) errors.push('帧率必须 ≥ 1');
  if (fps > 120) warnings.push(`帧率 ${fps} 偏高，多数设备跑不满，建议 24–60`);

  const { list, frames } = planParts();
  if (!list.length) errors.push('至少需要 1 个动画段');
  if (list.length > 32) errors.push('动画段过多（上限 32）');

  const seen = new Set();
  list.forEach((p, i) => {
    if (!/^[A-Za-z0-9._-]+$/.test(p.dir)) errors.push(`第 ${i + 1} 段目录名非法：只能用字母、数字、点、下划线、连字符`);
    if (seen.has(p.dir.toLowerCase())) errors.push(`目录名重复：${p.dir}`);
    seen.add(p.dir.toLowerCase());
    if (p.end <= p.start) errors.push(`第 ${i + 1} 段时长为 0`);
    if (i > 0 && p.start < list[i - 1].end - 0.01) warnings.push(`第 ${i + 1} 段起点早于上一段终点，画面会重叠`);
  });

  if (isVideo) {
    if (list.length > 1) {
      notes.push('视频版会把多段按顺序拼成一个连续视频，循环由系统控制（每段的循环次数/暂停不再生效）');
    }
    const dur = list.reduce((a, p) => a + Math.max(0, p.end - p.start), 0);
    notes.push(`视频约 ${dur.toFixed(2)} 秒 · H.264 Main / yuv420p / 无 B 帧 / moov 前置`);
    if (dur > 15) warnings.push(`视频时长 ${dur.toFixed(1)} 秒偏长`);
    if (Number(c.crf) < 16) notes.push(`CRF ${c.crf} 画质很高但体积明显变大`);
    if (Number(c.crf) > 30) warnings.push(`CRF ${c.crf} 偏高，画面会出现明显色块`);
  } else {
    if (list.length > 1 && list.every((p) => Number(p.count) === 0)) {
      notes.push('所有段都是无限循环：后面的段永远不会播到，只会看到第一段');
    }
    const mb = (w * h * 4) / 1048576;
    notes.push(`共 ${frames} 帧，单帧位图约 ${mb.toFixed(1)} MB`);
    if (frames > 4000) warnings.push(`总帧数 ${frames} 偏多，文件会很大、开机解包变慢（建议 2000 帧以内）`);
    if (w * h > 1920 * 1080 && fps > 60) warnings.push('高分辨率 + 高帧率，低端设备极易卡顿');
  }

  const info = state.info;
  if (info?.video) {
    const srcAR = info.video.displayWidth / info.video.displayHeight;
    const dstAR = w / h;
    const diff = Math.abs(srcAR - dstAR) / srcAR;
    if (c.scaleMode === 'fit' && diff > 0.01) {
      notes.push(`源比例 ${srcAR.toFixed(2)} : 目标 ${dstAR.toFixed(2)}，将等比缩放并在四周留边（不会拉伸）`);
    }
    if (c.scaleMode === 'stretch' && diff > 0.01) {
      warnings.push(`拉伸模式：源比例 ${srcAR.toFixed(2)} 与目标 ${dstAR.toFixed(2)} 不同，画面会变形`);
    }
    if (c.scaleMode === 'fill' && diff > 0.01) {
      notes.push('铺满模式：会裁掉画面边缘');
    }
    if (diff > 0.4) warnings.push('源视频与目标比例差异很大，留边或裁切会很明显，建议换个接近的比例');
    if (info.video.isHdr) warnings.push('源视频是 HDR：转成 SDR 后会丢失 HDR 效果，颜色可能偏灰');
    if (info.video.rotation) notes.push(`源视频带 ${info.video.rotation}° 旋转信息，已自动按显示方向处理`);
    if (isVideo && info.video.hasAlpha) notes.push('视频版不支持透明通道，已按不透明处理');
  }

  if (c.magisk) {
    const mo = c.magiskOpts || {};
    if (!String(mo.id || '').trim()) errors.push('Magisk 模块 id 不能为空');
    else if (!/^[A-Za-z0-9._-]+$/.test(mo.id)) errors.push('Magisk 模块 id 只能包含字母、数字、点、下划线、连字符');
    if (!String(mo.name || '').trim()) warnings.push('Magisk 模块名称为空，将使用默认名');
    if (!/^\d+(\.\d+)*$/.test(String(mo.version || ''))) warnings.push('模块版本建议用数字点号形式，如 1.0.0');
    notes.push('将额外生成 Magisk 模块 zip（可直接刷入，卸载即还原）');
  }

  // 帧命名：补零位数不够会「撞名」
  if (!isVideo) {
    const nm = naming();
    const maxNo = nm.startNumber + Math.max(0, frames - 1);
    if (String(maxNo).length > nm.padWidth) {
      errors.push(`帧命名补零位数不够：共 ${frames} 帧，编号最大到 ${maxNo}（${String(maxNo).length} 位），` +
        `而补零位数是 ${nm.padWidth} 位，文件名会重复。请改为 ${String(maxNo).length} 位以上`);
    }
    notes.push(`帧文件命名：${nm.prefix || '（无前缀）'}${'0'.repeat(nm.padWidth)} 起于 ${nm.startNumber}，例如 ${nm.sample}`);
    if (!nm.prefix) notes.push('采用纯数字命名（如 001.png）—— 部分安卓手表用这种写法；通用设备通常用 frame_ 前缀');
  }

  return { errors, warnings, notes, frames };
}

export function validationToMessages(v) {
  const out = [];
  for (const e of v.errors || []) out.push({ kind: 'err', text: e });
  for (const w of v.warnings || []) out.push({ kind: 'warn', text: w });
  for (const n of v.notes || []) out.push({ kind: 'note', text: n });
  return out;
}

/* ================================================================== */
/* API                                                                */
/* ================================================================== */

async function req(path, { method = 'GET', body, timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  health: () => req('/api/health'),
  fetchEngine: () => req('/api/runtime/fetch', { method: 'POST' }),
  probe: (input) => req('/api/probe', { method: 'POST', body: { input } }),
  analyze: (payload) => req('/api/analyze', { method: 'POST', body: payload }),
  thumbnail: (input, time, width, duration) => req('/api/thumbnail', { method: 'POST', body: { input, time, width, duration }, timeout: 60000 }),
  extract: (payload) => req('/api/extract', { method: 'POST', body: payload, timeout: 60000 }),
  job: (id) => req(`/api/job/${id}`),
  cancel: (id) => req(`/api/job/${id}/cancel`, { method: 'POST' }),
  listDir: (dir, files = false) => req(`/api/fs/list${dir ? `?dir=${encodeURIComponent(dir)}` : ''}${files ? (dir ? '&' : '?') + 'files=1' : ''}`),
  mkdir: (dir) => req('/api/fs/mkdir', { method: 'POST', body: { dir } }),
  reveal: (p, select = true) => req('/api/reveal', { method: 'POST', body: { path: p, select } }),
  open: (p) => req('/api/open', { method: 'POST', body: { path: p } }),
  settings: () => req('/api/settings'),
  saveSettings: (patch) => req('/api/settings', { method: 'POST', body: patch }),
  shutdown: () => req('/api/shutdown', { method: 'POST' }),
  media: (p) => `/api/media?path=${encodeURIComponent(p)}`,
};

/** 订阅任务进度（SSE，失败自动降级为轮询） */
export function watchJob(id, { onProgress, onLog, onDone } = {}) {
  let stopped = false;
  let es = null;
  let pollTimer = null;
  let lastLogIndex = 0;

  const finish = (payload) => {
    if (stopped) return;
    stopped = true;
    try { es?.close(); } catch { /* ignore */ }
    clearInterval(pollTimer);
    onDone?.(payload);
  };

  const startPolling = async () => {
    if (stopped) return;
    try {
      const j = await api.job(id);
      onProgress?.(j.progress || {});
      const logs = j.logs || [];
      for (let i = lastLogIndex; i < logs.length; i++) onLog?.(logs[i]);
      lastLogIndex = logs.length;
      if (j.state !== 'running' && j.state !== 'cancelling') {
        finish(j.state === 'done' ? j.result : { error: j.error, state: j.state });
        return;
      }
    } catch (e) {
      // 服务可能已退出
    }
    pollTimer = setTimeout(startPolling, 700);
  };

  try {
    es = new EventSource(`/api/job/${id}/events`);
    es.addEventListener('progress', (e) => onProgress?.(JSON.parse(e.data)));
    es.addEventListener('log', (e) => onLog?.(JSON.parse(e.data)));
    es.addEventListener('done', (e) => finish(JSON.parse(e.data)));
    es.onerror = () => {
      if (stopped) return;
      try { es.close(); } catch { /* ignore */ }
      es = null;
      if (!pollTimer) startPolling();
    };
  } catch {
    startPolling();
  }

  return {
    stop() {
      stopped = true;
      try { es?.close(); } catch { /* ignore */ }
      clearTimeout(pollTimer);
    },
  };
}

/* ================================================================== */
/* 轻量提示条                                                          */
/* ================================================================== */

export function toast(message, kind = '', ms = 3400) {
  const host = document.getElementById('snackbar-host');
  if (!host) return;
  const icons = { '': ICON.info, ok: ICON.check, err: ICON.warn };
  const node = el('div', { class: `snackbar ${kind}` }, [
    el('span', { html: svgIcon(icons[kind] || ICON.info, 'icon') }),
    el('div', { text: message }),
  ]);
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, ms);
}

/* ================================================================== */
/* 设备预设辅助                                                        */
/* ================================================================== */

export function matchPreset(w, h) {
  const hit = DEVICE_PRESETS.find((p) => p.w === Math.round(w) && p.h === Math.round(h));
  return hit ? hit.id : 'custom';
}

export function groupedPresets() {
  const groups = new Map();
  for (const p of DEVICE_PRESETS) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  return groups;
}

export { STAGE_LABEL };
