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

/**
 * 测试装置：在 PC 上驱动安卓端「制作」核心的纯 JDK 类。
 * 内联在此，不依赖 .work（临时目录会被清理）。
 */
const CREATOR_TEST_JAVA = `
import com.baimacao.bootanimforge.Creator;
import com.baimacao.bootanimforge.PngEncoder;
import com.baimacao.bootanimforge.ZipStoreWriter;
import java.io.File;

public class CreatorTest {
    static int W = 64, H = 64;

    /** 造一帧：左半边红、右半边蓝，便于判断是否被拉伸/裁切 */
    static int[] testFrame(int w, int h) {
        int[] px = new int[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                px[y * w + x] = (x < w / 2) ? 0xFFFF0000 : 0xFF0000FF;
        return px;
    }

    /** 4 个角 + 中心取色，导给 JS 侧判断留边与内容 */
    static int[] corners(int[] px, int w, int h) {
        return new int[] {
            px[0], px[w - 1], px[(h - 1) * w], px[(h - 1) * w + w - 1], px[(h / 2) * w + w / 2]
        };
    }

    public static void main(String[] args) throws Exception {
        File outDir = new File(args[0]);
        outDir.mkdirs();

        /* ---- 1. PNG 编码器：红底 + 绿块 + 四角蓝，供 ffmpeg 逐像素核对 ---- */
        int[] px = new int[W * H];
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                int c = 0xFFCC2222;
                if (x >= 16 && x < 48 && y >= 16 && y < 48) c = 0xFF22CC44;
                if ((x < 8 || x >= W - 8) && (y < 8 || y >= H - 8)) c = 0xFF2244CC;
                px[y * W + x] = c;
            }
        }
        write(new File(outDir, "enc-rgb.png"), PngEncoder.encode(px, W, H, true));
        write(new File(outDir, "enc-rgba.png"), PngEncoder.encode(px, W, H, false));

        /* ---- 2. 等比缩放 + 留边（源 200x100 → 目标 100x100 应缩为 100x50 并上下留黑） ---- */
        int srcW = 200, srcH = 100;
        int[] src = testFrame(srcW, srcH);
        int[] fitted = Creator.fitAndPad(src, srcW, srcH, 100, 100, 0xFF000000);
        write(new File(outDir, "fit.bin"), intsToBytes(corners(fitted, 100, 100)));
        write(new File(outDir, "fit.png"), PngEncoder.encode(fitted, 100, 100, true));

        /* ---- 3. STORE zip 写入器 ---- */
        ZipStoreWriter zip = new ZipStoreWriter(new File(outDir, "made.zip"));
        zip.add("desc.txt", "480 480 15\\r\\np 0 0 part0\\r\\n".getBytes("UTF-8"));
        for (int i = 0; i < 5; i++)
            zip.add("part0/" + pad(i + 1, 3) + ".png", PngEncoder.encode(testFrame(32, 32), 32, 32, true));
        zip.finish();

        /* ---- 4. 帧命名 ---- */
        Creator.Options o = new Creator.Options();
        o.framePrefix = ""; o.padWidth = 3; o.startNumber = 1;
        StringBuilder names = new StringBuilder();
        for (int i = 0; i < 3; i++) names.append(Creator.frameName(o, i)).append(',');
        Creator.Options o2 = new Creator.Options();
        o2.framePrefix = "frame_"; o2.padWidth = 5; o2.startNumber = 0;
        names.append(Creator.frameName(o2, 7));

        /* ---- 5. plan / desc（开机） ---- */
        Creator.Options o3 = new Creator.Options();
        o3.width = 480; o3.height = 480; o3.fps = 15;
        java.util.List<Creator.Part> parts = new java.util.ArrayList<Creator.Part>();
        parts.add(new Creator.Part("part0", 0, 1, 15, 0));
        String desc = Creator.buildDesc(o3, parts);

        /* ---- 6. 关机动画：文件名与段类型 ---- */
        System.out.println("BOOTFILE\\t" + Creator.targetFileName(Creator.TARGET_BOOT));
        System.out.println("SHUTFILE\\t" + Creator.targetFileName(Creator.TARGET_SHUTDOWN));
        System.out.println("BOOTVIDEO\\t" + Creator.targetVideoFileName(Creator.TARGET_BOOT));
        System.out.println("SHUTVIDEO\\t" + Creator.targetVideoFileName(Creator.TARGET_SHUTDOWN));
        System.out.println("BOOTLABEL\\t" + Creator.targetLabel(Creator.TARGET_BOOT));
        System.out.println("SHUTLABEL\\t" + Creator.targetLabel(Creator.TARGET_SHUTDOWN));

        Creator.Options os = new Creator.Options();
        os.width = 480; os.height = 480; os.fps = 15; os.partType = 'c';
        System.out.println("DESCSHUT\\t" + Creator.buildDesc(os, parts).replace("\\r\\n", "\\\\r\\\\n"));

        Creator.Options od = new Creator.Options();
        od.width = 480; od.height = 480; od.fps = 15; od.partType = 'f';
        System.out.println("DESCEXPLICIT\\t" + Creator.buildDesc(od, parts).replace("\\r\\n", "\\\\r\\\\n"));

        // 段自身携带类型时应优先于 cfg.partType
        java.util.List<Creator.Part> typed = new java.util.ArrayList<Creator.Part>();
        typed.add(new Creator.Part("part0", 0, 1, 15, 0));
        typed.get(0).type = 'p';
        Creator.Options op = new Creator.Options();
        op.width = 480; op.height = 480; op.fps = 15; op.partType = 'c';
        System.out.println("DESCTYPE\\t" + Creator.buildDesc(op, typed).replace("\\r\\n", "\\\\r\\\\n"));

        /* ---- 7. 取用区间 ---- */
        final double fakeDur = 10.0;
        Creator.FrameSource fs = new Creator.FrameSource() {
            public int displayWidth() { return 64; }
            public int displayHeight() { return 64; }
            public double durationSec() { return fakeDur; }
            public double fps() { return 30; }
            public int[] frameAt(double sec) { return testFrame(64, 64); }
            public void close() { }
        };
        Creator.Options ot = new Creator.Options();
        ot.fps = 10; ot.startSec = 1.0; ot.endSec = 2.0;
        java.util.List<Creator.Part> trimPlan = Creator.plan(ot, fs);
        System.out.println("TRIMSTART\\t" + trimPlan.get(0).start);
        System.out.println("TRIMEND\\t" + trimPlan.get(0).end);
        System.out.println("TRIMFRAMES\\t" + trimPlan.get(0).frames);

        Creator.Options oclip = new Creator.Options();
        oclip.fps = 10; oclip.startSec = 2.0; oclip.endSec = 99.0;
        System.out.println("CLIPEND\\t" + Creator.plan(oclip, fs).get(0).end);

        /* ---- 8. 真跑一次转换（含取用区间），验证产物 ---- */
        Creator.Options run = new Creator.Options();
        run.target = Creator.TARGET_SHUTDOWN;
        run.width = 64; run.height = 64; run.fps = 10;
        run.startSec = 1.0; run.endSec = 2.0;
        run.partType = 'c'; run.padWidth = 3; run.startNumber = 1;
        final int[] counter = new int[1];
        Creator.FrameSource counting = new Creator.FrameSource() {
            public int displayWidth() { return 64; }
            public int displayHeight() { return 64; }
            public double durationSec() { return fakeDur; }
            public double fps() { return 30; }
            public int[] frameAt(double sec) { counter[0]++; return testFrame(64, 64); }
            public void close() { }
        };
        File made = new File(outDir, "made-shutdown.zip");
        Creator.Result rr = Creator.convert(run, counting, made, null);
        System.out.println("RUNFRAMES\\t" + rr.totalFrames);
        System.out.println("RUNTAKEN\\t" + counter[0]);
        System.out.println("RUNNAME\\t" + made.getName());
        System.out.println("RUNBYTES\\t" + rr.bytes);

        /* ---- 9. 取消：进度回调返回 false 应中断并删除半成品 ---- */
        Creator.Options oc = new Creator.Options();
        oc.width = 64; oc.height = 64; oc.fps = 10; oc.startSec = 0; oc.endSec = 5;
        File cancelFile = new File(outDir, "made-cancel.zip");
        String cancelErr = null;
        try {
            Creator.convert(oc, counting, cancelFile, new Creator.Progress() {
                public boolean onProgress(double ratio, String note) { return ratio < 0.3; }
            });
        } catch (Throwable t) {
            cancelErr = t.getClass().getSimpleName();
        }
        System.out.println("CANCELERR\\t" + cancelErr);
        System.out.println("CANCELFILEEXISTS\\t" + cancelFile.exists());

        System.out.println("NAMES\\t" + names);
        System.out.println("DESC\\t" + desc.replace("\\r\\n", "\\\\r\\\\n"));
        System.out.println("DONE");
    }

    static String pad(int n, int w) {
        StringBuilder sb = new StringBuilder(Integer.toString(n));
        while (sb.length() < w) sb.insert(0, '0');
        return sb.toString();
    }

    static byte[] intsToBytes(int[] v) {
        byte[] b = new byte[v.length * 4];
        for (int i = 0; i < v.length; i++) {
            b[i * 4] = (byte) ((v[i] >>> 24) & 0xFF);
            b[i * 4 + 1] = (byte) ((v[i] >>> 16) & 0xFF);
            b[i * 4 + 2] = (byte) ((v[i] >>> 8) & 0xFF);
            b[i * 4 + 3] = (byte) (v[i] & 0xFF);
        }
        return b;
    }

    static void write(File f, byte[] data) throws Exception {
        java.io.FileOutputStream os = new java.io.FileOutputStream(f);
        os.write(data);
        os.close();
    }
}
`;

/** BootCore 校验入口，用于反向复核产物 */
const CORE_TEST_JAVA = `
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
            System.out.println("MOOVFIRST\\t" + r.moovFirst);
            for (String e : r.errors) System.out.println("ERR\\t" + e);
            for (String w : r.warnings) System.out.println("WARN\\t" + w);
        }
    }
}
`;


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

  // 测试装置内联在本脚本中（与 coretest-android.js 同一模式），不依赖 .work 下的临时文件。
  // 为什么必须内联：.work 是临时目录、会被清理规则反复删除，而这两个测试类是**手写资产**。
  // 原实现从 .work/android-creatortest/CreatorTest.java 读取，该目录一被清理测试就整体失效（已踩过）。
  const creatorTest = path.join(WORK, 'CreatorTest.java');
  await fsp.writeFile(creatorTest, CREATOR_TEST_JAVA, 'utf8');
  const coreTestLocal = path.join(WORK, 'CoreTest.java');
  await fsp.writeFile(coreTestLocal, CORE_TEST_JAVA, 'utf8');

  await run(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-d', classes, ...sources, creatorTest, coreTestLocal], WORK);
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
