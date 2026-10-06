/**
 * app.js — 界面与交互
 */

import {
  $, $$, el, ICON, svgIcon, clamp, fmtTime, fmtBytes, fmtDur, debounce,
  baseName, ext, dirName, escapeHtml, setText, state, loadState, saveState, defaultConfig,
  ensureParts, planParts, estimateDuration, estimateBytes, buildDescPreview,
  describeLine, validate, validationToMessages, api, watchJob, toast,
  matchPreset, groupedPresets, STAGE_LABEL, naming, namingPreview,
} from './core.js';
import { DEVICE_PRESETS, SCALE_MODES, FORMAT_MODES, TARGET_MODES, HELP, TUTORIAL, VIDEO_EXT, QUALITY_MODES } from './data.js';

/* ================================================================== */
/* 视图切换                                                            */
/* ================================================================== */

const VIEWS = ['welcome', 'import', 'configure', 'export', 'progress', 'done'];
let currentView = null;
let currentViewIndex = -1;

/** 视图切换：带方向信息的 shared-axis X 过渡 */
function showView(name, opts = {}) {
  if (currentView === name) return;
  const nextIndex = VIEWS.indexOf(name);
  const from = currentView;
  const fromNode = from ? $(`#view-${from}`) : null;
  const node = $(`#view-${name}`);

  // 方向：目标步数前进则为 forward，否则 back
  let dir = opts.dir;
  if (!dir) {
    if (currentViewIndex < 0) dir = 'plain';
    else dir = nextIndex >= currentViewIndex ? 'forward' : 'back';
  }

  if (fromNode) {
    // 旧视图：冻结当前状态后按加速曲线退出，避免与新区块互相挤压
    fromNode.classList.remove('enter-forward', 'enter-back', 'enter-plain');
    fromNode.classList.add(dir === 'back' ? 'exit-back' : 'exit-forward');
    const dying = fromNode;
    setTimeout(() => {
      dying.hidden = true;
      dying.classList.remove('exit-forward', 'exit-back');
    }, 200);
  }

  if (node) {
    node.hidden = false;
    node.classList.remove('exit-forward', 'exit-back', 'enter-forward', 'enter-back', 'enter-plain');
    void node.offsetWidth;                      // 强制重排，确保动画重新开始
    node.classList.add(dir === 'plain' ? 'enter-plain' : dir === 'back' ? 'enter-back' : 'enter-forward');
  }

  currentView = name;
  currentViewIndex = nextIndex;
  $('#content')?.scrollTo({ top: 0, behavior: 'smooth' });
  renderStepper();
}

function renderStepper() {
  const host = $('#stepper');
  if (!host) return;
  const labels = ['导入', '配置', '导出'];
  const uiStep = state.step >= 4 ? 3 : state.step;
  host.innerHTML = '';
  labels.forEach((label, i) => {
    const n = i + 1;
    const chip = el('button', {
      class: 'step-chip',
      type: 'button',
      'data-state': uiStep === n ? 'active' : uiStep > n ? 'done' : 'todo',
      disabled: !state.info || state.step >= 4,
      title: `第 ${n} 步：${label}`,
      onclick: () => goStep(n),
    }, [
      el('span', { class: 'num' }, [el('i', { text: String(n) })]),
      el('span', { class: 'label', text: label }),
    ]);
    host.appendChild(chip);
    if (i < labels.length - 1) host.appendChild(el('span', { class: 'line step-line' }));
  });
}

function goStep(n) {
  if (n === 3 && !state.info) return;
  if (n === 2 && !state.info) return;
  state.step = n;
  showView(VIEWS[n] || 'import');
  if (n === 2) { renderConfigure(); }
  if (n === 3) { renderExport(); }
  saveState();
}

/* ================================================================== */
/* 初始化                                                              */
/* ================================================================== */

async function init() {
  loadState();
  applyTheme(state.theme);
  bindGlobal();
  bootStepper();

  try {
    const health = await api.health();
    state.engine = health;
    renderEngineCard(health);
    if (!health.ok) {
      showView('welcome');
      return;
    }
  } catch (e) {
    showView('welcome');
    $('#engine-body').innerHTML = `<span class="hint err">无法连接本地服务：${escapeHtml(e.message)}</span>`;
    return;
  }

  // 读取本机设置（最近使用、上次输出目录、是否看过教程）
  try {
    state.settings = await api.settings() || {};
    if (state.settings.outputDir && !state.config.outputDir) {
      state.config.outputDir = state.settings.outputDir;
    }
  } catch { state.settings = {}; }

  // 上次打开的视频还在 → 询问是否继续
  if (state.input && state.input.trim()) {
    try {
      const r = await api.probe(state.input);
      if (r.ok) {
        await loadVideo(state.input, { silent: true });
        toast('已恢复上次的视频');
        return;
      }
    } catch { /* 文件没了，正常走导入 */ }
  }
  showView('import');
  renderRecent();

  // 第一次使用 → 主动把教程端上来
  if (!state.settings.tutorialDone) {
    setTimeout(() => openTutorial('intro'), 420);
    api.saveSettings({ tutorialDone: true }).catch(() => {});
    state.settings.tutorialDone = true;
  }
}

function bindGlobal() {
  $('#btn-theme').onclick = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(state.theme);
    saveState();
  };
  $('#btn-close').onclick = async () => {
    if (state.step === 4) { toast('转换进行中，请先取消'); return; }
    try { await api.shutdown(); } catch { /* 服务可能已经退出 */ }
    toast('程序已退出，可以关闭此窗口');
    setTimeout(() => window.close(), 350);
  };
  for (const id of ['#btn-tutorial', '#btn-tutorial2', '#btn-tutorial3']) {
    const n = $(id);
    if (n) n.onclick = () => openTutorial('intro');
  }
  $('#btn-start').onclick = async () => {
    if (!state.engine?.ok) { toast('请先安装视频引擎', 'err'); return; }
    goStep(1);
  };
  $('#btn-fetch-engine').onclick = () => fetchEngine();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); openTutorial('intro'); return; }
    if (e.key === 'Escape') { closeTopModal(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#file-input')?.click(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const run = $('#btn-run');
      if (run && !run.disabled && state.step === 3) { e.preventDefault(); run.click(); }
    }
    if (e.key === ' ' && currentView === 'configure' && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });

  // 关闭外链跳转（本应用离线使用）
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target="_blank"], a[href^="http"]');
    if (a) e.preventDefault();
  }, true);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function bootStepper() { renderStepper(); }

/* ================================================================== */
/* 引擎卡片                                                            */
/* ================================================================== */

function renderEngineCard(health) {
  const tag = $('#engine-tag');
  const body = $('#engine-body');
  const btnFetch = $('#btn-fetch-engine');
  const btnStart = $('#btn-start');
  if (!tag) return;
  if (health.ok) {
    tag.className = 'tag ok';
    tag.textContent = '就绪';
    body.innerHTML = `
      <div class="kv"><span>ffmpeg</span><b class="mono">${escapeHtml(health.ffmpeg || '未知')}</b></div>
      <div class="kv"><span>ffprobe</span><b class="mono">${health.ffprobePath ? '已就绪' : '缺失'}</b></div>
      <div class="kv"><span>引擎位置</span><b class="mono" style="font-size:11px">${escapeHtml(health.ffmpegPath || '')}</b></div>
      <div class="kv"><span>本程序</span><b class="mono">v${escapeHtml(health.version || '1.0.0')} · Node ${escapeHtml(health.node || '')}</b></div>`;
    btnFetch.hidden = true;
    btnStart.disabled = false;
  } else {
    tag.className = 'tag err';
    tag.textContent = '未安装';
    body.innerHTML = `<span class="hint err">没有找到 ffmpeg / ffprobe。转换功能需要它来解码视频。</span>
      <div class="hint" style="margin-top:6px">点下面的「重新下载引擎」会自动从镜像下载（约 115 MB，实测几秒钟）。</div>`;
    btnFetch.hidden = false;
    btnStart.disabled = true;
  }
}

async function fetchEngine() {
  const log = $('#engine-log');
  log.hidden = false;
  log.textContent = '';
  $('#btn-fetch-engine').disabled = true;
  try {
    const { jobId } = await api.fetchEngine();
    watchJob(jobId, {
      onLog: (l) => { log.textContent += l.line + '\n'; log.scrollTop = log.scrollHeight; },
      onDone: async (r) => {
        $('#btn-fetch-engine').disabled = false;
        if (r && r.ok) {
          toast('引擎安装完成', 'ok');
          const health = await api.health();
          state.engine = health;
          renderEngineCard(health);
        } else {
          toast('引擎安装失败：' + (r?.error?.message || r?.message || '未知错误'), 'err', 8000);
        }
      },
    });
  } catch (e) {
    $('#btn-fetch-engine').disabled = false;
    toast('下载失败：' + e.message, 'err');
  }
}

/* ================================================================== */
/* 导入                                                                */
/* ================================================================== */

function renderRecent() {
  const dir = state.settings?.recentDirs || [];
  const wrap = $('#recent-wrap');
  const list = $('#recent-list');
  if (!list) return;
  list.innerHTML = '';
  if (!dir.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const p of dir.slice(0, 6)) {
    list.appendChild(el('button', {
      class: 'chip', title: p, onclick: () => loadVideo(p),
    }, [el('span', { html: svgIcon(ICON.file, 'icon-s') }), el('b', { text: baseName(p) })]));
  }
}

function bindImport() {
  const drop = $('#drop');
  const input = $('#file-input');
  if (!drop) return;

  drop.onclick = () => input.click();
  input.onchange = () => { if (input.files?.[0]) handleFile(input.files[0]); input.value = ''; };

  let depth = 0;
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('over'); });
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  $('#btn-change-file').onclick = () => openVideoPicker();
  $('#btn-browse-file').onclick = () => openVideoPicker();
  $('#btn-back-1').onclick = () => goStep(1);
}

/** 从拖入的 File 取真实路径；浏览器出于安全拿不到路径时，转到路径浏览器 */
async function handleFile(file) {
  let p = file?.path || '';
  if (!p) {
    try {
      const { webUtils } = window; // Electron 环境会提供
      if (webUtils?.getPathForFile) p = webUtils.getPathForFile(file);
    } catch { /* ignore */ }
  }
  if (p) { await loadVideo(p); return; }
  await openVideoPicker(
    `浏览器出于安全限制不把文件的磁盘路径交给网页，所以拖放/选择框只能拿到文件名（**${escapeHtml(file?.name || '未命名')}**）。\n` +
    '请在下面按路径选择同一个文件——本机应用读的是原始文件，不会复制或上传。',
  );
}

