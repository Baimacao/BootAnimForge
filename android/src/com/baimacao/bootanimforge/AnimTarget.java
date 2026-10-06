package com.baimacao.bootanimforge;

import java.util.ArrayList;
import java.util.List;

/**
 * AnimTarget —— 开机 / 关机动画的路径与命名规则。
 *
 * 两者**格式完全相同**（desc.txt + partN 帧，或 bootanimation.mp4 那种视频版），
 * 区别只在落位的文件名与目录：
 *
 *   开机：bootanimation.zip     /system/media、/product/media、/oem/media …
 *   关机：shutdownanimation.zip 同上目录
 *
 * 关机动画的 desc.txt 建议用 c（必须播完）—— 系统关闭前要保证整段播完，
 * 用 p 的话可能刚播一半就被掐掉。
 *
 * 注意：关机动画的路径与文件名没有 AOSP 级的统一规范，各厂商自定义较多，
 * 所以这里列的是常见值，用户仍可手动挑选路径。
 */
final class AnimTarget {

    static final int BOOT = 0;
    static final int SHUTDOWN = 1;

    private AnimTarget() { }

    static String label(int target) {
        return target == SHUTDOWN ? "关机动画" : "开机动画";
    }

    static String fileName(int target) {
        return target == SHUTDOWN ? "shutdownanimation.zip" : "bootanimation.zip";
    }

    /** 视频版（Android 12+）的文件名 */
    static String videoFileName(int target) {
        return target == SHUTDOWN ? "shutdownanimation.mp4" : "bootanimation.mp4";
    }

    /** 候选绝对路径，按出现频率排序 */
    static String[] candidates(int target) {
        if (target == SHUTDOWN) {
            return new String[] {
                    "/system/media/shutdownanimation.zip",
                    "/product/media/shutdownanimation.zip",
                    "/system/product/media/shutdownanimation.zip",
                    "/oem/media/shutdownanimation.zip",
                    "/system/oem/media/shutdownanimation.zip",
                    "/vendor/media/shutdownanimation.zip",
                    "/system_ext/media/shutdownanimation.zip",
                    "/data/local/shutdownanimation.zip",
            };
        }
        return new String[] {
                "/system/media/bootanimation.zip",
                "/system/media/bootanimation-encrypted.zip",
                "/product/media/bootanimation.zip",
                "/system/product/media/bootanimation.zip",
                "/oem/media/bootanimation.zip",
                "/system/oem/media/bootanimation.zip",
                "/vendor/media/bootanimation.zip",
                "/system_ext/media/bootanimation.zip",
                "/data/local/bootanimation.zip",
                "/sdcard/media/bootanimation.zip",
        };
    }

    /** 常见安装目录（用于"路径不存在时新建"的候选项） */
    static List<String> dirs() {
        List<String> l = new ArrayList<String>();
        l.add("/system/media");
        l.add("/product/media");
        l.add("/system/product/media");
        l.add("/oem/media");
        l.add("/system/oem/media");
        l.add("/vendor/media");
        l.add("/system_ext/media");
        return l;
    }

    /** 在某个目录下这个目标的完整路径 */
    static String pathIn(String dir, int target) {
        return dir + "/" + fileName(target);
    }

    /** 从路径里判断是哪种目标（按文件名） */
    static int detectFromPath(String path) {
        if (path == null) return BOOT;
        return path.toLowerCase().contains("shutdown") ? SHUTDOWN : BOOT;
    }

    /** 哪些视频版文件名都算"合法载荷" */
    static boolean isVideoPayloadName(String name) {
        return "bootanimation.mp4".equals(name) || "shutdownanimation.mp4".equals(name);
    }
}
