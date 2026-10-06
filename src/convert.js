'use strict';
/**
 * convert.js — 转换流水线
 *
 *  模块化格式：传统 PNG 序列（desc.txt + partN/）
 *  视频格式  ：Android 12+（bootanimation.mp4，可选 audio.mp3）
 *  打包形态：纯 bootanimation.zip  或  Magisk 模块 zip（内含前者，可直接刷入）
 *
 * 流程：探测 → 校验 → 生成载荷 → 打包 → 自检
 * 中间产物放 `.work/<jobId>/`，结束后清理。输出只留最终 zip。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ffs = require('./ffmpeg');
const { buildDesc, buildPlan, validate, normalizePart, frameNumberOf } = require('./desc');
const { createZipWriter, verifyZip, readZip } = require('./zip');
const { buildMagiskModule } = require('./pack');
const { uid, ensureDir, rmrf, num, int, fmtBytes } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const WORK_ROOT = path.join(ROOT, '.work');

/** 进度权重（合计 = 1） */
const W = { prepare: 0.02, probe: 0.03, plan: 0.02, frames: 0.80, desc: 0.01, zip: 0.08, verify: 0.04 };
const BASE = {
  prepare: 0,
  probe: W.prepare,
  plan: W.prepare + W.probe,
  frames: W.prepare + W.probe + W.plan,
  desc: W.prepare + W.probe + W.plan + W.frames,
  zip: W.prepare + W.probe + W.plan + W.frames + W.desc,
  verify: W.prepare + W.probe + W.plan + W.frames + W.desc + W.zip,
};

/**
 * 列出目录里的帧文件，按「文件名里最后一段数字」升序排列。
 *
 * 不能用固定正则去匹配某一种命名：帧名可以是 frame_00001.png、001.png（手表常见）、
 * 甚至 part0_1.jpg。这里统一用 frameNumberOf 取编号，与 zip 自检的顺序判定同一套规则。
 */
async function listFrames(dir) {
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return items
    .filter((i) => i.isFile() && /\.(png|jpe?g)$/i.test(i.name) && !/^audio\./i.test(i.name))
    .map((i) => i.name)
    .sort((a, b) => {
      const na = frameNumberOf(a);
      const nb = frameNumberOf(b);
      if (na === null || nb === null) return a.localeCompare(b);
      return na - nb;
    });
}

/* ================================================================== */
/* 载荷 1：传统 PNG 序列                                                */
/* ================================================================== */

