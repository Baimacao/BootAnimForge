'use strict';
/**
 * desc.js — bootanimation 规格层
 *
 * 依据 AOSP `cmds/bootanimation/FORMAT.md`：
 *   第 1 行： WIDTH HEIGHT FPS [PROGRESS]
 *   可选行 ： 动态取色属性（本项目不生成）
 *   之后每行： TYPE COUNT PAUSE PATH [FADE] [#RRGGBB [CLOCK1 [CLOCK2]]]
 *     TYPE  : p = 开机未完成时循环播放；c = 必须播完；f = 同 p 但被打断时淡出 FADE 帧
 *     COUNT : 播放次数，0 = 一直循环到开机结束
 *     PAUSE : 该段播完后暂停的**帧数**（不是秒）
 *     FADE  : 仅 f 类型，被打断时淡出的帧数
 */

const { int, num, clamp } = require('./util');

const TYPE_CHARS = new Set(['p', 'c', 'f']);
const DIR_RE = /^[A-Za-z0-9._-]+$/;

function hexColor(v, fallback = '') {
  if (!v) return fallback;
  const s = String(v).trim();
  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return fallback;
  return '#' + m[1].toUpperCase();
}

function normClock(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  if (parts.length > 2) return null;
  for (const p of parts) if (!/^(c|-?\d+)$/i.test(p)) return null;
  return parts.join(' ');
}

/** 单段规范化 */
function normalizePart(p, index) {
  const start = Math.max(0, num(p.start, 0));
  const end = Math.max(start + 0.001, num(p.end, start + 1));
  // 关键：用户**没写** type 时不要把默认值 'p' 写进结果。
  // 否则下游（buildDesc）无法区分「用户明确要 p」和「没指定」，
  // 关机动画需要的 c 就永远覆盖不上（踩过：desc 一直是 p）。
  // 未指定时保持 undefined，由消费者按 cfg.partType 或 'p' 兜底。
  const rawType = p.type === undefined || p.type === null ? '' : String(p.type).trim().toLowerCase();
  const type = TYPE_CHARS.has(rawType) ? rawType : undefined;
  const dir = String(p.dir || `part${index}`).trim() || `part${index}`;
  const effType = type || 'p';
  return {
    dir,
    name: String(p.name || `第 ${index + 1} 段`).slice(0, 60),
    start,
    end,
    type,
    typeProvided: type !== undefined,
    count: clamp(int(p.count, 0), 0, 100000),
    pause: clamp(int(p.pause, 0), 0, 100000),
    fade: effType === 'f' ? clamp(int(p.fade, 0), 0, 100000) : 0,
    background: hexColor(p.background, ''),
    clock: normClock(p.clock),
    audio: !!p.audio,
    trim: !!p.trim,
  };
}

/* ------------------------------------------------------------------ */
/* 帧文件命名                                                          */
/* ------------------------------------------------------------------ */

/** 通用写法（Android 官方 bootanimation 生成脚本常见） */
const DEFAULT_PREFIX = 'frame_';

/**
 * 第 seq 张（0 基）的文件名，不含扩展名。
 * 例：prefix='' pad=3 start=0 → "000"；prefix='frame_' pad=5 → "frame_00000"
 */
function frameNameOf(naming, seq) {
  const n = (Number(naming.startNumber) || 0) + (Number(seq) || 0);
  return `${naming.prefix || ''}${String(n).padStart(Number(naming.padWidth) || 5, '0')}`;
}

/**
 * 规范化自定义帧命名。
 *
 * 厂商差异很大：常见的是 `frame_00001.png`，但很多安卓手表（实测一台 480×480 的手表）
 * 直接用纯数字 `001.png`。所以前缀、补零位数、起始编号都必须可配，
 * 而不是把 `frame_%05d` 写死。
 *
 * @param {object} cfg { framePrefix, padWidth, startNumber }
 */
function normalizeNaming(cfg = {}) {
  // 前缀允许为空（纯数字命名）；剔除会造成路径问题的字符
  const prefix = String(cfg.framePrefix ?? DEFAULT_PREFIX).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  const padWidth = clamp(int(cfg.padWidth, 5), 1, 8);
  const startNumber = clamp(int(cfg.startNumber, 0), 0, 10000000);
  const naming = { prefix, padWidth, startNumber };
  return {
    ...naming,
    pattern: `${prefix}%0${padWidth}d`,
    first: frameNameOf(naming, 0),
    sample: `${frameNameOf(naming, 0)}.png`,
  };
}

/**
 * 从文件名里取出「最后一段连续数字」作为帧编号 —— 与 zip.js 的顺序检查同规则。
 * 例：frame_00012.png → 12；001.png → 1；part0_0007.jpg → 7
 */
function frameNumberOf(fileName) {
  const base = String(fileName).replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/(\d+)(?!.*\d)/);
  return m ? int(m[1], 0) : null;
}

/**
 * 生成 desc.txt 文本（CRLF：Android 解析器对行尾不敏感，但 CRLF 最保险）
 * @param {object} cfg  {width,height,fps,progress,parts:[...]}
 */
