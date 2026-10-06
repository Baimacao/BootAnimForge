package com.baimacao.bootanimforge;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * FramePreview —— 从动画包里取出几帧给用户看。
 *
 * 为什么需要：装上之后要重启才能知道效果，代价太大。
 * 预览能把 desc.txt 声明的分辨率/帧率、以及真实帧画面先摆出来，
 * 让用户在刷入前就能判断"这是不是我想要的东西"。
 *
 * 取帧策略：
 *   · 传统帧序列：按 part 目录，每段均匀取若干帧（首/中/尾）
 *   · 视频版 mp4：没法直接解，交给系统解码器抽一帧（简单起见先只报参数）
 */
final class FramePreview {

    static final class Frame {
        public final String label;      // 例如 "part0 · 001.png"
        public final Bitmap bitmap;
        Frame(String label, Bitmap bitmap) { this.label = label; this.bitmap = bitmap; }
    }

    static final class Result {
        public final List<Frame> frames = new ArrayList<Frame>();
        public String info = "";
        public String error;
        public boolean videoOnly;
    }

    private FramePreview() { }

    /** 每个 part 最多取几帧 */
    private static final int PER_PART = 3;

    static Result load(File zip, int maxFrames) {
        Result r = new Result();
        if (zip == null || !zip.exists()) { r.error = "文件不存在"; return r; }

        ZipFile zf = null;
        try {
            zf = new ZipFile(zip);

            // 先按 part 目录把帧文件分组（文件名里最后一段数字排序，与 BootCore 同规则）
            java.util.Map<String, List<String>> byDir = new java.util.TreeMap<String, List<String>>();
            boolean hasMp4 = false;
            String mp4Name = null;
            ZipEntry desc = null;

            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String name = e.getName();
                if (e.isDirectory()) continue;
                if ("desc.txt".equals(name)) { desc = e; continue; }
                String lower = name.toLowerCase(Locale.US);
                if (lower.endsWith(".mp4") && name.indexOf('/') < 0) { hasMp4 = true; mp4Name = name; continue; }
                if (name.indexOf('/') < 0) continue;
                if (!(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg"))) continue;
                int i = name.lastIndexOf('/');
                String dir = name.substring(0, i);
                String file = name.substring(i + 1);
                List<String> l = byDir.get(dir);
                if (l == null) { l = new ArrayList<String>(); byDir.put(dir, l); }
                l.add(file);
            }

            // desc.txt 摘要
            StringBuilder info = new StringBuilder();
            if (desc != null) {
                java.io.BufferedReader br = new java.io.BufferedReader(
                        new java.io.InputStreamReader(zf.getInputStream(desc), "UTF-8"));
                String line;
                int no = 0;
                while ((line = br.readLine()) != null) {
                    line = line.trim();
                    if (line.length() == 0) continue;
                    no++;
                    if (no == 1) {
                        String[] p = line.split("\\s+");
                        if (p.length >= 3) info.append(p[0]).append("×").append(p[1]).append(" @").append(p[2]).append("fps");
                    } else {
                        String[] p = line.split("\\s+");
                        if (p.length >= 4) {
                            info.append(info.length() > 0 ? "\n" : "")
                                .append(typeLabel(p[0])).append(" · ")
                                .append("0".equals(p[1]) ? "无限循环" : p[1] + " 次")
                                .append(" · ").append(p[3]);
                        }
                    }
                }
                br.close();
            }
            if (hasMp4) {
                r.videoOnly = true;
                info.append(info.length() > 0 ? "\n" : "").append("视频版：").append(mp4Name)
                    .append("（视频版无法直接预览单帧，装机后即为动态画面）");
            }
            r.info = info.toString();

            if (byDir.isEmpty()) {
                if (!hasMp4) r.error = "包里没有可预览的帧";
                return r;
            }

            int perPart = maxFrames <= 0 ? PER_PART : Math.max(1, Math.min(PER_PART, maxFrames / Math.max(1, byDir.size())));
            for (java.util.Map.Entry<String, List<String>> e : byDir.entrySet()) {
                List<String> files = e.getValue();
                sortByNumber(files);
                if (files.isEmpty()) continue;
                List<Integer> picks = pickIndexes(files.size(), perPart);
                for (Integer idx : picks) {
                    String fname = files.get(idx.intValue());
                    Bitmap bmp = decode(zf, e.getKey() + "/" + fname);
                    if (bmp != null) {
                        r.frames.add(new Frame(e.getKey() + " · " + fname, bmp));
                    }
                }
            }
            if (r.frames.isEmpty() && r.error == null) r.error = "帧解码失败";
            return r;
        } catch (Throwable t) {
            r.error = "读取失败：" + t.getMessage();
            return r;
        } finally {
            try { if (zf != null) zf.close(); } catch (Throwable ignored) { }
        }
    }

    private static String typeLabel(String t) {
        if ("c".equals(t)) return "必须播完";
        if ("f".equals(t)) return "被打断时淡出";
        return "可被打断";
    }

    /** 均匀取样：首 / 中 / 尾，帧少时去重 */
    private static List<Integer> pickIndexes(int count, int perPart) {
        List<Integer> out = new ArrayList<Integer>();
        if (count <= 0) return out;
        if (perPart <= 1 || count == 1) { out.add(Integer.valueOf(0)); return out; }
        for (int i = 0; i < perPart; i++) {
            int idx = (int) Math.round((double) i * (count - 1) / (perPart - 1));
            if (!out.contains(Integer.valueOf(idx))) out.add(Integer.valueOf(idx));
        }
        return out;
    }

    private static void sortByNumber(List<String> files) {
        java.util.Collections.sort(files, new java.util.Comparator<String>() {
            public int compare(String a, String b) {
                Integer na = BootCore.frameNumberOf(a);
                Integer nb = BootCore.frameNumberOf(b);
                if (na == null || nb == null) return a.compareTo(b);
                return na.intValue() - nb.intValue();
            }
        });
    }

    private static Bitmap decode(ZipFile zf, String entry) {
        InputStream in = null;
        try {
            ZipEntry e = zf.getEntry(entry);
            if (e == null) return null;
            in = zf.getInputStream(e);
            // 两段式解码：先读尺寸，再按需降采样，避免大帧直接把内存吃满
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(
                    (int) Math.max(1024, Math.min(e.getSize(), 4L * 1024 * 1024)));
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            byte[] data = bos.toByteArray();

            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, o);
            int sample = 1;
            int maxSide = 720;
            while (o.outWidth / (sample * 2) >= maxSide && o.outHeight / (sample * 2) >= maxSide) {
                sample *= 2;
            }
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = sample;
            o2.inPreferredConfig = Bitmap.Config.ARGB_8888;
            return BitmapFactory.decodeByteArray(data, 0, data.length, o2);
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }
    }

    /** 直接预览单个图片文件（用户从文件选来的） */
    static Result loadImage(File img) {
        Result r = new Result();
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(img.getAbsolutePath(), o);
            int sample = 1;
            while (o.outWidth / (sample * 2) >= 720 && o.outHeight / (sample * 2) >= 720) sample *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeFile(img.getAbsolutePath(), o2);
            if (bmp == null) r.error = "无法解码这张图片";
            else {
                r.frames.add(new Frame(img.getName(), bmp));
                r.info = o.outWidth + "×" + o.outHeight;
            }
        } catch (Throwable t) {
            r.error = t.getMessage();
        }
        return r;
    }
}
