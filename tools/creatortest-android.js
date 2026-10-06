'use strict';
/**
 * creatortest-android.js — 在 PC 上验证安卓端「制作」核心的正确性
 *
 * 这是本轮最关键的验证：安卓端的「制作」是**手写**的 PNG 编码器与 STORE zip 写入器
 * （因为不能用 Android 的 Bitmap.compress 生成 PNG —— 它在老版本上不可靠，而且本机
 * 没有真机可测）。既然手写，就必须证明产物真的合法，而不是"看起来像"。
 *
 * 做法：
 *   1. 在 PC 上编译并运行 CreatorTest，产出手写的 PNG 与 zip
 *   2. 用 ffmpeg 解码这些 PNG，并逐个像素核对颜色（红底/绿块/四角蓝）
 *   3. 用自己写的 zip 读取器读回来，核对条目、顺序、CRC
 *   4. 用 BootCore（就是 App 里跑的那份代码）校验产出的 zip 合法
 *   5. 验证"绝不拉伸"：等比缩放 + 留边的像素结果
 *
 * 用法：node tools/creatortest-android.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.work', 'android-creatortest');
const OUT = path.join(WORK, 'out');
const JAVA_HOME = process.env.JAVA_HOME || 'E:\\Program Files\\Java\\jdk-21.0.10';
const SRC_DIR = path.join(ROOT, 'android', 'src', 'com', 'baimacao', 'bootanimforge');
const ffs = require('../src/ffmpeg.js');

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

/** 用 ffmpeg 把图片转成 rawvideo rgb24，返回像素缓冲 */
async function decodeRaw(file) {
  const { ffmpeg } = ffs.resolveBinaries();
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const bufs = [];
    let err = '';
    p.stdout.on('data', (d) => bufs.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(bufs)) : reject(new Error('ffmpeg 解码失败: ' + err))));
  });
}

async function probeSize(file) {
  const info = await ffs.probe(file);
  return info.video.codedWidth + 'x' + info.video.codedHeight;
}

