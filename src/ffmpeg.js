'use strict';
/**
 * ffmpeg.js — ffmpeg / ffprobe 封装
 *
 * 关键点：
 *  - 自动定位运行时（项目 runtime/ → PATH → 常见安装位置）
 *  - ffprobe 解析（含旋转元数据、可变帧率、HDR/alpha 探测）
 *  - 帧提取参数构造：**永不拉伸**（等比缩放 + 居中留边 或 等比填充裁切）
 *  - 实时进度：解析 `-progress` 输出
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { int, num } = require('./util');

const ROOT = path.resolve(__dirname, '..');

let cached = null;
let verCache = null;

const WIN_EXT = process.platform === 'win32' ? '.exe' : '';

/**
 * 解析 ffmpeg 版本号。版本差异会影响参数名：
 *   ffmpeg ≥ 5.0 用 `-fps_mode cfr`，更早的版本只有 `-vsync cfr`。
 * 例： "ffmpeg version 8.0.1-full_build" → 8.0.1
 *      "ffmpeg version N-92722-gf22fcd4483 Copyright …" → 未知（每日构建）
 */
function parseVersion(text) {
  const s = String(text || '');
  // 每日构建： "ffmpeg version N-92722-gf22fcd4483" —— 这个数字是提交序号，不是版本号。
  // N-92722 属于 FFmpeg 4.1 时代（2018），按 4.x 处理，才能正确选择 -vsync。
  let m = s.match(/ffmpeg version N-(\d+)/i);
  if (m) return { major: 4, minor: 1, patch: 0, text: `N-${m[1]}`, known: true, nbuild: +m[1] };
  m = s.match(/ffmpeg version (\d+)\.(\d+)(?:\.(\d+))?/i);
  if (m) return { major: +m[1], minor: +m[2], patch: +(m[3] || 0), text: m[0], known: true };
  m = s.match(/ffmpeg version n?(\d+)(?![\d-])/i);
  if (m) return { major: +m[1], minor: 0, patch: 0, text: m[0], known: true };
  return { major: 0, minor: 0, patch: 0, text: s.split(/\r?\n/)[0] || '', known: false };
}

/** 取得（并缓存）ffmpeg 版本 */
async function getVersion(force = false) {
  if (verCache && !force) return verCache;
  const { ffmpeg } = resolveBinaries();
  if (!ffmpeg) { verCache = { major: 0, minor: 0, patch: 0, known: false, text: '' }; return verCache; }
  try {
    const { stdout, stderr } = await runProcess(ffmpeg, ['-hide_banner', '-version']);
    verCache = parseVersion((stdout || '') + (stderr || ''));
  } catch {
    verCache = { major: 0, minor: 0, patch: 0, known: false, text: '' };
  }
  return verCache;
}