async function loadVideo(p, { silent = false } = {}) {
  const path = String(p || '').trim().replace(/^"|"$/g, '');
  if (!path) return false;
  if (VIDEO_EXT.length && !VIDEO_EXT.includes(ext(path))) {
    toast(`看起来不是视频文件（${ext(path) || '无扩展名'}）`, 'err');
  }
  try {
    const r = await api.probe(path);
    if (!r.ok) { toast('无法读取该视频：' + (r.error || ''), 'err', 6000); return false; }
    state.input = path;
    state.info = r.info;

    // 记忆最近使用
    const recents = [path, ...(state.settings?.recentDirs || []).filter((x) => x !== path)].slice(0, 8);
    state.settings = { ...state.settings, recentDirs: recents };
    api.saveSettings({ recentDirs: recents }).catch(() => {});

    // 首次载入视频：把区间设为整段，匹配比例
    const dur = r.info.duration || 0;
    state.config.start = 0;
    state.config.end = 0;
    state.config.parts = [];
    ensureParts(r.info);
    if (state.config.presetId === 'custom' || !state.config.width) {
      state.config.width = r.info.video.displayWidth;
      state.config.height = r.info.video.displayHeight;
      state.config.presetId = matchPreset(r.info.video.displayWidth, r.info.video.displayHeight);
    }
    // 帧率贴近源（不超过 30，保证体积可控）
    const srcFps = Math.round(r.info.video.fps) || 30;
    if (!silent) state.config.fps = clamp(srcFps, 12, 30);

    saveState();
    renderImportSummary();
    await refreshThumbnail(true, false);   // 首次预览：允许挑一张有代表性的帧
    computeValidation();
    renderRail();
    $('#btn-start').textContent = '配置动画';
    $('#btn-start').disabled = false;
    showView('import');
    $('#import-info').hidden = false;
    $('#recent-wrap').hidden = true;
    // 已导入后直接进入配置页体验更顺
    setTimeout(() => goStep(2), silent ? 0 : 320);
    if (!silent) toast(`已载入 ${r.info.video.displayWidth}×${r.info.video.displayHeight} · ${dur.toFixed(1)}s`, 'ok');
    return true;
  } catch (e) {
    toast('读取失败：' + e.message, 'err', 6000);
    return false;
  }
}

function renderImportSummary() {
  const info = state.info;
  if (!info) return;
  $('#src-name').textContent = info.fileName;
  $('#src-detail').textContent =
    `${info.video.displayWidth}×${info.video.displayHeight} · ${info.video.fps.toFixed(2)} fps · ${fmtDur(info.duration)} · ${fmtBytes(info.size)}`;
  const tag = $('#src-tag');
  tag.textContent = info.video.codec.toUpperCase() + (info.video.rotation ? ` · 旋转 ${info.video.rotation}°` : '');
  const stats = $('#src-stats');
  stats.innerHTML = '';
  const rows = [
    ['容器', info.container.split(',')[0].toUpperCase()],
    ['编码', info.video.codec + (info.video.profile ? ` (${info.video.profile})` : '')],
    ['像素格式', info.video.pixFmt],
    ['音轨', info.audio ? `${info.audio.codec} · ${info.audio.channels}ch` : '无'],
    ['色彩', info.video.isHdr ? 'HDR' : (info.video.colorSpace || '未标注')],
    ['时长', fmtDur(info.duration)],
  ];
  for (const [k, v] of rows) {
    stats.appendChild(el('div', { class: 'stat' }, [el('b', { text: v, style: 'font-size:14px' }), el('span', { text: k })]));
  }
  if (state.thumbnail) $('#src-thumb').style.backgroundImage = `url("${state.thumbnail}")`;
}

/* ================================================================== */
/* 缩略图与时间轴                                                      */
/* ================================================================== */

const thumbCache = new Map();

/**
 * @param {boolean} force 忽略缓存
 * @param {boolean} exact true = 就取播放头这一帧（拖动时间轴时用）；
 *                        false = 允许服务端挑一张有代表性的帧（避免片头黑场）
 */
async function refreshThumbnail(force = false, exact = true) {
  const info = state.info;
  if (!info) return;
  const t = clamp(Number(state.playhead) || 0, 0, Math.max(0, info.duration - 0.05));
  const key = `${state.input}@${t.toFixed(2)}${exact ? '' : '#rep'}`;
  try {
    let data = !force && thumbCache.get(key);
    if (!data) {
      // 加载视频时带上 duration，服务端会挑一张不是全黑的代表帧（片头黑场很常见）
      const r = await api.thumbnail(state.input, t, 480, exact ? 0 : info.duration);
      if (!r.ok) { if (!exact) showPreviewNote(r.error || '预览不可用'); return; }
      data = r.data;
      if (thumbCache.size > 40) thumbCache.clear();
      thumbCache.set(key, data);
    }
    state.thumbnail = data;
    const img = $('#preview-img');
    img.src = data;
    img.hidden = false;
    const ph = $('#preview-placeholder');
    ph.hidden = true;
    $('#src-thumb').style.backgroundImage = `url("${data}")`;
  } catch (e) {
    if (!exact) showPreviewNote(e.message);
  }
}

/** 预览拿不到图时，明确说明而不是留一块黑 */
function showPreviewNote(text) {
  const ph = $('#preview-placeholder');
  const img = $('#preview-img');
  if (img) img.hidden = true;
  if (ph) {
    ph.hidden = false;
    ph.textContent = text ? `预览不可用\n${text}` : '预览不可用';
  }
}

let stripTiles = [];
let stripLoading = false;

async function buildStrip() {
  const info = state.info;
  if (!info || stripLoading) return;
  const dur = Math.max(0.1, info.duration || 1);
  const count = 12;
  stripLoading = true;
  stripTiles = [];
  const canvas = $('#tl-canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0f12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    for (let i = 0; i < count; i++) {
      const t = (i / count) * dur;
      let data = thumbCache.get(`${state.input}@${t.toFixed(2)}`);
      if (!data) {
        try {
          const r = await api.thumbnail(state.input, t, 160);
          data = r.ok ? r.data : '';
        } catch {
          data = '';            // 单张失败不影响其它，也不往控制台抛
        }
        if (data) thumbCache.set(`${state.input}@${t.toFixed(2)}`, data);
      }
      if (data) stripTiles.push({ i, t, data });
    }
    await Promise.all(stripTiles.map((tile) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { tile.img = im; res(); };
      im.onerror = res;
      im.src = tile.data;
    })));
    drawStrip();
  } finally {
    stripLoading = false;
  }
}

