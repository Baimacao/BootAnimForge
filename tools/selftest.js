'use strict';
/**
 * selftest.js — 端到端自检
 *
 * 不依赖外部素材：用 ffmpeg 合成测试片，然后跑完整转换，再校验产物。
 *   node tools/selftest.js            全套
 *   node tools/selftest.js --keep     保留中间产物与输出
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.work', 'selftest');
const OUT = path.join(TMP, 'out');
const ffs = require('../src/ffmpeg');
const convert = require('../src/convert');
const { buildDesc } = require('../src/desc');
const { verifyZip } = require('../src/zip');
const { fmtBytes } = require('../src/util');

const KEEP = process.argv.includes('--keep');
let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { results.push(`\n▶ ${t}`); }

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(err) : reject(new Error(`${path.basename(bin)} 退出码 ${c}\n${err.slice(-1200)}`))));
  });
}

/** 合成一段测试视频：彩色渐变 + 秒表文字 + 音轨 */
async function makeVideo(file, { w, h, dur, fps, rotation = 0, text = 'TEST' }) {
  const { ffmpeg } = ffs.resolveBinaries();
  const args = [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
    '-vf', `drawtext=text='${text} %{eif\\:t\\:d}.%{eif\\:mod(t*10\\,10)\\:d}':fontsize=${Math.round(h / 8)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.6,drawbox=x=0:y=0:w=iw:h=8:color=red@1:t=fill`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(fps),
    '-c:a', 'aac', '-shortest',
  ];
  if (rotation) args.push('-metadata:s:v:0', `rotate=${rotation}`);
  args.push(file);
  await run(ffmpeg, args);
  return file;
}

/** 用 mp4box 给 mp4 写入 display matrix（真正的旋转元数据）
 *  angle: 顺时针旋转角度（写在矩阵里的 a,b 分量即 -sin）
 */
async function applyRotationToMp4(file, angleDeg) {
  const { createFile } = require('mp4box');
  const outPath = file.replace(/\.mp4$/, '-matrix.mp4');
  const buf = await fsp.readFile(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  ab.fileStart = 0;
  const infile = createFile();
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => { if (!done) { done = true; err ? reject(err) : resolve(); } };
    infile.onReady = (vinfo) => {
      try {
        const track = infile.getTrackById(vinfo.tracks[0].id);
        if (typeof track.setMatrix === 'function') {
          track.setMatrix(rotationMatrix(angleDeg));
        } else {
          for (const box of infile.moov.boxes) {
            if (box.type === 'trak') {
              const tkhd = box.boxes.find((b) => b.type === 'tkhd');
              if (tkhd) tkhd.matrix = rotationMatrix(angleDeg);
            }
          }
        }
        // save() 会触发 onSegment 回调，逐个写出分片
        const chunks = [];
        infile.onSegment = (id, _u, data) => chunks.push(Buffer.from(data));
        infile.save();
        setTimeout(async () => {
          try {
            await fsp.writeFile(outPath, Buffer.concat(chunks));
            finish();
          } catch (e) { finish(e); }
        }, 120);
      } catch (e) { finish(e); }
    };
    setTimeout(() => finish(new Error('mp4box 处理超时')), 15000);
    infile.appendBuffer(ab);
    infile.flush();
  });
  return outPath;
}