function firstExisting(list) {
  for (const p of list) {
    if (!p) continue;
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** 定位 ffmpeg / ffprobe，结果缓存 */
function resolveBinaries(force = false) {
  if (cached && !force) return cached;
  const exe = (n) => n + WIN_EXT;
  const dirs = [
    process.env.BOOTANIMFORGE_FFMPEG_DIR,
    path.join(ROOT, 'runtime'),
    path.join(ROOT, 'bin'),
    __dirname,
    'C:\\ffmpeg\\bin',
    'E:\\ffmpeg\\bin',
    'D:\\ffmpeg\\bin',
  ].filter(Boolean);

  let ffmpeg = null, ffprobe = null, source = null;
  for (const d of dirs) {
    const a = firstExisting([path.join(d, exe('ffmpeg')), path.join(d, exe('ffmpeg.exe'))]);
    if (a) {
      ffmpeg = a;
      source = d;
      ffprobe = firstExisting([path.join(d, exe('ffprobe')), path.join(d, exe('ffprobe.exe'))]);
      break;
    }
  }
  if (!ffmpeg) {
    // 退回到 PATH（用 where/which 的轻量替代：直接尝试 spawn 时会失败，这里做探测）
    const paths = (process.env.PATH || '').split(path.delimiter);
    for (const d of paths) {
      const a = firstExisting([path.join(d, exe('ffmpeg')), path.join(d, exe('ffmpeg.exe'))]);
      if (a) {
        ffmpeg = a; source = 'PATH';
        ffprobe = firstExisting([path.join(d, exe('ffprobe')), path.join(d, exe('ffprobe.exe'))]);
        break;
      }
    }
  }
  // ffprobe 缺失时允许用 `ffmpeg -i` 兜底（解析 stderr），此处仅记录
  cached = { ffmpeg, ffprobe, source, runtimeDir: path.join(ROOT, 'runtime') };
  return cached;
}

function runProcess(bin, args, { onStderrLine, onStdoutLine, signal, cwd, env, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('未找到可执行文件'));
    const p = spawn(bin, args, { windowsHide: true, cwd, env: { ...process.env, ...(env || {}) }, signal });
    let stderr = '';
    let stdout = '';
    const stdoutChunks = [];      // raw 模式：保留原始字节
    let tail = '';
    p.stdout.on('data', (d) => {
      if (raw) {
        stdoutChunks.push(d);
      } else {
        const s = d.toString('utf8');
        stdout += s;
        if (onStdoutLine) {
          tail += s;
          const lines = tail.split(/\r?\n/);
          tail = lines.pop();
          for (const l of lines) onStdoutLine(l);
        }
      }
    });
    p.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (onStderrLine) {
        tail += s;
        const lines = tail.split(/\r?\n/);
        tail = lines.pop();
        for (const l of lines) onStderrLine(l);
      }
    });
    p.on('error', (e) => {
      if (signal?.aborted || e?.name === 'AbortError') {
        const err = new Error('已取消');
        err.cancelled = true;
        err.stderr = stderr;
        return reject(err);
      }
      reject(Object.assign(e, { stderr }));
    });
    p.on('close', (code, sig) => {
      if (code === 0) {
        resolve({ stdout: raw ? Buffer.concat(stdoutChunks) : stdout, stderr, code, signal: sig });
      } else if (signal?.aborted) {
        const err = new Error('已取消');
        err.cancelled = true;
        err.stderr = stderr;
        reject(err);
      } else {
        const e = new Error(`ffmpeg 退出码 ${code}${sig ? ` (${sig})` : ''}`);
        e.code = code; e.signal = sig; e.stderr = stderr; e.stdout = raw ? Buffer.concat(stdoutChunks) : stdout;
        reject(e);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* ffprobe                                                             */
/* ------------------------------------------------------------------ */

const PROBE_ARGS = [
  '-hide_banner', '-v', 'error',
  '-show_format', '-show_streams',
  '-show_entries', 'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,duration,bit_rate,color_space,color_transfer,color_primaries,has_b_frames,sample_rate,channels,channel_layout:stream_tags=rotate:stream_side_data=rotation',
  '-of', 'json',
];

/** 解析 "30000/1001" */
function parseRate(s) {
  if (!s) return 0;
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) { const d = Number(m[2]); return d ? Number(m[1]) / d : 0; }
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : 0;
}

/** 判断像素格式是否含 alpha 通道（显式匹配，避免误判 yuv 系列） */
const ALPHA_PIXFMT = /^(rgba|bgra|argb|abgr|yuva\d+p|ya\d+p|pal8|rgba64|bgra64|argb64|abgr64)$/i;
function pixHasAlpha(pixFmt) {
  return ALPHA_PIXFMT.test(String(pixFmt || '').trim());
}

/**
 * 求视频的「显示方向」旋转角度。
 *
 * 统一约定为**顺时针角度**（0/90/180/270），与 Android 相机、UI 的说法一致。
 * 两个来源的原始约定不同，必须分别换算：
 *   - MP4 的 `rotate` 标签：表示解码后需要**逆时针**旋转的角度
 *     （rotate=90 → 顺时针 90° 显示），所以顺时针角 = 360 - 该值。
 *   - ffmpeg 的 display matrix side_data `rotation`：同样按逆时针给出
 *     （-90 表示逆时针 -90° = 顺时针 90°），换算后顺时针角 = (360 - v) % 360。
 * 两种来源换算公式一致，正好可以合并处理。
 */
function streamRotation(st) {
  let raw = null;
  const tag = st?.tags?.rotate;
  if (tag !== undefined && tag !== null && String(tag).trim() !== '') raw = int(tag, 0);
  if (Array.isArray(st?.side_data_list)) {
    for (const sd of st.side_data_list) {
      if (sd && sd.rotation !== undefined && sd.rotation !== null) raw = int(sd.rotation, raw ?? 0);
    }
  }
  if (raw === null) return 0;
  const ccw = ((raw % 360) + 360) % 360;      // 归一化到 [0,360)
  const clockwise = (360 - ccw) % 360;        // 转成顺时针角度
  if (![0, 90, 180, 270].includes(clockwise)) return Math.round(clockwise / 90) * 90 % 360;
  return clockwise;
}

function normalizeProbe(json, filePath) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const videos = streams.filter((s) => s.codec_type === 'video');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const v = videos[0];

  const rotation = v ? streamRotation(v) : 0;
  const codedW = int(v?.width, 0);
  const codedH = int(v?.height, 0);
  const swap = rotation === 90 || rotation === 270;
  const displayWidth = swap ? codedH : codedW;
  const displayHeight = swap ? codedW : codedH;

  const fps = parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate) || 0;
  const duration = num(json?.format?.duration, 0) || num(v?.duration, 0) || 0;
  const nbFrames = int(v?.nb_frames, 0);
  const size = num(json?.format?.size, 0) || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);

  const pixFmt = String(v?.pix_fmt || '');
  const isHdr = ['smpte2084', 'arib-std-b67'].includes(String(v?.color_transfer || ''));
  return {
    file: filePath,
    fileName: path.basename(filePath),
    container: json?.format?.format_name || '',
    duration,
    size,
    bitrate: num(json?.format?.bit_rate, 0),
    video: v ? {
      codec: v.codec_name,
      profile: v.profile || '',
      codedWidth: codedW,
      codedHeight: codedH,
      displayWidth,
      displayHeight,
      rotation,
      fps,
      fpsText: v.avg_frame_rate || v.r_frame_rate || '',
      nbFrames,
      pixFmt,
      hasAlpha: pixHasAlpha(pixFmt),
      hasBFrames: int(v?.has_b_frames, 0),
      isHdr,
      colorSpace: v.color_space || '',
      bitrate: num(v.bit_rate, 0),
    } : null,
    audio: audios.length ? {
      codec: audios[0].codec_name,
      sampleRate: int(audios[0].sample_rate, 0),
      channels: int(audios[0].channels, 0),
      layout: audios[0].channel_layout || '',
      count: audios.length,
    } : null,
    streamCount: streams.length,
    raw: undefined,
  };
}

