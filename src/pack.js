'use strict';
/**
 * pack.js — 打包层
 *
 *   1. classic  ：传统开机动画 —— desc.txt + partN/ 帧图片，整体打成 bootanimation.zip
 *   2. video    ：Android 12+ 视频版 —— bootanimation.mp4 (+ audio.mp3)，直接放进媒体目录
 *   3. magisk   ：Magisk 模块 zip —— 内含上面任意一种，可直接刷入
 *
 * Magisk 模块规范要点：
 *   · zip 根目录放 module.prop / customize.sh，系统文件放在 system/ 下（镜像 /system）
 *   · 由 Magisk 挂载到系统，不动真实分区，可随时卸载
 *   · 权限由 set_perm_recursive / chmod 设置
 */

const fsp = require('fs/promises');
const { createZipWriter } = require('./zip');
const { safeName } = require('./util');

/** 常见 bootanimation 文件在系统里的路径（按出现频率排序） */
const SYSTEM_PATHS = [
  { dir: 'system/media', label: '/system/media', note: '最常见' },
  { dir: 'system/product/media', label: '/product/media', note: 'Android 10+ 常见' },
  { dir: 'system/oem/media', label: '/oem/media', note: '部分厂商' },
];

/**
 * @param {object} o
 *   o.outFile    输出 zip 路径
 *   o.files      [{ name, buffer }] 要放进每个目标目录的载荷文件
 *                （传统格式：bootanimation.zip；视频格式：bootanimation.mp4 [+ audio.mp3]）
 *   o.id,name,version,versionCode,author,description
 *   o.pathKey    写入哪个系统路径（SYSTEM_PATHS[].dir），默认 system/media
 *   o.allPaths   是否在多个路径都放一份（更保险，体积翻倍）
 *   o.withReadme 是否附带中文说明
 *   o.kind       'classic' | 'video'（只用于文案）
 */
async function buildMagiskModule(o) {
  const files = (o.files || []).filter((f) => f && f.buffer && f.name);
  if (!files.length) throw new Error('Magisk 模块没有任何载荷文件');

  const zip = createZipWriter({ file: o.outFile, compress: true });

  const id = safeName(o.id || 'bootanimforge_bootanimation', 'bootanimforge_bootanimation')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const version = String(o.version || '1.0.0');
  const versionCode = Number(o.versionCode) || Math.round(parseFloat(String(version).replace(/[^\d.]/g, '')) * 100) || 1;
  const name = String(o.name || '开机动画').slice(0, 60);
  const author = String(o.author || 'BootAnimForge').slice(0, 40);
  const description = String(o.description || '由开机动画工坊生成的 Magisk 开机动画模块').slice(0, 200);
  const kindText = o.kind === 'video' ? '视频版（Android 12+）' : '传统帧序列版';

  const targets = o.allPaths ? SYSTEM_PATHS.map((p) => p.dir) : [o.pathKey || 'system/media'];
  const fileNames = files.map((f) => f.name);

  /* --- module.prop --- */
  const prop = [
    `id=${id}`,
    `name=${name}`,
    `version=${version}`,
    `versionCode=${versionCode}`,
    `author=${author}`,
    `description=${description}`,
  ].join('\n') + '\n';
  zip.add('module.prop', prop);

  /* --- customize.sh：设置权限 --- */
  const permLines = targets.flatMap((t) => [
    `set_perm_recursive $MODPATH/${t} 0 0 0755 0644`,
    ...fileNames.map((f) => `[ -f $MODPATH/${t}/${f} ] && chmod 0644 $MODPATH/${t}/${f}`),
  ]);
  const printLines = targets.flatMap((t) => fileNames.map((f) =>
    `[ -f $MODPATH/${t}/${f} ] && ui_print "    /${t.replace(/^system\//, '')}/${f}"`));

  const cust = `#!/system/bin/sh
# 开机动画工坊 · BootAnimForge 生成的 Magisk 模块
# 载荷：${fileNames.join('、')}（${kindText}）
SKIPUNZIP=0

set_perm_recursive $MODPATH 0 0 0755 0644
${permLines.join('\n')}

ui_print " "
ui_print "- 开机动画已就位："
${printLines.join('\n')}
ui_print "- 重启后生效；卸载本模块即恢复原动画"
ui_print " "
`;
  zip.add('customize.sh', cust);

  /* --- README（可选） --- */
  if (o.withReadme !== false) {
    const readme = `开机动画工坊 · BootAnimForge
================================

模块名：${name}
版本：${version}（versionCode ${versionCode}）
作者：${author}
格式：${kindText}

这个模块做了什么
----------------
把 ${fileNames.join('、')} 通过 Magisk 挂载到：

${targets.map((t) => `  /${t.replace(/^system\//, '')}/${fileNames.join('、')}`).join('\n')}

因为是挂载，不修改真实系统分区，所以：

  · 卸载模块即可恢复系统原来的开机动画
  · 不受 OTA 影响
  · 不需要手动改权限

怎么用
------
1. 打开 Magisk App → 模块 → 从本地安装
2. 选择这个 zip，安装完成后重启
3. 若开机看不到动画，进 Magisk 卸载本模块再重启即可恢复

注意事项
--------
· 开机动画文件本身若有问题，可能导致开机阶段黑屏（系统仍会正常启动）
· 不同厂商系统读取的路径不同，本模块已按常见路径布置
· 建议先确认设备原本的 bootanimation 文件位置
${o.kind === 'video' ? '· 视频版格式只被 Android 12+ 的部分机型识别；若设备仍在用传统格式，请改用传统帧序列版\n' : ''}`;
    zip.add('README.txt', readme);
  }

  /* --- 载荷：每个目标路径下都放一份 --- */
  for (const t of targets) {
    for (const f of files) {
      zip.add(`${t}/${f.name}`, f.buffer);
    }
  }

  const stat = zip.finish();
  return {
    file: o.outFile,
    entries: stat.entries,
    bytes: stat.bytes,
    id,
    files: fileNames,
    targets,
  };
}

module.exports = { buildMagiskModule, SYSTEM_PATHS };