(async () => {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  /* ---------- 编译 ---------- */
  const classes = path.join(WORK, 'classes');
  await fsp.mkdir(classes, { recursive: true });
  const sources = ['Creator.java', 'PngEncoder.java', 'ZipStoreWriter.java', 'BootCore.java']
    .map((f) => path.join(SRC_DIR, f));
  // CoreTest 用来在本轮里顺便用 BootCore 复核产物，需要一起编译
  const coreTest = path.join(ROOT, '.work', 'android-coretest', 'CoreTest.java');
  const coreTestLocal = path.join(WORK, 'CoreTest.java');
  if (fs.existsSync(coreTest)) {
    await fsp.copyFile(coreTest, coreTestLocal);
  } else {
    await fsp.writeFile(coreTestLocal, `
import com.baimacao.bootanimforge.BootCore;
import java.io.File;
public class CoreTest {
    public static void main(String[] args) throws Exception {
        for (String a : args) {
            BootCore.Report r = BootCore.validate(new File(a));
            System.out.println("KIND\\t" + r.kind);
            System.out.println("VALID\\t" + r.valid);
            System.out.println("SIZE\\t" + r.width + "x" + r.height);
            System.out.println("FPS\\t" + r.fps);
            System.out.println("FRAMES\\t" + r.totalFrames);
            for (String e : r.errors) System.out.println("ERR\\t" + e);
        }
    }
}
`, 'utf8');
  }
  await run(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-d', classes, ...sources, path.join(WORK, 'CreatorTest.java'), coreTestLocal], WORK);
  console.log('已编译 Creator / PngEncoder / ZipStoreWriter / BootCore（安卓端"制作"的纯逻辑部分）\n');

  /* ---------- 运行 ---------- */
  const res = await run(path.join(JAVA_HOME, 'bin', 'java.exe'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', classes, 'CreatorTest', OUT], WORK);
  const namesLine = (res.out.match(/^NAMES\t(.*)$/m) || [])[1] || '';
  const descLine = (res.out.match(/^DESC\t(.*)$/m) || [])[1] || '';
  ok('测试程序执行完成', /DONE/.test(res.out), res.err);

  /* ---------- 1. 手写 PNG 是否真的合法 ---------- */
  section('1. 手写 PNG 编码器（用 ffmpeg 当裁判）');
  const rgbPng = path.join(OUT, 'enc-rgb.png');
  const rgbaPng = path.join(OUT, 'enc-rgba.png');

  ok('PNG 文件已生成', fs.existsSync(rgbPng) && fs.existsSync(rgbaPng));
  const sig = fs.readFileSync(rgbPng).subarray(0, 8);
  ok('PNG 签名正确', sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  let rgbInfo = null, rgbaInfo = null;
  try {
    rgbInfo = await ffs.probe(rgbPng);
    ok('ffmpeg 能解析 RGB 版 PNG（即文件合法）', true, '');
    ok('尺寸 = 64×64', rgbInfo.video.codedWidth === 64 && rgbInfo.video.codedHeight === 64,
      rgbInfo.video.codedWidth + 'x' + rgbInfo.video.codedHeight);
    ok('像素格式为 rgb24（颜色类型 2）', /rgb24|gbrp/.test(rgbInfo.video.pixFmt), rgbInfo.video.pixFmt);
  } catch (e) {
    ok('ffmpeg 能解析 RGB 版 PNG', false, e.message.split('\n')[0]);
  }
  try {
    rgbaInfo = await ffs.probe(rgbaPng);
    ok('ffmpeg 能解析 RGBA 版 PNG', true, '');
    ok('RGBA 版保留 alpha 通道', /a$/.test(rgbaInfo.video.pixFmt), rgbaInfo.video.pixFmt);
  } catch (e) {
    ok('ffmpeg 能解析 RGBA 版 PNG', false, e.message.split('\n')[0]);
  }

  // 逐点核对颜色：红底 / 绿块 / 四角蓝
  try {
    const px = await decodeRaw(rgbPng);
    const W = 64;
    const at = (x, y) => {
      const o = (y * W + x) * 3;
      return [px[o], px[o + 1], px[o + 2]];
    };
    const near = (c, r, g, b, tol = 12) =>
      Math.abs(c[0] - r) <= tol && Math.abs(c[1] - g) <= tol && Math.abs(c[2] - b) <= tol;

    ok('背景像素是红色 (204,34,34)', near(at(4, 32), 204, 34, 34), JSON.stringify(at(4, 32)));
    ok('中心方块是绿色 (34,204,68)', near(at(32, 32), 34, 204, 68), JSON.stringify(at(32, 32)));
    ok('左上角是蓝色 (34,68,204)', near(at(2, 2), 34, 68, 204), JSON.stringify(at(2, 2)));
    ok('右下角是蓝色', near(at(62, 62), 34, 68, 204), JSON.stringify(at(62, 62)));
    ok('绿色方块边界正确（x=15 处仍是红）', near(at(15, 32), 204, 34, 34), JSON.stringify(at(15, 32)));
    ok('绿色方块边界正确（x=16 处是绿）', near(at(16, 32), 34, 204, 68), JSON.stringify(at(16, 32)));
  } catch (e) {
    ok('像素级核对', false, e.message.split('\n')[0]);
  }

  /* ---------- 2. 绝不拉伸 ---------- */
  section('2. 等比缩放 + 留边（绝不拉伸）');
  try {
    const size = await probeSize(path.join(OUT, 'fit.png'));
    ok('输出尺寸严格等于目标 100×100', size === '100x100', size);
  } catch (e) {
    ok('输出尺寸严格等于目标', false, e.message.split('\n')[0]);
  }
  // corners.bin 里是 [左上, 右上, 左下, 右下, 中心] 的 ARGB
  const cb = fs.readFileSync(path.join(OUT, 'fit.bin'));
  const argb = [];
  for (let i = 0; i < 5; i++) argb.push(cb.readUInt32BE(i * 4));
  const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  // 源 200x100 → 目标 100x100：应缩为 100x50，上下各留 25 行黑边
  ok('左上角是留边（黑）', argb[0] === 0xFF000000, hex(argb[0]));
  ok('右上角是留边（黑）', argb[1] === 0xFF000000, hex(argb[1]));
  ok('左下角是留边（黑）', argb[2] === 0xFF000000, hex(argb[2]));
  ok('右下角是留边（黑）', argb[3] === 0xFF000000, hex(argb[3]));
  // 中心落在画面内：源左半红右半蓝，中心 x=50 正好是分界，取到蓝或红都算"有内容"
  ok('中心是画面内容（非黑边）', argb[4] === 0xFFFF0000 || argb[4] === 0xFF0000FF, hex(argb[4]));
  lines.push(`  · 四角=${hex(argb[0])} 中心=${hex(argb[4])} —— 内容被缩到中间、四周补黑，没有拉伸`);

  /* ---------- 3. 手写 STORE zip ---------- */
  section('3. 手写 STORE zip 写入器');
  const zipPath = path.join(OUT, 'made.zip');
  const { readZip, verifyZip } = require('../src/zip.js');
  let z = null;
  try {
    z = await readZip(zipPath);
    ok('自己写的读取器能读回手写 zip', true);
  } catch (e) {
    ok('自己写的读取器能读回手写 zip', false, e.message);
  }
  if (z) {
    const names = [...z.keys()];
    ok('含 desc.txt', names.includes('desc.txt'));
    ok('条目数 = 1 + 5', names.length === 6, String(names.length));
    ok('帧按序存放', names.slice(1).join(',') === 'part0/001.png,part0/002.png,part0/003.png,part0/004.png,part0/005.png',
      names.slice(1).join(','));
    ok('desc.txt 内容正确', z.get('desc.txt').toString('utf8') === '480 480 15\r\np 0 0 part0\r\n',
      JSON.stringify(z.get('desc.txt').toString('utf8')));
    // 解出第一帧交给 ffmpeg，证明 zip 里存的 PNG 也是好的
    const first = z.get('part0/001.png');
    const tmp = path.join(OUT, 'fromzip.png');
    fs.writeFileSync(tmp, first);
    try {
      const s = await probeSize(tmp);
      ok('zip 里的帧是合法 PNG（ffmpeg 可解）', s === '32x32', s);
    } catch (e) {
      ok('zip 里的帧是合法 PNG', false, e.message.split('\n')[0]);
    }
  }
  // 用 BootCore（App 里真正跑的那份代码）校验
  const bootCoreOut = await run(path.join(JAVA_HOME, 'bin', 'java.exe'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', classes, 'CoreTest', zipPath], WORK)
    .catch((e) => ({ out: '', err: e.message }));
  ok('BootCore 判定产物合法', /VALID\ttrue/.test(bootCoreOut.out || ''),
    (bootCoreOut.out || '').split('\n').filter((l) => l.startsWith('ERR')).join(' | '));
  ok('BootCore 识别为传统帧序列版', /KIND\t1/.test(bootCoreOut.out || ''));
  ok('BootCore 解析出 480×480 / 15fps', /SIZE\t480x480/.test(bootCoreOut.out || '') && /FPS\t15/.test(bootCoreOut.out || ''));
  ok('BootCore 解析出 5 帧', /FRAMES\t5/.test(bootCoreOut.out || ''),
    (bootCoreOut.out || '').split('\n').filter((l) => l.startsWith('FRAMES')).join(''));

  /* ---------- 4. 命名与 desc ---------- */
  section('4. 帧命名与 desc.txt');
  ok('纯数字命名 001,002,003', namesLine.startsWith('001,002,003'), namesLine);
  ok('带前缀命名 frame_00007', namesLine.endsWith('frame_00007'), namesLine);
  ok('desc.txt 用 CRLF 结尾', /\\r\\n$/.test(descLine), JSON.stringify(descLine));
  ok('desc.txt 首行 = 480 480 15', descLine.startsWith('480 480 15'), descLine);

  const field = (k) => (res.out.match(new RegExp('^' + k + '\\t(.*)$', 'm')) || [])[1] || '';

  /* ---------- 5. 关机动画 ---------- */
  section('5. 关机动画（文件名与段类型）');
  ok('开机产物是 bootanimation.zip', field('BOOTFILE') === 'bootanimation.zip', field('BOOTFILE'));
  ok('关机产物是 shutdownanimation.zip', field('SHUTFILE') === 'shutdownanimation.zip', field('SHUTFILE'));
  ok('开机视频版是 bootanimation.mp4', field('BOOTVIDEO') === 'bootanimation.mp4', field('BOOTVIDEO'));
  ok('关机视频版是 shutdownanimation.mp4', field('SHUTVIDEO') === 'shutdownanimation.mp4', field('SHUTVIDEO'));
  ok('中文标签正确', field('BOOTLABEL') === '开机动画' && field('SHUTLABEL') === '关机动画',
    field('BOOTLABEL') + '/' + field('SHUTLABEL'));
  ok('关机 desc 用 c（必须播完）', /^480 480 15\\r\\nc 0 0 part0\\r\\n$/.test(field('DESCSHUT')), field('DESCSHUT'));
  ok('开机 desc 仍是 p', /^480 480 15\\r\\np 0 0 part0\\r\\n$/.test(descLine), descLine);
  // Creator.Part 不携带 fade 值，所以 f 类型不带第四个字段（fade 省略即为 0）
  ok('partType=f 时段类型变 f', /^480 480 15\\r\\nf 0 0 part0\\r\\n$/.test(field('DESCEXPLICIT')),
    field('DESCEXPLICIT'));
  ok('段自身带类型时优先于 partType', /^480 480 15\\r\\np 0 0 part0\\r\\n$/.test(field('DESCTYPE')), field('DESCTYPE'));

  /* ---------- 6. 取用区间 ---------- */
  section('6. 取用区间');
  ok('起点 1.0s 被采纳', Number(field('TRIMSTART')) === 1, field('TRIMSTART'));
  ok('终点 2.0s 被采纳', Number(field('TRIMEND')) === 2, field('TRIMEND'));
  ok('帧数 = 1s × 10fps = 10', Number(field('TRIMFRAMES')) === 10, field('TRIMFRAMES'));
  ok('终点超过视频时长时被夹到结尾', Number(field('CLIPEND')) === 10, field('CLIPEND'));

  /* ---------- 7. 转换与取消 ---------- */
  section('7. 真跑一次转换 + 取消');
  ok('产物文件名是 shutdownanimation.zip', field('RUNNAME') === 'made-shutdown.zip', field('RUNNAME'));
  ok('只生成区间内的 10 帧', Number(field('RUNFRAMES')) === 10, field('RUNFRAMES'));
  ok('只向视频源取了 10 次帧', Number(field('RUNTAKEN')) === 10, field('RUNTAKEN'));
  ok('产物非空', Number(field('RUNBYTES')) > 0, field('RUNBYTES'));
  ok('取消时抛 InterruptedException', field('CANCELERR') === 'InterruptedException', field('CANCELERR'));
  ok('取消后不留下半成品', field('CANCELFILEEXISTS') === 'false', field('CANCELFILEEXISTS'));

  // 用 BootCore 校验真跑出来的关机产物
  const shutZip = path.join(OUT, 'made-shutdown.zip');
  if (fs.existsSync(shutZip)) {
    const bc = await run(path.join(JAVA_HOME, 'bin', 'java.exe'),
      ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', classes, 'CoreTest', shutZip], WORK)
      .catch((e) => ({ out: '', err: e.message }));
    ok('BootCore 判定关机产物合法', /VALID\ttrue/.test(bc.out || ''),
      (bc.out || '').split('\n').filter((l) => l.startsWith('ERR')).join(' | '));
    ok('关机产物被识别为 64×64 / 10fps',
      /SIZE\t64x64/.test(bc.out || '') && /FPS\t10/.test(bc.out || ''));
    // 直接读包里的 desc.txt，确认段类型真的是 c
    const { readZip } = require('../src/zip.js');
    const z2 = await readZip(shutZip);
    const d2 = z2.get('desc.txt').toString('utf8');
    ok('真跑产物的 desc.txt 段类型是 c', /^c\s/m.test(d2), JSON.stringify(d2));
  }

  console.log(lines.join('\n'));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  console.log('说明：以上 PNG/zip 全部由**安卓端将要运行的那份手写代码**产出，');
  console.log('      正确性由 ffmpeg（外部裁判）与 BootCore（App 内同一份校验代码）双重判定。');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试失败：', e.message); process.exit(2); });
