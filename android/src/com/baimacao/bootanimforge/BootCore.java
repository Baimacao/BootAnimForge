package com.baimacao.bootanimforge;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * BootCore —— 开机动画包的解析与校验（纯 JDK，无 Android 依赖）。
 *
 * 为什么单独抽出来：这段逻辑是整个 App 里最容易出错、也最值得测的部分
 * （判断错格式 = 装错 = 开机黑屏）。它只用到 java.util.zip，所以可以在 PC 上
 * 直接跑测试，不必依赖真机。App 侧只负责把结果显示出来。
 */
public final class BootCore {

    public static final int KIND_CLASSIC = 1;
    public static final int KIND_VIDEO = 2;
    public static final int KIND_UNKNOWN = 0;

    public static final class FrameInfo {
        public final String dir;
        public final int count;
        public final int minNo;
        public final int maxNo;
        public final boolean numbered;
        FrameInfo(String dir, int count, int minNo, int maxNo, boolean numbered) {
            this.dir = dir; this.count = count; this.minNo = minNo; this.maxNo = maxNo; this.numbered = numbered;
        }
        public String range() {
            if (!numbered || count == 0) return "—";
            return minNo + "–" + maxNo;
        }
    }

    public static final class Report {
        public int kind = KIND_UNKNOWN;
        public boolean valid;
        public boolean moovFirst;
        public int width, height, fps;
        public boolean hasProgress;
        public int totalFrames;
        public long totalFrameBytes;
        public final List<FrameInfo> parts = new ArrayList<FrameInfo>();
        public final List<String> partLines = new ArrayList<String>();
        public final List<String> errors = new ArrayList<String>();
        public final List<String> warnings = new ArrayList<String>();
        public final List<String> notes = new ArrayList<String>();

        public String kindLabel() {
            if (kind == KIND_CLASSIC) return "传统帧序列版";
            if (kind == KIND_VIDEO) return "视频版（Android 12+）";
            return "无法识别";
        }
    }

    private BootCore() { }