function rotationMatrix(deg) {
  const a = ((deg % 360) + 360) % 360;
  const r = (a * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 65536);
  const s = Math.round(Math.sin(r) * 65536);
  // tkhd matrix: [a b u; c d v; x y w] —— 顺时针 deg 的 a,b 分量为 cos,-sin
  if (a === 90) return [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824];
  if (a === 180) return [-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824];
  if (a === 270) return [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824];
  return [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
}

/** 从 zip 里取出某一帧，用 ffmpeg 解码后再探测 */
async function extractFrameFromZip(zipPath, entryName, outPng, ffmpeg) {
  const { readZipEntry } = require('../src/zip');
  const data = await readZipEntry(zipPath, entryName);
  if (!data) throw new Error(`zip 内找不到 ${entryName}`);
  const tmp = path.join(TMP, 'frame-src' + path.extname(entryName));
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.rm(tmp, { force: true });
  await fsp.writeFile(tmp, data);
  await fsp.rm(outPng, { force: true });
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', tmp, '-frames:v', '1', outPng]);
  await fsp.rm(tmp, { force: true });
  return outPng;
}

async function main() {
  const { ffmpeg, ffprobe } = ffs.resolveBinaries();
  console.log('BootAnimForge 自检\n');
  if (!ffmpeg || !ffprobe) throw new Error('缺少 ffmpeg/ffprobe，请先运行 node tools/fetch-ffmpeg.js');
  const ver = await ffs.version();
  console.log(`引擎：${ver.version}  (${ffmpeg})\n`);
  await fsp.mkdir(OUT, { recursive: true });

  /* ---------------- 1. 合成素材 ---------------- */
  section('1. 合成测试素材');
  const src16x9 = path.join(TMP, 'src-1280x720-6s.mp4');
  const srcRot = path.join(TMP, 'src-portrait-rot90.mp4');
  const srcAlpha = path.join(TMP, 'src-alpha.mov');
  if (!fs.existsSync(src16x9)) await makeVideo(src16x9, { w: 1280, h: 720, dur: 6, fps: 30, text: 'LANDSCAPE' });
  ok('生成 1280x720 / 6s / 30fps 测试片', fs.existsSync(src16x9));
  if (!fs.existsSync(srcRot)) await makeVideo(srcRot, { w: 1080, h: 1920, dur: 4, fps: 25, text: 'PORTRAIT' });
  ok('生成 1080x1920 竖屏测试片', fs.existsSync(srcRot));
  try {
    if (!fs.existsSync(srcAlpha)) await run(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x480:rate=24:duration=2', '-vf', 'format=rgba,colorchannelmixer=aa=0.5', '-c:v', 'qtrle', srcAlpha]);
    ok('生成带 alpha 通道的测试片 (qtrle)', fs.existsSync(srcAlpha));
  } catch (e) { ok('生成带 alpha 通道的测试片', false, e.message.split('\n')[0]); }

  /* ---------------- 2. 探测 ---------------- */
  section('2. ffprobe 探测');
  const info = await ffs.probe(src16x9);
  ok('识别分辨率', info.video.displayWidth === 1280 && info.video.displayHeight === 720, JSON.stringify([info.video.displayWidth, info.video.displayHeight]));
  ok('识别时长 ≈6s', Math.abs(info.duration - 6) < 0.4, String(info.duration));
  ok('识别帧率 ≈30', Math.abs(info.video.fps - 30) < 0.2, String(info.video.fps));
  ok('识别音轨', !!info.audio, info.audio ? info.audio.codec : 'none');
  // 旋转元数据：真机上就是 rotate 标签 或 display matrix 两种来源。
  // 实测（2026-10-03，用 tkhd 矩阵打补丁验证）：
  //   ffmpeg 的 side_data.rotation = 它自动旋转时应用的角度，90/-90 都产出竖屏，
  //   0/180 保持横屏。故统一换算成顺时针角： clockwise = (360 - v) % 360
  const cases = [
    { name: 'rotate 标签 90°（逆时针 90 = 顺时针 270）', stream: { codec_type: 'video', width: 1920, height: 1080, tags: { rotate: '90' }, avg_frame_rate: '25/1' }, want: { rot: 270, w: 1080, h: 1920 } },
    { name: 'display matrix 90°', stream: { codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: 90 }], avg_frame_rate: '30/1' }, want: { rot: 270, w: 1080, h: 1920 } },
    { name: 'display matrix -90°（顺时针 90）', stream: { codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }], avg_frame_rate: '30/1' }, want: { rot: 90, w: 1080, h: 1920 } },
    { name: 'display matrix 180°', stream: { codec_type: 'video', width: 720, height: 1280, side_data_list: [{ rotation: 180 }], avg_frame_rate: '30/1' }, want: { rot: 180, w: 720, h: 1280 } },
    { name: '无旋转', stream: { codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '60/1' }, want: { rot: 0, w: 1280, h: 720 } },
  ];
  for (const c of cases) {
    const n = ffs.normalizeProbe({ streams: [c.stream], format: { duration: '10', size: '1000' } }, 'x.mp4');
    ok(`旋转解析：${c.name}`, n.video.rotation === c.want.rot && n.video.displayWidth === c.want.w && n.video.displayHeight === c.want.h,
      `rot=${n.video.rotation} ${n.video.displayWidth}x${n.video.displayHeight}`);
  }
  const infoRot = await ffs.probe(srcRot);
  ok('竖屏素材探测正常', infoRot.video.displayHeight > infoRot.video.displayWidth, `${infoRot.video.displayWidth}x${infoRot.video.displayHeight}`);
  const infoAlpha = await ffs.probe(srcAlpha);
  ok('识别 alpha 通道', infoAlpha.video.hasAlpha === true, infoAlpha.video.pixFmt);

  /* ---------------- 3. 滤镜构造（不拉伸） ---------------- */
  section('3. 缩放滤镜：绝不拉伸');
  const fitFilter = ffs.buildScaleFilter({ srcW: 1280, srcH: 720, targetW: 1080, targetH: 1920, mode: 'fit' });
  ok('fit 模式使用等比缩放 + 留边', /force_original_aspect_ratio=decrease/.test(fitFilter) && /pad=/.test(fitFilter), fitFilter);
  ok('fit 模式不含直接 stretch 的 scale=W:H（无 force/aspect 参数）', !/scale=1080:1920:flags/.test(fitFilter));
  const fillFilter = ffs.buildScaleFilter({ srcW: 1280, srcH: 720, targetW: 1080, targetH: 1920, mode: 'fill' });
  ok('fill 模式使用覆盖放大 + 裁切', /force_original_aspect_ratio=increase/.test(fillFilter) && /crop=1080:1920/.test(fillFilter), fillFilter);

  /* ---------------- 4. desc.txt ---------------- */
  section('4. desc.txt 生成');
  const desc = buildDesc({
    width: 1080, height: 1920, fps: 30, progress: true,
    parts: [
      { dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 3 },
      { dir: 'part1', type: 'c', count: 1, pause: 10, start: 3, end: 6, background: '#112233' },
    ],
  });
  const lines = desc.split('\r\n').filter(Boolean);
  ok('首行 = 宽 高 帧率 进度', lines[0] === '1080 1920 30 1', lines[0]);
  ok('分段行格式 p 0 0 part0', lines[1] === 'p 0 0 part0', lines[1]);
  ok('带背景色的 c 段格式', lines[2] === 'c 1 10 part1 #112233', lines[2]);
  ok('以 CRLF 结尾', desc.endsWith('\r\n'));

  /* ---------------- 5. 完整转换：横屏素材 → 竖屏设备（重点验证不拉伸） ---------------- */
  section('5. 端到端转换（1280x720 → 1080x1920，fit 模式）');
  const r1 = await convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-fit.zip',
    width: 1080, height: 1920, fps: 30, progress: false,
    scaleMode: 'fit', background: '#101418', quality: 'png-fast', zipCompress: false,
    parts: [
      { dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 2 },
      { dir: 'part1', type: 'p', count: 3, pause: 15, start: 2, end: 4 },
    ],
  }, { onLog: () => {} });
  ok('产物存在', fs.existsSync(r1.output), r1.output);
  ok('desc.txt 写入 zip', r1.verify.hasDesc);
  ok('zip 结构校验通过', r1.verify.ok, (r1.verify.errors || []).join('；'));
  ok('总帧数 = 30*2 + 30*2 = 120', r1.frames === 120, String(r1.frames));
  ok('条目数 = 1 + 120', r1.entries === 121, String(r1.entries));
  ok('采用 STORE（未压缩）', r1.compressed === false);

  // 关键校验：解出 zip 里第一帧，确认尺寸为目标分辨率且画面被居中留边（不是被拉伸）
  const exDir = path.join(TMP, 'examine');
  await fsp.rm(exDir, { recursive: true, force: true });
  await fsp.mkdir(exDir, { recursive: true });
  try {
    const firstPng = path.join(exDir, 'first.png');
    await extractFrameFromZip(r1.output, 'part0/frame_00000.png', firstPng, ffmpeg);
    const pi = await ffs.probe(firstPng);
    ok('帧尺寸 = 1080x1920', pi.video.codedWidth === 1080 && pi.video.codedHeight === 1920, `${pi.video.codedWidth}x${pi.video.codedHeight}`);
  } catch (e) { ok('从 zip 解出帧', false, e.message.split('\n')[0]); }

  // 用原始像素检测：留边区域应为背景色（#101418），说明是 pad 而非拉伸
  try {
    const framePath = path.join(TMP, 'frame0.png');
    await fsp.rm(framePath, { force: true });
    await extractFrameFromZip(r1.output, 'part0/frame_00000.png', framePath, ffmpeg);
    const probePng = await ffs.probe(framePath);
    console.log(`  · 单帧信息：${probePng.video.codedWidth}x${probePng.video.codedHeight} ${probePng.video.pixFmt}`);
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', framePath,
      '-vf', 'crop=40:40:20:20,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', path.join(exDir, 'corner.raw')]);
    const raw = await fsp.readFile(path.join(exDir, 'corner.raw'));
    const [r, g, b] = [raw[0], raw[1], raw[2]];
    ok('留边区域为背景色 #101418（证明未拉伸而是留边）', Math.abs(r - 16) < 12 && Math.abs(g - 20) < 12 && Math.abs(b - 24) < 12, `rgb(${r},${g},${b})`);
    // 再取画面中心：应当是测试图内容（非背景色），证明视频真的画在了中间
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', framePath,
      '-vf', 'crop=40:40:520:940,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', path.join(exDir, 'center.raw')]);
    const cRaw = await fsp.readFile(path.join(exDir, 'center.raw'));
    const isBg = Math.abs(cRaw[0] - 16) < 12 && Math.abs(cRaw[1] - 20) < 12 && Math.abs(cRaw[2] - 24) < 12;
    ok('画面中心是视频内容而非背景色', !isBg, `rgb(${cRaw[0]},${cRaw[1]},${cRaw[2]})`);
  } catch (e) { ok('留边颜色检测', false, e.message.split('\n').slice(-3).join(' | ')); }

  /* ---------------- 6. 旋转素材 ---------------- */
  section('6. 旋转元数据素材转换');
  const r2 = await convert.run({
    input: srcRot, outputDir: OUT, outputName: 'test-rot.zip',
    width: 1080, height: 1920, fps: 25, scaleMode: 'fit', quality: 'png-fast', zipCompress: false,
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1.5 }],
  }, { onLog: () => {} });
  ok('旋转素材转换成功', fs.existsSync(r2.output));
  ok('旋转素材帧数 = 25*1.5 ≈ 38', Math.abs(r2.frames - 38) <= 1, String(r2.frames));

  /* ---------------- 7. alpha 保真 ---------------- */
  section('7. alpha 通道');
  const r3 = await convert.run({
    input: srcAlpha, outputDir: OUT, outputName: 'test-alpha.zip',
    width: 480, height: 480, fps: 24, scaleMode: 'fit', quality: 'png', keepAlpha: true, zipCompress: false,
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1 }],
  }, { onLog: () => {} });
  ok('alpha 素材转换成功', fs.existsSync(r3.output));
  const exDir2 = path.join(TMP, 'examine2');
  await fsp.mkdir(exDir2, { recursive: true });
  try {
    const aPng = path.join(exDir2, 'a.png');
    await extractFrameFromZip(r3.output, 'part0/frame_00000.png', aPng, ffmpeg);
    const pi = await ffs.probe(aPng);
    ok('alpha 帧保留 alpha 通道', ffs.parseVersion ? /^(rgba|bgra|argb|abgr)/i.test(pi.video.pixFmt) : false, pi.video.pixFmt);
  } catch (e) { ok('alpha 帧检测', false, e.message.split('\n')[0]); }

  /* ---------------- 8. zip 结构自检能力 ---------------- */
  section('8. zip 校验器');
  const v = await verifyZip(r1.output);
  ok('校验器读到 121 条目', v.entries === 121, String(v.entries));
  ok('校验器确认帧序连续', v.order === true);
  const bad = path.join(TMP, 'bad.zip');
  await fsp.writeFile(bad, 'not a zip');
  const vb = await verifyZip(bad);
  ok('损坏 zip 被判定失败', vb.ok === false);

  /* ---------------- 8b. JPEG 输出 ---------------- */
  section('8b. JPEG 帧格式');
  const rJpeg = await convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-jpeg.zip',
    width: 640, height: 360, fps: 10, scaleMode: 'fit', quality: 'mjpeg', jpegQuality: 4, zipCompress: true,
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1 }],
  }, { onLog: () => {} });
  const { readZip } = require('../src/zip');
  const zj = await readZip(rJpeg.output);
  const jpgNames = [...zj.keys()].filter((n) => n.endsWith('.jpg'));
  const pngNames = [...zj.keys()].filter((n) => n.endsWith('.png'));
  ok('JPEG 模式产出 .jpg 帧', jpgNames.length === 10, `jpg=${jpgNames.length} png=${pngNames.length}`);
  ok('JPEG 模式不再产出 .png 帧', pngNames.length === 0, String(pngNames.length));
  ok('JPEG 压缩包体积明显小于 PNG', fs.statSync(rJpeg.output).size < fs.statSync(r1.output).size / 3,
    `${fmtBytes(fs.statSync(rJpeg.output).size)} vs ${fmtBytes(fs.statSync(r1.output).size)}`);
  ok('压缩模式标记正确', rJpeg.compressed === true);
  // 解出一帧确认能正常解码
  try {
    const jf = path.join(TMP, 'jpeg-frame.jpg');
    await extractFrameFromZip(rJpeg.output, jpgNames[0], jf, ffmpeg);
    const pj = await ffs.probe(jf);
    ok('JPEG 帧可正常解码', pj.video.codedWidth === 640 && pj.video.codedHeight === 360, `${pj.video.codedWidth}x${pj.video.codedHeight}`);
  } catch (e) { ok('JPEG 帧可正常解码', false, e.message.split('\n')[0]); }

  /* ---------------- 9. 取消 ---------------- */
  section('9. 任务取消');
  const ctrl = new AbortController();
  const p = convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-cancel.zip',
    width: 1080, height: 1920, fps: 30, scaleMode: 'fit', quality: 'png',
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 6 }],
  }, { signal: ctrl.signal, onLog: () => {} }).then(() => 'done').catch((e) => (e.cancelled ? 'cancelled' : 'error:' + e.message));
  setTimeout(() => ctrl.abort(), 700);
  const cancelResult = await p;
  ok('取消会中断任务', cancelResult === 'cancelled', cancelResult);
  ok('取消后不留下产物', !fs.existsSync(path.join(OUT, 'test-cancel.zip')));

  /* ---------------- 10. 校验器拦截 ---------------- */
  section('10. 参数校验');
  try {
    await convert.run({ input: src16x9, outputDir: OUT, width: 0, height: 0, fps: 0, parts: [] }, { onLog: () => {} });
    ok('非法参数被拦截', false, '未抛错');
  } catch (e) {
    ok('非法参数被拦截', Array.isArray(e.validation?.errors) && e.validation.errors.length > 0, e.message);
  }

  /* ---------------- 11. 视频版格式（Android 12+） ---------------- */
  section('11. Android 12+ 视频版格式');
  const rVid = await convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-video.zip',
    format: 'video',
    width: 1280, height: 720, fps: 30, scaleMode: 'fit',
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0.5, end: 3.5 }],
    audio: true, crf: 23, preset: 'ultrafast',
  }, { onLog: () => {} });
  ok('视频版产物存在', fs.existsSync(rVid.output), rVid.output);
  ok('视频版标记正确', rVid.format === 'video');
  const zv = await readZip(rVid.output);
  const namesV = [...zv.keys()];
  ok('zip 内含 bootanimation.mp4', namesV.includes('bootanimation.mp4'), namesV.join(' | '));
  ok('没有 desc.txt（视频版不需要）', !namesV.includes('desc.txt'));
  ok('含 audio.mp3 音轨', namesV.includes('audio.mp3'), namesV.join(' | '));
  ok('moov 在文件头（faststart 生效）', rVid.faststart === true, String(rVid.faststart));

  // 把 mp4 解出来交给 ffprobe 检查编码参数是否符合开机动画的兼容性要求
  const vpath = path.join(TMP, 'examine3', 'bootanimation.mp4');
  await fsp.mkdir(path.dirname(vpath), { recursive: true });
  await fsp.rm(vpath, { force: true });
  await fsp.writeFile(vpath, zv.get('bootanimation.mp4'));
  const vInfo = await ffs.probe(vpath);
  ok('视频编码为 H.264', vInfo.video.codec === 'h264', vInfo.video.codec);
  ok('profile 为 Main', String(vInfo.video.profile).toLowerCase() === 'main', vInfo.video.profile);
  ok('像素格式 yuv420p', vInfo.video.pixFmt === 'yuv420p', vInfo.video.pixFmt);
  ok('无 B 帧（解码器起播更快）', vInfo.video.hasBFrames === 0, String(vInfo.video.hasBFrames));
  ok('分辨率 = 目标 1280x720', vInfo.video.codedWidth === 1280 && vInfo.video.codedHeight === 720,
    `${vInfo.video.codedWidth}x${vInfo.video.codedHeight}`);
  ok('时长 ≈ 3 秒（区间 0.5→3.5）', Math.abs(vInfo.duration - 3) < 0.35, String(vInfo.duration));
  ok('含音轨', !!vInfo.audio, vInfo.audio ? vInfo.audio.codec : 'none');

  /* ---------------- 12. Magisk 模块 ---------------- */
  section('12. Magisk 模块打包');
  const rMag = await convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-magisk.zip',
    format: 'classic', magisk: true,
    width: 480, height: 480, fps: 10, scaleMode: 'fit', quality: 'png-fast',
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1 }],
    magiskOpts: {
      id: 'bootanimforge_test', name: '测试开机动画', version: '1.2.3',
      author: 'BootAnimForge', description: '自检用模块',
      allPaths: true,
    },
  }, { onLog: () => {} });
  ok('Magisk 模块产物存在', fs.existsSync(rMag.output), rMag.output);
  ok('标记为 Magisk 模块', rMag.magisk === true);
  const zm = await readZip(rMag.output);
  const namesM = [...zm.keys()];
  ok('含 module.prop', namesM.includes('module.prop'));
  ok('含 customize.sh', namesM.includes('customize.sh'));
  ok('含系统载荷 system/media/bootanimation.zip', namesM.includes('system/media/bootanimation.zip'));
  ok('allPaths 时覆盖 /product/media', namesM.includes('system/product/media/bootanimation.zip'));
  ok('含中文说明 README.txt', namesM.includes('README.txt'));
  const propText = zm.get('module.prop').toString('utf8');
  ok('module.prop 含 id', /^id=bootanimforge_test$/m.test(propText), propText.split('\n')[0]);
  ok('module.prop 含 version', /^version=1\.2\.3$/m.test(propText));
  ok('module.prop 含 versionCode（数字）', /^versionCode=\d+$/m.test(propText));
  const custText = zm.get('customize.sh').toString('utf8');
  ok('customize.sh 有 shebang', custText.startsWith('#!/system/bin/sh'));
  ok('customize.sh 设置了权限', /set_perm_recursive/.test(custText) && /chmod 0644/.test(custText));
  ok('模块内的载荷本身是合法 zip', (() => {
    try {
      const inner = zm.get('system/media/bootanimation.zip');
      return inner && inner.length > 0 && inner.slice(0, 2).toString('latin1') === 'PK';
    } catch { return false; }
  })());

  // 模块里的 bootanimation.zip 应当能被自己的校验器读出来
  try {
    const innerPath = path.join(TMP, 'examine4', 'inner.zip');
    await fsp.mkdir(path.dirname(innerPath), { recursive: true });
    await fsp.writeFile(innerPath, zm.get('system/media/bootanimation.zip'));
    const iv = await verifyZip(innerPath);
    ok('模块内载荷通过结构自检', iv.ok && iv.hasDesc, (iv.errors || []).join('；'));
  } catch (e) { ok('模块内载荷通过结构自检', false, e.message.split('\n')[0]); }

  /* ---------------- 13. 视频版 + Magisk 组合 ---------------- */
  section('13. 视频版 Magisk 模块');
  const rVM = await convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-video-magisk.zip',
    format: 'video', magisk: true,
    width: 640, height: 360, fps: 15, scaleMode: 'fit',
    parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1.5 }],
    audio: false, crf: 30, preset: 'ultrafast',
    magiskOpts: { id: 'bootanimforge_vtest', name: '视频版测试', version: '0.9', allPaths: false, pathKey: 'system/media' },
  }, { onLog: () => {} });
  ok('视频版 Magisk 模块生成成功', fs.existsSync(rVM.output));
  const zvm = await readZip(rVM.output);
  const namesVM = [...zvm.keys()];
  ok('模块内是 bootanimation.mp4（而非 desc.txt）',
    namesVM.includes('system/media/bootanimation.mp4') && !namesVM.includes('system/media/bootanimation.zip'),
    namesVM.join(' | '));
  ok('模块只放了一个路径（allPaths=false）', namesVM.filter((n) => n.endsWith('bootanimation.mp4')).length === 1);

  /* ---------------- 14. 自定义帧命名（手表常见写法） ---------------- */
  section('14. 自定义帧文件命名');
  const { normalizeNaming, frameNameOf, frameNumberOf } = require('../src/desc');

  const n1 = normalizeNaming({ framePrefix: '', padWidth: 3, startNumber: 1 });
  ok('纯数字命名：首帧 001', n1.first === '001', n1.first);
  ok('纯数字命名：样例 001.png', n1.sample === '001.png', n1.sample);
  ok('纯数字命名：pattern 为 %03d', n1.pattern === '%03d', n1.pattern);
  ok('frameNameOf 递增到 030', frameNameOf(n1, 29) === '030', frameNameOf(n1, 29));

  const n2 = normalizeNaming({ framePrefix: 'frame_', padWidth: 5, startNumber: 0 });
  ok('默认通用命名 frame_00000', n2.first === 'frame_00000', n2.first);

  const n3 = normalizeNaming({ framePrefix: '', padWidth: 0, startNumber: -5 });
  ok('非法参数被夹到合法范围', n3.padWidth >= 1 && n3.startNumber >= 0, JSON.stringify(n3));

  const n4 = normalizeNaming({ framePrefix: 'img/../x*y\\z', padWidth: 4 });
  ok('前缀里的路径危险字符被剔除', !/[/*\\]/.test(n4.prefix), JSON.stringify(n4.prefix));

  ok('编号解析 001.png → 1', frameNumberOf('001.png') === 1, String(frameNumberOf('001.png')));
  ok('编号解析 frame_00042.png → 42', frameNumberOf('frame_00042.png') === 42, String(frameNumberOf('frame_00042.png')));
  ok('编号解析 part0_0007.jpg → 7', frameNumberOf('part0_0007.jpg') === 7, String(frameNumberOf('part0_0007.jpg')));
  ok('编号解析 audio.wav → null', frameNumberOf('audio.wav') === null, String(frameNumberOf('audio.wav')));

  // 端到端：手表写法（480×480，001.png 起于 1，两段）
  const rWatch = await convert.run({
    input: src16x9, outputDir: OUT, outputName: 'test-watch.zip',
    format: 'classic', width: 480, height: 480, fps: 12, scaleMode: 'fit', quality: 'png-fast',
    framePrefix: '', padWidth: 3, startNumber: 1,
    parts: [
      { dir: 'part0', type: 'p', count: 1, pause: 0, start: 0, end: 1 },
      { dir: 'part1', type: 'p', count: 0, pause: 0, start: 1, end: 2.5 },
    ],
  }, { onLog: () => {} });
  const zw = await readZip(rWatch.output);
  const namesW = [...zw.keys()];
  const p0w = namesW.filter((n) => n.startsWith('part0/') && n.endsWith('.png'));
  const p1w = namesW.filter((n) => n.startsWith('part1/') && n.endsWith('.png'));
  ok('手表写法：part0 首帧 001.png', p0w[0] === 'part0/001.png', p0w[0]);
  ok('手表写法：part0 末帧 012.png（1s × 12fps）', p0w[p0w.length - 1] === 'part0/012.png', p0w[p0w.length - 1]);
  ok('手表写法：part1 首帧同样是 001.png', p1w[0] === 'part1/001.png', p1w[0]);
  ok('手表写法：全程不含 frame_ 前缀', !namesW.some((n) => n.includes('frame_')), namesW.slice(0, 4).join(','));
  ok('手表写法：zip 顺序自检通过', rWatch.verify.ok, (rWatch.verify.errors || []).join('；'));
  ok('手表写法：帧数 12 + 18 = 30', rWatch.frames === 30, String(rWatch.frames));
  const numsW = p0w.map((f) => frameNumberOf(f));
  ok('手表写法：part0 编号严格递增', numsW.every((v, i) => i === 0 || v === numsW[i - 1] + 1), numsW.join(','));

  // 补零位数不足必须被拦下，而不是生成会撞名的坏包
  try {
    await convert.run({
      input: src16x9, outputDir: OUT, outputName: 'test-padfail.zip',
      format: 'classic', width: 320, height: 320, fps: 30, framePrefix: '', padWidth: 1, startNumber: 1,
      parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1 }],
    }, { onLog: () => {} });
    ok('补零位数不足被拦截', false, '未抛错');
  } catch (e) {
    ok('补零位数不足被拦截',
      Array.isArray(e.validation?.errors) && e.validation.errors.some((x) => x.includes('补零')),
      (e.validation?.errors || [e.message]).join('；'));
  }

  /* ---------------- 关机动画 ---------------- */
  section('关机动画（与开机同格式，不同文件名与段类型）');
  {
    const shutReq = {
      input: src16x9, outputDir: OUT, outputName: 'test-shutdown.zip',
      target: 'shutdown',
      format: 'classic', width: 480, height: 480, fps: 15, framePrefix: '', padWidth: 3, startNumber: 1,
      parts: [{ dir: 'part0', count: 0, pause: 0, start: 0, end: 1 }],
    };
    const a = await convert.run(shutReq, { onLog: () => {} });
    ok('关机动画产出成功', a.ok === true);
    ok('结果里带 target=shutdown', a.target === 'shutdown', String(a.target));
    ok('靶标标签正确', a.targetLabel === '关机动画', String(a.targetLabel));

    const z = await readZip(a.output);
    const desc = z.get('desc.txt').toString('utf8');
    ok('desc 用 c（必须播完）而不是 p', /^c\s/m.test(desc), JSON.stringify(desc));
    ok('desc 首行仍是 480 480 15', desc.startsWith('480 480 15'), JSON.stringify(desc));

    // 与开机动画对比：除了段类型，其他应完全一致
    const bootReq = { ...shutReq, target: 'boot', outputName: 'test-bootcmp.zip' };
    const b = await convert.run(bootReq, { onLog: () => {} });
    const zb = await readZip(b.output);
    const descB = zb.get('desc.txt').toString('utf8');
    ok('开机动画仍用 p', /^p\s/m.test(descB), JSON.stringify(descB));
    ok('两者只有段类型不同', desc.replace(/^c/m, 'p') === descB, `${JSON.stringify(desc)} vs ${JSON.stringify(descB)}`);

    // 视频版：文件名应为 shutdownanimation.mp4
    const v = await convert.run({ ...shutReq, format: 'video', outputName: 'test-shutdown-video.zip' },
      { onLog: () => {} });
    const zv = await readZip(v.output);
    ok('视频版产出 shutdownanimation.mp4', [...zv.keys()].some((k) => k.endsWith('shutdownanimation.mp4')),
      [...zv.keys()].join(','));
    ok('视频版不含 bootanimation.mp4', ![...zv.keys()].some((k) => k.endsWith('bootanimation.mp4')));

    // Magisk 模块：id / 名字 / 载荷都应跟着关机走
    const m = await convert.run({ ...shutReq, magisk: true, magiskOpts: {}, outputName: 'test-shutdown-magisk.zip' },
      { onLog: () => {} });
    const zm = await readZip(m.output);
    const prop = zm.get('module.prop').toString('utf8');
    ok('关机模块 id 与开机模块区分开', /id=bootanimforge_shutdownanimation/.test(prop),
      (prop.match(/id=.*/) || [''])[0]);
    ok('关机模块名字是「关机动画」', /name=关机动画/.test(prop), (prop.match(/name=.*/) || [''])[0]);
    ok('模块载荷是 shutdownanimation.zip',
      [...zm.keys()].some((k) => k.endsWith('/shutdownanimation.zip')),
      [...zm.keys()].filter((k) => k.endsWith('.zip')).join(','));
    ok('模块不误带 bootanimation.zip', ![...zm.keys()].some((k) => k.endsWith('/bootanimation.zip')));

    // 用户显式给了段类型时不应被 target 覆盖
    const exp = await convert.run({
      ...shutReq, outputName: 'test-shutdown-explicit.zip',
      parts: [{ dir: 'part0', type: 'p', count: 0, pause: 0, start: 0, end: 1 }],
    }, { onLog: () => {} });
    const ze = await readZip(exp.output);
    ok('用户显式指定段类型时不被覆盖', /^p\s/m.test(ze.get('desc.txt').toString('utf8')),
      JSON.stringify(ze.get('desc.txt').toString('utf8')));

    // 未知 target 应安全回落到开机
    const unk = await convert.run({ ...shutReq, target: 'nonsense', outputName: 'test-unknown-target.zip' },
      { onLog: () => {} });
    ok('未知 target 安全回落为开机动画', unk.target === 'boot', String(unk.target));
  }

  /* ---------------- 汇总 ---------------- */
  console.log(results.join('\n'));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (!KEEP) { /* 保留素材以便复跑 */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n自检异常：', e.stderr || e.message);
  process.exit(2);
});
