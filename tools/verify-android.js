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
  ok('应用名称为中文', /application-label:'开机动画工坊'/.test(d) || /application-label-zh/.test(d), (d.match(/application-label[^\n]*/) || [''])[0]);
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
    'Lcom/baimacao/bootanimforge/RootShell;',
    'Lcom/baimacao/bootanimforge/BootScanner;',
    'Lcom/baimacao/bootanimforge/BootCore;',
    'Lcom/baimacao/bootanimforge/BackupManager;',
    'Lcom/baimacao/bootanimforge/ScreenShape;',
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
  ];
  for (const [s, what] of must) ok(`含「${s}」（${what}）`, dexContains(dex, s));

  section('5. 兼容性写法');
  ok('用了 isScreenRound（API 23+ 特性检测）', dexContains(dex, 'isScreenRound'));
  ok('用了 UiModeManager 旧版本回退', dexContains(dex, 'getCurrentModeType'));
  ok('用了 RippleDrawable（有版本判断）', dexContains(dex, 'RippleDrawable') || dexContains(dex, 'Landroid/graphics/drawable/RippleDrawable;'));
  ok('用了 od 而不是 xxd 读文件头（精简 ROM 兼容）', dexContains(dex, 'od -An -tx1 -N 4'));
  ok('su 路径有多候选回退', dexContains(dex, '/system/xbin/su') && dexContains(dex, '/debug_ramdisk/su'));

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