    /** 校验一个本地 zip 文件 */
    public static Report validate(File zip) {
        Report r = new Report();
        if (zip == null || !zip.exists()) { r.errors.add("文件不存在"); return r; }
        if (!zip.canRead()) { r.errors.add("文件不可读（可能没有存储权限）"); return r; }
        if (zip.length() < 100) { r.errors.add("文件太小，不像是开机动画包"); return r; }

        ZipFile zf;
        try {
            zf = new ZipFile(zip);
        } catch (IOException e) {
            r.errors.add("不是有效的 zip：" + e.getMessage());
            return r;
        }

        try {
            Map<String, ZipEntry> entries = new HashMap<String, ZipEntry>();
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                entries.put(e.getName(), e);
            }

            boolean hasDesc = entries.containsKey("desc.txt");
            boolean hasMp4 = entries.containsKey("bootanimation.mp4");
            boolean hasMp3 = entries.containsKey("audio.mp3");

            if (hasMp4) {
                r.kind = KIND_VIDEO;
                ZipEntry e = entries.get("bootanimation.mp4");
                long size = e.getSize();
                if (size <= 0) r.warnings.add("bootanimation.mp4 大小未知");
                else if (size > 60L * 1024 * 1024) r.warnings.add("视频体积偏大（" + mb(size) + "），开机解码可能吃力");
                if (hasMp3) r.notes.add("包含独立音轨 audio.mp3");
                try {
                    r.moovFirst = moovIsFirst(zf, e);
                    if (!r.moovFirst) r.warnings.add("moov 不在文件头：开机需要读完整个视频才能出画面，建议用「开机动画工坊」PC 版重新导出");
                    else r.notes.add("moov 在文件头（起播快）");
                } catch (Throwable ignored) { }
                if (hasDesc) r.notes.add("同时含 desc.txt —— 新旧混合包，系统读哪个取决于机型");
                r.valid = true;
            } else if (hasDesc) {
                r.kind = KIND_CLASSIC;
                parseDesc(zf, entries.get("desc.txt"), r);
                collectFrames(entries, r);
                if (r.width <= 0 || r.height <= 0 || r.fps <= 0) {
                    r.errors.add("desc.txt 第一行不是合法的「宽 高 帧率」");
                }
                if (r.parts.isEmpty()) {
                    r.errors.add("desc.txt 里没有任何 part 段，或者对应的帧目录是空的");
                }
                r.valid = r.errors.isEmpty();
            } else {
                r.kind = KIND_UNKNOWN;
                r.errors.add("zip 根目录既没有 desc.txt，也没有 bootanimation.mp4 —— 不是开机动画包");
                boolean nested = false;
                for (String n : entries.keySet()) {
                    if (n.endsWith("/desc.txt") || n.endsWith("/bootanimation.mp4")) { nested = true; break; }
                }
                if (nested) r.errors.add("看起来多套了一层目录：zip 根目录必须直接是 desc.txt / partN");
            }

            if (r.kind == KIND_CLASSIC && r.valid) {
                r.notes.add("共 " + r.totalFrames + " 帧（压前约 " + (r.totalFrameBytes / 1048576) + " MB / 包 " + mb(zip.length()) + "）");
                if (r.totalFrames > 4000) r.warnings.add("总帧数偏多（" + r.totalFrames + "），低端机开机解包会明显变慢");
                if (r.width * r.height > 1920 * 1080) r.notes.add("分辨率 " + r.width + "×" + r.height + "，属于大尺寸");
            }
        } catch (Throwable t) {
            r.errors.add("校验时出错：" + t.getMessage());
        } finally {
            try { zf.close(); } catch (IOException ignored) { }
        }
        return r;
    }

    private static void parseDesc(ZipFile zf, ZipEntry e, Report r) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(zf.getInputStream(e), "UTF-8"));
        String line;
        int no = 0;
        while ((line = br.readLine()) != null) {
            line = line.trim();
            if (line.length() == 0 || line.startsWith("#")) continue;
            no++;
            if (no == 1) {
                String[] p = line.split("\\s+");
                if (p.length >= 3) {
                    try {
                        r.width = Integer.parseInt(p[0]);
                        r.height = Integer.parseInt(p[1]);
                        r.fps = Integer.parseInt(p[2]);
                        r.hasProgress = p.length >= 4 && !"0".equals(p[3]);
                    } catch (NumberFormatException ignored) { }
                }
                r.notes.add("desc.txt 首行：" + line);
            } else {
                r.partLines.add(line);
            }
        }
        br.close();
    }

    private static void collectFrames(Map<String, ZipEntry> entries, Report r) {
        Map<String, List<String>> byDir = new HashMap<String, List<String>>();
        for (Map.Entry<String, ZipEntry> en : entries.entrySet()) {
            String name = en.getKey();
            if (en.getValue().isDirectory()) continue;
            int i = name.lastIndexOf('/');
            if (i <= 0) continue;
            String dir = name.substring(0, i);
            String file = name.substring(i + 1);
            String lower = file.toLowerCase(Locale.US);
            if (lower.equals("audio.wav") || lower.equals("trim.txt")) continue;
            if (!(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg"))) continue;
            List<String> l = byDir.get(dir);
            if (l == null) { l = new ArrayList<String>(); byDir.put(dir, l); }
            l.add(file);
            r.totalFrames++;
            r.totalFrameBytes += en.getValue().getSize() > 0 ? en.getValue().getSize() : 0;
        }

        for (String line : r.partLines) {
            String[] p = line.split("\\s+");
            if (p.length < 4) {
                r.warnings.add("有无法解析的段定义：" + line);
                continue;
            }
            String dir = p[3];
            List<String> files = byDir.get(dir);
            int count = files == null ? 0 : files.size();
            int minNo = Integer.MAX_VALUE, maxNo = Integer.MIN_VALUE;
            boolean numbered = count > 0;
            if (count > 0) {
                for (String f : files) {
                    Integer n = frameNumberOf(f);
                    if (n == null) { numbered = false; continue; }
                    if (n.intValue() < minNo) minNo = n.intValue();
                    if (n.intValue() > maxNo) maxNo = n.intValue();
                }
            }
            if (count == 0) {
                r.errors.add("desc.txt 引用了 " + dir + "，但 zip 里没有对应的帧文件");
            } else if (!numbered) {
                r.warnings.add(dir + " 里有文件名不含数字的帧，排序可能不稳定");
            } else if (maxNo - minNo + 1 != count) {
                r.warnings.add(dir + " 的帧编号不连续（" + count + " 个文件，编号 " + minNo + "–" + maxNo +
                        "）：某些系统会读不到帧，建议重新导出");
            } else {
                r.notes.add(dir + "：" + count + " 帧，编号 " + minNo + "–" + maxNo + "（连续）");
            }
            r.parts.add(new FrameInfo(dir, count, count > 0 ? minNo : 0, count > 0 ? maxNo : 0, numbered));
        }
    }

    /** 取文件名里最后一段连续数字 */
    public static Integer frameNumberOf(String fileName) {
        String base = fileName;
        int dot = base.lastIndexOf('.');
        if (dot > 0) base = base.substring(0, dot);
        int end = -1;
        for (int i = base.length() - 1; i >= 0; i--) {
            if (Character.isDigit(base.charAt(i))) { end = i; break; }
        }
        if (end < 0) return null;
        int start = end;
        while (start > 0 && Character.isDigit(base.charAt(start - 1))) start--;
        try {
            return Integer.valueOf(Integer.parseInt(base.substring(start, end + 1)));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** mp4 的 moov 是否在 mdat 之前（只读开头 2 MB） */
    private static boolean moovIsFirst(ZipFile zf, ZipEntry e) throws IOException {
        InputStream in = zf.getInputStream(e);
        try {
            int limit = (int) Math.min(e.getSize() > 0 ? e.getSize() : (2L * 1024 * 1024), 2L * 1024 * 1024);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(1024, Math.min(limit, 1 << 20)));
            byte[] buf = new byte[8192];
            int total = 0, n;
            while (total < limit && (n = in.read(buf, 0, Math.min(buf.length, limit - total))) > 0) {
                bos.write(buf, 0, n);
                total += n;
            }
            byte[] data = bos.toByteArray();
            int moov = indexOf(data, "moov");
            int mdat = indexOf(data, "mdat");
            if (moov < 0) return false;
            if (mdat < 0) return true;
            return moov < mdat;
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }

    private static int indexOf(byte[] hay, String needle) {
        byte[] n = needle.getBytes();
        outer:
        for (int i = 0; i + n.length <= hay.length; i++) {
            for (int j = 0; j < n.length; j++) if (hay[i + j] != n[j]) continue outer;
            return i;
        }
        return -1;
    }

    public static String mb(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024) + " KB";
        return String.format(Locale.US, "%.1f MB", bytes / 1048576.0);
    }
}
