package com.baimacao.bootanimforge;

import java.io.ByteArrayOutputStream;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/**
 * PngEncoder —— 自己编码 PNG（纯 JDK，可在 PC 上测）。
 *
 * 为什么不直接用 android.graphics.Bitmap.compress(PNG)：
 *   · 它在历史上对 PNG 的支持并不稳定，不同版本/ROM 行为不一致，而本机没有真机可测
 *   · 自己编码只依赖 Deflater + CRC32，从 Android 4.4 到最新版行为完全一致
 *   · 而且这份代码没有 Android 依赖，能在 PC 上用 ffmpeg 反向验证正确性
 *
 * 输出：8 位 RGBA（颜色类型 6），滤波固定用 None(0)。
 * 体积会比最优编码略大（每行多 1 字节滤波字节，且没有做滤波预测），
 * 但 PNG 本身已压缩，而开机动画包里帧本来就占大头 —— 换来的是确定性。
 */
public final class PngEncoder {

    private static final byte[] SIGNATURE = {
            (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A
    };

    private PngEncoder() { }

    /**
     * 把 ARGB 像素数组编码成 PNG。
     *
     * @param argb   长度必须 >= width*height，每像素 0xAARRGGBB
     * @param width  宽
     * @param height 高
     * @param opaque true 时丢弃 alpha（输出 RGB，颜色类型 2），文件更小
     */
    public static byte[] encode(int[] argb, int width, int height, boolean opaque) throws Exception {
        if (width <= 0 || height <= 0) throw new IllegalArgumentException("尺寸非法");
        if (argb == null || argb.length < width * height) throw new IllegalArgumentException("像素数据不足");

        int channels = opaque ? 3 : 4;
        // 每行前加 1 字节滤波类型；这里固定 0（None）
        byte[] raw = new byte[height * (1 + width * channels)];
        int p = 0;
        for (int y = 0; y < height; y++) {
            raw[p++] = 0;                       // filter: None
            int rowBase = y * width;
            for (int x = 0; x < width; x++) {
                int c = argb[rowBase + x];
                raw[p++] = (byte) ((c >> 16) & 0xFF);   // R
                raw[p++] = (byte) ((c >> 8) & 0xFF);    // G
                raw[p++] = (byte) (c & 0xFF);           // B
                if (!opaque) raw[p++] = (byte) ((c >>> 24) & 0xFF);  // A
            }
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(raw.length / 2 + 1024);
        out.write(SIGNATURE);

        // IHDR
        ByteArrayOutputStream ihdr = new ByteArrayOutputStream(13);
        writeInt(ihdr, width);
        writeInt(ihdr, height);
        ihdr.write(8);                                  // bit depth
        ihdr.write(opaque ? 2 : 6);                     // color type: 2=RGB, 6=RGBA
        ihdr.write(0);                                  // compression
        ihdr.write(0);                                  // filter
        ihdr.write(0);                                  // interlace
        writeChunk(out, "IHDR", ihdr.toByteArray());

        // IDAT
        Deflater def = new Deflater(Deflater.BEST_SPEED);
        try {
            def.setInput(raw);
            def.finish();
            byte[] buf = new byte[64 * 1024];
            ByteArrayOutputStream idat = new ByteArrayOutputStream(raw.length / 3 + 1024);
            while (!def.finished()) {
                int n = def.deflate(buf);
                if (n > 0) idat.write(buf, 0, n);
                else if (!def.needsInput()) break;
            }
            writeChunk(out, "IDAT", idat.toByteArray());
        } finally {
            def.end();
        }

        // IEND
        writeChunk(out, "IEND", new byte[0]);
        return out.toByteArray();
    }

    private static void writeChunk(ByteArrayOutputStream out, String type, byte[] data) throws Exception {
        writeInt(out, data.length);
        byte[] t = new byte[4];
        for (int i = 0; i < 4; i++) t[i] = (byte) type.charAt(i);
        out.write(t);
        out.write(data);
        CRC32 crc = new CRC32();
        crc.update(t);
        crc.update(data);
        writeInt(out, (int) crc.getValue());
    }

    private static void writeInt(ByteArrayOutputStream out, int v) {
        out.write((v >>> 24) & 0xFF);
        out.write((v >>> 16) & 0xFF);
        out.write((v >>> 8) & 0xFF);
        out.write(v & 0xFF);
    }
}