function drawStrip() {
  const canvas = $('#tl-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0f12';
  ctx.fillRect(0, 0, w, h);
  const n = Math.max(1, stripTiles.length);
  const tw = w / n;
  for (const tile of stripTiles) {
    if (!tile.img) continue;
    // 等比裁切填充
    const im = tile.img;
    const scale = Math.max(tw / im.width, h / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.drawImage(im, tile.i * tw + (tw - dw) / 2, (h - dh) / 2, dw, dh);
  }
  // 未取到图时用渐变占位
  if (!stripTiles.length) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#12202a'); g.addColorStop(1, '#1b2730');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

/* ---------------- 时间轴交互 ---------------- */

let tlDrag = null;

function bindTimeline() {
  const tl = $('#timeline');
  if (!tl) return;
  const overlay = $('#tl-overlay');

  const posToTime = (clientX) => {
    const r = tl.getBoundingClientRect();
    const ratio = clamp((clientX - r.left) / r.width, 0, 1);
    return ratio * (state.info?.duration || 0);
  };

  const update = (clientX) => {
    if (!state.info) return;
    if (tlDrag === 'playhead') {
      state.playhead = clamp(posToTime(clientX), 0, state.info.duration || 0);
      state.config.playhead = state.playhead;
      renderTimeline();
      scheduleThumb();
    } else if (tlDrag === 'start' || tlDrag === 'end') {
      const t = clamp(posToTime(clientX), 0, state.info.duration || 0);
      const parts = state.config.parts;
      if (tlDrag === 'start') {
        const first = parts[0];
        first.start = Math.min(t, (first.end || t) - 0.05);
        state.config.start = first.start;
      } else {
        const last = parts[parts.length - 1];
        last.end = Math.max(t, (last.start || 0) + 0.05);
        state.config.end = last.end;
      }
      renderTimeline();
      computeValidation();
      renderRail();
    }
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (!state.info) return;
    const handle = e.target.closest('.tl-handle');
    tlDrag = handle ? handle.dataset.handle : 'playhead';
    overlay.setPointerCapture(e.pointerId);
    update(e.clientX);
    if (tlDrag === 'start' || tlDrag === 'end') stopPlay();
  });
  overlay.addEventListener('pointermove', (e) => { if (tlDrag) update(e.clientX); });
  overlay.addEventListener('pointerup', (e) => {
    if (!tlDrag) return;
    const wasPlayhead = tlDrag === 'playhead';
    tlDrag = null;
    try { overlay.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (wasPlayhead) {
      scheduleThumb();
      if (state.playing) startPlayFrom(state.playhead);
    }
  });

  $('#btn-split').onclick = () => splitAtPlayhead();
  $('#btn-add-part').onclick = () => addPart();
  $('#btn-clear-parts').onclick = () => {
    state.config.parts = [];
    ensureParts(state.info);
    renderParts();
    renderTimeline();
    computeValidation();
    renderRail();
  };
  $('#btn-play').onclick = () => togglePlay();
}

const scheduleThumb = debounce(() => refreshThumbnail(), 260);

function renderTimeline() {
  const overlay = $('#tl-overlay');
  const info = state.info;
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!info) return;
  const dur = Math.max(0.001, info.duration || 1);
  const pct = (t) => `${(clamp(t, 0, dur) / dur) * 100}%`;

  const { list } = planParts();
  const trimStart = list.length ? list[0].start : 0;
  const trimEnd = list.length ? list[list.length - 1].end : dur;

  // 区外遮罩
  if (trimStart > 0.001) overlay.appendChild(el('div', { class: 'tl-mask', style: `left:0;width:${pct(trimStart)}` }));
  if (trimEnd < dur - 0.001) overlay.appendChild(el('div', { class: 'tl-mask', style: `left:${pct(trimEnd)};right:0` }));

  for (const p of list) {
    const node = el('div', {
      class: 'tl-part', dataset: { type: p.type || 'p' },
      style: `left:${pct(p.start)};width:calc(${pct(p.end)} - ${pct(p.start)})`,
    }, [el('div', { class: 'tl-part-label', text: `${p.dir}${p.count === 0 ? ' ∞' : ` ×${p.count}`}` })]);
    overlay.appendChild(node);
  }

  overlay.appendChild(el('div', {
    class: 'tl-handle', dataset: { handle: 'start' }, style: `left:${pct(trimStart)}`, title: '起点',
  }, [el('span')]));
  overlay.appendChild(el('div', {
    class: 'tl-handle', dataset: { handle: 'end' }, style: `left:${pct(trimEnd)}`, title: '终点',
  }, [el('span')]));

  overlay.appendChild(el('div', { class: 'tl-playhead', style: `left:${pct(state.playhead)}` }));

  $('#tl-end').textContent = `${dur.toFixed(2)}s`;
  $('#tl-mid').textContent = `${((trimStart + trimEnd) / 2).toFixed(2)}s`;
  renderRailPartsBar();
}

/* ================================================================== */
/* 配置页                                                              */
/* ================================================================== */

let configureRendered = false;

function renderConfigure() {
  if (!configureRendered) {
    buildPresetSelect();
    buildTargetModes();
    buildFormatModes();
    buildScaleModes();
    bindConfigureInputs();
    configureRendered = true;
  }
  syncConfigureInputs();
  renderParts();
  renderTimeline();
  renderTrimSlider();
  if (!stripTiles.length) buildStrip();
  const info = state.info;
  if (info) {
    const ar = info.video.displayWidth / info.video.displayHeight;
    const src = ar > 1.05 ? 'landscape' : ar < 0.95 ? 'portrait' : 'square';
    $('#preview-frame').className = `preview-frame ${src === 'portrait' ? 'portrait' : src === 'landscape' ? 'landscape' : ''}`;
  }
}

function buildPresetSelect() {
  const sel = $('#preset-select');
  sel.innerHTML = '';
  for (const [group, items] of groupedPresets()) {
    const og = el('optgroup', { label: group });
    for (const p of items) {
      og.appendChild(el('option', { value: p.id, text: p.name + (p.hint ? ` · ${p.hint}` : '') }));
    }
    sel.appendChild(og);
  }
}

function buildTargetModes() {
  const host = $('#target-modes');
  if (!host) return;
  host.innerHTML = '';
  for (const m of TARGET_MODES) {
    const btn = el('button', {
      class: 'opt', type: 'button', 'data-target': m.id,
      'aria-pressed': (state.config.target || 'boot') === m.id,
      onclick: () => setTarget(m.id),
    }, [
      el('span', { class: 'tick', html: svgIcon(ICON.check) }),
      el('b', { text: m.name }),
      el('span', { text: m.hint }),
      el('span', {
        class: 'tag ' + (m.tone === 'warn' ? 'warn' : m.tone === 'info' ? 'info' : 'ok'),
        text: m.detail, style: 'margin-top:6px;align-self:flex-start',
      }),
      el('span', {
        class: 'hint mono', text: m.path,
        style: 'margin-top:6px;font-size:11px;word-break:break-all',
      }),
    ]);
    host.appendChild(btn);
  }
}

/** 切换开机 / 关机：同步默认文件名 */
function setTarget(target) {
  const c = state.config;
  c.target = target;
  const isShutdown = target === 'shutdown';
  $$('.opt[data-target]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.target === target)));

  const nameInput = $('#in-outname');
  if (nameInput) {
    const cur = nameInput.value.trim();
    const autos = ['bootanimation.zip', 'shutdownanimation.zip',
      'bootanimation-magisk.zip', 'shutdownanimation-magisk.zip',
      'bootanimation-video.zip', 'shutdownanimation-video.zip', ''];
    if (!cur || autos.includes(cur)) {
      const base = isShutdown ? 'shutdownanimation' : 'bootanimation';
      nameInput.value = c.magisk ? `${base}-magisk.zip` : `${base}.zip`;
      c.outputName = nameInput.value;
    }
  }
  // 关机动画的 Magisk 模块信息也跟着换，避免两个包撞 id
  const mo = c.magiskOpts || (c.magiskOpts = {});
  if (!mo.id || /^bootanimforge_(boot|shutdown)animation$/.test(mo.id)) {
    mo.id = isShutdown ? 'bootanimforge_shutdownanimation' : 'bootanimforge_bootanimation';
  }

  computeValidation();
  renderRail();
  saveState();
}

function buildFormatModes() {
  const host = $('#format-modes');
  if (!host) return;
  host.innerHTML = '';
  for (const m of FORMAT_MODES) {
    const btn = el('button', {
      class: 'opt', type: 'button', 'data-format': m.id,
      'aria-pressed': state.config.format === m.id,
      onclick: () => setFormat(m.id),
    }, [
      el('span', { class: 'tick', html: svgIcon(ICON.check) }),
      el('span', { class: 'ar-box', html: `<svg width="120" height="46" viewBox="0 0 24 24" style="color:currentColor;opacity:.7"><path fill="currentColor" d="${m.icon}"/></svg>` }),
      el('b', { text: m.name }),
      el('span', { text: m.hint }),
      el('span', {
        class: 'tag ' + (m.tone === 'warn' ? 'warn' : m.tone === 'info' ? 'info' : 'ok'),
        text: m.detail, style: 'margin-top:6px;align-self:flex-start',
      }),
    ]);
    host.appendChild(btn);
  }
}

/** 切换输出格式：同步所有受影响的控件可见性与默认文件名 */
function setFormat(fmt) {
  const c = state.config;
  c.format = fmt;
  const isVideo = fmt === 'video';
  applyFormatVisibility();

  // 文件名默认值：按「开机/关机」与「格式」共同决定，避免不同产物互相覆盖
  const nameInput = $('#in-outname');
  if (nameInput) {
    const base = c.target === 'shutdown' ? 'shutdownanimation' : 'bootanimation';
    const cur = nameInput.value.trim();
    const autos = ['', 'bootanimation.zip', 'shutdownanimation.zip',
      'bootanimation-magisk.zip', 'shutdownanimation-magisk.zip',
      'bootanimation-video.zip', 'shutdownanimation-video.zip'];
    if (autos.includes(cur)) {
      nameInput.value = `${base}${c.magisk ? '-magisk' : (isVideo ? '-video' : '')}.zip`;
      c.outputName = nameInput.value;
    }
  }
  // 视频版无法保留 alpha，取消勾选状态以免误导
  if (isVideo) {
    const alpha = $('#in-alpha');
    if (alpha) alpha.checked = false;
  } else {
    const alpha = $('#in-alpha');
    if (alpha) alpha.checked = !!c.keepAlpha;
  }

  computeValidation();
  renderRail();
  saveState();
}

function buildScaleModes() {
  const host = $('#scale-modes');
  host.innerHTML = '';
  for (const m of SCALE_MODES) {
    const btn = el('button', {
      class: 'opt', type: 'button', 'data-mode': m.id,
      'aria-pressed': state.config.scaleMode === m.id,
      onclick: () => {
        state.config.scaleMode = m.id;
        $$('.opt[data-mode]', host).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m.id)));
        computeValidation();
        renderRail();
        saveState();
      },
    }, [
      el('span', { class: 'tick', html: svgIcon(ICON.check) }),
      el('span', { class: 'ar-box', html: aspectDiagram(m.id) }),
      el('b', { text: m.name }),
      el('span', { text: m.hint }),
      el('span', { class: 'tag ' + (m.tone === 'warn' ? 'warn' : m.tone === 'info' ? 'info' : 'ok'), text: m.detail, style: 'margin-top:6px;align-self:flex-start' }),
    ]);
    host.appendChild(btn);
  }
}

/** 用两个方块画出示意：内框 = 视频，外框 = 屏幕 */
function aspectDiagram(mode) {
  if (mode === 'fit') {
    return `<svg width="120" height="46" viewBox="0 0 120 46">
      <rect x="30" y="3" width="60" height="40" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="3 3"/>
      <rect x="38" y="11" width="44" height="24" rx="2" fill="currentColor" fill-opacity=".75"/></svg>`;
  }
  if (mode === 'fill') {
    return `<svg width="120" height="46" viewBox="0 0 120 46">
      <rect x="30" y="3" width="60" height="40" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="3 3"/>
      <clipPath id="cp-fill"><rect x="30" y="3" width="60" height="40" rx="3"/></clipPath>
      <g clip-path="url(#cp-fill)"><rect x="18" y="3" width="84" height="40" rx="2" fill="currentColor" fill-opacity=".75"/></g></svg>`;
  }
  return `<svg width="120" height="46" viewBox="0 0 120 46">
    <rect x="30" y="3" width="60" height="40" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="3 3"/>
    <rect x="30" y="3" width="60" height="40" rx="3" fill="currentColor" fill-opacity=".75"/>
    <circle cx="60" cy="23" r="9" fill="none" stroke="var(--md-surface)" stroke-width="2"/></svg>`;
}

/**
 * 集中处理「哪些控件属于哪种输出格式」。
 *
 * 之前这段显隐逻辑散在 setFormat / syncConfigureInputs / renderConfigure 三处，
 * 结果出现「某些路径没跑到 → 控件该显示却是隐藏的」这类不一致（真踩过）。
 * 现在只有一个入口，且每次都用 state 重新推导，不依赖上一次的状态。
 */
