package com.baimacao.bootanimforge;

import java.util.ArrayList;
import java.util.List;

/**
 * BootScanner —— 找出这台设备上（开机 / 关机）动画究竟放在哪。
 *
 * 为什么需要：不同厂商路径完全不同（/system/media、/product/media、/oem/media…），
 * 用户手动找很容易找错，权限也容易设错，结果就是黑屏。
 * 这里把候选路径全扫一遍，把「哪个真的存在、多大、什么权限、什么 SELinux 上下文」
 * 一次列清楚，安装时就照着同一个路径覆盖。
 *
 * 路径与文件名由 AnimTarget 提供，所以开机与关机共用同一套扫描逻辑。
 */
final class BootScanner {

    static final class Found {
        public String path;
        public boolean exists;
        public long size;
        public String perms = "";
        public String owner = "";
        public String context = "";
        public String type = "";        // zip / bin / unknown
        public String note = "";
        public int target = AnimTarget.BOOT;

        public String title() {
            int i = path.lastIndexOf('/');
            return i > 0 ? path.substring(0, i) : "/";
        }

        public boolean isZip() { return "zip".equals(type); }
    }

    private BootScanner() { }

    static List<Found> scan(boolean rooted) {
        return scan(rooted, AnimTarget.BOOT);
    }

    /**
     * 扫描候选路径。
     * 用一次 su 会话把该问的都问完，避免十几次 su 调用（每次都弹授权 / 都很慢）。
     */
    static List<Found> scan(boolean rooted, int target) {
        List<Found> out = new ArrayList<Found>();
        String[] candidates = AnimTarget.candidates(target);

        for (String p : candidates) {
            Found f = placeholder(p);
            f.target = target;
            out.add(f);
        }

        if (!rooted) {
            for (Found f : out) f.note = "需要 root 才能读取系统目录";
            return out;
        }

        StringBuilder sb = new StringBuilder();
        sb.append("for F in");
        for (String p : candidates) sb.append(' ').append(RootShell.q(p));
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
        // Magisk 模块：模块里提供了对应动画的就标注出来（开机/关机都查）
        sb.append("if [ -d /data/adb/modules ]; then\n");
        sb.append("  for M in /data/adb/modules/*; do\n");
        sb.append("    [ -d \"$M\" ] || continue\n");
        sb.append("    I=$(basename \"$M\")\n");
        sb.append("    for D in system/media system/product/media system/oem/media product/media; do\n");
        sb.append("      for N in bootanimation.zip shutdownanimation.zip bootanimation.mp4 shutdownanimation.mp4; do\n");
        sb.append("        [ -e \"$M/$D/$N\" ] && echo \"MOD|$I|$N\"\n");
        sb.append("      done\n");
        sb.append("    done\n");
        sb.append("  done\n");
        sb.append("fi\n");

        RootShell.Result r = RootShell.run(sb.toString());

        List<String> modules = new ArrayList<String>();
        String wantZip = AnimTarget.fileName(target);
        String wantVideo = AnimTarget.videoFileName(target);

        for (String line : r.out.split("\n")) {
            line = line.trim();
            if (line.startsWith("MOD|")) {
                String[] m = line.split("\\|", -1);
                if (m.length >= 3 && (m[2].equals(wantZip) || m[2].equals(wantVideo))) {
                    String desc = m[1] + "（" + m[2] + "）";
                    if (!modules.contains(desc)) modules.add(desc);
                }
                continue;
            }
            if (!line.startsWith("HIT|")) continue;
            String[] f = line.split("\\|", -1);
            if (f.length < 7) continue;
            int idx = indexOf(out, f[1]);
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
                if (fo.exists) fo.note = note.toString();
            }
        }
        return out;
    }

    private static Found placeholder(String path) {
        Found f = new Found();
        f.path = path;
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
            if (f.isZip() && !best.isZip()) best = f;
            else if (f.isZip() == best.isZip() && f.size > best.size) best = f;
        }
        return best;
    }
}
