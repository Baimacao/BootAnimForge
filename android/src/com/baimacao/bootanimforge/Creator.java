package com.baimacao.bootanimforge;

import java.io.File;

/**
 * Creator —— 把视频转成 bootanimation.zip。
 *
 * 与 PC 端保持同样的两条铁律：
 *   1. **绝不拉伸**：等比缩放 + 居中留边（留边填背景色）
 *   2. **规范产物**：zip 用 STORE 不压缩、帧按序存放、desc.txt 严格按 AOSP 格式
 *
 * 视频解码通过 FrameSource 抽象注入（安卓侧用 MediaMetadataRetriever 实现），
 * 于是这里的全部逻辑都是纯 JDK，可以在 PC 上真跑测试。
 */
public final class Creator {

    /* ---------------- 参数 ---------------- */

    public static final class Options {
        public int width = 1080;
        public int height = 2400;
        public int fps = 30;
        public double startSec = 0;
        public double endSec = 0;            // 0 = 到视频结尾
        public int background = 0xFF000000;  // 留边颜色
        public String framePrefix = "";      // 前缀（默认空 = 纯数字，手表常见）
        public int padWidth = 3;             // 补零位数
        public int startNumber = 1;          // 起始编号
        /** 段设置：每段 [开始秒, 结束秒, 播放次数]；播放次数 0 = 无限循环 */
        public double[][] parts;             // null 时用单段无限循环覆盖整个区间
        public boolean opaque = true;        // 丢弃 alpha（开机动画一般不需要）
    }

    /* ---------------- 数据源抽象 ---------------- */

    /** 视频帧来源。实现方负责把帧解码成 ARGB，并处理旋转元数据 */
    public interface FrameSource {
        /** 显示用宽高（已考虑旋转） */
        int displayWidth();
        int displayHeight();
        double durationSec();
        double fps();
        /** 取某一时刻的帧，返回长度 >= w*h 的 ARGB 数组（行优先） */
        int[] frameAt(double sec) throws Exception;
        void close();
    }

    public interface Progress {
        /** @param ratio 0..1，@param note 说明文字；返回 false 表示用户取消 */
        boolean onProgress(double ratio, String note);
    }

    public static final class Result {
        public File file;
        public int totalFrames;
        public int width, height, fps;
        public long bytes;
        public double seconds;
        public String desc;
        public final java.util.List<String> warnings = new java.util.ArrayList<String>();
    }

    private Creator() { }

    /* ---------------- 计划 ---------------- */

    public static final class Part {
        public final String dir;
        public final double start;
        public final double end;
        public final int frames;
        public final int count;
        public Part(String dir, double start, double end, int frames, int count) {
            this.dir = dir; this.start = start; this.end = end; this.frames = frames; this.count = count;
        }
    }

    /** 计算分段与每段帧数，并与 PC 端 desc.js 的算法保持一致 */
    public static java.util.List<Part> plan(Options o, FrameSource src) {
        double dur = src.durationSec();
        double s = Math.max(0, o.startSec);
        double e = o.endSec > 0 ? Math.min(o.endSec, dur) : dur;
        if (e <= s) e = Math.min(dur, s + 0.1);
        if (e <= s) e = s + 0.1;
        int fps = Math.max(1, Math.min(120, o.fps));

        java.util.List<Part> out = new java.util.ArrayList<Part>();
        if (o.parts == null || o.parts.length == 0) {
            out.add(new Part("part0", s, e, frameCount(s, e, fps), 0));
            return out;
        }
        for (int i = 0; i < o.parts.length; i++) {
            double[] p = o.parts[i];
            double ps = Math.max(s, p[0]);
            double pe = Math.min(e, p[1]);
            if (pe <= ps) continue;
            int count = p.length > 2 ? (int) p[2] : 0;
            out.add(new Part("part" + i, ps, pe, frameCount(ps, pe, fps), count));
        }
        if (out.isEmpty()) out.add(new Part("part0", s, e, frameCount(s, e, fps), 0));
        return out;
    }

    static int frameCount(double start, double end, int fps) {
        return Math.max(1, (int) Math.round(Math.max(0, end - start) * fps));
    }

    /** 生成 desc.txt（CRLF 结尾，与 PC 端一致） */
    public static String buildDesc(Options o, java.util.List<Part> parts) {
        StringBuilder sb = new StringBuilder();
        sb.append(o.width).append(' ').append(o.height).append(' ').append(o.fps).append("\r\n");
        for (Part p : parts) {
            sb.append("p ").append(p.count).append(" 0 ").append(p.dir).append("\r\n");
        }
        return sb.toString();
    }

    public static String frameName(Options o, int seq) {
        int n = o.startNumber + seq;
        StringBuilder sb = new StringBuilder(o.framePrefix == null ? "" : o.framePrefix);
        String s = Integer.toString(n);
        for (int i = s.length(); i < o.padWidth; i++) sb.append('0');
        return sb.append(s).toString();
    }