function applyFormatVisibility() {
  const c = state.config;
  const isVideo = c.format === 'video';
  const set = (sel, visible) => {
    const n = $(sel);
    if (n) n.hidden = !visible;
  };
  set('#video-card', isVideo);            // 视频版专属参数
  set('#frame-opts', !isVideo);           // 帧图片格式（JPEG/PNG）
  set('#naming-box', !isVideo);           // 帧文件命名
  set('#compress-switch', !isVideo);      // zip 压缩
  set('#alpha-switch', !isVideo);         // 透明通道
  set('#jpeg-field', !isVideo && c.quality === 'mjpeg');
  set('#magisk-opts', !!c.magisk);
  $$('.opt[data-format]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === c.format)));
}

function syncConfigureInputs() {
  const c = state.config;
  const mo = c.magiskOpts || (c.magiskOpts = {});
  $('#in-width').value = Math.round(c.width);
  $('#in-height').value = Math.round(c.height);
  $('#preset-select').value = c.presetId || 'custom';
  $('#in-fps').value = clamp(Math.round(c.fps), 1, 60);
  $('#in-fps-num').value = Math.round(c.fps);
  paintRange($('#in-fps'));
  const dur = state.info?.duration || 0;
  $('#in-start').value = (list0().start ?? 0).toFixed(2);
  $('#in-end').value = (list0().end ?? dur).toFixed(2);
  $('#in-bg').value = c.background || '#000000';
  $('#in-bg-pick').value = /^#[0-9a-f]{6}$/i.test(c.background || '') ? c.background : '#000000';
  $('#in-quality').value = c.quality;
  $('#in-jpegq').value = c.jpegQuality;
  $('#jpegq-val').textContent = String(c.jpegQuality);
  $('#in-compress').checked = !!c.zipCompress;
  $('#in-alpha').checked = !!c.keepAlpha;
  $('#in-audio').checked = !!c.audio;
  $('#in-outdir').value = c.outputDir || '';
  $('#in-outname').value = c.outputName || 'bootanimation.zip';
  // 帧命名
  $('#in-prefix').value = c.framePrefix ?? 'frame_';
  $('#in-pad').value = c.padWidth ?? 5;
  $('#in-startnum').value = c.startNumber ?? 0;
  updateNamingPreview();
  // 视频版参数
  $('#in-crf').value = c.crf;
  $('#crf-val').textContent = String(c.crf);
  paintRange($('#in-crf'));
  $('#in-preset').value = c.preset;
  $('#in-audiobr').value = String(c.audioBitrate);
  updateCrfLabel();
  // Magisk
  const magiskBox = $('#in-magisk');
  if (magiskBox) magiskBox.checked = !!c.magisk;
  const magiskOpts = $('#magisk-opts');
  if (magiskOpts) magiskOpts.hidden = !c.magisk;
  $('#in-magisk-id').value = mo.id || '';
  $('#in-magisk-name').value = mo.name || '';
  $('#in-magisk-version').value = mo.version || '';
  $('#in-magisk-author').value = mo.author || '';
  $('#in-magisk-desc').value = mo.description || '';
  $('#in-magisk-path').value = mo.pathKey || 'system/media';
  $('#in-magisk-allpaths').checked = mo.allPaths !== false;

  // 格式相关的可见性（唯一入口）
  applyFormatVisibility();

  $('#res-tag').textContent = `${Math.round(c.width)} × ${Math.round(c.height)}`;
  updateArHint();
  updateTrimHint();
  const run = $('#btn-run');
  if (run) run.disabled = false;
}

function updateCrfLabel() {
  const v = Number(state.config.crf) || 20;
  const text = v <= 16 ? '几乎无损' : v <= 21 ? '推荐' : v <= 25 ? '较省空间' : '明显压缩';
  const node = $('#crf-label');
  if (node) node.textContent = `· ${text}`;
}

/** 帧命名实时预览：告诉用户第一张和最后一张会叫什么 */
function updateNamingPreview() {
  const box = $('#naming-preview');
  const tag = $('#naming-tag');
  if (!box) return;
  const p = namingPreview();
  const pad = '0'.repeat(p.padWidth);
  const style = `${p.prefix ? `前缀 “${p.prefix}” + ` : '纯数字 · '}${p.padWidth} 位补零 · 从 ${p.startNumber} 开始`;
  if (tag) tag.textContent = `${p.prefix || '（无前缀）'}${pad}`;
  if (!p.frames) {
    box.textContent = `${style}　→　${p.sample}`;
    return;
  }
  // 补零位数不够会导致撞名，这里提前标红
  const need = String(p.startNumber + p.frames - 1).length;
  const overflow = need > p.padWidth;
  box.innerHTML = `${escapeHtml(style)}　→　首帧 <b class="mono">${escapeHtml(p.sample)}</b>` +
    `，末帧 <b class="mono">${escapeHtml(p.last)}</b>（共 ${p.frames} 帧）` +
    (overflow ? `　<span class="hint err">补零位数不足，编号会重复，请改成 ${need} 位以上</span>` : '');
}

function list0() {
  const { list } = planParts();
  if (!list.length) return { start: 0, end: state.info?.duration || 0 };
  return { start: list[0].start, end: list[list.length - 1].end };
}

function updateArHint() {
  const c = state.config;
  const hint = $('#ar-hint');
  if (!hint) return;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const w = Math.round(c.width), h = Math.round(c.height);
  const g = gcd(w, h) || 1;
  let text = `比例 ${(w / h).toFixed(3)}（${w / g}:${h / g}）`;
  const info = state.info;
  if (info?.video) {
    const srcAR = info.video.displayWidth / info.video.displayHeight;
    const same = Math.abs(srcAR - w / h) < 0.01;
    text += same ? ' · 与视频一致 ✓' : ` · 视频为 ${(srcAR * 100).toFixed(1)}%（比例不同）`;
  }
  hint.textContent = text;
}

function updateTrimHint() {
  const { list } = planParts();
  const dur = state.info?.duration || 0;
  const hint = $('#trim-hint');
  if (!hint) return;
  const len = list.length ? list[list.length - 1].end - list[0].start : 0;
  hint.textContent = `取用 ${len.toFixed(2)}s / 全长 ${dur.toFixed(2)}s`;
}

function paintRange(input) {
  if (!input) return;
  const min = Number(input.min || 0), max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}

/* ---------------- 取用区间：滑块 + 输入框双向同步 ---------------- */

let trimDrag = null;

function renderTrimSlider() {
  const track = $('#trim-track');
  const fill = $('#trim-fill');
  const hs = $('#trim-h-start');
  const he = $('#trim-h-end');
  if (!track || !fill || !hs || !he) return;
  const dur = state.info?.duration || 0;
  const { list } = planParts();
  const s = list.length ? list[0].start : 0;
  const e = list.length ? list[list.length - 1].end : dur;
  const pct = (t) => dur > 0 ? clamp(t / dur, 0, 1) * 100 : 0;
  const a = pct(s), b = pct(e);
  fill.style.left = a + '%';
  fill.style.right = (100 - b) + '%';
  hs.style.left = a + '%';
  he.style.left = b + '%';
  setText($('#trim-mid'), `取用 ${(e - s).toFixed(2)}s`);
  setText($('#trim-total'), `${dur.toFixed(2)}s`);
}

function bindTrimSlider() {
  const track = $('#trim-track');
  if (!track) return;
  const timeAt = (clientX) => {
    const r = track.getBoundingClientRect();
    const ratio = clamp((clientX - r.left) / r.width, 0, 1);
    return ratio * (state.info?.duration || 0);
  };
  const apply = (clientX) => {
    if (!trimDrag || !state.info) return;
    const dur = state.info.duration || 0;
    const t = clamp(timeAt(clientX), 0, dur);
    const parts = state.config.parts;
    if (!parts || !parts.length) return;
    if (trimDrag === 'start') {
      const first = parts[0];
      first.start = Math.min(t, (first.end || t) - 0.05);
      state.config.start = first.start;
    } else {
      const last = parts[parts.length - 1];
      last.end = Math.max(t, (last.start || 0) + 0.05);
      state.config.end = last.end;
    }
    $('#in-start').value = (parts[0].start ?? 0).toFixed(2);
    $('#in-end').value = (parts[parts.length - 1].end ?? dur).toFixed(2);
    renderTrimSlider();
    renderTimeline();
    renderParts();
    computeValidation();
  };

  const startDrag = (which) => (e) => {
    if (!state.info) return;
    trimDrag = which;
    const h = which === 'start' ? $('#trim-h-start') : $('#trim-h-end');
    h?.classList.add('drag');
    track.setPointerCapture?.(e.pointerId);
    apply(e.clientX);
  };
  $('#trim-h-start').addEventListener('pointerdown', startDrag('start'));
  $('#trim-h-end').addEventListener('pointerdown', startDrag('end'));
  track.addEventListener('pointermove', (e) => { if (trimDrag) apply(e.clientX); });
  const endDrag = (e) => {
    if (!trimDrag) return;
    $('#trim-h-start')?.classList.remove('drag');
    $('#trim-h-end')?.classList.remove('drag');
    trimDrag = null;
    try { track.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    saveState();
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
}

function bindConfigureInputs() {
  const c = state.config;
  const onResize = debounce(() => {
    computeValidation();
    renderRail();
    renderTimeline();
    saveState();
  }, 220);

  const setSize = (w, h) => {
    c.width = clamp(Math.round(w) || 2, 2, 7680);
    c.height = clamp(Math.round(h) || 2, 2, 7680);
    c.presetId = matchPreset(c.width, c.height);
    $('#in-width').value = c.width;
    $('#in-height').value = c.height;
    $('#preset-select').value = c.presetId;
    $('#res-tag').textContent = `${c.width} × ${c.height}`;
    updateArHint();
    onResize();
  };

  $('#in-width').oninput = (e) => setSize(e.target.value, c.height);
  $('#in-height').oninput = (e) => setSize(c.width, e.target.value);

  $('#preset-select').onchange = (e) => {
    const p = DEVICE_PRESETS.find((x) => x.id === e.target.value);
    c.presetId = e.target.value;
    if (p && p.w) setSize(p.w, p.h);
    else { updateArHint(); saveState(); }
  };

  $('#btn-swap').onclick = () => setSize(c.height, c.width);
  $('#btn-fit-source').onclick = () => {
    if (!state.info) return;
    // 保持目标高度，按视频比例算宽（取偶数）
    let w = Math.round((c.height * state.info.video.displayWidth) / state.info.video.displayHeight);
    if (w % 2) w++;
    setSize(w, c.height);
    toast('已按视频比例匹配宽度', 'ok');
  };

  const setFps = (v) => {
    c.fps = clamp(Math.round(Number(v)) || 30, 1, 120);
    $('#in-fps').value = clamp(c.fps, 1, 60);
    $('#in-fps-num').value = c.fps;
    paintRange($('#in-fps'));
    onResize();
  };
  $('#in-fps').oninput = (e) => setFps(e.target.value);
  $('#in-fps-num').onchange = (e) => setFps(e.target.value);
  $$('[data-fps]').forEach((b) => { b.onclick = () => setFps(b.dataset.fps); });

  const clampRange = () => {
    const dur = state.info?.duration || 0;
    let s = clamp(Number($('#in-start').value) || 0, 0, Math.max(0, dur - 0.05));
    let e = Number($('#in-end').value) || 0;
    e = e <= 0 ? dur : clamp(e, s + 0.05, dur);
    const parts = state.config.parts;
    if (parts?.length) {
      parts[0].start = s;
      parts[parts.length - 1].end = e;
      // 中间的段按比例重排，避免越界
      for (let i = 1; i < parts.length - 1; i++) {
        parts[i].start = clamp(parts[i].start, s, e);
        parts[i].end = clamp(parts[i].end, parts[i].start + 0.05, e);
      }
    }
    c.start = s;
    c.end = e;
    $('#in-start').value = s.toFixed(2);
    $('#in-end').value = e.toFixed(2);
    updateTrimHint();
    renderTimeline();
    renderTrimSlider();
    renderParts();
    onResize();
  };
  $('#in-start').onchange = clampRange;
  $('#in-end').onchange = clampRange;

  const setBg = (v) => {
    c.background = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : c.background;
    $('#in-bg').value = c.background;
    $('#in-bg-pick').value = c.background;
    saveState();
  };
  $('#in-bg').onchange = (e) => setBg(e.target.value.trim());
  $('#in-bg-pick').oninput = (e) => setBg(e.target.value);

  $('#in-quality').onchange = (e) => {
    c.quality = e.target.value;
    $('#jpeg-field').hidden = c.quality !== 'mjpeg';
    computeValidation();
    renderRail();
    saveState();
  };
  $('#in-jpegq').oninput = (e) => { c.jpegQuality = Number(e.target.value); $('#jpegq-val').textContent = e.target.value; renderRail(); paintRange(e.target); };
  paintRange($('#in-jpegq'));

  $('#in-compress').onchange = (e) => { c.zipCompress = e.target.checked; computeValidation(); renderRail(); saveState(); };
  $('#in-alpha').onchange = (e) => { c.keepAlpha = e.target.checked; saveState(); };
  $('#in-audio').onchange = (e) => { c.audio = e.target.checked; saveState(); };
  $('#in-outdir').onchange = (e) => { c.outputDir = e.target.value.trim(); saveState(); };
  $('#in-outname').onchange = (e) => { c.outputName = e.target.value.trim() || 'bootanimation.zip'; saveState(); };

  /* --- 帧文件命名 --- */
  const onNamingChange = () => {
    c.framePrefix = $('#in-prefix').value;
    c.padWidth = clamp(Math.round(Number($('#in-pad').value)) || 5, 1, 8);
    c.startNumber = clamp(Math.round(Number($('#in-startnum').value)) || 0, 0, 10000000);
    $('#in-pad').value = c.padWidth;
    $('#in-startnum').value = c.startNumber;
    updateNamingPreview();
    computeValidation();
    saveState();
  };
  $('#in-prefix').onchange = onNamingChange;
  $('#in-pad').onchange = onNamingChange;
  $('#in-startnum').onchange = onNamingChange;
  $$('[data-naming]').forEach((chip) => {
    chip.onclick = () => {
      const [prefix, pad, start] = String(chip.dataset.naming).split('|');
      $('#in-prefix').value = prefix;
      $('#in-pad').value = pad;
      $('#in-startnum').value = start;
      onNamingChange();
      toast(`已切换为 ${prefix || '纯数字'} + ${pad} 位补零，起于 ${start}`, 'ok');
    };
  });

  /* --- 视频版参数 --- */
  $('#in-crf').oninput = (e) => {
    c.crf = Number(e.target.value) || 20;
    $('#crf-val').textContent = String(c.crf);
    paintRange(e.target);
    updateCrfLabel();
    onResize();
  };
  $('#in-preset').onchange = (e) => { c.preset = e.target.value; saveState(); };
  $('#in-audiobr').onchange = (e) => { c.audioBitrate = Number(e.target.value) || 128; renderRail(); saveState(); };

  /* --- Magisk 模块 --- */
  $('#in-magisk').onchange = (e) => {
    c.magisk = e.target.checked;
    applyFormatVisibility();
    // Magisk 模块与纯动画是两个不同的产物，默认文件名分开，避免互相覆盖
    const nameInput = $('#in-outname');
    if (nameInput) {
      const base = c.target === 'shutdown' ? 'shutdownanimation' : 'bootanimation';
      const cur = nameInput.value.trim();
      const autos = ['', 'bootanimation.zip', 'shutdownanimation.zip',
        'bootanimation-magisk.zip', 'shutdownanimation-magisk.zip',
        'bootanimation-video.zip', 'shutdownanimation-video.zip'];
      if (autos.includes(cur)) {
        nameInput.value = `${base}${c.magisk ? '-magisk' : (c.format === 'video' ? '-video' : '')}.zip`;
        c.outputName = nameInput.value;
      }
    }
    computeValidation();
    renderRail();
    saveState();
  };
  const mo = () => (c.magiskOpts = c.magiskOpts || {});
  $('#in-magisk-id').onchange = (e) => { mo().id = e.target.value.trim(); computeValidation(); renderRail(); saveState(); };
  $('#in-magisk-name').onchange = (e) => { mo().name = e.target.value.trim(); saveState(); };
  $('#in-magisk-version').onchange = (e) => { mo().version = e.target.value.trim() || '1.0.0'; computeValidation(); saveState(); };
  $('#in-magisk-author').onchange = (e) => { mo().author = e.target.value.trim(); saveState(); };
  $('#in-magisk-desc').onchange = (e) => { mo().description = e.target.value.trim(); saveState(); };
  $('#in-magisk-path').onchange = (e) => { mo().pathKey = e.target.value; saveState(); };
  $('#in-magisk-allpaths').onchange = (e) => { mo().allPaths = e.target.checked; saveState(); };

  $('#btn-pick-dir').onclick = () => openDirPicker();

  $('#btn-to-export').onclick = () => goStep(3);
}

/* ---------------- 分段编辑 ---------------- */

function splitAtPlayhead() {
  const t = clamp(state.playhead, 0, state.info?.duration || 0);
  const parts = state.config.parts;
  const idx = parts.findIndex((p) => t > p.start + 0.1 && t < p.end - 0.1);
  if (idx < 0) { toast('把播放头移到某一段中间再切分', 'err'); return; }
  const src = parts[idx];
  const right = {
    ...src,
    dir: `part${parts.length}`,
    name: `第 ${parts.length + 1} 段`,
    start: t,
    count: 0,
    pause: 0,
  };
  src.end = t;
  src.count = 1;                 // 被切开的前段默认播 1 次
  src.name = src.name || '第 1 段';
  parts.splice(idx + 1, 0, right);
  // 目录名重新编号，保证连续
  parts.forEach((p, i) => { p.dir = `part${i}`; });
  renderParts();
  renderTimeline();
  computeValidation();
  renderRail();
  saveState();
  toast(`已在 ${t.toFixed(2)}s 处切分`, 'ok');
}

function addPart() {
  const parts = state.config.parts;
  const dur = state.info?.duration || 1;
  const last = parts[parts.length - 1];
  const start = clamp(last?.end ?? 0, 0, Math.max(0, dur - 0.2));
  parts.push({
    dir: `part${parts.length}`,
    name: `第 ${parts.length + 1} 段`,
    start,
    end: clamp(start + 1, start + 0.1, dur),
    type: 'p', count: 0, pause: 0, fade: 0, background: '', clock: '', audio: false,
  });
  renderParts();
  renderTimeline();
  computeValidation();
  renderRail();
  saveState();
}

function renderParts() {
  const host = $('#parts-list');
  if (!host) return;
  const { list, fps } = planParts();
  host.innerHTML = '';
  $('#parts-tag').textContent = `${list.length} 段 · 共 ${list.reduce((a, p) => a + p.frames, 0)} 帧`;

  list.forEach((p, i) => {
    const color = el('div', { class: `part-color ${p.type || 'p'}` });
    const info = el('div', { class: 'part-info' }, [
      el('b', { text: `${i + 1}. ${p.name || p.dir}` }),
      el('span', { text: `${p.start.toFixed(2)}s → ${p.end.toFixed(2)}s · ${p.frames} 帧 · ${(p.frames / fps).toFixed(2)}s` }),
    ]);

    const controls = el('div', { class: 'part-controls' });

    // 循环次数
    const countWrap = el('div', { class: 'unit-input', style: 'width:120px' }, [
      el('input', {
        class: 'input mono small', type: 'number', min: '0', max: '9999', value: String(p.count),
        title: '播放次数，0 = 无限循环',
        onchange: (e) => {
          p.count = clamp(Number(e.target.value) || 0, 0, 9999);
          e.target.value = String(p.count);
          renderTimeline(); computeValidation(); renderRail(); saveState();
        },
      }),
      el('span', { class: 'unit', text: p.count === 0 ? '次∞' : '次' }),
    ]);

    // 暂停帧数
    const pauseWrap = el('div', { class: 'unit-input', style: 'width:126px' }, [
      el('input', {
        class: 'input mono small', type: 'number', min: '0', max: '9999', value: String(p.pause),
        title: `播完本段后暂停的帧数（${fps}fps 下 1 秒 = ${fps} 帧）`,
        onchange: (e) => {
          p.pause = clamp(Number(e.target.value) || 0, 0, 9999);
          e.target.value = String(p.pause);
          renderRail(); saveState();
        },
      }),
      el('span', { class: 'unit', text: `帧≈${((p.pause || 0) / fps).toFixed(1)}s` }),
    ]);

    // 类型
    const typeSel = el('select', {
      class: 'input small', style: 'width:150px', title: 'p 可被打断 / c 必须播完 / f 被打断时淡出',
      onchange: (e) => {
        p.type = e.target.value;
        color.className = `part-color ${p.type}`;
        renderParts(); renderTimeline(); computeValidation(); renderRail(); saveState();
      },
    }, [
      el('option', { value: 'p', text: 'p · 可被打断', selected: p.type === 'p' }),
      el('option', { value: 'c', text: 'c · 必须播完', selected: p.type === 'c' }),
      el('option', { value: 'f', text: 'f · 淡出', selected: p.type === 'f' }),
    ]);

    controls.appendChild(countWrap);
    controls.appendChild(pauseWrap);
    controls.appendChild(typeSel);

    if (p.type === 'f') {
      controls.appendChild(el('div', { class: 'unit-input', style: 'width:110px' }, [
        el('input', {
          class: 'input mono small', type: 'number', min: '0', value: String(p.fade || 0), title: '被打断时淡出的帧数',
          onchange: (e) => { p.fade = clamp(Number(e.target.value) || 0, 0, 9999); renderRail(); saveState(); },
        }),
        el('span', { class: 'unit', text: '淡出' }),
      ]));
    }

    // 背景色（可选）
    controls.appendChild(el('input', {
      class: 'input mono small', type: 'text', style: 'width:104px', value: p.background || '',
      placeholder: '背景色', title: '该段的背景色 #RRGGBB（留空则透明/黑）', spellcheck: 'false',
      onchange: (e) => { p.background = e.target.value.trim(); renderRail(); saveState(); },
    }));

    controls.appendChild(el('button', {
      class: 'icon-btn', title: '删除这一段', style: 'width:34px;height:34px',
      onclick: () => {
        if (list.length <= 1) { toast('至少要保留一段', 'err'); return; }
        state.config.parts.splice(i, 1);
        state.config.parts.forEach((x, k) => { x.dir = `part${k}`; });
        renderParts(); renderTimeline(); computeValidation(); renderRail(); saveState();
      },
      html: svgIcon(ICON.trash, 'icon-s'),
    }));

    host.appendChild(el('div', { class: 'part-row' }, [color, info, el('div'), controls]));
  });
}

/* ---------------- 试播（模拟开机时的播放顺序） ---------------- */

let playTimer = null;

function stopPlay() {
  state.playing = false;
  clearTimeout(playTimer);
  const v = $('#preview-video');
  if (v) { v.pause(); v.hidden = true; }
  const img = $('#preview-img');
  if (img && state.thumbnail) img.hidden = false;
  const btn = $('#btn-play');
  if (btn) btn.innerHTML = svgIcon(ICON.play, 'icon-s') + '试播';
}

function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  if (!state.info) { toast('先导入视频', 'err'); return; }
  state.playing = true;
  const btn = $('#btn-play');
  if (btn) btn.innerHTML = svgIcon(ICON.pause, 'icon-s') + '停止';
  startPlayFrom(list0().start);
}

function startPlayFrom(t) {
  const { list, fps } = planParts();
  const v = $('#preview-video');
  if (!v || !state.info) return;
  v.src = api.media(state.input);
  v.hidden = false;
  $('#preview-img').hidden = true;

  let partIndex = 0;
  let loopLeft = 0;

  const playPart = () => {
    if (!state.playing) return;
    const p = list[partIndex];
    if (!p) { stopPlay(); return; }
    loopLeft = p.count === 0 ? Infinity : Math.max(1, p.count);
    playOnce(p);
  };

  const playOnce = (p) => {
    if (!state.playing) return;
    if (loopLeft <= 0) {
      // 本段播完 → 暂停 → 下一段
      const pauseMs = ((Number(p.pause) || 0) / fps) * 1000;
      playTimer = setTimeout(() => {
        partIndex += 1;
        if (partIndex >= list.length) { stopPlay(); return; }
        playPart();
      }, Math.max(0, pauseMs));
      return;
    }
    loopLeft -= 1;
    const onTime = () => {
      state.playhead = v.currentTime;
      renderPlayheadOnly();
      if (v.currentTime >= p.end - 0.02) {
        v.removeEventListener('timeupdate', onTime);
        v.pause();
        attemptLoop(p);
      }
    };
    v.currentTime = clamp(p.start, 0, state.info.duration);
    v.addEventListener('timeupdate', onTime);
    v.play().catch(() => { stopPlay(); });
  };

  const attemptLoop = (p) => {
    if (!state.playing) return;
    if (loopLeft > 0) playOnce(p);
    else playOnce(p);   // 触发暂停分支
  };

  playPart();
}

function renderPlayheadOnly() {
  const el2 = $('.tl-playhead');
  if (!el2 || !state.info) return;
  const dur = Math.max(0.001, state.info.duration || 1);
  el2.style.left = `${(clamp(state.playhead, 0, dur) / dur) * 100}%`;
}

/* ================================================================== */
/* 校验 / 侧栏                                                         */
/* ================================================================== */

function computeValidation() {
  ensureParts(state.info);          // 保证「至少一段」这一不变量，再算摘要
  state.validation = validate();
  state.plan = planParts();
  state.estimate = { ...estimateBytes(), duration: estimateDuration() };
  renderRail();
}

function renderRail() {
  const c = state.config;
  const { list, frames, fps } = state.plan || planParts();
  setText($('#rail-res'), `${Math.round(c.width)} × ${Math.round(c.height)}`);
  setText($('#rail-fps'), `${fps} FPS`);
  setText($('#rail-frames'), String(frames));
  setText($('#rail-parts'), list.length === 1
    ? (list[0].count === 0 ? '1 段 · 无限循环' : `1 段 · ${list[0].count} 次`)
    : `${list.length} 段`);
  setText($('#rail-format'), c.format === 'video' ? '视频版 (12+)' : '传统帧序列');
  const tgtMode = TARGET_MODES.find((m) => m.id === (c.target || 'boot')) || TARGET_MODES[0];
  setText($('#rail-output'), c.magisk ? `${tgtMode.name}模块` : tgtMode.file);
  const est = state.estimate || estimateBytes();
  setText($('#rail-size'), `≈ ${fmtBytes(est.bytes)}`, { pulse: true });
  setText($('#rail-dur'), fmtDur(state.estimate?.duration || estimateDuration()), { pulse: true });

  const badge = $('#preview-badge');
  if (state.info) {
    badge.hidden = false;
    badge.textContent = `${Math.round(c.width)}×${Math.round(c.height)} · ${fps}fps`;
  }

  // desc.txt 预览 / 视频版载荷预览
  const lines = buildDescPreview();
  $('#desc-mini').innerHTML = c.format === 'video'
    ? '<span class="c0">bootanimation.mp4</span>\n<span class="cm"># 视频版：无 desc.txt</span>'
    : lines.map((l, i) => `<span class="${i === 0 ? 'c0' : ''}">${escapeHtml(l)}</span>`).join('\n');

  // 校验消息
  const host = $('#rail-msgs');
  const msgs = validationToMessages(state.validation);
  host.innerHTML = '';
  if (!msgs.length) {
    host.appendChild(msgNode('ok', '参数检查通过，可以导出'));
  } else {
    const order = { err: 0, warn: 1, ok: 2, note: 3 };
    msgs.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    for (const m of msgs.slice(0, 8)) host.appendChild(msgNode(m.kind, m.text));
    if (msgs.length > 8) host.appendChild(msgNode('note', `还有 ${msgs.length - 8} 条提示…`));
  }
  renderRailPartsBar();
}

function msgNode(kind, text) {
  const icon = kind === 'err' ? ICON.warn : kind === 'warn' ? ICON.warn : kind === 'ok' ? ICON.check : ICON.info;
  return el('div', { class: `msg ${kind}` }, [
    el('span', { html: svgIcon(icon, 'icon-s') }),
    el('div', { text }),
  ]);
}

function renderRailPartsBar() {
  const host = $('#preview-parts');
  if (!host) return;
  const { list } = planParts();
  host.innerHTML = '';
  for (const p of list) host.appendChild(el('i', { class: p.type || 'p', title: `${p.dir}（${p.count === 0 ? '无限循环' : p.count + ' 次'}）` }));
}

/* ================================================================== */
/* 导出页                                                              */
/* ================================================================== */

function renderExport() {
  computeValidation();
  const c = state.config;
  const { list, frames, fps } = state.plan;
  const isVideo = c.format === 'video';

  // desc.txt 完整预览（视频版没有 desc.txt，改为展示载荷说明）
  const descCard = $('#desc-full');
  const explain = $('#desc-explain');
  if (isVideo) {
    const dur = list.reduce((a, p) => a + Math.max(0, p.end - p.start), 0);
    descCard.innerHTML = `<span class="c0">bootanimation.mp4</span>\n` +
      `<span class="cm"># 视频版开机动画（Android 12+）不需要 desc.txt</span>\n` +
      `<span class="cm"># H.264 / Main profile / yuv420p / 无 B 帧 / moov 前置</span>` +
      (c.audio ? `\n<span class="c0">audio.mp3</span>` : '');
    explain.innerHTML = [
      `· 时长 ${dur.toFixed(2)} 秒，按 ${fps} FPS 重新编码`,
      `· 分辨率 ${Math.round(c.width)}×${Math.round(c.height)}，${c.scaleMode === 'fill' ? '铺满裁切' : c.scaleMode === 'stretch' ? '拉伸' : '等比留边（不拉伸）'}`,
      `· 画质 CRF ${c.crf}，编码 preset ${c.preset}`,
      `· 循环由系统控制：一般循环播放直到开机完成`,
      list.length > 1 ? `· ${list.length} 个分段会按顺序拼成一个连续视频` : '',
    ].filter(Boolean).map((t) => `<div>${escapeHtml(t)}</div>`).join('');
    $('#btn-copy-desc').hidden = true;
  } else {
    const lines = buildDescPreview();
    descCard.innerHTML = lines
      .map((l, i) => `<span class="${i === 0 ? 'c0' : ''}">${escapeHtml(l)}</span>`)
      .join('\n');
    explain.innerHTML = lines.map((l, i) => `<div>· ${escapeHtml(describeLine(l, i))}</div>`).join('');
    $('#btn-copy-desc').hidden = false;
  }

  // 打包内容
  const host = $('#zip-plan');
  host.innerHTML = '';
  if (isVideo) {
    host.appendChild(msgNode('note', `bootanimation.mp4 — H.264 视频${c.audio && state.info?.audio ? '（内含音轨）' : ''}`));
    if (c.audio && state.info?.audio) host.appendChild(msgNode('note', 'audio.mp3 — 独立音轨'));
  } else {
    host.appendChild(msgNode('note', `desc.txt（${buildDescPreview().length} 行）`));
    for (const p of list) {
      host.appendChild(msgNode('note', `${p.dir}/ — ${p.frames} 个${c.quality === 'mjpeg' ? '.jpg' : '.png'} 帧` +
        (c.audio && state.info?.audio ? ' + audio.wav' : '')));
    }
    const nm = namingPreview();
    host.appendChild(msgNode('note',
      `帧文件命名：${nm.prefix || '（无前缀）'}${'0'.repeat(nm.padWidth)} 起于 ${nm.startNumber}` +
      `　首帧 ${nm.sample}${nm.frames > 1 ? ` → 末帧 ${nm.last}` : ''}`));
    host.appendChild(msgNode('note', `打包方式：${c.zipCompress ? 'DEFLATE 压缩' : 'STORE 不压缩（推荐，符合 zip -0 规范）'}`));
  }
  if (c.magisk) {
    const mo = c.magiskOpts || {};
    host.appendChild(msgNode('ok', `Magisk 模块：module.prop（id=${mo.id || '默认'}）+ customize.sh + ` +
      `载荷写入 ${mo.allPaths !== false ? '三个常见路径' : '/' + String(mo.pathKey || 'system/media').replace(/^system\//, '')}`));
  }

  // 预检
  const pf = $('#preflight-msgs');
  pf.innerHTML = '';
  const msgs = validationToMessages(state.validation);
  const tag = $('#preflight-tag');
  if (state.validation.errors.length) {
    tag.className = 'tag err';
    tag.textContent = `${state.validation.errors.length} 个问题`;
  } else if (state.validation.warnings.length) {
    tag.className = 'tag warn';
    tag.textContent = `${state.validation.warnings.length} 条警告`;
  } else {
    tag.className = 'tag ok';
    tag.textContent = '可以转换';
  }
  if (!msgs.length) pf.appendChild(msgNode('ok', '一切正常'));
  else for (const m of msgs) pf.appendChild(msgNode(m.kind, m.text));

  const stats = $('#preflight-stats');
  stats.innerHTML = '';
  const est = state.estimate;
  const rows = [
    ['目标分辨率', `${Math.round(c.width)}×${Math.round(c.height)}`],
    ['帧率', `${fps} FPS`],
    ['输出格式', isVideo ? '视频版' : '传统帧序列'],
  ];
  if (isVideo) {
    const dur = list.reduce((a, p) => a + Math.max(0, p.end - p.start), 0);
    rows.push(['视频时长', `${dur.toFixed(2)}s`], ['画质', `CRF ${c.crf}`], ['预计体积', `≈ ${fmtBytes(est.bytes)}`]);
  } else {
    rows.push(['总帧数', String(frames)], ['预计体积', `≈ ${fmtBytes(est.bytes)}`], ['播放一轮', fmtDur(est.duration)]);
  }
  rows.push([c.magisk ? '产出' : '打包', c.magisk ? '模块 + 动画' : (c.zipCompress ? '压缩' : 'STORE')]);
  for (const [k, v] of rows) {
    stats.appendChild(el('div', { class: 'stat' }, [el('b', { text: v, style: 'font-size:15px' }), el('span', { text: k })]));
  }

  $('#btn-run').disabled = state.validation.errors.length > 0;
  $('#btn-back-2').onclick = () => goStep(2);
  $('#btn-copy-desc').onclick = async () => {
    try {
      await navigator.clipboard.writeText(buildDescPreview().join('\r\n') + '\r\n');
      toast('desc.txt 已复制', 'ok');
    } catch { toast('复制失败', 'err'); }
  };
  $('#btn-run').onclick = runConversion;
}

/* ================================================================== */
/* 转换与进度                                                          */
/* ================================================================== */

const STAGES = ['probe', 'plan', 'frames', 'desc', 'zip', 'verify'];

async function runConversion() {
  const c = state.config;
  if (!state.input) { toast('请先导入视频', 'err'); return; }
  if (state.validation.errors.length) { toast('请先修正参数错误', 'err'); return; }

  state.step = 4;
  showView('progress');
  renderStepper();
  $('#prog-log').textContent = '';
  $('#prog-pct').textContent = '0%';
  $('#prog-stage').textContent = '准备中';
  $('#prog-detail').textContent = '—';
  setRing(0);
  renderStageChips('prepare');

  const { list } = planParts();
  const mo = c.magiskOpts || {};
  const payload = {
    input: state.input,
    outputDir: c.outputDir || '',
    outputName: c.outputName || 'bootanimation.zip',
    target: c.target === 'shutdown' ? 'shutdown' : 'boot',
    format: c.format === 'video' ? 'video' : 'classic',
    magisk: !!c.magisk,
    width: Math.round(c.width),
    height: Math.round(c.height),
    fps: Math.round(c.fps),
    progress: !!c.progress,
    scaleMode: c.scaleMode,
    background: c.background,
    keepAlpha: c.format === 'video' ? false : !!c.keepAlpha,
    quality: c.quality,
    jpegQuality: Number(c.jpegQuality) || 4,
    framePrefix: c.framePrefix ?? 'frame_',
    padWidth: Number(c.padWidth) || 5,
    startNumber: Number(c.startNumber) || 0,
    zipCompress: !!c.zipCompress,
    audio: !!c.audio,
    crf: Number(c.crf) || 20,
    preset: c.preset || 'medium',
    audioBitrate: Number(c.audioBitrate) || 128,
    magiskOpts: {
      id: mo.id || 'bootanimforge_bootanimation',
      name: mo.name || '开机动画',
      version: mo.version || '1.0.0',
      versionCode: Number(mo.versionCode) || 0,
      author: mo.author || 'BootAnimForge',
      description: mo.description || '',
      pathKey: mo.pathKey || 'system/media',
      allPaths: mo.allPaths !== false,
      withReadme: mo.withReadme !== false,
    },
    parts: list.map((p) => ({
      dir: p.dir, name: p.name, start: p.start, end: p.end,
      type: p.type, count: Number(p.count) || 0, pause: Number(p.pause) || 0,
      fade: Number(p.fade) || 0, background: p.background || '', clock: p.clock || '',
      audio: !!c.audio,
    })),
  };

  try {
    const { jobId } = await api.extract(payload);
    state.job = jobId;
    watchJob(jobId, {
      onProgress: (p) => updateProgress(p),
      onLog: (l) => {
        const box = $('#prog-log');
        const line = document.createElement('div');
        line.textContent = l.line;
        if (/error|错误|failed/i.test(l.line)) line.className = 'l-err';
        box.appendChild(line);
        if (box.childElementCount > 500) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
      },
      onDone: (r) => {
        if (r && r.output) finishSuccess(r);
        else finishFail(r);
      },
    });
  } catch (e) {
    finishFail({ error: { message: e.message } });
  }

  $('#btn-cancel').onclick = async () => {
    if (!state.job) return;
    try { await api.cancel(state.job); toast('正在取消…'); } catch { /* ignore */ }
  };
  $('#btn-toggle-log').onclick = () => {
    const box = $('#prog-log');
    box.hidden = !box.hidden;
    $('#btn-toggle-log').textContent = box.hidden ? '显示日志' : '隐藏日志';
  };
}

function setRing(ratio) {
  const C = 2 * Math.PI * 54;
  const fg = $('#ring-fg');
  if (!fg) return;
  fg.setAttribute('stroke-dasharray', String(C));
  fg.setAttribute('stroke-dashoffset', String(C * (1 - clamp(ratio, 0, 1))));
}

function renderStageChips(stage) {
  const host = $('#prog-stages');
  if (!host) return;
  const order = ['probe', 'plan', 'frames', 'desc', 'zip', 'verify'];
  const cur = order.indexOf(stage === 'prepare' ? 'probe' : stage);
  host.innerHTML = '';
  for (const s of STAGES) {
    const i = order.indexOf(s);
    const st = stage === 'prepare' ? 'todo' : i < cur ? 'done' : i === cur ? 'active' : 'todo';
    host.appendChild(el('div', { class: 'pstage', 'data-state': st }, [
      el('span', { class: 'dot' }),
      el('span', { text: STAGE_LABEL[s] || s }),
    ]));
  }
}

function updateProgress(p) {
  const ratio = Number(p.ratio) || 0;
  setText($('#prog-pct'), `${Math.round(ratio * 100)}%`);
  setText($('#prog-stage'), STAGE_LABEL[p.stage] || p.stage || '');
  setRing(ratio);
  if (p.stage) renderStageChips(p.stage);
  const detail = [];
  if (p.totalFrames) detail.push(`帧 ${p.doneFrames || 0}/${p.totalFrames}`);
  if (p.videoTotalSec) detail.push(`视频 ${p.videoSec || 0}s/${p.videoTotalSec}s`);
  if (p.zipTotal) detail.push(`打包 ${p.zipFiles || 0}/${p.zipTotal}`);
  if (p.speed) detail.push(`速度 ${p.speed}`);
  setText($('#prog-detail'), detail.join(' · ') || '—');
}

function finishSuccess(r) {
  state.result = r;
  state.step = 5;
  showView('done');
  renderStepper();
  $('#done-path').textContent = r.output;
  const stats = $('#done-stats');
  stats.innerHTML = '';
  const rows = [
    ['文件大小', fmtBytes(r.size)],
    ['输出格式', r.format === 'video' ? '视频版' : '帧序列'],
    ['打包形态', r.magisk ? 'Magisk 模块' : 'bootanimation.zip'],
  ];
  if (r.format === 'video') {
    if (r.faststart != null) rows.push(['moov 前置', r.faststart ? '是 ✓' : '否']);
  } else {
    rows.push(['总帧数', String(r.frames)], ['分段数', String(r.parts.length)]);
  }
  rows.push(['分辨率', `${r.width}×${r.height}`], ['耗时', `${(r.elapsedMs / 1000).toFixed(1)}s`]);
  for (const [k, v] of rows) {
    stats.appendChild(el('div', { class: 'stat' }, [el('b', { text: v }), el('span', { text: k })]));
  }

  // 刷入指引按输出形态切换
  renderInstallGuide(r);

  const msgs = [...(r.warnings || []).map((t) => ({ kind: 'warn', text: t })), ...(r.notes || []).map((t) => ({ kind: 'note', text: t }))];
  const card = $('#done-msgs-card');
  const host = $('#done-msgs');
  host.innerHTML = '';
  if (r.module) {
    host.appendChild(msgNode('ok', `Magisk 模块 id=${r.module.id}，载荷 ${(r.module.files || []).join('、')} → ${(r.module.targets || []).join('、')}`));
  }
  if (msgs.length) {
    card.hidden = false;
    for (const m of msgs) host.appendChild(msgNode(m.kind, m.text));
  } else if (!r.module) {
    card.hidden = true;
  } else {
    card.hidden = false;
  }

  if (!r.verify?.ok) {
    host.appendChild(msgNode('warn', '产物自检有异常：' + (r.verify?.errors || []).join('；')));
    card.hidden = false;
  }

  $('#btn-reveal').onclick = () => api.reveal(r.output, true).catch(() => toast('打开失败', 'err'));
  $('#btn-again').onclick = () => {
    state.step = 1;
    state.result = null;
    goStep(1);
  };
  toast(`已生成 ${r.outputName}（${fmtBytes(r.size)}）`, 'ok');
}

/** 完成页的刷入指引：按 Magisk / 视频版 / 传统直接替换 分别给步骤，并区分开机/关机 */
function renderInstallGuide(r) {
  const host = $('#install-guide');
  if (!host) return;
  const isShutdown = r.target === 'shutdown';
  const tgtLabel = isShutdown ? '关机动画' : '开机动画';
  const fileName = r.outputName && /\.zip$/.test(r.outputName)
    ? r.outputName
    : (isShutdown ? 'shutdownanimation.zip' : 'bootanimation.zip');
  const relDir = isShutdown ? 'shutdownanimation.zip' : 'bootanimation.zip';
  const steps = [];
  if (r.magisk) {
    steps.push({ b: '直接刷入模块（推荐）', d: `产出的 <span class="mono">${escapeHtml(r.outputName)}</span> 就是 Magisk 模块：打开 Magisk App → 模块 → 从本地安装 → 选中它 → 重启。因为是挂载，卸载模块即可恢复原来的${tgtLabel}。` });
    steps.push({ b: '原来的动画文件也一起生成了', d: `如果更想手动替换，用它也可以：复制到系统媒体目录（目标文件名 <span class="mono">${escapeHtml(relDir)}</span>）、权限设为 rw-r--r--（0644）、重启。` });
  } else {
    steps.push({ b: '有 Root / 已装 Magisk', d: `把 <span class="mono">${escapeHtml(fileName)}</span> 推到 <span class="mono">/system/media/</span>、<span class="mono">/product/media/</span> 或 <span class="mono">/oem/media/</span>，文件名保持 <span class="mono">${escapeHtml(relDir)}</span>，权限设为 <span class="mono">rw-r--r--</span>（0644），重启。用 Magisk 模块最省事，不用改系统分区。` });
    steps.push({ b: '第三方 Recovery（TWRP）', d: '把文件放进手机，在 TWRP 的文件管理器里覆盖到对应的系统媒体目录；或做成卡刷包在 recovery 里刷入。' });
  }
  if (isShutdown) {
    steps.push({ b: '⚠ 关机动画的位置没有统一规范', d: '不同厂商对关机动画的路径与文件名自定义较多（常见是 <span class="mono">/system/media/shutdownanimation.zip</span>）。建议先确认设备上原本有没有这个文件、放在哪，再替换同一路径。部分机型根本不支持自定义关机动画。' });
  } else {
    steps.push({ b: '⚠ 视频版只被部分机型识别', d: 'Android 12+ 的机型才可能使用 <span class="mono">bootanimation.mp4</span>。若替换后看不到动画（黑屏但能进系统），说明你的系统仍读传统格式——回到配置页把「输出格式」改成<b>传统帧序列</b>再做一次即可。' });
  }
  steps.push({ b: '没 Root 怎么办', d: '原生 Android 不允许替换这类系统动画，这条路走不通。可以留作素材用在别的设备上。' });

  host.innerHTML = '';
  steps.forEach((s, i) => {
    host.appendChild(el('div', { class: 'tut-step' }, [
      el('div', { class: 'n', text: String(i + 1) }),
      el('div', {}, [el('b', { text: s.b }), el('p', { html: s.d })]),
    ]));
  });
}

function finishFail(r) {
  state.step = 3;
  showView('export');
  renderStepper();
  const m = r?.error?.message || r?.message || '未知错误';
  toast('转换失败：' + m, 'err', 9000);
  const pf = $('#preflight-msgs');
  if (pf) pf.prepend(msgNode('err', m));
  if (r?.error?.validation?.errors) {
    for (const e of r.error.validation.errors) pf.prepend(msgNode('err', e));
  }
}

/* ================================================================== */
/* 目录选择器                                                          */
/* ================================================================== */

/**
 * 通用路径浏览器：既能选目录（导出目录），也能选视频文件。
 * 之所以必要：浏览器从拖放 / 文件选择框拿不到真实磁盘路径，
 * 所以必须有「按路径浏览」这条可靠通道。
 */
async function openBrowser({ mode = 'dir', title = '选择目录', startDir = '', onPick, note = '' } = {}) {
  let cwd = startDir || '';
  let picked = null;
  const body = el('div');
  const listBox = el('div', { class: 'picker-list' });
  const pathInput = el('input', { class: 'input mono', value: cwd, spellcheck: 'false', placeholder: '直接粘贴路径，例如 E:\\Videos' });
  const status = el('div', { class: 'hint' });
  const pickLabel = el('div', { class: 'hint', style: 'margin-top:6px' });

  const load = async (dir) => {
    status.textContent = '读取中…';
    listBox.innerHTML = '';
    try {
      const r = await api.listDir(dir, mode === 'file');
      cwd = r.cwd || '';
      pathInput.value = cwd;
      if (r.parent) {
        listBox.appendChild(el('button', { class: 'picker-row', onclick: () => load(r.parent) }, [
          el('span', { html: svgIcon(ICON.up, 'icon') }), el('span', { text: '.. 上一级' }),
        ]));
      }
      for (const q of r.quick || []) {
        listBox.appendChild(el('button', { class: 'picker-row', onclick: () => load(q.path) }, [
          el('span', { html: svgIcon(ICON.folder, 'icon') }), el('span', { text: `快捷：${q.name}` }),
        ]));
      }
      for (const d of r.drives || []) {
        listBox.appendChild(el('button', { class: 'picker-row', onclick: () => load(d.path) }, [
          el('span', { html: svgIcon(ICON.folder, 'icon') }), el('span', { text: d.name }),
        ]));
      }
      for (const e of r.entries || []) {
        listBox.appendChild(el('button', { class: 'picker-row', onclick: () => load(e.path) }, [
          el('span', { html: svgIcon(ICON.folder, 'icon') }), el('span', { text: e.name }),
        ]));
      }
      if (mode === 'file') {
        for (const f of r.files || []) {
          listBox.appendChild(el('button', {
            class: 'picker-row', title: f.path,
            onclick: () => { picked = f.path; pathInput.value = f.path; markPicked(); },
          }, [
            el('span', { html: svgIcon(ICON.file, 'icon') }),
            el('span', { text: f.name }),
            el('span', { class: 'tag info', text: ext(f.name).replace('.', '').toUpperCase(), style: 'margin-left:auto' }),
          ]));
        }
      }
      const n = (r.entries || []).length + (mode === 'file' ? (r.files || []).length : 0);
      status.textContent = n ? `共 ${n} 项` : '这个目录里没有可选项';
    } catch (e) {
      status.innerHTML = `<span class="hint err">${escapeHtml(e.message)}</span>`;
    }
  };

  const markPicked = () => {
    pickLabel.innerHTML = picked
      ? `已选择：<span class="mono">${escapeHtml(baseName(picked))}</span>`
      : '';
    $$('.picker-row', listBox).forEach((row) => {
      row.style.background = row.title === picked ? 'var(--md-primary-container)' : '';
    });
  };

  const modal = openModal({
    title,
    body: el('div', {}, [
      note ? el('div', { class: 'tut-note', style: 'margin:0 0 12px', html: mdInline(note) }) : null,
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '当前路径（可直接修改后回车）' }), pathInput]),
      el('div', { class: 'input-row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn tonal small', text: '转到', onclick: () => load(pathInput.value.trim()) }),
        mode === 'dir' ? el('button', {
          class: 'btn text small', text: '新建文件夹', onclick: async () => {
            const name = prompt('新文件夹名称');
            if (!name) return;
            try { await api.mkdir(`${cwd}\\${name}`.replace(/\\\\/g, '\\')); load(cwd); } catch (e) { toast(e.message, 'err'); }
          },
        }) : null,
      ]),
      listBox,
      status,
      pickLabel,
    ]),
    actions: [
      { text: '取消', kind: 'text', close: true },
      {
        text: mode === 'file' ? '载入这个视频' : '使用此目录', kind: 'filled', close: false,
        onclick: async () => {
          const v = picked || (mode === 'file' && VIDEO_EXT.includes(ext(pathInput.value.trim())) ? pathInput.value.trim() : '');
          const target = mode === 'file' ? v : cwd;
          if (!target) { toast(mode === 'file' ? '请选择一个视频文件' : '路径无效', 'err'); return false; }
          const ok = await onPick(target);
          return ok !== false;
        },
      },
    ],
    width: 640,
  });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathInput.value.trim()); });
  await load(cwd);
  return modal;
}

