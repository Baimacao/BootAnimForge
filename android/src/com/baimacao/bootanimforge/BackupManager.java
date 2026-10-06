package com.baimacao.bootanimforge;

import android.content.Context;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * BackupManager —— 备份与还原。
 *
 * 为什么要做：替换开机动画最坏的结果是「开机看不到动画」（系统仍能启动）。
 * 这时候如果手上没有原文件，用户就只能去找 ROM 包重新提取。
 * 所以每次安装前强制备份一份到应用目录，并固定一个「首次备份」，
 * 保证任何时候都能退回出厂状态。
 *
 * 备份位置选应用外部私有目录（/sdcard/Android/data/<pkg>/files/backup）：
 *   · root 可以直接读，方便还原
 *   · 不需要任何存储权限
 *   · 卸载应用时会被一起清掉（这是有意的，不留垃圾）
 */
final class BackupManager {

    private static final String DIR = "backup";
    private static final String FIRST = "origin-first.zip";
    private static final int MAX_BACKUPS = 8;

    private BackupManager() { }

    private static File dir(Context c) {
        File base = c.getExternalFilesDir(null);
        if (base == null) base = c.getFilesDir();
        File d = new File(base, DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /**
     * 备份当前动画。
     * @return 给用户看的一行说明
     */
    static String backup(Context c, String sourcePath, BootScanner.Found active) {
        if (sourcePath == null) return "跳过备份：没有确定当前动画路径";
        RootShell.FileInfo fi = RootShell.statFile(sourcePath);
        if (!fi.exists) return "跳过备份：" + sourcePath + " 不存在（首次安装）";

        File d = dir(c);
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        File out = new File(d, "bootanimation-" + stamp + ".zip");

        RootShell.Result r = RootShell.pullTo(sourcePath, out.getAbsolutePath());
        if (!r.ok() || !out.exists() || out.length() == 0) {
            return "备份失败（不影响安装）：" + r.text();
        }

        // 第一次备份额外留一份"原始"，永不被轮转删除
        File first = new File(d, FIRST);
        if (!first.exists()) {
            try {
                copyFile(out, first);
            } catch (Throwable ignored) { }
        }

        rotate(d);
        return "已备份原动画到 " + out.getName() + "（" + BootCore.mb(out.length()) + "）";
    }

    /** 按时间倒序列出备份，含首次备份 */
    static List<File> list(Context c) {
        List<File> out = new ArrayList<File>();
        File d = dir(c);
        File[] files = d.listFiles();
        if (files == null) return out;
        Arrays.sort(files, new Comparator<File>() {
            public int compare(File a, File b) {
                return Long.valueOf(b.lastModified()).compareTo(Long.valueOf(a.lastModified()));
            }
        });
        for (File f : files) {
            if (f.isFile() && f.getName().endsWith(".zip") && f.length() > 0) out.add(f);
        }
        // 首次备份永远排最前，方便一眼找到
        File first = new File(d, FIRST);
        if (first.exists()) {
            out.remove(first);
            out.add(0, first);
        }
        return out;
    }

    /** 还原某个备份到指定路径 */
    static RootShell.Result restore(File backup, String dest) {
        if (backup == null || !backup.exists()) {
            return new RootShell.Result(1, "", "备份文件不存在");
        }
        String ctx = dest.startsWith("/product") || dest.startsWith("/system/product")
                ? "u:object_r:system_file:s0" : "u:object_r:system_file:s0";
        return RootShell.installFile(backup.getAbsolutePath(), dest, ctx);
    }

    /** 只保留最近若干个，但首次备份不动 */
    private static void rotate(File d) {
        File[] files = d.listFiles();
        if (files == null) return;
        List<File> all = new ArrayList<File>();
        for (File f : files) {
            if (f.isFile() && f.getName().startsWith("bootanimation-") && f.getName().endsWith(".zip")) all.add(f);
        }
        if (all.size() <= MAX_BACKUPS) return;
        java.util.Collections.sort(all, new Comparator<File>() {
            public int compare(File a, File b) {
                return Long.valueOf(a.lastModified()).compareTo(Long.valueOf(b.lastModified()));
            }
        });
        for (int i = 0; i < all.size() - MAX_BACKUPS; i++) all.get(i).delete();
    }

    private static void copyFile(File src, File dst) throws Exception {
        java.io.InputStream in = new java.io.FileInputStream(src);
        java.io.OutputStream out = new java.io.FileOutputStream(dst);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush(); out.close(); in.close();
    }
}
