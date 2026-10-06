package com.baimacao.bootanimforge;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;

import java.io.File;

/**
 * VideoProbe —— 只读视频元信息，用于在制作前把参数展示给用户。
 *
 * 单列出来是因为「先探测、再让用户设参数、再转换」这三步之间要复用同一份信息，
 * 而且探测失败时的提示要能说清原因（不是视频 / 编码不支持 / 文件坏了）。
 */
final class VideoProbe {

    final boolean ok;
    final String error;
    final int width, height;        // 显示尺寸（已考虑旋转）
    final int rotation;
    final double durationSec;
    final double fps;
    final File file;

    private VideoProbe(boolean ok, String error, File file, int w, int h, int rot, double dur, double fps) {
        this.ok = ok; this.error = error; this.file = file;
        this.width = w; this.height = h; this.rotation = rot;
        this.durationSec = dur; this.fps = fps;
    }

    static VideoProbe probe(File f) {
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(f.getAbsolutePath());
            int cw = num(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            int ch = num(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            if (cw <= 0 || ch <= 0) {
                return new VideoProbe(false, "读不到视频尺寸：可能选错了文件，或编码不被系统支持", f, 0, 0, 0, 0, 0);
            }
            int rot = ((num(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)) % 360) + 360) % 360;
            if (rot != 90 && rot != 180 && rot != 270) rot = 0;
            boolean swap = rot == 90 || rot == 270;
            int dw = swap ? ch : cw;
            int dh = swap ? cw : ch;
            double dur = num(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)) / 1000.0;
            double fps = 0;
            try {
                String fr = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE);
                if (fr != null) fps = Double.parseDouble(fr);
            } catch (Throwable ignored) { }
            if (fps <= 0) {
                int cnt = num(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT));
                if (cnt > 0 && dur > 0) fps = cnt / dur;
            }
            if (fps <= 0) fps = 30;
            return new VideoProbe(true, null, f, dw, dh, rot, dur, fps);
        } catch (Throwable t) {
            return new VideoProbe(false, "打开失败：" + t.getMessage(), f, 0, 0, 0, 0, 0);
        } finally {
            try { mmr.release(); } catch (Throwable ignored) { }
        }
    }

    private static int num(String s) {
        if (s == null) return 0;
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return 0; }
    }

    String summary() {
        return width + "×" + height + " · " + String.format(java.util.Locale.US, "%.1f", durationSec) + " 秒"
                + (rotation != 0 ? " · 旋转 " + rotation + "°" : "");
    }
}
