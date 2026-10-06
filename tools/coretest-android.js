'use strict';
/**
 * coretest-android.js — 在 PC 上直接执行安卓端的核心解析逻辑
 *
 * 背景：本机没有 adb、也没有真机，界面与 root 流程无法冒烟。但
 * `android/src/.../BootCore.java` 是纯 JDK 代码（只用 java.util.zip），
 * 可以原样拿到 PC 上编译运行 —— 于是「格式识别对不对」这件事是**真跑出来的**，
 * 而不是靠看代码猜。
 *
 * 用法：node tools/coretest-android.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'android', 'src', 'com', 'baimacao', 'bootanimforge', 'BootCore.java');
const WORK = path.join(ROOT, '.work', 'android-coretest');
const JAVA_HOME = process.env.JAVA_HOME || 'E:\\Program Files\\Java\\jdk-21.0.10';

let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; lines.push('  ✓ ' + name); }
  else { fail++; lines.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { lines.push('\n▶ ' + t); }

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}\n${err}\n${out}`))));
  });
}

/** 造一个测试用 zip（目录条目 + 文件） */
function makeZip(file, entries) {
  const { createZipWriter } = require('../src/zip.js');
  const z = createZipWriter({ file, compress: false });
  for (const [name, content] of entries) z.add(name, content);
  z.finish();
}