/** 用 ffprobe 分析媒体文件 */
async function probe(filePath) {
  const { ffprobe, ffmpeg } = resolveBinaries();
  const bin = ffprobe || ffmpeg;
  if (!bin) throw new Error('未找到 ffprobe/ffmpeg，请先运行 tools/fetch-ffmpeg.js');
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
  const args = ffprobe ? PROBE_ARGS : ['-hide_banner', '-i', filePath, '-f', 'null', '-'];
  try {
    const { stdout, stderr } = await runProcess(bin, ffprobe ? [...PROBE_ARGS, filePath] : args);
    if (!ffprobe) throw new Error('缺少 ffprobe，无法解析媒体信息');
    const json = JSON.parse(stdout);
    const info = normalizeProbe(json, filePath);
    if (!info.video) throw new Error('该文件没有视频轨道');
    return info;
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('ffprobe 输出解析失败');
    throw e;
  }
}

/** 版本字符串，例如 "8.0.1-full_build"（同时填充缓存，供参数构造使用） */
async function version() {
  const { ffmpeg } = resolveBinaries();
  if (!ffmpeg) return null;
  const v = await getVersion();
  try {
    const { stderr, stdout } = await runProcess(ffmpeg, ['-hide_banner', '-version']);
    const text = (stdout || '') + (stderr || '');
    return { version: v.text.replace(/^ffmpeg version\s*/i, '') || 'unknown', major: v.major, known: v.known, firstLine: text.split(/\r?\n/)[0] || '', path: ffmpeg };
  } catch {
    return { version: v.text || 'unknown', major: v.major, known: v.known, firstLine: '', path: ffmpeg };
  }
}

/* ------------------------------------------------------------------ */
/* 帧提取                                                              */
/* ------------------------------------------------------------------ */

