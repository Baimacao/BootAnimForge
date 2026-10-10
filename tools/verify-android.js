'use strict';
/**
 * verify-android.js — 在没有真机的情况下，尽量把 APK 里能验的都验一遍
 *
 * 本机没有 adb、也没有连接的设备，所以做不到真机冒烟。但可以：
 *   1. 解出 APK，检查清单（包名/版本/minSdk/targetSdk/权限/组件）
 *   2. 在 classes.dex 里核对关键字符串与类名确实被编进去了
 *   3. 检查签名与对齐
 *   4. 用 aapt2 dump 交叉验证
 *
 * 明确标注哪些「验不了」：真机安装、root 授权、圆屏裁切效果。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { readZip } = require('../src/zip.js');

const ROOT = path.resolve(__dirname, '..');
const SDK = process.env.ANDROID_SDK_ROOT || 'E:\\B1807\\Documents\\DSH\\sdk';

/** 自动找最新的 APK，避免版本号一升就验错文件（踩过：升级到 1.2.0 后仍去验 1.1.0） */
function findApk() {
  const dir = path.join(ROOT, 'dist', 'android');
  if (!fs.existsSync(dir)) return null;
  const list = fs.readdirSync(dir).filter((f) => f.endsWith('.apk'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return list.length ? path.join(dir, list[0].f) : null;
}
const APK = process.argv[2] || findApk();

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push('  ✓ ' + name); }
  else { fail++; results.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { results.push('\n▶ ' + t); }

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve({ code: -1, out: '', err: 'spawn failed' }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** dex 里的字符串池是明文，直接搜字节即可判断字符串是否被打进去了 */
function dexContains(buf, s) {
  return buf.indexOf(Buffer.from(s, 'utf8')) >= 0;
}

(async () => {
  console.log('Android APK 静态验证\n');
  if (!fs.existsSync(APK)) throw new Error('找不到 APK：' + APK);
  const size = (await fsp.stat(APK)).size;
  console.log(`APK：${path.basename(APK)}（${(size / 1024).toFixed(1)} KB）\n`);

  /* ---------- 1. 结构 ---------- */
  section('1. 包结构');
  const z = await readZip(APK);
  const names = [...z.keys()];
  ok('含 AndroidManifest.xml', names.includes('AndroidManifest.xml'));
  ok('含 classes.dex', names.includes('classes.dex'));
  ok('含 resources.arsc', names.some((n) => n === 'resources.arsc'));
  ok('classes.dex 以 STORE 存放（未压缩）', (() => {
    // 读中央目录里的压缩方法：0 = STORE
    const buf = fs.readFileSync(APK);
    let p = -1;
    for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { p = i; break; }
    let cd = buf.readUInt32LE(p + 16);
    const n = buf.readUInt16LE(p + 10);
    for (let i = 0; i < n; i++) {
      const method = buf.readUInt16LE(cd + 10);
      const nameLen = buf.readUInt16LE(cd + 28);
      const extraLen = buf.readUInt16LE(cd + 30);
      const cmtLen = buf.readUInt16LE(cd + 32);
      const nm = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
      if (nm === 'classes.dex') return method === 0;
      cd += 46 + nameLen + extraLen + cmtLen;
    }
    return false;
  })());
  ok('含启动图标', names.some((n) => /mipmap.*ic_launcher/.test(n)), names.filter((n) => n.includes('mipmap')).join(','));

  /* ---------- 2. 清单 ---------- */
  section('2. 清单（用 aapt2 dump 交叉验证）');
  const aapt2 = path.join(SDK, 'build-tools-r37', 'aapt2.exe');
  const dump = await run(aapt2, ['dump', 'badging', APK]);
  const d = dump.out;
  ok('包名正确', /package: name='com\.baimacao\.bootanimforge'/.test(d), (d.match(/package:[^\n]*/) || [''])[0]);
  ok('minSdkVersion = 19（Android 4.4，向下兼容）', /minSdkVersion:'19'/.test(d), (d.match(/minSdkVersion:'\d+'/) || [''])[0]);
  ok('targetSdkVersion = 30', /targetSdkVersion:'30'/.test(d), (d.match(/targetSdkVersion:'\d+'/) || [''])[0]);
  ok('应用名称为中文', /application-label:'启幕'/.test(d) || /application-label-zh/.test(d), (d.match(/application-label[^\n]*/) || [''])[0]);
  ok('声明了启动 Activity', /launchable-activity: name='com\.baimacao\.bootanimforge\.MainActivity'/.test(d));
  ok('watch 特性声明为非必需（手机/手表都能装）',
    /uses-feature-not-required: name='android\.hardware\.type\.watch'/.test(d),
    (d.match(/uses-feature[^\n]*watch[^\n]*/) || [''])[0]);
  ok('touchscreen 也声明为非必需（手表可能没有触摸屏条目）',
    /uses-feature-not-required: name='android\.hardware\.touchscreen'/.test(d));
  ok('未申请危险的无限制存储权限', !/MANAGE_EXTERNAL_STORAGE/.test(d));

  /* ---------- 3. dex 内容 ---------- */
  section('3. DEX 内容（关键类与文案是否真的编进去了）');
  const dex = z.get('classes.dex');
  const classNames = [
    'Lcom/baimacao/bootanimforge/MainActivity;',
    'Lcom/baimacao/bootanimforge/CreatorActivity;',
    'Lcom/baimacao/bootanimforge/RootShell;',
    'Lcom/baimacao/bootanimforge/BootScanner;',
    'Lcom/baimacao/bootanimforge/BootCore;',
    'Lcom/baimacao/bootanimforge/BackupManager;',
    'Lcom/baimacao/bootanimforge/ScreenShape;',
    'Lcom/baimacao/bootanimforge/Creator;',
    'Lcom/baimacao/bootanimforge/PngEncoder;',
    'Lcom/baimacao/bootanimforge/ZipStoreWriter;',
    'Lcom/baimacao/bootanimforge/AndroidFrameSource;',
    'Lcom/baimacao/bootanimforge/VideoProbe;',
    'Lcom/baimacao/bootanimforge/AnimTarget;',
    'Lcom/baimacao/bootanimforge/FramePreview;',
    'Lcom/baimacao/bootanimforge/Palette;',
  ];
  for (const c of classNames) ok('包含类 ' + c.replace(/^L|;$/g, '').split('/').pop(), dexContains(dex, c));

  section('4. 关键功能字符串');
  const must = [
    ['bootanimation.zip', '目标文件名'],
    ['/system/media/bootanimation.zip', '最常见的系统路径'],
    ['/product/media/bootanimation.zip', 'Android 10+ 路径'],
    ['bootanimation.mp4', 'Android 12+ 视频版识别'],
    ['desc.txt', '传统格式识别'],
    ['moov 不在文件头', '视频版 moov 前置检查'],
    ['data/adb/modules', 'Magisk 模块检测'],
    ['u:object_r:system_file:s0', 'SELinux 上下文'],
    ['chmod 0644', '权限设置'],
    ['/data/local/tmp/baf-install.zip', 'root 暂存路径'],
    ['圆形布局', '圆屏适配文案'],
    ['强制圆形', '圆屏手动覆盖选项'],
    ['强制方形', '方形手动覆盖选项'],
    ['需要 root', '前置条件提示'],
    ['还原上一个备份', '回滚入口'],
    // 制作（新增）
    ['开始制作', '制作入口'],
    ['选择视频文件', '视频选择'],
    ['手表 480 × 480', '手表分辨率预设'],
    ['手机 1080 × 2400', '手机分辨率预设'],
    ['001.png（手表）', '帧命名预设'],
    ['frame_00000', '通用帧命名'],
    ['纯数字', '纯数字命名说明'],
    ['留边不拉伸', '不拉伸说明'],
    ['正在制作', '进度状态'],
    ['制作完成', '完成提示'],
    // 关机动画 / 取用区间 / 取消 / 预览（新增）
    ['shutdownanimation.zip', '关机动画文件名'],
    ['关机动画', '关机动画入口'],
    ['取用区间', '区间选择'],
    ['取消当前任务', '任务取消'],
    ['预览当前动画', '预览入口'],
    ['预览效果', '制作前预览'],
    ['已取消', '取消提示'],
  ];
  for (const [s, what] of must) ok(`含「${s}」（${what}）`, dexContains(dex, s));

  /* ---------- 4b. 瑞士风色板（防止被改回 MD3） ---------- */
  section('4b. 瑞士国际主义色板（三色）');
  // Palette 里的常量是 static final int，会被 javac 内联成字面量，
  // 因此 DEX 里搜不到常量名，但字符串形态的类名与资源值可验。
  ok('Palette 类已编入', dexContains(dex, 'Lcom/baimacao/bootanimforge/Palette;'));
  // 三色基色在 DEX 中以整型字面量存在，用十六进制串不可靠 —— 改验源码侧一致性
  const paletteSrc = fs.readFileSync(path.join(ROOT, 'android', 'src', 'com', 'baimacao', 'bootanimforge', 'Palette.java'), 'utf8');
  ok('Palette 定义强调红 #DA291C', /0xFFDA291C/.test(paletteSrc), '未找到 0xFFDA291C');
  ok('Palette 定义米白 #F5F2ED', /0xFFF5F2ED/.test(paletteSrc), '未找到 0xFFF5F2ED');
  ok('Palette 定义黑 #1A1A1A', /0xFF1A1A1A/.test(paletteSrc), '未找到 0xFF1A1A1A');
  ok('Palette 圆角为 0（瑞士风直角）', /static final int RADIUS = 0;/.test(paletteSrc), 'RADIUS 不为 0');
  // 两个 Activity 不应再各自硬编码 MD3 色值（应指向 Palette）
  for (const f of ['MainActivity.java', 'CreatorActivity.java']) {
    const src = fs.readFileSync(path.join(ROOT, 'android', 'src', 'com', 'baimacao', 'bootanimforge', f), 'utf8');
    ok(f + ' 不再硬编码 MD3 主色', !/0xFF4FC3F7/.test(src), '仍存在 #4FC3F7');
    ok(f + ' 色值已指向 Palette', /Palette\.PRIMARY/.test(src), '未引用 Palette');
  }
  // XML 色板同步（否则启动瞬间会闪深色背景）
  const colorsXml = fs.readFileSync(path.join(ROOT, 'android', 'res', 'values', 'colors.xml'), 'utf8');
  ok('colors.xml 主色为强调红', /md_primary">#DA291C/.test(colorsXml), '未同步');
  ok('colors.xml 表面为米白', /md_surface">#F5F2ED/.test(colorsXml), '未同步');
  ok('colors.xml 已无 MD3 深色残留', !/#0E1418|#4FC3F7/.test(colorsXml), '仍含 MD3 深色值');

  section('5. 兼容性写法');
  ok('用了 isScreenRound（API 23+ 特性检测）', dexContains(dex, 'isScreenRound'));
  ok('用了 UiModeManager 旧版本回退', dexContains(dex, 'getCurrentModeType'));
  ok('用了 RippleDrawable（有版本判断）', dexContains(dex, 'RippleDrawable') || dexContains(dex, 'Landroid/graphics/drawable/RippleDrawable;'));
  ok('用了 od 而不是 xxd 读文件头（精简 ROM 兼容）', dexContains(dex, 'od -An -tx1 -N 4'));
  ok('su 路径有多候选回退', dexContains(dex, '/system/xbin/su') && dexContains(dex, '/debug_ramdisk/su'));
  // 制作相关的兼容写法
  // 注意：METADATA_KEY_VIDEO_ROTATION / OPTION_CLOSEST 都是 static final int 常量，
  // javac 会把它们**内联**成字面量，所以 DEX 里搜不到这些名字 —— 不能拿它们当断言，
  // 否则会得到"明明写了却验不到"的假失败。改验方法名与类名。
  ok('用 MediaMetadataRetriever 取帧（框架 API，无第三方库）', dexContains(dex, 'MediaMetadataRetriever'));
  ok('调用了 getFrameAtTime（取帧入口）', dexContains(dex, 'getFrameAtTime'));
  ok('调用了 extractMetadata（读旋转/时长/帧率）', dexContains(dex, 'extractMetadata'));
  ok('调用了 Bitmap.createBitmap（ARGB_8888 像素搬运）', dexContains(dex, 'createBitmap'));
  ok('实现 FrameSource（可测试的取帧抽象）', dexContains(dex, 'FrameSource'));
  ok('PNG 由自己编码（不依赖 Bitmap.compress 生成 PNG）', dexContains(dex, 'PngEncoder'));
  ok('zip 用自己写的 STORE 写入器', dexContains(dex, 'ZipStoreWriter'));

  /* ---------- 6. 签名 ---------- */
  section('6. 签名与对齐');
  const apksigner = path.join(SDK, 'build-tools-r37', 'apksigner.bat');
  const ver = await run('cmd.exe', ['/c', apksigner, 'verify', '--verbose', APK]);
  const vout = ver.out + ver.err;
  ok('v1 签名（兼容 Android 4.4）', /Verified using v1 scheme.*true/i.test(vout), '');
  ok('v2 签名', /Verified using v2 scheme.*true/i.test(vout));
  ok('签名整体校验通过', /Verified/.test(vout) && !/DOES NOT VERIFY/.test(vout));

  const zipalign = path.join(SDK, 'build-tools-r37', 'zipalign.exe');
  // 新版 zipalign 的校验用法是 `-c [-v] <align> infile`；加了 -P/-p 反而会参数冲突
  const al = await run(zipalign, ['-c', '-v', '4', APK]);
  ok('4 字节对齐校验通过', al.code === 0 && /Verification successful/.test(al.out),
    (al.out + al.err).split('\n').filter((l) => l.trim()).slice(-2).join(' '));

  /* ---------- 汇总 ---------- */
  console.log(results.join('\n'));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  console.log('⚠ 本机没有 adb、也没有连接真机，以下**未能验证**，需要你装到设备上确认：');
  console.log('   · 真机安装与启动');
  console.log('   · root 授权流程（su 弹窗、不同 ROM 的 su 路径）');
  console.log('   · 实际写入系统分区后的权限/SELinux 上下文');
  console.log('   · 圆屏上的安全区视觉效果（我用的是内切圆 16% 缩进，只能靠肉眼确认）');
  console.log('   · 手表与手机各自的布局观感');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('验证失败：', e.message); process.exit(2); });
