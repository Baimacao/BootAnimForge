package com.baimacao.bootanimforge;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.media.MediaMetadataRetriever;

import java.io.File;

/**
 * AndroidFrameSource —— 用 MediaMetadataRetriever 取帧。
 *
 * 两个容易踩的点：
 *
 * 1) **旋转元数据**：竖屏视频常以横向存储 + rotation=90 标记。不同 Android 版本
 *    的 getFrameAtTime 对旋转的处理并不一致（有的已经转好，有的没转）。
 *    这里不去猜版本，而是「**比对尺寸**」：先按元数据算出期望的显示尺寸，
 *    再看实际拿到的帧尺寸是否已经等于它 —— 相等就说明系统已经转过了，不再重复旋转。
 *    这样新旧行为都能正确。
 *
 * 2) **内存**：1080p 的 ARGB_8888 一帧约 8 MB。这里只保留当前帧，
 *    用完立刻 recycle，峰值内存可控；再叠加 Creator 的"编一帧写一帧"，整体不会爆。
 */
final class AndroidFrameSource implements Creator.FrameSource {

    private final MediaMetadataRetriever mmr = new MediaMetadataRetriever();
    private final int codedW, codedH;
    private final int rotation;          // 0/90/180/270（顺时针）
    private final int displayW, displayH;
    private final double duration;
    private final double fps;
    private Bitmap reuse;                // 复用的目标 Bitmap，减少分配
    private final int decodeW, decodeH;  // 实际的解码尺寸（受内存上限约束）

    AndroidFrameSource(File file) throws Exception {
        this(file, 0);
    }

    /**
     * @param maxDim 解码长边上限（0 = 不限制）。1080p 的 ARGB_8888 一帧约 8 MB，
     *               解码时先缩到合理尺寸能显著降低内存峰值与 GC 压力；
     *               最终输出尺寸由 Creator 的等比缩放负责，所以这里缩过不影响画质上限。
     */
    AndroidFrameSource(File file, int maxDim) throws Exception {
        mmr.setDataSource(file.getAbsolutePath());

        codedW = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH), 0);
        codedH = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT), 0);
        rotation = normalizeRotation(parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION), 0));
        duration = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION), 0) / 1000.0;

        double f = 0;
        try {
            String fr = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE);
            if (fr != null) f = Double.parseDouble(fr);
        } catch (Throwable ignored) { }
        if (f <= 0) {
            int frames = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT), 0);
            if (frames > 0 && duration > 0) f = frames / duration;
        }
        fps = f > 0 ? f : 30;

        boolean swap = rotation == 90 || rotation == 270;
        displayW = swap ? codedH : codedW;
        displayH = swap ? codedW : codedH;

        if (codedW <= 0 || codedH <= 0) throw new Exception("读不到视频尺寸，可能不是视频文件或编码不支持");

        // 计算受约束的解码尺寸，保持比例
        if (maxDim > 0 && Math.max(codedW, codedH) > maxDim) {
            double k = (double) maxDim / Math.max(codedW, codedH);
            decodeW = Math.max(2, (int) (codedW * k));
            decodeH = Math.max(2, (int) (codedH * k));
        } else {
            decodeW = codedW;
            decodeH = codedH;
        }
    }

    private static int parseInt(String s, int def) {
        if (s == null) return def;
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    private static int normalizeRotation(int r) {
        int a = ((r % 360) + 360) % 360;
        if (a == 90 || a == 180 || a == 270) return a;
        return 0;
    }

    public int displayWidth() { return decodeW; }
    public int displayHeight() { return decodeH; }
    public double durationSec() { return duration; }
    public double fps() { return fps; }
    public int rotationDegrees() { return rotation; }
    public int codedWidth() { return codedW; }
    public int codedHeight() { return codedH; }
    /** 视频真实显示尺寸（未受解码上限影响），用于给用户展示 */
    public int trueDisplayWidth() { return (rotation == 90 || rotation == 270) ? codedH : codedW; }
    public int trueDisplayHeight() { return (rotation == 90 || rotation == 270) ? codedW : codedH; }

    public int[] frameAt(double sec) throws Exception {
        long us = (long) (Math.max(0, sec) * 1_000_000L);
        Bitmap bmp;
        try {
            bmp = mmr.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST);
        } catch (Throwable t) {
            // 个别 ROM 在 OPTION_CLOSEST 上会失败，退回最近关键帧
            bmp = mmr.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
        }
        if (bmp == null) {
            // 再退一步：直接给 0，至少不整段失败
            bmp = mmr.getFrameAtTime(us);
        }
        if (bmp == null) return null;

        try {
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            // 尺寸已经等于「期望显示尺寸」→ 说明系统已经把旋转应用过了。
            // 这里用解码尺寸判断（而不是原始显示尺寸），因为解码时可能被缩过。
            boolean alreadyRotated = (w == decodeW && h == decodeH);

            Bitmap target = ensureReuse(w, h);
            Canvas c = new Canvas(target);
            // 源 Bitmap 若已含旋转（尺寸已等于解码尺寸），直接画；
            // 否则在画布上做一次旋转，保证输出方向与用户看到的一致。
            if (alreadyRotated || rotation == 0) {
                c.drawBitmap(bmp, 0, 0, new Paint(Paint.FILTER_BITMAP_FLAG));
            } else {
                c.save();
                c.translate(w / 2f, h / 2f);
                c.rotate(rotation);
                float k = (rotation == 90 || rotation == 270)
                        ? Math.min((float) w / bmp.getHeight(), (float) h / bmp.getWidth())
                        : Math.min((float) w / bmp.getWidth(), (float) h / bmp.getHeight());
                c.scale(k, k);
                c.drawBitmap(bmp, -bmp.getWidth() / 2f, -bmp.getHeight() / 2f, new Paint(Paint.FILTER_BITMAP_FLAG));
                c.restore();
            }

            int[] px = new int[target.getWidth() * target.getHeight()];
            target.getPixels(px, 0, target.getWidth(), 0, 0, target.getWidth(), target.getHeight());
            return px;
        } finally {
            if (bmp != reuse) bmp.recycle();
        }
    }

    private Bitmap ensureReuse(int w, int h) {
        if (reuse != null && (reuse.getWidth() != w || reuse.getHeight() != h)) {
            reuse.recycle();
            reuse = null;
        }
        if (reuse == null) {
            reuse = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        }
        return reuse;
    }

    /** 按顺时针角度旋转像素数组 */
    static int[] rotate(int[] src, int w, int h, int deg) {
        if (deg == 0) return src;
        int[] out;
        if (deg == 180) {
            out = new int[w * h];
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    out[(h - 1 - y) * w + (w - 1 - x)] = src[y * w + x];
                }
            }
            return out;
        }
        // 90 / 270：宽高互换
        out = new int[w * h];
        if (deg == 90) {
            // 顺时针 90：新宽 = 原高
            int nw = h, nh = w;
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int nx = h - 1 - y;
                    int ny = x;
                    out[ny * nw + nx] = src[y * w + x];
                }
            }
        } else {
            int nw = h, nh = w;
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int nx = y;
                    int ny = w - 1 - x;
                    out[ny * nw + nx] = src[y * w + x];
                }
            }
        }
        return out;
    }

    public void close() {
        try { mmr.release(); } catch (Throwable ignored) { }
        if (reuse != null) { reuse.recycle(); reuse = null; }
    }
}