/**
 * 构造等比缩放滤镜：**绝不拉伸**
 *  - 'fit'  等比缩放至完整可见 + 居中留边（背景色填充）
 *  - 'fill' 等比放大铺满 + 居中裁切（会切掉边缘）
 *  - 'stretch' 直接拉伸（不推荐，仅供高级用户）
 *
 * @param {object} o
 *   o.srcW,o.srcH    源显示尺寸（已考虑旋转）
 *   o.targetW,o.targetH
 *   o.mode           fit | fill | stretch
 *   o.background     '#RRGGBB'，用于 fit 留边；支持 alpha 时用透明
 *   o.keepAlpha      boolean
 */
function buildScaleFilter(o) {
  const tw = Math.max(2, int(o.targetW, 1080));
  const th = Math.max(2, int(o.targetH, 1920));
  const srcW = Math.max(1, int(o.srcW, tw));
  const srcH = Math.max(1, int(o.srcH, th));
  const mode = o.mode || 'fit';

  if (mode === 'stretch') {
    return `scale=${tw}:${th}:flags=lanczos,setsar=1`;
  }

  const scale = mode === 'fill'
    ? { w: `ceil(${tw}*max(iw/(${tw})*(${th})/ih,1))`, h: `ceil(${th}*max((${tw})/iw*ih/(${th}),1))` }
    : null;

  if (mode === 'fill') {
    // 先按覆盖方式放大，再居中裁切
    return [
      `scale=${tw}:${th}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${tw}:${th}`,
      'setsar=1',
    ].join(',');
  }

  // fit：等比缩小到框内，再 pad 居中
  const padColor = o.keepAlpha ? (o.background || '#000000') + '@0' : (o.background || '#000000');
  return [
    `scale=${tw}:${th}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`,
    'setsar=1',
  ].join(',');
}

/**
 * 构造一个分段的取帧参数
 * 注意：异步 —— 内部会确保 ffmpeg 版本已知，以选择 `-fps_mode`（≥5.0）或 `-vsync`（旧版）。
 * @param {object} o
 *   o.input, o.outDir, o.pattern, o.startNumber
 *   o.start, o.duration         秒
 *   o.fps
 *   o.frameCount                预期帧数（用于 -frames:v 兜底）
 *   o.filter                    完整 -vf 链
 *   o.quality                   'png' | 'png-fast' | 'png-max' | 'mjpeg'
 *   o.jpegQuality               2-31
 *   o.keepAlpha
 *   o.overwrite
 */
async function buildFrameArgs(o) {
  const v = await getVersion();
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (o.colorRange) args.push('-color_range', 'pc');
  // 快速定位 + 精确到段
  args.push('-ss', String(Math.max(0, num(o.start, 0)).toFixed(3)));
  if (o.duration > 0) args.push('-t', String(num(o.duration, 0).toFixed(3)));
  args.push('-i', o.input);

  args.push('-an', '-sn', '-dn');
  if (o.threads) args.push('-threads', String(int(o.threads, 0)));
  args.push('-vf', o.filter);
  // 恒定帧率：只有确定是 5.0+ 才用 -fps_mode，否则一律用所有版本都认的 -vsync
  const modern = v.known && v.major >= 5;
  args.push(modern ? '-fps_mode' : '-vsync', 'cfr');
  args.push('-r', String(o.fps));
  if (o.frameCount > 0) args.push('-frames:v', String(Math.ceil(o.frameCount) + 2));
  args.push('-start_number', String(int(o.startNumber, 0)));

  const fmt = o.quality || 'png';
  const out = path.join(o.outDir, o.pattern);
  if (fmt === 'mjpeg') {
    args.push('-c:v', 'mjpeg', '-q:v', String(int(o.jpegQuality, 3)));
    if (o.keepAlpha) args.push('-pix_fmt', 'yuva420p'); else args.push('-pix_fmt', 'yuvj420p');
    args.push('-huffman', 'optimal');
  } else {
    const level = fmt === 'png-fast' ? 1 : fmt === 'png-max' ? 9 : 6;
    args.push('-c:v', 'png', '-compression_level', String(level));
    args.push('-pix_fmt', o.keepAlpha ? 'rgba' : 'rgb24');
  }
  if (o.overwrite === false) args.push('-n');
  args.push('-progress', 'pipe:2');
  args.push(out);
  return args;
}

/** 构造音频提取参数（每个 part 可带 audio.wav） */
function buildAudioArgs(o) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (o.start > 0) args.push('-ss', String(num(o.start, 0).toFixed(3)));
  if (o.duration > 0) args.push('-t', String(num(o.duration, 0).toFixed(3)));
  args.push('-i', o.input, '-vn', '-ac', String(int(o.channels, 2)), '-ar', String(int(o.sampleRate, 44100)));
  args.push('-c:a', 'pcm_s16le', path.join(o.outDir, o.outName || 'audio.wav'));
  return args;
}