function openDirPicker() {
  return openBrowser({
    mode: 'dir',
    title: '选择输出目录',
    startDir: state.config.outputDir || '',
    onPick: (dir) => {
      state.config.outputDir = dir;
      const input = $('#in-outdir');
      if (input) input.value = dir;
      saveState();
      state.settings = { ...state.settings, outputDir: dir };
      api.saveSettings({ outputDir: dir }).catch(() => {});
    },
  });
}

function openVideoPicker(note) {
  return openBrowser({
    mode: 'file',
    title: '选择视频文件',
    startDir: dirName(state.input) || '',
    note: note || '',
    onPick: async (p) => {
      const ok = await loadVideo(p);
      return ok !== false;
    },
  });
}

/* ================================================================== */
/* 模态框 / 提示气泡 / 教程                                            */
/* ================================================================== */

const modalStack = [];

function openModal({ title, body, actions = [], width }) {
  const host = $('#modal-host');
  const scrim = el('div', { class: 'scrim' });
  const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
  if (width) dialog.style.width = `min(${width}px, 100%)`;

  const close = () => {
    scrim.classList.add('closing');
    setTimeout(() => {
      scrim.remove();
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
    }, 220);
  };

  const head = el('div', { class: 'dialog-head' }, [
    el('h2', { text: title }),
    el('button', {
      class: 'icon-btn', title: '关闭', onclick: close, html: svgIcon(ICON.close),
    }),
  ]);

  const bodyWrap = el('div', { class: 'dialog-body' }, [body]);
  const foot = el('div', { class: 'dialog-foot' });
  for (const a of actions) {
    foot.appendChild(el('button', {
      class: `btn ${a.kind || 'text'}`,
      text: a.text,
      onclick: async () => {
        if (a.onclick) {
          const r = await a.onclick(dialog);
          if (r === false) return;
        }
        if (a.close !== false) close();
      },
    }));
  }

  dialog.appendChild(head);
  dialog.appendChild(bodyWrap);
  if (actions.length) dialog.appendChild(foot);
  scrim.appendChild(dialog);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim && entry.dismissable !== false) close(); });
  host.appendChild(scrim);

  const entry = { close, root: dialog, dismissable: true };
  modalStack.push(entry);
  setTimeout(() => dialog.querySelector('button, input, select')?.focus(), 60);
  return entry;
}

