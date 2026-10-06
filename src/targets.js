'use strict';
/**
 * targets.js — 开机 / 关机动画的目标定义（双端一致的一份来源）
 *
 * 两者**格式完全相同**（desc.txt + partN 帧，或 Android 12+ 的视频版 mp4），
 * 区别只在落位的文件名与目录：
 *
 *   开机：bootanimation.zip     → /system/media、/product/media、/oem/media …
 *   关机：shutdownanimation.zip → 同上目录
 *
 * 关机动画建议用 c（必须播完）：系统关闭前要保证整段播完，用 p 可能播一半就被掐掉。
 *
 * 注意：关机动画的路径与文件名没有 AOSP 级的统一规范，各厂商自定义较多，
 * 所以这里列的是常见值。安卓端允许用户手动挑选路径。
 */

const TARGETS = {
  boot: {
    id: 'boot',
    label: '开机动画',
    zipName: 'bootanimation.zip',
    videoName: 'bootanimation.mp4',
    magiskId: 'bootanimforge_bootanimation',
    partType: 'p',
    paths: [
      { dir: 'system/media', label: '/system/media', note: '最常见' },
      { dir: 'system/product/media', label: '/product/media', note: 'Android 10+ 常见' },
      { dir: 'system/oem/media', label: '/oem/media', note: '部分厂商' },
    ],
    absCandidates: [
      '/system/media/bootanimation.zip',
      '/product/media/bootanimation.zip',
      '/system/product/media/bootanimation.zip',
      '/oem/media/bootanimation.zip',
      '/system/oem/media/bootanimation.zip',
    ],
  },
  shutdown: {
    id: 'shutdown',
    label: '关机动画',
    zipName: 'shutdownanimation.zip',
    videoName: 'shutdownanimation.mp4',
    magiskId: 'bootanimforge_shutdownanimation',
    partType: 'c',
    paths: [
      { dir: 'system/media', label: '/system/media', note: '最常见' },
      { dir: 'system/product/media', label: '/product/media', note: 'Android 10+ 常见' },
      { dir: 'system/oem/media', label: '/oem/media', note: '部分厂商' },
    ],
    absCandidates: [
      '/system/media/shutdownanimation.zip',
      '/product/media/shutdownanimation.zip',
      '/system/product/media/shutdownanimation.zip',
      '/oem/media/shutdownanimation.zip',
      '/system/oem/media/shutdownanimation.zip',
    ],
  },
};

/** 规范化：非法值一律回落到 boot */
function getTarget(id) {
  return TARGETS[id] === TARGETS.shutdown ? TARGETS.shutdown : TARGETS.boot;
}

const TARGET_LIST = [TARGETS.boot, TARGETS.shutdown];

module.exports = { TARGETS, TARGET_LIST, getTarget };