/**
 * 执行一次转码，带进度回调
 * @returns {Promise<{stdout:string,stderr:string}>}
 */
async function runFfmpeg(args, { onProgress, signal, onLog } = {}) {
  const { ffmpeg } = resolveBinaries();
  if (!ffmpeg) throw new Error('未找到 ffmpeg');
  let block = {};
  return runProcess(ffmpeg, args, {
    signal,
    onStderrLine: (line) => {
      const i = line.indexOf('=');
      if (i <= 0) { if (onLog) onLog(line); return; }
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === 'progress') {
        if (onProgress) onProgress({ ...block, done: v === 'end' });
        block = {};
      } else {
        block[k] = v;
      }
    },
  });
}

/** 取一张 JPEG 的平均亮度（0-255），用于判断是否几乎全黑 */
async function jpegLuma(dataUrl) {
  const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const { ffmpeg } = resolveBinaries();
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', 'pipe:0',
      '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('close', () => {
      const b = Buffer.concat(chunks);
      if (b.length < 3) return resolve(null);
      resolve(Math.round(0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2]));
    });
    p.on('error', () => resolve(null));
    try { p.stdin.end(buf); } catch { resolve(null); }
  });
}

/** 亮度低于此值就认为「几乎全黑」，换一个时间点再试 */
const BLACK_LUMA = 12;

/**
 * 取一张「有代表性」的预览图。
 *
 * 为什么不能直接取 0 秒：很多视频开头就是黑场或淡入，取 t=0 会得到一张全黑图，
 * 用户看到会以为预览坏了。所以先试 10% 位置，若几乎全黑再依次试其它候选点，
 * 选中亮度最高的一张；全都黑就如实返回（那是素材本身如此，不是故障）。
 *
 * @returns {{data:string, time:number, luma:number|null, allBlack:boolean}}
 */
async function previewThumbnail(o) {
  const dur = Math.max(0, num(o.duration, 0));
  const cands = [];
  const push = (t) => {
    const v = Math.max(0, Math.min(dur > 0 ? dur - 0.05 : 0, Number(t)));
    if (!cands.some((x) => Math.abs(x - v) < 0.05)) cands.push(v);
  };
  push(o.time !== undefined ? o.time : dur * 0.1);
  if (dur > 0) {
    push(0);
    push(dur * 0.25);
    push(dur * 0.5);
    push(dur * 0.75);
    push(dur * 0.9);
  }
  if (!cands.length) cands.push(0);

  let best = null;
  for (const t of cands) {
    try {
      const data = await thumbnail({ input: o.input, time: t, width: o.width });
      const luma = await jpegLuma(data);
      if (best === null || (luma ?? -1) > (best.luma ?? -1)) best = { data, time: t, luma };
      if ((luma ?? 0) >= BLACK_LUMA) break;      // 够亮就不再试
    } catch { /* 该时间点不可用，试下一个 */ }
  }
  if (!best) throw new Error('无法生成预览图');
  return { ...best, allBlack: (best.luma ?? 0) < BLACK_LUMA };
}

/* ------------------------------------------------------------------ */
/* 视频版开机动画（Android 12+：bootanimation.mp4）                     */
/* ------------------------------------------------------------------ */

/**
 * 构造视频版开机动画的编码参数。
 *
 * 兼容性要求（各家 bootanimation 实现的共同点）：
 *   · H.264，yuv420p，无 B 帧（Main profile 即可），很快就能出第一帧
 *   · moov 必须在文件头（+faststart），否则要读完整个文件才能播
 *   · 分辨率一般不超过 1080p
 *
 * 注意：这里**不处理音频**。合并音轨交给单独一遍（buildMuxAudioArgs），
 * 否则多段拼接时 `-map 1:a` 会指向不存在的音频输入而报错。
 *
 * @param {object} o
 *   o.input / o.concatFile、o.out、o.start、o.duration、o.fps、o.filter、o.crf、o.preset
 */
