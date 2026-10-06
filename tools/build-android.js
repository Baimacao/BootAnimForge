'use strict';
/**
 * build-android.js — 不依赖 Gradle/AGP 的 APK 构建流水线
 *
 * 为什么手写：本机 repo.maven.apache.org / dl.google.com / maven.aliyun.com 全部不可达，
 * 拿不到 Android Gradle Plugin。所以直接用 SDK 自带的工具链：
 *
 *   aapt2 compile / link  →  javac  →  d8  →  (aapt2 link 加 dex)  →  zipalign  →  apksigner
 *
 * 代价是不能用 androidx / Material Components，界面只能用 framework 控件自己画 ——
 * 好处是构建飞快、零下载、完全可复现。
 *
 * 用法：
 *   node tools/build-android.js                 构建 debug APK
 *   node tools/build-android.js --release       用 release keystore 签名
 *   node tools/build-android.js --out dist/android
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'android');
const BUILD = path.join(ROOT, '.work', 'android-build');

/** SDK 定位：按 ANDROID_SDK_ROOT → ANDROID_HOME → 常见路径 顺序找 */
function findSdk() {
  const cands = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    'E:\\B1807\\Documents\\DSH\\sdk',
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk'),
    'C:\\Android\\Sdk',
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'platform', 'android.jar'))) return c;
  }
  return null;
}

/** 在 build-tools-* 目录里找到需要的工具（选版本号最大的那个） */
function findBuildTools(sdk) {
  const roots = ['build-tools', 'build-tools-r37', 'bt36'].map((d) => path.join(sdk, d));
  const withTools = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    // build-tools/<ver>/aapt2.exe 或 build-tools-r37/aapt2.exe 两种布局都要支持
    if (fs.existsSync(path.join(r, 'aapt2.exe'))) withTools.push(r);
    for (const sub of fs.readdirSync(r, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const p = path.join(r, sub.name);
      if (fs.existsSync(path.join(p, 'aapt2.exe'))) withTools.push(p);
      // bt36/android-37.0 里可能只有一部分工具，往下一层找
      for (const sub2 of fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const q = path.join(p, sub2.name);
        if (fs.existsSync(path.join(q, 'aapt2.exe'))) withTools.push(q);
      }
    }
  }
  if (!withTools.length) return null;
  // 优先选同时具备 aapt2 + d8 + zipalign + apksigner 的目录
  const need = ['aapt2.exe', 'd8.bat', 'zipalign.exe', 'apksigner.bat'];
  const full = withTools.filter((d) => need.every((n) => fs.existsSync(path.join(d, n))));
  return (full.length ? full : withTools).sort().pop();
}

function findJavaHome() {
  const cands = [
    process.env.JAVA_HOME,
    'E:\\Program Files\\Java\\jdk-21.0.10',
    'E:\\Program Files\\Eclipse Adoptium\\jdk-25.0.3.9-hotspot',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'bin', 'javac.exe'))) return c;
  return null;
}

