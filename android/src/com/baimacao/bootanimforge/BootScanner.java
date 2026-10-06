package com.baimacao.bootanimforge;

import java.util.ArrayList;
import java.util.List;

/**
 * BootScanner —— 找出这台设备上开机动画究竟放在哪。
 *
 * 为什么需要：不同厂商路径完全不同（/system/media、/product/media、/oem/media…），
 * 用户手动找很容易找错，权限也容易设错，结果就是黑屏。
 * 这里把候选路径全扫一遍，把「哪个真的存在、多大、什么权限、什么 SELinux 上下文」
 * 一次列清楚，安装时就照着同一个路径覆盖。
 */
final class BootScanner {

    /** 候选路径，按出现频率排序 */
    static final String[] CANDIDATES = {
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

    /** 视频版（Android 12+）常见形态 */
    static final String[] VIDEO_CANDIDATES = {
            "/product/media/bootanimation.zip",
            "/system/product/media/bootanimation.zip",
            "/system/media/bootanimation.zip",
    };

    static final class Found {
        public String path;
        public boolean exists;
        public long size;
        public String perms = "";
        public String owner = "";
        public String context = "";
        public String type = "";        // zip / bin / unknown
        public String note = "";        // 由 Magisk 模块提供的可能性等
        public BootCore.Report report;

        public String title() {
            int i = path.lastIndexOf('/');
            String dir = i > 0 ? path.substring(0, i) : "/";
            return dir;
        }

        public boolean isZip() { return "zip".equals(type); }
    }

    private BootScanner() { }

    /**
     * 扫描候选路径。
     * 用一次 su 会话把该问的都问完，避免十几次 su 调用（每次都弹授权 / 都很慢）。
     */
    static List<Found> scan(boolean rooted) {
        List<Found> out = new ArrayList<Found>();
        if (!rooted) {
            // 没 root 时至少把「存在性」以外的信息留空，界面会提示需要 root
            for (String p : CANDIDATES) out.add(placeholder(p, "需要 root 才能读取系统目录"));
            return out;
        }

        // 一条脚本把所有候选都 stat 一遍
        StringBuilder sb = new StringBuilder();
        sb.append("for F in");
        for (String p : CANDIDATES) sb.append(' ').append(RootShell.q(p));
        sb.append("; do\n");
        sb.append("  if [ -e \"$F\" ]; then\n");
        sb.append("    SZ=$(stat -c %s \"$F\" 2>/dev/null || echo 0)\n");
        sb.append("    PM=$(stat -c %a \"$F\" 2>/dev/null || echo ?)\n");
        sb.append("    OW=$(stat -c '%U:%G' \"$F\" 2>/dev/null || echo ?)\n");
        sb.append("    CX=$(ls -Z \"$F\" 2>/dev/null | awk '{print $5}')\n");
        sb.append("    MG=$(od -An -tx1 -N 4 \"$F\" 2>/dev/null | tr -d ' \\n')\n");
        sb.append("    echo \"HIT|$F|$SZ|$PM|$OW|$CX|$MG\"\n");
        sb.append("  fi\n");
        sb.append("done\n");
        // Magisk 模块：如果某个模块提供了 bootanimation，标注出来
        sb.append("if [ -d /data/adb/modules ]; then\n");
        sb.append("  for M in /data/adb/modules/*; do\n");
        sb.append("    [ -d \"$M\" ] || continue\n");
        sb.append("    I=$(basename \"$M\")\n");
        sb.append("    if [ -e \"$M/system/media/bootanimation.zip\" ] || [ -e \"$M/system/product/media/bootanimation.zip\" ]; then\n");
        sb.append("      echo \"MOD|$I\"\n");
        sb.append("    fi\n");
        sb.append("  done\n");
        sb.append("fi\n");

        RootShell.Result r = RootShell.run(sb.toString());

        // 先把所有候选填成占位，再按扫描结果覆盖，保证顺序稳定、不丢项
        for (String p : CANDIDATES) out.add(placeholder(p, ""));

        List<String> modules = new ArrayList<String>();
        for (String line : r.out.split("\n")) {
            line = line.trim();
            if (line.startsWith("MOD|")) {
                modules.add(line.substring(4).trim());
                continue;
            }
            if (!line.startsWith("HIT|")) continue;
            String[] f = line.split("\\|", -1);
            if (f.length < 7) continue;
            String path = f[1];
            int idx = indexOf(out, path);
            if (idx < 0) continue;
            Found fo = out.get(idx);
            fo.exists = true;
            try { fo.size = Long.parseLong(f[2]); } catch (Exception ignored) { }
            fo.perms = f[3];
            fo.owner = f[4];
            fo.context = f[5];
            String magic = f[6].toLowerCase();
            fo.type = magic.startsWith("504b0304") ? "zip" : (magic.length() >= 8 ? "bin" : "unknown");
        }

        if (!modules.isEmpty()) {
            StringBuilder note = new StringBuilder("检测到 Magisk 模块：");
            for (int i = 0; i < modules.size(); i++) {
                if (i > 0) note.append('、');
                note.append(modules.get(i));
            }
            note.append("（模块会挂载覆盖系统文件，安装前建议先卸载对应模块）");
            for (Found fo : out) {
                if (fo.exists && fo.path.startsWith("/system/")) fo.note = note.toString();
            }
        }
        return out;
    }

    private static Found placeholder(String path, String note) {
        Found f = new Found();
        f.path = path;
        f.note = note == null ? "" : note;
        return f;
    }

    private static int indexOf(List<Found> list, String path) {
        for (int i = 0; i < list.size(); i++) if (list.get(i).path.equals(path)) return i;
        return -1;
    }

    /** 从扫描结果里挑出「当前实际在用的」那个路径：优先已存在且是 zip 的 */
    static Found pickActive(List<Found> found) {
        Found best = null;
        for (Found f : found) {
            if (!f.exists) continue;
            if (best == null) { best = f; continue; }
            // 已经在用 zip 的优先；其次体积大的（更像真的动画）
            if (f.isZip() && !best.isZip()) best = f;
            else if (f.isZip() == best.isZip() && f.size > best.size) best = f;
        }
        return best;
    }
}
