package com.baimacao.bootanimforge;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * RootShell —— 通过 su 执行命令。
 *
 * 设计要点：
 *  · 单条命令用 `su -c "cmd"`，多条用一次 su 会话喂 stdin（减少反复弹授权、也更快）
 *  · 命令里的路径一律单引号包裹，避免空格/特殊字符出问题
 *  · 不假设 su 一定存在：先探测，失败就把原因如实抛给界面，不静默失败
 */
final class RootShell {

    private RootShell() { }

    /** su 可执行文件的位置（不同 ROM 不同） */
    private static final String[] SU_PATHS = {
            "su", "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/su/bin/su", "/magisk/.core/bin/su", "/debug_ramdisk/su",
    };

    /** 探测结果缓存，避免每次都 fork 一遍 */
    private static Boolean cachedAvailable;

    static final class Result {
        public final int code;
        public final String out;
        public final String err;
        Result(int code, String out, String err) { this.code = code; this.out = out == null ? "" : out; this.err = err == null ? "" : err; }
        public boolean ok() { return code == 0; }
        public String text() {
            String t = (out + "\n" + err).trim();
            return t.length() > 400 ? t.substring(0, 400) + "…" : t;
        }
    }

    /** 单引号包裹，内部单引号转义 —— 兼容 busybox sh 的标准写法 */
    static String q(String s) {
        if (s == null) return "''";
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /** 找出可用的 su 命令前缀；找不到返回 null */
    private static String findSu() {
        for (String p : SU_PATHS) {
            if (p.equals("su")) return "su";   // 由 PATH 解析
            if (new File(p).exists()) return p;
        }
        return null;
    }

    /** 是否已 root（探测一次并缓存） */
    static boolean available() {
        if (cachedAvailable != null) return cachedAvailable;
        cachedAvailable = Boolean.valueOf(probe());
        return cachedAvailable.booleanValue();
    }

    static void resetCache() { cachedAvailable = null; }

    private static boolean probe() {
        String su = findSu();
        if (su == null) return false;
        try {
            Process p = new ProcessBuilder(su, "-c", "id").redirectErrorStream(true).start();
            String out = readAll(p.getInputStream());
            boolean done = p.waitFor(8, TimeUnit.SECONDS);
            if (!done) { p.destroy(); return false; }
            return p.exitValue() == 0 && out.contains("uid=0");
        } catch (Exception e) {
            return false;
        }
    }

    /** 执行一组命令（一次 su 会话） */
    static Result run(List<String> commands) {
        String su = findSu();
        if (su == null) return new Result(127, "", "找不到 su：设备可能没有 root");
        try {
            ProcessBuilder pb = new ProcessBuilder(su, "-c", joinForSu(commands));
            pb.redirectErrorStream(false);
            Process p = pb.start();

            OutputStream stdin = p.getOutputStream();
            // 用 -c 传了整条脚本，这里只需收尾
            try { stdin.write("\n".getBytes("UTF-8")); stdin.flush(); stdin.close(); } catch (IOException ignored) { }

            String out = readAll(p.getInputStream());
            String err = readAll(p.getErrorStream());
            boolean done = p.waitFor(180, TimeUnit.SECONDS);
            if (!done) { p.destroy(); return new Result(124, out, "执行超时"); }
            return new Result(p.exitValue(), out, err);
        } catch (Exception e) {
            return new Result(126, "", "执行失败：" + e.getMessage());
        }
    }

    static Result run(String command) {
        List<String> l = new ArrayList<String>();
        l.add(command);
        return run(l);
    }

    /**
     * 把多条命令拼成一段 sh 脚本给 su -c。
     * 每条命令后追加 `|| echo "__FAIL__:描述"`，这样单条失败不会中断整段，
     * 同时我们仍能在输出里看到是哪一步失败了。
     */
    private static String joinForSu(List<String> commands) {
        StringBuilder sb = new StringBuilder();
        sb.append("set +e\n");
        for (String c : commands) sb.append(c).append("\n");
        sb.append("exit 0\n");
        return sb.toString();
    }

    private static String readAll(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        return sb.toString();
    }

    /* ------------------------------------------------------------------ */
    /* 面向业务的封装                                                      */
    /* ------------------------------------------------------------------ */

    /** 读取某个文件的信息（存在性、大小、权限、SELinux 上下文） */
    static class FileInfo {
        public boolean exists;
        public long size;
        public String perms = "";
        public String owner = "";
        public String context = "";
        public String type = "";      // zip / mp4 / 未知
    }

    /**
     * 用一条命令把文件信息一次性取回，减少 su 调用次数。
     */
    static FileInfo statFile(String path) {
        FileInfo fi = new FileInfo();
        // 用 od 而不是 xxd：很多精简 ROM 没有 xxd，od 是 toybox/busybox 都有的
        String cmd =
            "F=" + q(path) + "\n" +
            "if [ -e \"$F\" ]; then\n" +
            "  echo \"EXISTS=1\"\n" +
            "  echo \"SIZE=$(stat -c %s \"$F\" 2>/dev/null || echo 0)\"\n" +
            "  echo \"PERMS=$(stat -c %a \"$F\" 2>/dev/null || echo ?)\"\n" +
            "  echo \"OWNER=$(stat -c '%U:%G' \"$F\" 2>/dev/null || echo ?)\"\n" +
            "  echo \"CTX=$(ls -Z \"$F\" 2>/dev/null | awk '{print $5}' || echo)\"\n" +
            "  echo \"MAGIC=$(od -An -tx1 -N 4 \"$F\" 2>/dev/null | tr -d ' \\n')\"\n" +
            "else\n" +
            "  echo \"EXISTS=0\"\n" +
            "fi\n";
        Result r = run(cmd);
        for (String line : r.out.split("\n")) {
            int i = line.indexOf('=');
            if (i <= 0) continue;
            String k = line.substring(0, i).trim();
            String v = line.substring(i + 1).trim();
            if (k.equals("EXISTS")) fi.exists = v.equals("1");
            else if (k.equals("SIZE")) { try { fi.size = Long.parseLong(v); } catch (Exception ignored) { } }
            else if (k.equals("PERMS")) fi.perms = v;
            else if (k.equals("OWNER")) fi.owner = v;
            else if (k.equals("CTX")) fi.context = v;
            else if (k.equals("MAGIC")) {
                String m = v.toLowerCase();
                if (m.startsWith("504b0304")) fi.type = "zip";
                else if (m.length() >= 8) fi.type = "bin";   // mp4 等：看扩展名更靠谱
            }
        }
        return fi;
    }

    /** 复制文件并设置属主 / 权限 / SELinux 上下文 */
    static Result installFile(String src, String dest, String context) {
        List<String> cmds = new ArrayList<String>();
        cmds.add("mkdir -p " + q(parentOf(dest)));
        cmds.add("cp -f " + q(src) + " " + q(dest));
        cmds.add("chown 0:0 " + q(dest));
        cmds.add("chmod 0644 " + q(dest));
        if (context != null && context.length() > 0) {
            cmds.add("chcon " + q(context) + " " + q(dest) + " 2>/dev/null || true");
        }
        cmds.add("ls -lZ " + q(dest));
        return run(cmds);
    }

    static Result copy(String src, String dest) {
        List<String> cmds = new ArrayList<String>();
        cmds.add("mkdir -p " + q(parentOf(dest)));
        cmds.add("cp -f " + q(src) + " " + q(dest));
        cmds.add("chmod 0644 " + q(dest));
        cmds.add("ls -l " + q(dest));
        return run(cmds);
    }

    static Result delete(String path) {
        return run("rm -f " + q(path));
    }

    /** 把系统文件复制到应用可读的目录（用于备份） */
    static Result pullTo(String src, String dest) {
        List<String> cmds = new ArrayList<String>();
        cmds.add("mkdir -p " + q(parentOf(dest)));
        cmds.add("cp -f " + q(src) + " " + q(dest));
        cmds.add("chmod 0644 " + q(dest));
        cmds.add("ls -l " + q(dest));
        return run(cmds);
    }

    private static String parentOf(String p) {
        int i = p.lastIndexOf('/');
        return i > 0 ? p.substring(0, i) : "/";
    }
}