/** Windows 下给 cmd 用的参数引号处理 */
function quoteWin(s) {
  s = String(s);
  if (s.length === 0) return '""';
  if (/[\s"^&|<>()]/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"';
  return s;
}

function run(cmd, args, opts = {}) {
  // Windows 上 .bat/.cmd 不能被 CreateProcess 直接执行（会报 spawn EINVAL），
  // 必须走 shell。但 Node 对 (shell:true + args 数组) 会发 DEP0190 警告污染输出，
  // 所以这里自己拼命令行、只传一个字符串。
  const useShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
  const spawnCmd = useShell ? [cmd, ...args].map(quoteWin).join(' ') : cmd;
  const spawnArgs = useShell ? [] : args;
  return new Promise((resolve, reject) => {
    const p = spawn(spawnCmd, spawnArgs, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: useShell, ...opts,
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`${path.basename(cmd)} 无法启动: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else {
        const e = new Error(`${path.basename(cmd)} 退出码 ${code}`);
        e.out = out; e.err = err;
        reject(e);
      }
    });
  });
}

/** 递归收集 .java */
async function collectJava(dir) {
  const out = [];
  async function walk(d) {
    for (const it of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.name.endsWith('.java')) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

/** 递归收集资源文件（相对 res/ 的路径） */
async function collectRes(dir) {
  const out = [];
  async function walk(d, rel) {
    for (const it of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(p, r);
      else out.push({ abs: p, rel: r });
    }
  }
  await walk(dir, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function ensureKeystore(javaHome, ksDir) {
  const ks = path.join(ksDir, 'bootanimforge-debug.jks');
  if (fs.existsSync(ks)) return ks;
  await fsp.mkdir(ksDir, { recursive: true });
  const keytool = path.join(javaHome, 'bin', 'keytool.exe');
  console.log('  · 生成调试签名密钥…');
  await run(keytool, [
    '-genkeypair', '-v',
    '-keystore', ks,
    '-alias', 'bootanimforge',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
    '-storepass', 'bootanimforge', '-keypass', 'bootanimforge',
    '-dname', 'CN=BootAnimForge, OU=Android, O=Baimacao, L=, ST=, C=CN',
  ]);
  return ks;
}

async function main() {
  const argv = process.argv.slice(2);
  const release = argv.includes('--release');
  const outDir = (() => {
    const i = argv.indexOf('--out');
    return i >= 0 && argv[i + 1] ? path.resolve(ROOT, argv[i + 1]) : path.join(ROOT, 'dist', 'android');
  })();

  /* ---------- 环境检查 ---------- */
  const sdk = findSdk();
  if (!sdk) throw new Error('找不到 Android SDK（需要 platform/android.jar）');
  const bt = findBuildTools(sdk);
  if (!bt) throw new Error('找不到可用的 build-tools（需要 aapt2/d8/zipalign/apksigner）');
  const javaHome = findJavaHome();
  if (!javaHome) throw new Error('找不到 JDK（需要 javac）');

  const androidJar = path.join(sdk, 'platform', 'android.jar');
  const aapt2 = path.join(bt, 'aapt2.exe');
  const d8 = path.join(bt, 'd8.bat');
  const zipalign = path.join(bt, 'zipalign.exe');
  const apksigner = path.join(bt, 'apksigner.bat');
  const javac = path.join(javaHome, 'bin', 'javac.exe');

  const pkgJson = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  console.log('Android 构建（无 Gradle）');
  console.log(`  SDK        ${sdk}`);
  console.log(`  build-tools ${path.basename(bt)}`);
  console.log(`  JDK        ${path.basename(javaHome)}`);
  console.log(`  版本       ${pkgJson.version}`);

  const manifest = path.join(PROJ, 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) throw new Error('缺少 android/AndroidManifest.xml');

  await fsp.rm(BUILD, { recursive: true, force: true });
  await fsp.mkdir(BUILD, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });

  /* ---------- 1. aapt2 compile 资源 ---------- */
  const resDir = path.join(PROJ, 'res');
  const flatDir = path.join(BUILD, 'flat');
  await fsp.mkdir(flatDir, { recursive: true });
  const resFiles = fs.existsSync(resDir) ? await collectRes(resDir) : [];
  if (resFiles.length) {
    const resOut = path.join(BUILD, 'res.zip');
    const args = ['compile', '--dir', resDir, '-o', resOut];
    await run(aapt2, args);
    console.log(`  · 资源已编译（${resFiles.length} 个文件）`);
    // aapt2 compile --dir 输出的是 zip，link 时直接给它
    var compiledRes = resOut;
  } else {
    var compiledRes = null;
  }

  /* ---------- 2. javac ---------- */
  const srcDir = path.join(PROJ, 'src');
  const sources = await collectJava(srcDir);
  if (!sources.length) throw new Error('android/src 下没有 .java');
  const classesDir = path.join(BUILD, 'classes');
  await fsp.mkdir(classesDir, { recursive: true });
  const argFile = path.join(BUILD, 'javac.args');
  await fsp.writeFile(argFile, [
    '-source', '8', '-target', '8',
    '-encoding', 'UTF-8',
    '-bootclasspath', androidJar,
    '-classpath', androidJar,
    '-d', classesDir,
    ...sources,
  ].map((s) => (/\s/.test(s) ? `"${s}"` : s)).join('\n'), 'utf8');
  // 注意：-J 开头的 JVM 选项不能出现在 @argfile 里（javac 会报"无效的标记"），
  // 只能放在命令行上。这里用 -J 让诊断输出英文，避免中文乱码影响判读。
  await run(javac, ['-J-Duser.language=en', '-J-Duser.country=US', `@${argFile}`]);
  console.log(`  · Java 已编译（${sources.length} 个源文件）`);

  /* ---------- 3. d8 ---------- */
  const dexDir = path.join(BUILD, 'dex');
  await fsp.mkdir(dexDir, { recursive: true });
  // d8 不接受「目录」作为 program input（会报 Unsupported source file type），
  // 而把几百个 .class 逐个当参数传又会超出 Windows 命令行长度。
  // 所以先用自己的 zip 写入器把 class 打成一个 jar，只给它一个参数。
  const classJar = path.join(BUILD, 'classes.jar');
  {
    const { createZipWriter } = require('../src/zip.js');
    const zip = createZipWriter({ file: classJar, compress: false });
    const base = classesDir;
    (function walk(d) {
      for (const it of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) walk(p);
        else if (it.name.endsWith('.class')) zip.add(path.relative(base, p).split(path.sep).join('/'), fs.readFileSync(p));
      }
    })(base);
    zip.finish();
  }
  // 本仓库与 SDK 路径都不含空格；d8 的 argfile 不去引号，所以只能无引号传参
  const withSpace = [androidJar, classJar, dexDir].filter((p) => /\s/.test(p));
  if (withSpace.length) {
    throw new Error('路径含空格，d8 无法处理：' + withSpace.join('、') +
      '\n请把项目或 SDK 移到不含空格的路径，或改用 Gradle 构建。');
  }
  await run(d8, [
    '--release', '--min-api', '19',
    '--lib', androidJar,
    '--output', dexDir,
    classJar,
  ]);
  const dexFiles = fs.readdirSync(dexDir).filter((f) => f.endsWith('.dex'));
  if (!dexFiles.length) throw new Error('d8 没有产出 dex');
  console.log(`  · 已 dex（${dexFiles.length} 个文件）`);

  /* ---------- 4. aapt2 link（含 dex，产出未签名 APK） ---------- */
  const unsigned = path.join(BUILD, 'unsigned.apk');
  const linkArgs = [
    'link',
    '-o', unsigned,
    '--manifest', manifest,
    '-I', androidJar,
    '--java', path.join(BUILD, 'gen'),
    '--min-sdk-version', '19',
    '--target-sdk-version', '30',
    '--version-code', String(pkgJson.versionCode || 110),
    '--version-name', pkgJson.version,
    '--auto-add-overlay',
  ];
  if (compiledRes) linkArgs.push(compiledRes);
  const dexList = fs.readdirSync(path.join(BUILD, 'dex')).filter((f) => f.endsWith('.dex'));
  linkArgs.push('--no-version-vectors');
  await run(aapt2, linkArgs);
  console.log('  · 资源已链接');

  /* ---------- 5. 把 dex 塞进 APK（aapt2 不会自动加，用 zip 追加） ---------- */
  const { createZipWriter, readZip } = require('../src/zip.js');
  const withDex = path.join(BUILD, 'with-dex.apk');
  {
    const base = await readZip(unsigned);
    const zip = createZipWriter({ file: withDex, compress: true });
    // classes.dex 必须放在最前，并以 STORE 存放（Android 加载器要求）
    for (const f of dexList.sort()) {
      zip.add(f, await fsp.readFile(path.join(BUILD, 'dex', f)), { store: true });
    }
    for (const [name, buf] of base) {
      if (/^classes\d*\.dex$/.test(name)) continue;   // 避免重复
      zip.add(name, buf);
    }
    zip.finish();
    console.log(`  · 已写入 ${dexList.length} 个 dex`);
  }

  /* ---------- 6. zipalign ---------- */
  const aligned = path.join(BUILD, 'aligned.apk');
  await run(zipalign, ['-f', '-p', '4', withDex, aligned]);
  console.log('  · 已 4 字节对齐');

  /* ---------- 7. 签名 ---------- */
  const ksDir = path.join(ROOT, '.work', 'keys');
  const ks = release && fs.existsSync(path.join(ksDir, 'release.jks'))
    ? path.join(ksDir, 'release.jks')
    : await ensureKeystore(javaHome, ksDir);
  const ksPass = release ? (process.env.BAF_KS_PASS || '') : 'bootanimforge';
  const ksAlias = release ? (process.env.BAF_KS_ALIAS || 'bootanimforge') : 'bootanimforge';

  const apkName = `BootAnimForge-Android-${pkgJson.version}${release ? '' : '-debug'}.apk`;
  const finalApk = path.join(outDir, apkName);
  await fsp.rm(finalApk, { force: true });
  await run(apksigner, [
    'sign',
    '--ks', ks,
    '--ks-pass', `pass:${ksPass}`,
    '--key-pass', `pass:${ksPass}`,
    '--ks-key-alias', ksAlias,
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    '--out', finalApk,
    aligned,
  ]);
  console.log('  · 已签名（v1+v2+v3，兼容 Android 4.4 起）');

  /* ---------- 8. 自检 ---------- */
  const verify = await run(apksigner, ['verify', '--verbose', finalApk]).catch((e) => ({ out: e.out || '', err: e.err || '' }));
  const stat = await fsp.stat(finalApk);
  const z = await readZip(finalApk);
  const names = [...z.keys()];
  const report = {
    apk: finalApk,
    size: stat.size,
    entries: names.length,
    hasManifest: names.includes('AndroidManifest.xml'),
    dex: names.filter((n) => /^classes\d*\.dex$/.test(n)),
    resCount: names.filter((n) => n.startsWith('res/')).length,
    signatureFiles: names.filter((n) => /^META-INF\/.*\.(RSA|SF|MF)$/i.test(n)).length,
    verified: /Verified using v1 scheme|Verified using v2 scheme|Verified using v3 scheme/.test(verify.out + verify.err),
  };
  console.log('\n=== APK 自检 ===');
  console.log(`  文件      ${report.apk}`);
  console.log(`  大小      ${(report.size / 1024).toFixed(1)} KB`);
  console.log(`  条目      ${report.entries}（资源 ${report.resCount}）`);
  console.log(`  dex       ${report.dex.join(', ') || '缺少！'}`);
  console.log(`  清单      ${report.hasManifest ? '有' : '缺少！'}`);
  console.log(`  签名文件  ${report.signatureFiles} 个`);
  console.log(`  签名校验  ${report.verified ? '通过' : '未确认'}`);
  if (!report.hasManifest || !report.dex.length) {
    throw new Error('APK 结构不完整');
  }
  console.log('\n完成。安装：adb install -r "' + finalApk + '"');
}

main().catch((e) => {
  console.error('\n构建失败：' + e.message);
  if (e.err) console.error((e.err + e.out || '').split(/\r?\n/).slice(0, 40).join('\n'));
  process.exit(1);
});