function closeTopModal() {
  const m = modalStack[modalStack.length - 1];
  if (m) { m.close(); return true; }
  return false;
}

function openTutorial(initial = 'intro') {
  const keys = Object.keys(TUTORIAL);
  let active = initial;
  const navHost = el('div', { class: 'tut-nav' });
  const content = el('div');

  const render = () => {
    navHost.innerHTML = '';
    for (const k of keys) {
      navHost.appendChild(el('button', {
        class: 'chip',
        style: active === k ? 'background:var(--md-primary-container);color:var(--md-on-primary-container);border-color:transparent' : '',
        onclick: () => { active = k; render(); },
      }, [el('b', { text: TUTORIAL[k].title })]));
    }
    const t = TUTORIAL[active];
    content.innerHTML = '';
    t.steps.forEach((s, i) => {
      content.appendChild(el('div', { class: 'tut-step' }, [
        el('div', { class: 'n', text: String(i + 1) }),
        el('div', {}, [el('b', { text: s.t }), el('p', { html: mdInline(s.d) })]),
      ]));
    });
    for (const n of t.notes || []) {
      content.appendChild(el('div', { class: `tut-note ${n.type || ''}`, html: `<b>${escapeHtml(n.b)}</b><p>${mdInline(n.body)}</p>` }));
    }
  };
  render();

  openModal({
    title: '使用教程',
    body: el('div', {}, [navHost, content]),
    actions: [
      { text: '知道了', kind: 'filled', close: true },
    ],
    width: 780,
  });
}