function buildVideoArgs(o) {
  const fps = Math.max(1, Math.min(120, int(o.fps, 30)));
  const args = ['-hide_banner', '-nostdin', '-y'];

  if (o.concatFile) {
    args.push('-f', 'concat', '-safe', '0', '-i', o.concatFile);
  } else {
    if (o.start > 0) args.push('-ss', String(num(o.start, 0).toFixed(3)));
    if (o.duration > 0) args.push('-t', String(num(o.duration, 0).toFixed(3)));
    args.push('-i', o.input);
  }

  args.push('-an', '-sn', '-dn');
  // 必须显式转成 yuv420p：源若是 rgb，x264 会退回 Constrained Baseline（不支持 B 帧、压缩率差）
  args.push('-vf', `${o.filter},format=yuv420p`);
  args.push('-r', String(fps));
  args.push('-c:v', 'libx264');
  args.push('-preset', safePreset(o.preset));
  args.push('-crf', String(int(o.crf, 20)));
  args.push('-profile:v', 'main');
  args.push('-level', '4.0');
  args.push('-bf', '0');                 // 无 B 帧，解码器负担最小
  args.push('-pix_fmt', 'yuv420p');
  args.push('-g', String(Math.max(1, fps)));   // 每秒一个关键帧，便于循环与裁剪
  args.push('-movflags', '+faststart');
  args.push('-f', 'mp4', o.out);
  return args;
}

/** 可用的 x264 preset。注意 ultrafast 会强制 Constrained Baseline，缺少 CABAC，
 *  压缩率明显变差，这里直接把它排除（需要快就用 veryfast）。 */
const X264_PRESETS = ['superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
function safePreset(p) {
  const s = String(p || '').trim().toLowerCase();
  return X264_PRESETS.includes(s) ? s : 'medium';
}

/** 把音轨并进已编码好的视频（视频流直接拷贝，只重编音频） */
function buildMuxAudioArgs(o) {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', o.video, '-i', o.audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', `${int(o.bitrate, 128)}k`, '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart',
    '-f', 'mp4', o.out,
  ];
}

/** 提取音频为 mp3（视频版音频轨 audio.mp3） */
function buildMp3Args(o) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (o.start > 0) args.push('-ss', String(num(o.start, 0).toFixed(3)));
  if (o.duration > 0) args.push('-t', String(num(o.duration, 0).toFixed(3)));
  args.push('-i', o.input, '-vn');
  args.push('-c:a', 'libmp3lame', '-b:a', `${int(o.bitrate, 128)}k`, '-ac', '2', '-ar', '48000');
  args.push(o.out);
  return args;
}

/** 写 concat 清单文件内容（ffmpeg concat demuxer 格式） */
function concatListContent(files) {
  return files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/* ------------------------------------------------------------------ */

/**
 * 生成一张预览缩略图（JPEG，base64 dataURL）
 *
 * 注意：ffmpeg 输出的是二进制，必须用 raw 模式收原始 Buffer。
 * 早先的写法是 `Buffer.from(stdout, 'binary')`，而 stdout 已经按 UTF-8 解码成字符串，
 * 非法字节被替换成 U+FFFD，图片数据就损坏了 —— 表现为 <img> 解码失败、预览一片黑。
 */
async function thumbnail(o) {
  const { ffmpeg } = resolveBinaries();
  if (!ffmpeg) throw new Error('未找到 ffmpeg');
  const tw = Math.max(16, int(o.width, 360));
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
  args.push('-ss', String(Math.max(0, num(o.time, 0)).toFixed(3)));
  args.push('-i', o.input, '-frames:v', '1');
  args.push('-vf', `scale=${tw}:-2:flags=lanczos`);
  args.push('-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1');
  const { stdout } = await runProcess(ffmpeg, args, { raw: true });
  if (!Buffer.isBuffer(stdout) || stdout.length < 128) {
    throw new Error('缩略图为空（该时间点可能超出视频长度）');
  }
  return 'data:image/jpeg;base64,' + stdout.toString('base64');
}

module.exports = {
  resolveBinaries, probe, version, getVersion, parseVersion, runFfmpeg, runProcess,
  buildScaleFilter, buildFrameArgs, buildAudioArgs, thumbnail, previewThumbnail, jpegLuma,
  buildVideoArgs, buildMuxAudioArgs, buildMp3Args, concatListContent,
  safePreset, X264_PRESETS,
  parseRate, streamRotation, normalizeProbe, pixHasAlpha,
};