    /**
     * 等比缩放 + 居中留边（绝不拉伸）。
     * 返回的像素数组长度恒为 outW*outH。
     */
    public static int[] fitAndPad(int[] src, int srcW, int srcH, int outW, int outH, int background) {
        int[] out = new int[outW * outH];
        java.util.Arrays.fill(out, background);
        if (srcW <= 0 || srcH <= 0 || src == null) return out;

        // 用 long 计算避免大尺寸下溢出
        long byW = (long) outW * srcH;      // 以宽为基准时所需的高度
        long byH = (long) outH * srcW;
        int drawW, drawH;
        if (byW <= byH) {
            drawW = outW;
            drawH = (int) (byW / srcW);
        } else {
            drawH = outH;
            drawW = (int) (byH / srcH);
        }
        if (drawW < 1) drawW = 1;
        if (drawH < 1) drawH = 1;
        if (drawW > outW) drawW = outW;
        if (drawH > outH) drawH = outH;

        int ox = (outW - drawW) / 2;
        int oy = (outH - drawH) / 2;

        // 最近邻采样：整数步进，避免浮点误差与额外分配
        for (int y = 0; y < drawH; y++) {
            int sy = (int) ((long) y * srcH / drawH);
            if (sy >= srcH) sy = srcH - 1;
            int srcRow = sy * srcW;
            int dstRow = (oy + y) * outW + ox;
            for (int x = 0; x < drawW; x++) {
                int sx = (int) ((long) x * srcW / drawW);
                if (sx >= srcW) sx = srcW - 1;
                out[dstRow + x] = src[srcRow + sx];
            }
        }
        return out;
    }

    /* ---------------- 主流程 ---------------- */

    /**
     * 执行转换。
     *
     * @param outFile 目标 zip
     */
    public static Result convert(Options o, FrameSource src, File outFile, Progress progress) throws Exception {
        long t0 = System.currentTimeMillis();
        Result r = new Result();

        // 参数裁剪
        o.fps = Math.max(1, Math.min(120, o.fps));
        o.width = Math.max(2, Math.min(4096, o.width));
        o.height = Math.max(2, Math.min(4096, o.height));
        o.padWidth = Math.max(1, Math.min(8, o.padWidth));
        o.startNumber = Math.max(0, o.startNumber);
        if (o.framePrefix == null) o.framePrefix = "";
        o.framePrefix = o.framePrefix.replaceAll("[^A-Za-z0-9._-]", "");
        r.width = o.width; r.height = o.height; r.fps = o.fps;

        java.util.List<Part> parts = plan(o, src);
        int total = 0;
        for (Part p : parts) total += p.frames;
        if (total <= 0) throw new Exception("没有可转换的帧");
        if (total > 6000) {
            r.warnings.add("总帧数 " + total + " 偏多，手机可能生成很慢、包也很大");
        }
        // 补零位数不够会撞名，必须拦住（与 PC 端同规则）
        int maxNo = o.startNumber + total - 1;
        if (String.valueOf(maxNo).length() > o.padWidth) {
            throw new Exception("帧命名补零位数不够：共 " + total + " 帧，编号最大到 " + maxNo
                    + "（" + String.valueOf(maxNo).length() + " 位），而补零位数是 " + o.padWidth);
        }
        // 尺寸检查：留边用的目标尺寸若与源比例差太多会很难看
        if (src.displayWidth() > 0 && src.displayHeight() > 0) {
            double srcAR = (double) src.displayWidth() / src.displayHeight();
            double dstAR = (double) o.width / o.height;
            double diff = Math.abs(srcAR - dstAR) / srcAR;
            if (diff > 0.35) {
                r.warnings.add("源视频比例 " + String.format(java.util.Locale.US, "%.2f", srcAR)
                        + " 与目标 " + String.format(java.util.Locale.US, "%.2f", dstAR)
                        + " 差别较大，留边会比较宽");
            }
        }

        String desc = buildDesc(o, parts);
        r.desc = desc;

        ZipStoreWriter zip = new ZipStoreWriter(outFile);
        try {
            zip.add("desc.txt", desc.getBytes("UTF-8"));

            int written = 0;
            for (Part part : parts) {
                int seq = 0;
                for (int i = 0; i < part.frames; i++) {
                    double t = part.start + (double) i / o.fps;
                    if (t >= part.end) t = Math.max(part.start, part.end - 0.001);

                    int[] frame = src.frameAt(t);
                    if (frame == null) throw new Exception("在 " + String.format(java.util.Locale.US, "%.2f", t) + "s 处取帧失败");
                    int[] scaled = fitAndPad(frame, src.displayWidth(), src.displayHeight(),
                            o.width, o.height, o.background);
                    byte[] png = PngEncoder.encode(scaled, o.width, o.height, o.opaque);
                    zip.add(part.dir + "/" + frameName(o, seq) + ".png", png);
                    seq++;
                    written++;

                    if (progress != null) {
                        boolean go = progress.onProgress((double) written / total,
                                part.dir + " " + written + "/" + total);
                        if (!go) throw new InterruptedException("用户取消");
                    }
                }
            }
            zip.finish();
            r.totalFrames = written;
            r.bytes = outFile.length();
            r.seconds = (System.currentTimeMillis() - t0) / 1000.0;
            r.file = outFile;
            return r;
        } catch (Exception e) {
            zip.abort();
            // 失败就清理半成品，避免用户误把它当成成品刷进去
            try { outFile.delete(); } catch (Throwable ignored) { }
            throw e;
        }
    }
}