/** 极简 markdown：**粗体**、`代码`、换行 */
function mdInline(s) {
  return escapeHtml(String(s))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
    .replace(/\n/g, '<br>');
}

/* ---------------- 帮助气泡 ---------------- */

let tipNode = null;
function showTip(anchor, helpKey) {
  hideTip();
  const h = HELP[helpKey];
  if (!h) return;
  tipNode = el('div', { class: 'tip' }, [
    el('div', { style: 'font-weight:600;margin-bottom:4px', text: h.title }),
    el('div', { html: mdInline(h.body) }),
  ]);
  document.body.appendChild(tipNode);
  const r = anchor.getBoundingClientRect();
  const tw = Math.min(340, Math.max(260, tipNode.offsetWidth));
  tipNode.style.width = tw + 'px';
  let left = r.left + r.width / 2 - tw / 2;
  left = clamp(left, 12, window.innerWidth - tw - 12);
  let top = r.bottom + 10;
  if (top + tipNode.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - tipNode.offsetHeight - 10);
  tipNode.style.left = left + 'px';
  tipNode.style.top = top + 'px';
  requestAnimationFrame(() => tipNode?.classList.add('show'));
}
function hideTip() {
  if (!tipNode) return;
  const n = tipNode;
  tipNode = null;
  n.classList.remove('show');
  setTimeout(() => n.remove(), 200);
}