(async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });

  /* ---------- 编译 BootCore + 测试入口 ---------- */
  const testJava = path.join(WORK, 'CoreTest.java');
  await fsp.writeFile(testJava, `
import com.baimacao.bootanimforge.BootCore;
import java.io.File;

public class CoreTest {
    public static void main(String[] args) throws Exception {
        for (String a : args) {
            File f = new File(a);
            BootCore.Report r = BootCore.validate(f);
            System.out.println("FILE\\t" + a);
            System.out.println("KIND\\t" + r.kind);
            System.out.println("VALID\\t" + r.valid);
            System.out.println("SIZE\\t" + r.width + "x" + r.height);
            System.out.println("FPS\\t" + r.fps);
            System.out.println("FRAMES\\t" + r.totalFrames);
            System.out.println("MOOVFIRST\\t" + r.moovFirst);
            for (BootCore.FrameInfo p : r.parts) {
                System.out.println("PART\\t" + p.dir + "\\t" + p.count + "\\t" + p.range() + "\\t" + p.numbered);
            }
            for (String e : r.errors) System.out.println("ERR\\t" + e);
            for (String w : r.warnings) System.out.println("WARN\\t" + w);
            for (String n : r.notes) System.out.println("NOTE\\t" + n);
            System.out.println("END");
        }
    }
}
`, 'utf8');

  const classes = path.join(WORK, 'classes');
  await fsp.mkdir(classes, { recursive: true });
  await run(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-d', classes, SRC, testJava], WORK);
  console.log('已编译 BootCore（PC 上直接跑安卓端解析逻辑）\n');

  /* ---------- 造测试样本 ---------- */
  section('1. 准备测试样本');

  // ① 手表风格：纯数字 001.png，两段（正是用户给的样本结构）
  const watchLike = path.join(WORK, 'watch-like.zip');
  {
    const e = [['desc.txt', '480 480 60\r\np 1 0 part0 \r\np 0 0 part1 \r\n']];
    for (let i = 1; i <= 12; i++) e.push([`part0/${String(i).padStart(3, '0')}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, i])]);
    for (let i = 1; i <= 8; i++) e.push([`part1/${String(i).padStart(3, '0')}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, i])]);
    makeZip(watchLike, e);
  }

  // ② 通用风格：frame_00000.png
  const generic = path.join(WORK, 'generic.zip');
  {
    const e = [['desc.txt', '1080 1920 30\r\np 0 0 part0\r\n']];
    for (let i = 0; i < 20; i++) e.push([`part0/frame_${String(i).padStart(5, '0')}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, i])]);
    makeZip(generic, e);
  }

  // ③ 编号不连续（应告警）
  const gap = path.join(WORK, 'gap.zip');
  {
    const e = [['desc.txt', '480 480 30\r\np 0 0 part0\r\n']];
    for (const i of [1, 2, 3, 7, 8]) e.push([`part0/${String(i).padStart(3, '0')}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, i])]);
    makeZip(gap, e);
  }

  // ④ desc.txt 引用了不存在的目录（应报错）
  const missingDir = path.join(WORK, 'missing-dir.zip');
  makeZip(missingDir, [['desc.txt', '480 480 30\r\np 0 0 part0\r\np 0 0 part9\r\n'], ['part0/001.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])]]);

  // ⑤ 多套一层目录（应报错并给出原因）
  const nested = path.join(WORK, 'nested.zip');
  makeZip(nested, [['anim/desc.txt', '480 480 30\r\np 0 0 part0\r\n'], ['anim/part0/001.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])]]);

  // ⑥ 根本不是 zip
  const notZip = path.join(WORK, 'notzip.zip');
  fs.writeFileSync(notZip, Buffer.alloc(2048, 0x41));

  // ⑦ desc.txt 首行非法
  const badHeader = path.join(WORK, 'bad-header.zip');
  makeZip(badHeader, [['desc.txt', 'not a valid header\np 0 0 part0\n'], ['part0/001.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])]]);

  // ⑧ 视频版：moov 在前
  const videoGood = path.join(WORK, 'video-good.zip');
  {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(8),
      Buffer.from([0, 0, 0, 8]), Buffer.from('moov'),
      Buffer.from([0, 0, 0, 64]), Buffer.from('mdat'), Buffer.alloc(56),
    ]);
    makeZip(videoGood, [['bootanimation.mp4', mp4], ['audio.mp3', Buffer.alloc(4096, 3)]]);
  }

  // ⑨ 视频版：moov 在后（应告警）
  const videoBad = path.join(WORK, 'video-bad.zip');
  {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(8),
      Buffer.from([0, 0, 0, 64]), Buffer.from('mdat'), Buffer.alloc(56),
      Buffer.from([0, 0, 0, 8]), Buffer.from('moov'),
    ]);
    makeZip(videoBad, [['bootanimation.mp4', mp4]]);
  }

  // ⑩ 用 PC 端真实产出的包（如果存在）
  const pcPackages = [];
  for (const p of [
    path.join(ROOT, '.work', 'selftest', 'out', 'test-watch.zip'),
    path.join(ROOT, '.work', 'selftest', 'out', 'test-video.zip'),
    path.join(ROOT, 'output', 'ui-watch.zip'),
  ]) {
    if (fs.existsSync(p)) pcPackages.push(p);
  }
  if (fs.existsSync('E:\\bootanimation.zip')) pcPackages.push('E:\\bootanimation.zip');

  console.log(`  样本：手写 9 个 + PC 端产物 ${pcPackages.length} 个`);

  /* ---------- 运行 ---------- */
  const all = [watchLike, generic, gap, missingDir, nested, notZip, badHeader, videoGood, videoBad, ...pcPackages];
  // 必须显式指定 stdout 编码：Java 默认按平台编码（中文系统是 GBK）输出，
  // 而 Node 按 UTF-8 解码，中文与「–」会被解成乱码，导致字符串断言假失败。
  const res = await run(path.join(JAVA_HOME, 'bin', 'java.exe'), [
    '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    '-cp', classes, 'CoreTest', ...all,
  ], WORK);

  const parsed = new Map();
  let cur = null;
  for (const line of res.out.split(/\r?\n/)) {
    const [k, ...rest] = line.split('\t');
    if (k === 'FILE') { cur = { file: rest[0], parts: [], errors: [], warnings: [], notes: [] }; parsed.set(rest[0], cur); continue; }
    if (!cur) continue;
    if (k === 'KIND') cur.kind = Number(rest[0]);
    else if (k === 'VALID') cur.valid = rest[0] === 'true';
    else if (k === 'SIZE') cur.size = rest[0];
    else if (k === 'FPS') cur.fps = Number(rest[0]);
    else if (k === 'FRAMES') cur.frames = Number(rest[0]);
    else if (k === 'MOOVFIRST') cur.moovFirst = rest[0] === 'true';
    else if (k === 'PART') cur.parts.push({ dir: rest[0], count: Number(rest[1]), range: rest[2], numbered: rest[3] === 'true' });
    else if (k === 'ERR') cur.errors.push(rest[0]);
    else if (k === 'WARN') cur.warnings.push(rest[0]);
    else if (k === 'NOTE') cur.notes.push(rest[0]);
  }

  const get = (f) => parsed.get(f);

  section('2. 手表风格样本（纯数字 001.png，两段）');
  {
    const r = get(watchLike);
    ok('识别为传统帧序列版', r && r.kind === 1);
    ok('判定为合法', r && r.valid);
    ok('解析出分辨率 480×480', r && r.size === '480x480', r && r.size);
    ok('解析出帧率 60', r && r.fps === 60, String(r && r.fps));
    ok('两段都识别到', r && r.parts.length === 2, String(r && r.parts.length));
    ok('part0 帧数 12、编号 1–12', r && r.parts[0] && r.parts[0].count === 12 && r.parts[0].range === '1–12',
      r && r.parts[0] ? JSON.stringify(r.parts[0]) : '');
    ok('纯数字文件名被认作「有编号」', r && r.parts[0] && r.parts[0].numbered === true);
    ok('总帧数 20', r && r.frames === 20, String(r && r.frames));
  }

  section('3. 通用风格样本（frame_00000.png）');
  {
    const r = get(generic);
    ok('识别为传统帧序列版且合法', r && r.kind === 1 && r.valid);
    ok('编号 0–19 连续', r && r.parts[0] && r.parts[0].range === '0–19', r && r.parts[0] && r.parts[0].range);
  }

  section('4. 应当告警的情况');
  {
    const r = get(gap);
    ok('编号不连续能识别出来', r && r.warnings.some((w) => w.includes('不连续')), (r && r.warnings.join(' | ')) || '');
    ok('不连续不算致命错误（仍可安装）', r && r.valid);
  }

  section('5. 应当拒绝的情况');
  {
    const r1 = get(missingDir);
    ok('desc.txt 引用不存在的目录 → 报错', r1 && !r1.valid && r1.errors.some((e) => e.includes('part9')),
      (r1 && r1.errors.join(' | ')) || '');
    const r2 = get(nested);
    ok('多套一层目录 → 报错', r2 && !r2.valid);
    ok('并给出「多套一层」的原因', r2 && r2.errors.some((e) => e.includes('多套了一层')),
      (r2 && r2.errors.join(' | ')) || '');
    const r3 = get(notZip);
    ok('非 zip 文件 → 报错', r3 && !r3.valid, (r3 && r3.errors.join(' | ')) || '');
    const r4 = get(badHeader);
    ok('desc.txt 首行非法 → 报错', r4 && !r4.valid && r4.errors.some((e) => e.includes('宽 高 帧率')),
      (r4 && r4.errors.join(' | ')) || '');
  }

  section('6. 视频版（Android 12+）');
  {
    const r1 = get(videoGood);
    ok('识别为视频版', r1 && r1.kind === 2, String(r1 && r1.kind));
    ok('moov 在前 → 判定通过且无告警', r1 && r1.valid && r1.moovFirst === true && !r1.warnings.some((w) => w.includes('moov')),
      (r1 && r1.warnings.join(' | ')) || '');
    const r2 = get(videoBad);
    ok('moov 在后 → 给出告警', r2 && r2.warnings.some((w) => w.includes('moov 不在文件头')),
      (r2 && r2.warnings.join(' | ')) || '');
  }

  section('7. PC 端真实产物（跨端一致性）');
  if (!pcPackages.length) {
    lines.push('  · 没有找到 PC 端产物，跳过（先跑 node tools/selftest.js）');
  }
  for (const p of pcPackages) {
    const r = get(p);
    const name = path.basename(p);
    if (!r) { ok(name + ' 能被解析', false, '无输出'); continue; }
    ok(name + ' 被判定为合法包', r.valid, (r.errors || []).join(' | '));
    if (/video/.test(name)) ok(name + ' 识别为视频版', r.kind === 2, String(r.kind));
    else ok(name + ' 识别为传统版', r.kind === 1, String(r.kind));
  }
  // 用户给的真实手表样本（如果还在）
  if (fs.existsSync('E:\\bootanimation.zip')) {
    const r = get('E:\\bootanimation.zip');
    ok('用户的手表样本 480×480/60fps', r && r.size === '480x480' && r.fps === 60, r && (r.size + ' ' + r.fps));
    ok('用户的手表样本被判定合法', r && r.valid, (r && r.errors.join(' | ')) || '');
    ok('用户样本的纯数字帧被正确识别', r && r.parts.length > 0 && r.parts[0].numbered === true);
  }

  console.log(lines.join('\n'));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试失败：', e.message); process.exit(2); });