async function buildClassicPayload(ctx) {
  const { req, info, cfg, plan, filter, workDir, hooks, checkAbort } = ctx;
  const { onLog } = hooks;

  const staged = [];
  for (const part of plan.parts) {
    checkAbort();

    if (part.frames > 0) {
      const dir = await ensureDir(path.join(workDir, part.dir));
      const args = await ffs.buildFrameArgs({
        input: req.input,
        outDir: dir,
        pattern: part.pattern,
        startNumber: plan.naming.startNumber,
        start: part.start,
        duration: part.end - part.start,
        fps: plan.fps,
        frameCount: part.frames,
        filter,
        quality: req.quality || 'png',
        jpegQuality: req.jpegQuality,
        keepAlpha: !!(req.keepAlpha && info.video.hasAlpha),
      });
      onLog(`[${part.dir}] ffmpeg ${args.slice(args.indexOf('-i') + 2).join(' ')}`);

      await ffs.runFfmpeg(args, {
        signal: ctx.signal,
        onLog: (l) => onLog(`[${part.dir}] ${l}`),
        onProgress: (p) => ctx.reportFrames(part, int(p.frame, 0), p),
      });
      ctx.finishPart(part);
    }

    // 音频（每段可选 audio.wav）
    if (part.audio && req.audio !== false && info.audio) {
      try {
        await ffs.runFfmpeg(ffs.buildAudioArgs({
          input: req.input, start: part.start, duration: part.end - part.start,
          outDir: path.join(workDir, part.dir), outName: 'audio.wav',
          sampleRate: 44100, channels: Math.min(2, info.audio.channels || 2),
        }), { signal: ctx.signal });
        onLog(`[${part.dir}] 已附带 audio.wav`);
      } catch (e) {
        onLog(`[${part.dir}] 音频提取失败（忽略）：${e.message}`);
      }
    }

    // 帧数校正：必须与 desc.txt 声称的时长一致，否则播放节奏会漂
    if (part.frames > 0) {
      const dir = path.join(workDir, part.dir);
      const files = await listFrames(dir);
      if (files.length > part.frames) {
        for (const f of files.slice(part.frames)) await fsp.rm(path.join(dir, f), { force: true });
        onLog(`[${part.dir}] 多出 ${files.length - part.frames} 帧，已裁掉以匹配 desc 时长`);
      } else if (files.length < part.frames) {
        const last = files[files.length - 1];
        if (!last) throw new Error(`第 ${part.index + 1} 段没有生成任何帧（区间可能超出视频长度）`);
        const buf = await fsp.readFile(path.join(dir, last));
        const extn = path.extname(last);
        // 补齐的帧要延续同一套命名规则（前缀 + 补零位数），不能写死 frame_%05d
        const lastNo = frameNumberOf(last) ?? (plan.naming.startNumber + files.length - 1);
        for (let n = 0; n < part.frames - files.length; n++) {
          const name = `${plan.naming.prefix}${String(lastNo + n + 1).padStart(plan.naming.padWidth, '0')}${extn}`;
          await fsp.writeFile(path.join(dir, name), buf);
        }
        onLog(`[${part.dir}] 缺 ${part.frames - files.length} 帧，已用末帧补齐`);
      }
    }
    staged.push(part);
  }

  const descText = buildDesc(cfg);
  await fsp.writeFile(path.join(workDir, 'desc.txt'), descText, 'utf8');
  onLog('desc.txt:\n' + descText.trim().split(/\r?\n/).map((l) => '  ' + l).join('\n'));

  /** 把载荷写进任意 zip writer（供纯 zip 与 Magisk 模块复用） */
  const addTo = async (zip, prefix = '') => {
    let count = prefix ? 0 : 1;
    zip.add(`${prefix}desc.txt`, descText);
    for (const part of staged) {
      const dir = path.join(workDir, part.dir);
      const files = part.frames > 0 ? await listFrames(dir) : [];
      for (const f of files) {
        zip.add(`${prefix}${part.dir}/${f}`, await fsp.readFile(path.join(dir, f)));
        count++;
      }
      const audioPath = path.join(dir, 'audio.wav');
      if (await exists(audioPath)) {
        zip.add(`${prefix}${part.dir}/audio.wav`, await fsp.readFile(audioPath));
        count++;
      }
    }
    return count;
  };

  return {
    kind: 'classic',
    ext: '.zip',
    descText,
    frameCount: plan.totalFrames,
    addTo,
    estimateEntries: 1 + plan.parts.reduce((a, p) => a + p.frames, 0),
  };
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/* ================================================================== */
/* 载荷 2：Android 12+ 视频版                                           */
/* ================================================================== */

async function buildVideoPayload(ctx) {
  const { req, info, plan, filter, workDir, hooks, checkAbort } = ctx;
  const { onLog } = hooks;

  const videoOut = path.join(workDir, 'bootanimation.mp4');
  const audioOut = path.join(workDir, 'audio.mp3');
  const partsCount = plan.parts.length;

  // 进度：整个区间按“秒”折算，视频编码没有帧序号可数，只能按时间估
  const totalSec = plan.parts.reduce((a, p) => a + (p.end - p.start), 0) || 1;
  let doneSec = 0;

  let concatFile = null;
  const segFiles = [];

  if (partsCount > 1) {
    // 多段：分别编码再无损拼接（concat demuxer 直接流拷贝）
    for (const part of plan.parts) {
      checkAbort();
      const seg = path.join(workDir, `seg${part.index}.mp4`);
      segFiles.push(seg);
      const args = ffs.buildVideoArgs({
        input: req.input, out: seg,
        start: part.start, duration: part.end - part.start,
        fps: plan.fps, filter, crf: req.crf, preset: req.preset,
      });
      onLog(`[seg${part.index}] 编码 ${(part.end - part.start).toFixed(2)}s`);
      await ffs.runFfmpeg(args, {
        signal: ctx.signal,
        onLog: (l) => onLog(`[seg${part.index}] ${l}`),
        onProgress: (p) => ctx.reportVideo(doneSec, totalSec, p),
      });
      doneSec += part.end - part.start;
      ctx.reportVideo(doneSec, totalSec);
    }
    concatFile = path.join(workDir, 'concat.txt');
    await fsp.writeFile(concatFile, ffs.concatListContent(segFiles), 'utf8');

    // 拼接 + 重新 faststart 化，保证 moov 在文件头
    const joinArgs = [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c', 'copy', '-movflags', '+faststart',
      '-f', 'mp4', videoOut,
    ];
    onLog(`拼接 ${segFiles.length} 段（流拷贝）`);
    await ffs.runFfmpeg(joinArgs, { signal: ctx.signal, onLog: (l) => onLog('[join] ' + l) });
  } else {
    const part = plan.parts[0];
    const args = ffs.buildVideoArgs({
      input: req.input, out: videoOut,
      start: part.start, duration: part.end - part.start,
      fps: plan.fps, filter, crf: req.crf, preset: req.preset,
    });
    onLog(`[video] ffmpeg ${args.join(' ')}`);
    await ffs.runFfmpeg(args, {
      signal: ctx.signal,
      onLog: (l) => onLog(`[video] ${l}`),
      onProgress: (p) => ctx.reportVideo(doneSec, totalSec, p),
    });
    doneSec = totalSec;
  }

  ctx.reportVideo(totalSec, totalSec);

  // 兼容性保障：确认编码 profile 达标（避免 Constrained Baseline 这类降级）
  const profile = await ensureVideoProfile(videoOut, ctx);
  if (profile) onLog(`编码 profile：${profile}`);

  // 音轨：先单独抽成 mp3（开机动画的独立音轨），再合并进 mp4
  let hasAudio = false;
  if (req.audio !== false && info.audio) {
    checkAbort();
    try {
      await ffs.runFfmpeg(ffs.buildMp3Args({
        input: req.input,
        start: plan.parts[0].start,
        duration: totalSec,
        out: audioOut,
        bitrate: req.audioBitrate || 128,
      }), { signal: ctx.signal });
      hasAudio = true;
      onLog(`已生成 audio.mp3（${fmtBytes((await fsp.stat(audioOut)).size)}）`);

      // 合并音轨（视频流 copy，MP4 里也带上声音）
      const merged = path.join(workDir, 'bootanimation-audio.mp4');
      try {
        await ffs.runFfmpeg(ffs.buildMuxAudioArgs({
          video: videoOut, audio: audioOut, out: merged, bitrate: req.audioBitrate || 128,
        }), { signal: ctx.signal, onLog: (l) => onLog('[mux] ' + l) });
        await fsp.rm(videoOut, { force: true });
        await fsp.rename(merged, videoOut);
        onLog('已把音轨并进 bootanimation.mp4');
      } catch (e) {
        onLog(`合并音轨失败（保留无音轨视频 + 独立 audio.mp3）：${e.message}`);
        await fsp.rm(merged, { force: true });
      }
    } catch (e) {
      onLog(`音轨提取失败（忽略）：${e.message}`);
      hasAudio = false;
    }
  }

  const videoBuf = await fsp.readFile(videoOut);
  const audioBuf = hasAudio ? await fsp.readFile(audioOut) : null;

  const addTo = async (zip, prefix = '') => {
    zip.add(`${prefix}bootanimation.mp4`, videoBuf);
    let n = 1;
    if (audioBuf) { zip.add(`${prefix}audio.mp3`, audioBuf); n++; }
    return n;
  };

  return {
    kind: 'video',
    ext: '.zip',
    frameCount: Math.max(1, Math.round(totalSec * plan.fps)),
    videoBytes: videoBuf.length,
    audioBytes: audioBuf ? audioBuf.length : 0,
    profile,
    addTo,
    estimateEntries: audioBuf ? 2 : 1,
  };
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

/**
 * @param {object} req
 *   input, outputDir, outputName
 *   format        'classic' | 'video'
 *   magisk        true 时输出 Magisk 模块 zip
 *   width,height,fps,progress,parts,scaleMode,background,keepAlpha
 *   quality,jpegQuality,zipCompress,audio,crf,preset,audioBitrate
 *   magiskOpts    { id, name, version, author, description, pathKey, allPaths }
 * @param {object} hooks { signal, onProgress, onLog, onStage }
 */
async function run(req, hooks = {}) {
  const { signal, onProgress = () => {}, onLog = () => {}, onStage = () => {} } = hooks;
  const jobId = req.jobId || uid('j');
  const workDir = path.join(WORK_ROOT, jobId);
  const startedAt = Date.now();
  const format = req.format === 'video' ? 'video' : 'classic';

  const checkAbort = () => {
    if (signal?.aborted) { const e = new Error('已取消'); e.cancelled = true; throw e; }
  };

  let totalFrames = 0;
  let doneFrames = 0;
  let partBase = 0;
  let stage = 'prepare';
  const setStage = (s) => { stage = s; onStage(s); };
  const report = (extra = {}) => {
    let ratio;
    switch (stage) {
      case 'frames': ratio = BASE.frames + W.frames * (totalFrames ? doneFrames / totalFrames : 0); break;
      case 'zip': ratio = BASE.zip + W.zip * (extra.zipRatio || 0); break;
      case 'verify': ratio = BASE.verify; break;
      default: ratio = BASE[stage] ?? 0;
    }
    onProgress({ stage, ratio: Math.min(0.995, ratio), doneFrames, totalFrames, ...extra });
  };
  const reportFrames = (part, f) => {
    doneFrames = partBase + f;
    report({ partIndex: part.index, partFrame: f, partFrames: part.frames });
  };
  const finishPart = (part) => {
    partBase += part.frames;
    doneFrames = partBase;
    report({ partIndex: part.index, partFrames: part.frames });
  };
  /** 视频编码按秒估进度 */
  const reportVideo = (doneSec, totalSec, p = {}) => {
    const frac = totalSec ? Math.min(1, doneSec / totalSec) : 0;
    totalFrames = 0;
    onProgress({
      stage: 'frames', ratio: Math.min(0.995, BASE.frames + W.frames * frac),
      videoSec: Math.round(doneSec * 10) / 10, videoTotalSec: Math.round(totalSec * 10) / 10,
      speed: p.speed, fps: p.fps,
    });
  };

  try {
    await ensureDir(workDir);
    onLog(`工作目录：${workDir}`);
    onLog(`输出形态：${format === 'video' ? 'Android 12+ 视频版（bootanimation.mp4）' : '传统帧序列（desc.txt + partN）'}` +
      (req.magisk ? ' + Magisk 模块' : ''));

    /* ---------- 1. 探测 ---------- */
    setStage('probe');
    report();
    await fsp.access(req.input);
    const fver = await ffs.getVersion();
    onLog(`引擎版本：${fver.text || '未知'}${fver.known ? '' : '（每日构建，按旧版参数处理）'}`);
    const info = await ffs.probe(req.input);
    onLog(`源：${info.fileName} ${info.video.displayWidth}x${info.video.displayHeight} ` +
      `${info.video.fps.toFixed(3)}fps ${info.duration.toFixed(2)}s 旋转${info.video.rotation}°`);

    /* ---------- 2. 计划与校验 ---------- */
    setStage('plan');
    const cfg = {
      width: int(req.width, 1080),
      height: int(req.height, 1920),
      fps: int(req.fps, 30),
      progress: !!req.progress,
      quality: req.quality || 'png',
      // 帧命名（厂商差异大：frame_00001.png / 001.png / …）
      framePrefix: req.framePrefix,
      padWidth: req.padWidth,
      startNumber: req.startNumber,
      parts: (req.parts || []).map(normalizePart),
    };
    const check = validate(cfg, info, { format });
    if (check.errors.length) {
      const e = new Error(check.errors.join('；'));
      e.validation = check;
      throw e;
    }

    const plan = buildPlan(cfg, info);
    totalFrames = format === 'video' ? 0 : plan.totalFrames;
    onLog(`计划：${plan.parts.length} 段 / ${plan.width}x${plan.height} @${plan.fps}fps` +
      (format === 'video' ? '' : ` / 共 ${plan.totalFrames} 帧`));

    const filter = ffs.buildScaleFilter({
      srcW: info.video.displayWidth,
      srcH: info.video.displayHeight,
      targetW: plan.width,
      targetH: plan.height,
      mode: req.scaleMode || 'fit',
      background: req.background || '#000000',
      keepAlpha: false,   // 视频格式编码 yuv420p，不支持 alpha
    });
    onLog(`缩放滤镜：${filter}`);

    /* ---------- 3. 生成载荷 ---------- */
    setStage('frames');
    const ctx = {
      req, info, cfg, plan, filter, workDir, hooks,
      signal, checkAbort, report, reportFrames, finishPart, reportVideo,
    };
    const payload = format === 'video' ? await buildVideoPayload(ctx) : await buildClassicPayload(ctx);

    /* ---------- 4. 打包 ---------- */
    checkAbort();
    setStage('zip');
    const outputDir = req.outputDir && fs.existsSync(req.outputDir) ? req.outputDir : path.join(ROOT, 'output');
    await ensureDir(outputDir);
    const rawName = (req.outputName || '').trim() || (req.magisk ? 'bootanimation-magisk.zip' : 'bootanimation.zip');
    const safeOut = rawName.replace(/[\\/:*?"<>|]/g, '_');
    const outFile = path.join(outputDir, safeOut.endsWith('.zip') ? safeOut : safeOut + '.zip');
    if (fs.existsSync(outFile)) {
      try { await fsp.rm(outFile, { force: true }); } catch { /* ignore */ }
    }

    let result;
    if (req.magisk) {
      // 载荷文件：传统格式是 bootanimation.zip；视频格式是 bootanimation.mp4(+audio.mp3)
      const payloadFiles = [];
      if (payload.kind === 'classic') {
        const payloadZip = path.join(workDir, 'payload-bootanimation.zip');
        const pz = createZipWriter({ file: payloadZip, compress: !!req.zipCompress });
        const pEntries = await payload.addTo(pz, '');
        const pStat = pz.finish();
        onLog(`载荷 bootanimation.zip：${pEntries} 个条目 / ${fmtBytes(pStat.bytes)}`);
        payloadFiles.push({ name: 'bootanimation.zip', buffer: await fsp.readFile(payloadZip) });
      } else {
        const videoPath = path.join(workDir, 'bootanimation.mp4');
        const audioPath = path.join(workDir, 'audio.mp3');
        payloadFiles.push({ name: 'bootanimation.mp4', buffer: await fsp.readFile(videoPath) });
        if (payload.audioBytes) payloadFiles.push({ name: 'audio.mp3', buffer: await fsp.readFile(audioPath) });
        onLog(`载荷：bootanimation.mp4 ${fmtBytes(payload.videoBytes)}` + (payload.audioBytes ? ` + audio.mp3 ${fmtBytes(payload.audioBytes)}` : ''));
      }

      const mo = req.magiskOpts || {};
      const mod = await buildMagiskModule({
        outFile,
        files: payloadFiles,
        kind: payload.kind,
        id: mo.id,
        name: mo.name,
        version: mo.version,
        versionCode: mo.versionCode,
        author: mo.author,
        description: mo.description,
        pathKey: mo.pathKey,
        allPaths: mo.allPaths !== false,
        withReadme: mo.withReadme !== false,
      });
      onLog(`Magisk 模块：id=${mod.id}，载荷 ${mod.files.join('、')}，系统路径：${mod.targets.join('、')}`);
      result = {
        magisk: true,
        module: { id: mod.id, files: mod.files, targets: mod.targets.map((t) => '/' + t.replace(/^system\//, '')), bytes: mod.bytes },
        payloadEntries: payloadFiles.length,
      };
    } else {
      const zip = createZipWriter({ file: outFile, compress: !!req.zipCompress });
      const entries = await payload.addTo(zip, '');
      const stat = zip.finish();
      report({ zipRatio: 1 });
      onLog(`打包完成：${stat.entries} 个条目 / ${fmtBytes(stat.bytes)}${req.zipCompress ? '' : '（未压缩 STORE）'}`);
      result = { magisk: false, payloadEntries: entries };
    }

    /* ---------- 5. 自检 ---------- */
    checkAbort();
    setStage('verify');
    report();
    // 必需条目随产物类型不同：Magisk 模块里没有 desc.txt
    const requireList = req.magisk
      ? ['module.prop', 'customize.sh']
      : (payload.kind === 'classic' ? ['desc.txt'] : ['bootanimation.mp4']);
    const verify = await verifyZip(outFile, { require: requireList });
    if (!verify.ok) onLog('自检警告：' + verify.errors.join('；'));
    else onLog(`自检通过：${verify.entries} 个条目，必需文件齐全（${requireList.join('、')}）`);

    // 视频格式：确认 moov 在文件头（否则开机要读完整文件才能出画面）
    let faststart = null;
    if (format === 'video') {
      try {
        const inner = await readZip(outFile);
        const key = [...inner.keys()].find((k) => k.endsWith('bootanimation.mp4'));
        if (key) faststart = moovIsFirst(inner.get(key));
        onLog(`moov 位置检查：${faststart === true ? '在文件头 ✓' : faststart === false ? '在文件尾 ✗（可能影响起播）' : '无法判断'}`);
      } catch (e) {
        onLog('moov 检查失败：' + e.message);
      }
    }

    /* ---------- 6. 清理 ---------- */
    if (!req.keepWork) {
      setStage('cleanup');
      await rmrf(workDir);
    }

    const stat = await fsp.stat(outFile);
    return {
      ok: true,
      jobId,
      format,
      magisk: !!result.magisk,
      module: result.module || null,
      output: outFile,
      outputName: path.basename(outFile),
      outputDir,
      size: stat.size,
      entries: verify.entries,
      payloadEntries: result.payloadEntries,
      frames: payload.frameCount || 0,
      parts: plan.parts.map((p) => ({
        dir: p.dir, frames: p.frames, count: p.count, pause: p.pause, type: p.type, start: p.start, end: p.end,
      })),
      desc: payload.descText || null,
      width: plan.width, height: plan.height, fps: plan.fps,
      compressed: !!req.zipCompress,
      faststart,
      verify,
      elapsedMs: Date.now() - startedAt,
      warnings: check.warnings,
      notes: check.notes,
    };
  } catch (e) {
    if (!e.cancelled && !req.keepWork) await rmrf(workDir).catch(() => {});
    e.jobId = jobId;
    throw e;
  }
}

/** 判断 mp4 里 moov 是否在 mdat 之前（faststart） */
function moovIsFirst(buf) {
  const scan = buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024));
  const s = scan.toString('latin1');
  const moov = s.indexOf('moov');
  const mdat = s.indexOf('mdat');
  if (moov < 0) return null;
  if (mdat < 0) return true;
  return moov < mdat;
}

/**
 * 视频版兼容性保障：若编码出的 profile 不是 Main/Baseline 以上（例如被 preset 降级成
 * Constrained Baseline），用安全 preset 重编一遍。宁可多花几秒，也不交付兼容性可疑的文件。
 */
async function ensureVideoProfile(videoPath, ctx) {
  const { onLog, signal } = ctx;
  let info;
  try { info = await ffs.probe(videoPath); } catch { return null; }
  const profile = String(info.video.profile || '');
  if (/^(main|high|baseline)$/i.test(profile.trim())) return profile;
  onLog(`编码结果是 ${profile || '未知 profile'}，兼容性不足，改用 medium preset 重编…`);
  const tmp = `${videoPath}.fix.mp4`;
  await ffs.runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', videoPath,
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'main', '-level', '4.0',
    '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'copy', tmp,
  ], { signal, onLog: (l) => onLog('[fix] ' + l) });
  await fsp.rm(videoPath, { force: true });
  await fsp.rename(tmp, videoPath);
  const again = await ffs.probe(videoPath);
  return again.video.profile;
}

/** 只做分析：不转换，用于 UI 实时校验 */
async function analyze(req) {
  const info = await ffs.probe(req.input);
  const cfg = {
    width: int(req.width, Math.max(2, info.video.displayWidth)),
    height: int(req.height, Math.max(2, info.video.displayHeight)),
    fps: int(req.fps, Math.round(info.video.fps) || 30),
    progress: !!req.progress,
    quality: req.quality || 'png',
    framePrefix: req.framePrefix,
    padWidth: req.padWidth,
    startNumber: req.startNumber,
    parts: (req.parts || []).map(normalizePart),
  };
  const check = validate(cfg, info, { format: req.format });
  return { info, ...check };
}

module.exports = { run, analyze, WORK_ROOT, moovIsFirst };
