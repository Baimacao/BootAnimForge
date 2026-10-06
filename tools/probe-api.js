'use strict';
/** probe-api.js — 用 javap 查 android.jar 里的 API 细节（避免猜） */
const { execFileSync } = require('child_process');
const path = require('path');

const JAVA_HOME = process.env.JAVA_HOME || 'E:\\Program Files\\Java\\jdk-21.0.10';
const JAVAP = path.join(JAVA_HOME, 'bin', 'javap.exe');
const AJAR = 'E:\\B1807\\Documents\\DSH\\sdk\\platform\\android.jar';

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('用法: node tools/probe-api.js <类名> [...]');
  process.exit(1);
}
for (const t of targets) {
  console.log('\n=== ' + t + ' ===');
  try {
    const out = execFileSync(JAVAP, ['-classpath', AJAR, t], { encoding: 'utf8' });
    console.log(out.trim().split('\n').filter((l) => /public|static|final/.test(l)).join('\n'));
  } catch (e) {
    console.log('查不到：' + (e.stderr || e.message).toString().split('\n')[0]);
  }
}
