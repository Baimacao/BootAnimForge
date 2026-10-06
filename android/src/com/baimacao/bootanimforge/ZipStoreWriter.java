package com.baimacao.bootanimforge;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.CRC32;

/**
 * ZipStoreWriter —— 只支持 STORE（不压缩）的流式 ZIP 写入器。
 *
 * 为什么要自己写，而且要"流式"：
 *   · 开机动画规范要求 zip 用 STORE（等价 zip -0）打包，帧按序存放
 *     —— java.util.zip.ZipOutputStream 强制 DEFLATE，写出来的包不符合规范
 *   · 手机内存有限，一帧 1080p 的 RGBA 就要 8 MB，几百帧不可能全放内存再打包
 *     所以每编码完一帧就立刻写盘，峰值内存只有一帧
 *
 * 结构：逐个写 local file header + 数据，元素信息先留内存（很小），最后写
 * 中央目录与 EOCD。因为 STORE 的 local header 就直接带 size 与 crc，不需要
 * data descriptor，所以能一边算一边顺序写。
 */
public final class ZipStoreWriter {

    private static final int SIG_LOCAL = 0x04034b50;
    private static final int SIG_CENTRAL = 0x02014b50;
    private static final int SIG_EOCD = 0x06054b50;

    private static final class Entry {
        String name;
        byte[] nameBytes;
        long crc;
        long size;
        long offset;
    }

    private final RandomAccessFile raf;
    private final List<Entry> entries = new ArrayList<Entry>();
    private long offset;
    private boolean finished;

    public ZipStoreWriter(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        this.raf = new RandomAccessFile(file, "rw");
        this.raf.setLength(0);
        this.offset = 0;
    }

    /** 当前已写入的总字节数（可用于进度显示） */
    public long bytesWritten() {
        return offset;
    }

    public int entryCount() {
        return entries.size();
    }

    /**
     * 写入一个条目。name 用 '/' 分隔，不带前导斜杠。
     * 内容一次性给出（一帧 PNG 的字节），STORE 直接存。
     */
    public void add(String name, byte[] data) throws IOException {
        if (finished) throw new IOException("zip 已结束，不能再写");
        Entry e = new Entry();
        e.name = name;
        e.nameBytes = name.getBytes("UTF-8");
        CRC32 crc = new CRC32();
        crc.update(data);
        e.crc = crc.getValue();
        e.size = data.length;
        e.offset = offset;

        writeLocalHeader(e);
        raf.write(data);
        offset += data.length;
        entries.add(e);
    }

    private void writeLocalHeader(Entry e) throws IOException {
        byte[] h = new byte[30];
        putInt(h, 0, SIG_LOCAL);
        putShort(h, 4, 20);              // version needed
        putShort(h, 6, 0x0800);          // 通用标志位：UTF-8 文件名
        putShort(h, 8, 0);               // 压缩方法 0 = STORE
        putShort(h, 10, 0);              // 时间
        putShort(h, 12, 0x21);           // 日期（固定值即可，避免依赖系统时间）
        putInt(h, 14, (int) e.crc);
        putInt(h, 18, (int) e.size);     // 压缩后大小
        putInt(h, 22, (int) e.size);     // 原始大小
        putShort(h, 26, e.nameBytes.length);
        putShort(h, 28, 0);              // extra 长度
        raf.write(h);
        raf.write(e.nameBytes);
        offset += h.length + e.nameBytes.length;
    }

    /** 写中央目录与 EOCD 并关闭文件 */
    public void finish() throws IOException {
        if (finished) return;
        long cdStart = offset;
        for (Entry e : entries) {
            byte[] h = new byte[46];
            putInt(h, 0, SIG_CENTRAL);
            putShort(h, 4, 20);          // version made by
            putShort(h, 6, 20);          // version needed
            putShort(h, 8, 0x0800);      // UTF-8
            putShort(h, 10, 0);          // STORE
            putShort(h, 12, 0);
            putShort(h, 14, 0x21);
            putInt(h, 16, (int) e.crc);
            putInt(h, 20, (int) e.size);
            putInt(h, 24, (int) e.size);
            putShort(h, 28, e.nameBytes.length);
            putShort(h, 30, 0);          // extra
            putShort(h, 32, 0);          // comment
            putShort(h, 34, 0);          // disk
            putShort(h, 36, 0);          // internal attrs
            putInt(h, 38, 0);            // external attrs
            putInt(h, 42, (int) e.offset);
            raf.write(h);
            raf.write(e.nameBytes);
            offset += h.length + e.nameBytes.length;
        }
        long cdSize = offset - cdStart;

        byte[] eocd = new byte[22];
        putInt(eocd, 0, SIG_EOCD);
        putShort(eocd, 4, 0);
        putShort(eocd, 6, 0);
        putShort(eocd, 8, entries.size());
        putShort(eocd, 10, entries.size());
        putInt(eocd, 12, (int) cdSize);
        putInt(eocd, 16, (int) cdStart);
        putShort(eocd, 20, 0);           // 注释长度
        raf.write(eocd);
        offset += eocd.length;

        raf.close();
        finished = true;
    }

    /** 出错时清理 */
    public void abort() {
        try { raf.close(); } catch (IOException ignored) { }
        finished = true;
    }

    private static void putShort(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xFF);
        b[off + 1] = (byte) ((v >>> 8) & 0xFF);
    }

    private static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xFF);
        b[off + 1] = (byte) ((v >>> 8) & 0xFF);
        b[off + 2] = (byte) ((v >>> 16) & 0xFF);
        b[off + 3] = (byte) ((v >>> 24) & 0xFF);
    }
}