function buildDesc(cfg) {
  const width = Math.max(1, int(cfg.width, 1080));
  const height = Math.max(1, int(cfg.height, 1920));
  const fps = clamp(int(cfg.fps, 30), 1, 240);
  const header = [width, height, fps];
  if (cfg.progress) header.push(1);

  const lines = [header.join(' ')];
  const rawParts = cfg.parts || [];
  const parts = rawParts.map(normalizePart);
  const cfgType = TYPE_CHARS.has(String(cfg.partType || '').toLowerCase())
    ? String(cfg.partType).toLowerCase() : null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // 关机动画建议用 c（必须播完）：系统关掉前要保证整段放完。
    // normalizePart 只在用户显式写过 type 时才给 p.type，所以这里能可靠区分。
    const type = p.type || cfgType || 'p';
    const fields = [type, p.count, p.pause, p.dir];
    if (type === 'f') fields.push(p.fade);
    if (p.background) fields.push(p.background);
    if (p.clock) fields.push(p.clock);
    lines.push(fields.join(' '));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * 计算某个分段的帧数（与 ffmpeg `-r fps` 的产出对齐）
 */
function frameCount(start, end, fps) {
  const dur = Math.max(0, num(end, 0) - num(start, 0));
  return Math.max(1, Math.round(dur * clamp(int(fps, 30), 1, 240)));
}

/**
 * 生成完整执行计划：每个 part 的目录、帧数、ffmpeg 参数片段
 * @param {object} cfg {width,height,fps,parts,scaleMode,background,keepAlpha,quality,jpegQuality}
 * @param {object} info ffprobe 结果
 */
function buildPlan(cfg, info) {
  const fps = clamp(int(cfg.fps, 30), 1, 240);
  const parts = (cfg.parts || []).map(normalizePart);
  // 帧文件扩展名必须由「图片格式」决定：JPEG 模式产出 .jpg，其余为 .png
  const suffix = String(cfg.quality || 'png') === 'mjpeg' ? '.jpg' : '.png';
  const naming = normalizeNaming(cfg);
  let total = 0;
  const items = parts.map((p, i) => {
    const frames = frameCount(p.start, p.end, fps);
    total += frames;
    return {
      ...p,
      index: i,
      frames,
      pattern: naming.pattern + suffix,
      startNumber: naming.startNumber,
      naming,
    };
  });
  return {
    width: int(cfg.width, 1080),
    height: int(cfg.height, 1920),
    fps,
    parts: items,
    totalFrames: total,
    suffix,
    naming,
  };
}

/**
 * 校验：返回 { errors:[], warnings:[], notes:[] }
 * errors 会阻止转换；warnings 只是提醒
 * @param {object} cfg
 * @param {object} info ffprobe 结果
 * @param {object} [opts] { format: 'classic' | 'video' }
 */
function validate(cfg, info, opts = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const format = opts.format === 'video' ? 'video' : 'classic';

  const width = int(cfg.width, 0);
  const height = int(cfg.height, 0);
  const fps = int(cfg.fps, 0);

  if (width < 2 || height < 2) errors.push('分辨率无效：宽高必须 ≥ 2 像素');
  if (width % 2 || height % 2) {
    const msg = '宽或高是奇数：H.264/JPEG 编码要求偶数，请改成偶数';
    if (format === 'video') errors.push(msg); else warnings.push(msg + '（部分设备的视频格式与 JPEG 也要求偶数）');
  }
  if (format === 'video') {
    if (width > 1920 || height > 1920) {
      warnings.push(`视频版建议不超过 1920×1080：当前 ${width}×${height} 在部分设备上可能无法解码`);
    }
    if (width > 4096 || height > 4096) errors.push('视频版分辨率上限 4096');
    if (cfg.progress) notes.push('视频版格式没有进度条开关，已忽略');
    if (cfg.parts && cfg.parts.length > 1) {
      notes.push('视频版会把多段按顺序拼接成一个连续视频，循环由系统控制（不再有每段的循环次数/暂停）');
    }
  } else {
    if (width > 7680 || height > 7680) errors.push('分辨率过大：单边不得超过 7680 像素');
  }
  if (fps < 1) errors.push('帧率必须 ≥ 1');
  if (fps > 120) warnings.push(`帧率 ${fps} FPS 偏高：多数设备实际刷新率不足以呈现，播放时可能掉帧（推荐 24–60）`);

  const parts = (cfg.parts || []).map(normalizePart);
  if (!parts.length) errors.push('至少需要 1 个动画段');
  if (parts.length > 32) errors.push('动画段过多（上限 32）');

  // 帧命名：补零位数不够时会「撞名」，必须拦住
  if (format === 'classic') {
    const naming = normalizeNaming(cfg);
    const plan = buildPlan(cfg, info);
    const maxNo = naming.startNumber + Math.max(0, plan.totalFrames - 1);
    if (String(maxNo).length > naming.padWidth) {
      errors.push(`帧命名补零位数不够：共 ${plan.totalFrames} 帧，编号最大会到 ${maxNo}（${String(maxNo).length} 位），` +
        `而补零位数设为 ${naming.padWidth} 位，会造成文件名重复。请把补零位数改为 ${String(maxNo).length} 位以上`);
    }
    notes.push(`帧文件命名：${naming.prefix || '（无前缀）'}${'0'.repeat(naming.padWidth)}` +
      ` 起于 ${naming.startNumber}，例如 ${naming.sample}`);
    if (!naming.prefix) {
      notes.push('采用纯数字命名（如 001.png）—— 部分安卓手表用这种写法；通用设备一般用 frame_ 前缀');
    }
  }

  const seen = new Set();
  parts.forEach((p, i) => {
    if (!DIR_RE.test(p.dir)) errors.push(`第 ${i + 1} 段的目录名非法：只允许字母、数字、点、下划线、连字符`);
    if (seen.has(p.dir.toLowerCase())) errors.push(`目录名重复：${p.dir}（每段必须独占一个目录）`);
    seen.add(p.dir.toLowerCase());
    if (p.end <= p.start) errors.push(`第 ${i + 1} 段时长为 0`);
    if (i > 0 && p.start < parts[i - 1].end - 0.01) {
      warnings.push(`第 ${i + 1} 段的起点早于上一段终点，画面会重叠播放`);
    }
    if (p.count > 0 && p.count > 1000) warnings.push(`第 ${i + 1} 段循环 ${p.count} 次，开机时间通常不足以播完`);
    if (p.pause > fps * 5) warnings.push(`第 ${i + 1} 段 PAUSE=${p.pause} 帧（≈${(p.pause / fps).toFixed(1)} 秒），等待时间较长`);
  });

  if (info?.video) {
    const srcW = info.video.displayWidth;
    const srcH = info.video.displayHeight;
    const srcAR = srcW / srcH;
    const dstAR = width / height;
    const diff = Math.abs(srcAR - dstAR) / srcAR;
    if (diff > 0.01 && (cfg.scaleMode || 'fit') === 'fit') {
      notes.push(`画面比例不一致（源 ${srcAR.toFixed(3)} : 目标 ${dstAR.toFixed(3)}），已按等比缩放居中留边处理，**不会拉伸**`);
    }
    if (diff > 0.5) warnings.push('源视频与目标分辨率比例差异很大，留边会比较宽：可考虑改用「填充裁切」或换一个接近源比例的分辨率');
    if (info.video.isHdr) warnings.push('源视频是 HDR：转成 SDR 后会丢失 HDR 效果、颜色可能偏灰，建议先用普通 SDR 片源');
    if (info.video.hasAlpha && format === 'video') notes.push('源视频带透明通道，视频版格式不支持透明，已按不透明处理');
  }

  if (format === 'classic') {
    const plan = buildPlan(cfg, info);
    const frames = plan.totalFrames;
    const boxMB = (width * height * 4) / 1048576;
    notes.push(`共 ${frames} 帧，单帧位图约 ${boxMB.toFixed(1)} MB，最坏情况显存占用约 ${(boxMB * Math.min(frames, 48)).toFixed(0)} MB（系统会按需解码，通常远低于此值）`);
    if (frames > 4000) warnings.push(`总帧数 ${frames} 偏多：文件会很大且开机解包变慢（超过 2000 帧的设备很少能流畅播完）`);
    if (width * height > 1920 * 1080 && fps > 60) warnings.push('高分辨率 + 高帧率：低端设备极易卡顿，建议降到 30 FPS 或 1080p');
    if (plan.parts.length > 1 && plan.parts.every((p) => p.count === 0)) {
      notes.push('所有段都是「无限循环」：后面的段永远不会被播放到，只有第一段会显示');
    }
  } else {
    const dur = parts.reduce((a, p) => a + Math.max(0, p.end - p.start), 0);
    notes.push(`视频时长约 ${dur.toFixed(2)} 秒（H.264 / Main / yuv420p / 无 B 帧，已 faststart 化）`);
    if (dur > 15) warnings.push(`视频版时长 ${dur.toFixed(1)} 秒偏长：解码负担比帧序列小，但开机阶段仍会持续占用资源`);
  }

  return { errors, warnings, notes };
}

/** 生成人类可读的 desc.txt 预览（带注释，仅展示用） */
function describeDesc(cfg) {
  const plan = buildPlan(cfg, null);
  const out = [];
  out.push(`# 第 1 行： 宽 ${plan.width}  高 ${plan.height}  帧率 ${plan.fps}${cfg.progress ? '  进度条=开' : ''}`);
  plan.parts.forEach((p) => {
    const typeText = { p: '可被打断（开机结束就停）', c: '必须播完', f: `被打断时淡出 ${p.fade} 帧` }[p.type];
    const countText = p.count === 0 ? '无限循环' : `播放 ${p.count} 次`;
    out.push(`# ${p.dir}: ${countText}，暂停 ${p.pause} 帧，${typeText}`);
  });
  return out.join('\n');
}

module.exports = {
  buildDesc, buildPlan, validate, normalizePart, frameCount,
  normalizeNaming, frameNameOf, frameNumberOf,
  hexColor, describeDesc, DIR_RE, DEFAULT_PREFIX,
};