function bindHelp() {
  document.addEventListener('click', (e) => {
    const h = e.target.closest('.help');
    if (h) { e.stopPropagation(); showTip(h, h.dataset.help); return; }
    hideTip();
  });
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
}

/* ================================================================== */
/* 启动                                                                */
/* ================================================================== */

bindImport();
bindTimeline();
bindTrimSlider();
bindHelp();
init();

/** 给自动化/调试用：放一段展示用的假数据，不依赖真实视频 */
function demoFill() {
  state.info = {
    file: 'E:\\Videos\\demo-miku.mp4', fileName: 'demo-miku.mp4', container: 'mov,mp4,m4a',
    duration: 8.4, size: 18_400_000, bitrate: 17_500_000,
    video: {
      codec: 'h264', profile: 'High', codedWidth: 1920, codedHeight: 1080,
      displayWidth: 1920, displayHeight: 1080, rotation: 0, fps: 30, fpsText: '30/1',
      nbFrames: 252, pixFmt: 'yuv420p', hasAlpha: false, isHdr: false, colorSpace: 'bt709', bitrate: 17_000_000,
    },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, layout: 'stereo', count: 1 },
    streamCount: 2,
  };
  state.playhead = 2.4;
  const c = state.config;
  c.width = 1080; c.height = 2400; c.presetId = 'mi-1080';
  c.fps = 30; c.scaleMode = 'fit'; c.background = '#000000';
  c.quality = 'png-fast'; c.outputName = 'bootanimation.zip';
  c.parts = [
    { dir: 'part0', name: '开场', start: 0.4, end: 2.6, type: 'p', count: 1, pause: 0, fade: 0, background: '', clock: '', audio: false },
    { dir: 'part1', name: '主循环', start: 2.6, end: 7.2, type: 'p', count: 0, pause: 0, fade: 0, background: '', clock: '', audio: false },
  ];
  goStep(2);
  renderConfigure();
  computeValidation();
  renderRail();
}

// 让外部调试方便
window.__baf = {
  state, api,
  actions: {
    goStep, loadVideo, openVideoPicker, openDirPicker, computeValidation,
    renderConfigure, renderExport, runConversion, planParts, demoFill, setFormat,
  },
};
