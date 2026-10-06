package com.baimacao.bootanimforge;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * CreatorActivity —— 在手机上把视频做成 bootanimation.zip。
 *
 * 为什么值得做：外出时可能只有手机。虽然手机算力不如电脑，
 * 但「截一小段、改成手表的 480×480、直接装上去」这种需求完全够用。
 *
 * 与 PC 端保持一致的两条铁律：
 *   1. 绝不拉伸（等比缩放 + 居中留边）
 *   2. 产物合规（zip 用 STORE、帧按序、desc.txt 严格格式）
 */
public class CreatorActivity extends Activity {

    /* 与 MainActivity 共用一套 MD3 令牌 */
    private static final int C_PRIMARY = 0xFF4FC3F7;
    private static final int C_ON_PRIMARY = 0xFF00344A;
    private static final int C_PRIMARY_CONT = 0xFF004C69;
    private static final int C_ON_PRIMARY_CONT = 0xFFC8E7FF;
    private static final int C_SURFACE = 0xFF0E1418;
    private static final int C_SURF_LOW = 0xFF141A1F;
    private static final int C_SURF_HIGH = 0xFF242C32;
    private static final int C_ON_SURFACE = 0xFFDFE3E6;
    private static final int C_ON_SURF_VAR = 0xFFBFC8CE;
    private static final int C_OUTLINE = 0xFF3F484E;
    private static final int C_ERROR_CONT = 0xFF93000A;
    private static final int C_ON_ERROR_CONT = 0xFFFFDAD6;
    private static final int C_SUCCESS_CONT = 0xFF1E4D2B;
    private static final int C_ON_SUCCESS_CONT = 0xFFC6F0D0;
    private static final int C_WARN = 0xFFFFD48A;

    private static final int REQ_PICK = 2001;

    /** 分辨率预设：{名称, 宽, 高} —— 覆盖手机与手表 */
    private static final String[][] PRESETS = {
            { "手机 1080 × 2400", "1080", "2400" },
            { "手机 1080 × 1920", "1080", "1920" },
            { "手机 1440 × 3200", "1440", "3200" },
            { "手表 480 × 480", "480", "480" },
            { "手表 466 × 466", "466", "466" },
            { "手表 450 × 450", "450", "450" },
            { "手表 454 × 454", "454", "454" },
            { "自定义…", "", "" },
    };

    private final Handler ui = new Handler(Looper.getMainLooper());

    private LinearLayout content;
    private TextView videoInfo;
    private LinearLayout presetRow, namingRow, progressBox;
    private ProgressBar progressBar;
    private TextView progressText;
    private Button startBtn;

    private int presetIndex = 3;          // 默认手表 480×480（上一轮的场景）
    private int targetW = 480, targetH = 480;
    private int fps = 15;
    private String framePrefix = "";      // 默认纯数字（手表常见）
    private int padWidth = 3;
    private int startNumber = 1;
    private boolean installAfter = true;

    private VideoProbe probe;
    private File stagedVideo;
    private volatile boolean cancelled;
    private volatile boolean running;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
    }

    @Override
    protected void onDestroy() {
        cancelled = true;
        super.onDestroy();
    }

    /* ================================================================== */

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(C_SURFACE);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(16), dp(20), dp(16), dp(28));
        scroll.addView(content, new FrameLayout.LayoutParams(-1, -2));
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));

        content.addView(head("制作开机动画"));
        content.addView(sub("选一段视频，在手机上直接生成 bootanimation.zip。留边不拉伸，产物符合规范。"));

        // ---- 1. 选视频 ----
        LinearLayout c1 = card();
        c1.addView(sectionHead("1 · 选择视频"));
        Button pick = primary("选择视频文件");
        pick.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { pickVideo(); }
        });
        c1.addView(pick);
        videoInfo = sub("还没有选择视频");
        LinearLayout.LayoutParams vi = lp(-1, -2);
        vi.topMargin = dp(10);
        c1.addView(videoInfo, vi);
        content.addView(c1);

        // ---- 2. 目标分辨率 ----
        LinearLayout c2 = card();
        c2.addView(sectionHead("2 · 目标分辨率"));
        c2.addView(sub("填你设备的屏幕分辨率。系统会把动画整体缩放到屏幕，比例不一致就会被拉伸。"));
        presetRow = new LinearLayout(this);
        presetRow.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams pr = lp(-1, -2);
        pr.topMargin = dp(10);
        c2.addView(presetRow, pr);
        content.addView(c2);

        // ---- 3. 帧率 ----
        LinearLayout c3 = card();
        c3.addView(sectionHead("3 · 帧率"));
        c3.addView(sub("24–30 最稳。手机生成时帧数越多越慢，手表建议 12–15。"));
        LinearLayout fpsRow = new LinearLayout(this);
        fpsRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams fr = lp(-1, -2);
        fr.topMargin = dp(10);
        c3.addView(fpsRow, fr);
        int[] fpsOpts = { 12, 15, 24, 30 };
        for (int i = 0; i < fpsOpts.length; i++) {
            final int f = fpsOpts[i];
            Button b = chip(String.valueOf(f), fps == f);
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    fps = f;
                    rebuildFpsRow();
                }
            });
            LinearLayout.LayoutParams bl = lp(0, dp(42));
            bl.weight = 1f;
            bl.rightMargin = dp(6);
            fpsRow.addView(b, bl);
        }
        this.fpsRow = fpsRow;
        content.addView(c3);

        // ---- 4. 帧命名（进阶）----
        LinearLayout c4 = card();
        c4.addView(sectionHead("4 · 帧文件命名（进阶）"));
        c4.addView(sub("默认「纯数字 001.png」，很多安卓手表用这种。通用设备一般是 frame_00000.png。"));
        namingRow = new LinearLayout(this);
        namingRow.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams nr = lp(-1, -2);
        nr.topMargin = dp(10);
        c4.addView(namingRow, nr);
        content.addView(c4);

        // ---- 5. 生成 ----
        LinearLayout c5 = card();
        c5.addView(sectionHead("5 · 生成"));
        CheckBox cb = new CheckBox(this);
        cb.setText("生成后直接安装（会自动备份当前动画）");
        cb.setTextColor(C_ON_SURFACE);
        cb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        cb.setChecked(installAfter);
        cb.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() {
            public void onCheckedChanged(android.widget.CompoundButton b, boolean v) { installAfter = v; }
        });
        c5.addView(cb);

        startBtn = primary("开始制作");
        startBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { startMake(); }
        });
        LinearLayout.LayoutParams sb = lp(-1, dp(48));
        sb.topMargin = dp(10);
        c5.addView(startBtn, sb);

        progressBox = new LinearLayout(this);
        progressBox.setOrientation(LinearLayout.VERTICAL);
        progressBox.setVisibility(View.GONE);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(1000);
        progressText = sub("");
        progressBox.addView(progressBar, lp(-1, dp(10)));
        LinearLayout.LayoutParams pt = lp(-1, -2);
        pt.topMargin = dp(8);
        progressBox.addView(progressText, pt);
        LinearLayout.LayoutParams pb = lp(-1, -2);
        pb.topMargin = dp(12);
        c5.addView(progressBox, pb);
        content.addView(c5);

        content.addView(sub("提示：手机上生成较慢（每秒视频约需几秒），建议先用「取用区间」截短一些。多段拆分与更细的参数请在电脑端做。"));

        setContentView(root);
        ScreenShape.applySafeArea(this, content, dp(16), dp(20), dp(28));
        rebuildPresetRow();
        rebuildNamingRow();
    }

    private LinearLayout fpsRow;

    private void rebuildFpsRow() {
        if (fpsRow == null) return;
        fpsRow.removeAllViews();
        int[] fpsOpts = { 12, 15, 24, 30 };
        for (int i = 0; i < fpsOpts.length; i++) {
            final int f = fpsOpts[i];
            Button b = chip(String.valueOf(f), fps == f);
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { fps = f; rebuildFpsRow(); }
            });
            LinearLayout.LayoutParams bl = lp(0, dp(42));
            bl.weight = 1f;
            bl.rightMargin = dp(6);
            fpsRow.addView(b, bl);
        }
    }

    private void rebuildPresetRow() {
        presetRow.removeAllViews();
        for (int i = 0; i < PRESETS.length; i++) {
            final int idx = i;
            String label = PRESETS[i][0];
            if (i == presetIndex && !PRESETS[i][1].isEmpty()) {
                label += "  ✓";
            }
            Button b = chip(label, i == presetIndex);
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (PRESETS[idx][1].isEmpty()) {
                        askCustomSize();
                    } else {
                        presetIndex = idx;
                        targetW = Integer.parseInt(PRESETS[idx][1]);
                        targetH = Integer.parseInt(PRESETS[idx][2]);
                        rebuildPresetRow();
                    }
                }
            });
            LinearLayout.LayoutParams bl = lp(-1, dp(42));
            bl.bottomMargin = dp(6);
            presetRow.addView(b, bl);
        }
    }

    private void askCustomSize() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);
        final EditText ew = new EditText(this);
        ew.setHint("宽，例如 480");
        ew.setInputType(InputType.TYPE_CLASS_NUMBER);
        final EditText eh = new EditText(this);
        eh.setHint("高，例如 480");
        eh.setInputType(InputType.TYPE_CLASS_NUMBER);
        box.addView(ew);
        box.addView(eh);
        new AlertDialog.Builder(this)
                .setTitle("自定义分辨率")
                .setView(box)
                .setNegativeButton("取消", null)
                .setPositiveButton("确定", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int w) {
                        try {
                            int a = Integer.parseInt(ew.getText().toString().trim());
                            int b = Integer.parseInt(eh.getText().toString().trim());
                            if (a < 2 || b < 2) throw new NumberFormatException();
                            targetW = Math.min(4096, a);
                            targetH = Math.min(4096, b);
                            presetIndex = PRESETS.length - 1;
                            rebuildPresetRow();
                        } catch (Throwable t) {
                            toast("宽高需要是大于 1 的整数");
                        }
                    }
                }).show();
    }

    private void rebuildNamingRow() {
        namingRow.removeAllViews();

        LinearLayout r1 = new LinearLayout(this);
        r1.setOrientation(LinearLayout.HORIZONTAL);
        namingRow.addView(r1, lp(-1, -2));

        r1.addView(presetChip("001.png（手表）", "".equals(framePrefix) && padWidth == 3 && startNumber == 1,
                new Runnable() { public void run() { framePrefix = ""; padWidth = 3; startNumber = 1; rebuildNamingRow(); } }));
        r1.addView(presetChip("000.png", "".equals(framePrefix) && padWidth == 3 && startNumber == 0,
                new Runnable() { public void run() { framePrefix = ""; padWidth = 3; startNumber = 0; rebuildNamingRow(); } }));
        r1.addView(presetChip("frame_00000", "frame_".equals(framePrefix) && padWidth == 5 && startNumber == 0,
                new Runnable() { public void run() { framePrefix = "frame_"; padWidth = 5; startNumber = 0; rebuildNamingRow(); } }));

        TextView t = sub("当前：" + (framePrefix.isEmpty() ? "纯数字" : "前缀 " + framePrefix)
                + "，补零 " + padWidth + " 位，起始 " + startNumber
                + "　→　首帧 " + sampleName());
        LinearLayout.LayoutParams tl = lp(-1, -2);
        tl.topMargin = dp(8);
        namingRow.addView(t, tl);

        Button adv = tonal("手动修改命名");
        adv.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askNaming(); }
        });
        LinearLayout.LayoutParams al = lp(-1, dp(42));
        al.topMargin = dp(8);
        namingRow.addView(adv, al);
    }

    private String sampleName() {
        StringBuilder sb = new StringBuilder(framePrefix);
        String s = Integer.toString(startNumber);
        for (int i = s.length(); i < padWidth; i++) sb.append('0');
        return sb.append(s).append(".png").toString();
    }

    private void askNaming() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);
        final EditText ep = new EditText(this);
        ep.setHint("前缀（可留空 = 纯数字）");
        ep.setText(framePrefix);
        final EditText epad = new EditText(this);
        epad.setHint("补零位数");
        epad.setInputType(InputType.TYPE_CLASS_NUMBER);
        epad.setText(String.valueOf(padWidth));
        final EditText est = new EditText(this);
        est.setHint("起始编号");
        est.setInputType(InputType.TYPE_CLASS_NUMBER);
        est.setText(String.valueOf(startNumber));
        box.addView(ep); box.addView(epad); box.addView(est);
        new AlertDialog.Builder(this)
                .setTitle("帧文件命名")
                .setView(box)
                .setNegativeButton("取消", null)
                .setPositiveButton("确定", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int w) {
                        framePrefix = ep.getText().toString().trim().replaceAll("[^A-Za-z0-9._-]", "");
                        try { padWidth = Math.max(1, Math.min(8, Integer.parseInt(epad.getText().toString().trim()))); } catch (Throwable ignored) { }
                        try { startNumber = Math.max(0, Integer.parseInt(est.getText().toString().trim())); } catch (Throwable ignored) { }
                        rebuildNamingRow();
                    }
                }).show();
    }

    /* ================================================================== */
    /* 选视频                                                              */
    /* ================================================================== */

    private void pickVideo() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        // 显式带上 video/*：只写 "*/*" 时有些 ROM 只让选 zip，反而选不到视频
        intent.setType("video/*");
        if (Build.VERSION.SDK_INT >= 19) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "video/*", "application/octet-stream" });
        }
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(intent, "选择视频"), REQ_PICK);
        } catch (Throwable t) {
            toast("打不开文件选择器：" + t.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || resultCode != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) { toast("没有拿到文件"); return; }
        stageVideo(uri);
    }

    /** 复制到应用私有目录：MediaMetadataRetriever 读本地文件最稳，也不用管权限 */
    private void stageVideo(final Uri uri) {
        videoInfo.setText("正在读取视频…");
        new Thread(new Runnable() {
            public void run() {
                File dir = new File(getExternalFilesDir(null) != null ? getExternalFilesDir(null) : getFilesDir(), "video");
                if (!dir.exists()) dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                final File out = new File(dir, "source.mp4");
                String err = null;
                try {
                    ContentResolver cr = getContentResolver();
                    InputStream in = cr.openInputStream(uri);
                    if (in == null) throw new Exception("无法打开所选文件");
                    OutputStream os = new FileOutputStream(out);
                    byte[] buf = new byte[128 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    os.flush(); os.close(); in.close();
                } catch (Throwable t) {
                    err = t.getMessage();
                }
                final String ferr = err;
                final VideoProbe p = ferr == null ? VideoProbe.probe(out) : null;
                ui.post(new Runnable() {
                    public void run() {
                        if (ferr != null) { videoInfo.setText("读取失败：" + ferr); toast("读取失败"); return; }
                        if (!p.ok) { videoInfo.setText(p.error); toast("无法解析这个视频"); return; }
                        probe = p;
                        stagedVideo = out;
                        videoInfo.setText("已选择：" + p.summary() + "\n文件大小 " + BootCore.mb(out.length()));
                        videoInfo.setTextColor(C_ON_SURFACE);
                        // 默认帧率贴近源（不超过 24，手机生成别太慢）
                        if (fps == 15 && p.fps > 0) {
                            fps = (int) Math.max(12, Math.min(24, Math.round(p.fps)));
                            if (fps > 24) fps = 24;
                            rebuildFpsRow();
                        }
                    }
                });
            }
        }).start();
    }

    /* ================================================================== */
    /* 生成                                                               */
    /* ================================================================== */

    private void startMake() {
        if (running) return;
        if (probe == null || stagedVideo == null) { toast("请先选择视频"); return; }
        if (targetW < 2 || targetH < 2) { toast("分辨率无效"); return; }

        // 帧数预估，太大会先提醒（手机上生成很慢）
        double dur = probe.durationSec;
        int est = (int) Math.round(dur * fps);
        if (est > 900) {
            new AlertDialog.Builder(this)
                    .setTitle("帧数较多")
                    .setMessage("按当前参数大约会生成 " + est + " 帧。\n\n手机生成较慢，"
                            + "建议先用电脑端处理长视频；手机端更适合做几秒的短动画。\n\n仍然继续吗？")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("继续", new android.content.DialogInterface.OnClickListener() {
                        public void onClick(android.content.DialogInterface d, int w) { doMake(); }
                    }).show();
            return;
        }
        doMake();
    }

    private void doMake() {
        running = true;
        cancelled = false;
        startBtn.setEnabled(false);
        startBtn.setText("正在制作…");
        progressBox.setVisibility(View.VISIBLE);
        progressBar.setProgress(0);
        progressText.setText("准备中…");

        new Thread(new Runnable() {
            public void run() {
                File outDir = new File(getExternalFilesDir(null) != null ? getExternalFilesDir(null) : getFilesDir(), "made");
                if (!outDir.exists()) outDir.mkdirs();
                final File outFile = new File(outDir, "bootanimation.zip");

                Creator.Options o = new Creator.Options();
                o.width = targetW;
                o.height = targetH;
                o.fps = fps;
                o.framePrefix = framePrefix;
                o.padWidth = padWidth;
                o.startNumber = startNumber;

                String err = null;
                Creator.Result result = null;
                AndroidFrameSource src = null;
                try {
                    // 解码长边限制在 1280：既够清晰，又避免大视频把内存打爆
                    src = new AndroidFrameSource(stagedVideo, 1280);
                    result = Creator.convert(o, src, outFile, new Creator.Progress() {
                        public boolean onProgress(final double ratio, final String note) {
                            ui.post(new Runnable() {
                                public void run() {
                                    progressBar.setProgress((int) (ratio * 1000));
                                    progressText.setText(String.format(Locale.US, "%.0f%%　%s", ratio * 100, note));
                                }
                            });
                            return !cancelled;
                        }
                    });
                } catch (InterruptedException ie) {
                    err = "已取消";
                } catch (Throwable t) {
                    err = t.getMessage() == null ? t.toString() : t.getMessage();
                } finally {
                    if (src != null) src.close();
                }

                final String ferr = err;
                final Creator.Result fres = result;
                ui.post(new Runnable() {
                    public void run() {
                        running = false;
                        startBtn.setEnabled(true);
                        startBtn.setText("开始制作");
                        progressBox.setVisibility(View.GONE);
                        if (ferr != null) {
                            new AlertDialog.Builder(CreatorActivity.this)
                                    .setTitle("制作失败").setMessage(ferr)
                                    .setPositiveButton("知道了", null).show();
                            return;
                        }
                        onMade(fres);
                    }
                });
            }
        }).start();
    }

    private void onMade(final Creator.Result r) {
        // 自检：用同一套 BootCore 反过来读一遍自己产出的包
        BootCore.Report rep = BootCore.validate(r.file);
        StringBuilder sb = new StringBuilder();
        sb.append("帧数：").append(r.totalFrames).append('\n');
        sb.append("分辨率：").append(r.width).append('×').append(r.height).append(" @").append(r.fps).append("fps\n");
        sb.append("体积：").append(BootCore.mb(r.bytes)).append('\n');
        sb.append("耗时：").append(String.format(Locale.US, "%.1f", r.seconds)).append(" 秒\n");
        sb.append("文件：").append(r.file.getAbsolutePath()).append('\n');
        sb.append("\n自检：").append(rep.valid ? "通过（" + rep.kindLabel() + "）" : "未通过");
        if (!rep.valid) {
            for (String e : rep.errors) sb.append("\n  ✕ ").append(e);
        }
        for (String wr : r.warnings) sb.append("\n  ! ").append(wr);

        new AlertDialog.Builder(this)
                .setTitle("制作完成")
                .setMessage(sb.toString())
                .setNegativeButton("仅保存", null)
                .setPositiveButton(installAfter ? "去安装" : "好", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int w) {
                        if (installAfter) {
                            // 把产物交给 MainActivity 走既有的校验 + 安装 + 备份流程
                            Intent i = new Intent(CreatorActivity.this, MainActivity.class);
                            i.setAction(Intent.ACTION_VIEW);
                            i.putExtra("install_path", r.file.getAbsolutePath());
                            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                            startActivity(i);
                        }
                    }
                }).show();
    }

    /* ================================================================== */
    /* 控件助手                                                            */
    /* ================================================================== */

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }
    private int dp(float v) { return ScreenShape.dp(this, v); }
    private static LinearLayout.LayoutParams lp(int w, int h) { return new LinearLayout.LayoutParams(w, h); }

    private TextView head(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        t.setTextColor(C_ON_SURFACE);
        t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
    }

    private TextView sectionHead(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setTextColor(C_PRIMARY);
        t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams p = lp(-1, -2);
        p.bottomMargin = dp(10);
        t.setLayoutParams(p);
        return t;
    }

    private TextView sub(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        t.setTextColor(C_ON_SURF_VAR);
        t.setLineSpacing(dp(3), 1f);
        return t;
    }

    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_SURF_LOW);
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), C_OUTLINE);
        c.setBackground(bg);
        c.setPadding(dp(16), dp(16), dp(16), dp(16));
        LinearLayout.LayoutParams p = lp(-1, -2);
        p.bottomMargin = dp(12);
        c.setLayoutParams(p);
        return c;
    }

    private Button primary(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextColor(C_ON_PRIMARY);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_PRIMARY);
        bg.setCornerRadius(dp(24));
        b.setBackground(ripple(bg));
        b.setMinHeight(dp(48));
        b.setLayoutParams(lp(-1, dp(48)));
        return b;
    }

    private Button tonal(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextColor(C_ON_PRIMARY_CONT);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_PRIMARY_CONT);
        bg.setCornerRadius(dp(24));
        b.setBackground(ripple(bg));
        b.setMinHeight(dp(42));
        return b;
    }

    private Button chip(String s, boolean selected) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setTextColor(selected ? C_ON_PRIMARY_CONT : C_ON_SURFACE);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(selected ? C_PRIMARY_CONT : C_SURF_HIGH);
        bg.setCornerRadius(dp(20));
        b.setBackground(selected ? bg : ripple(bg));
        b.setPadding(dp(12), 0, dp(12), 0);
        return b;
    }

    private Button presetChip(String s, boolean selected, final Runnable onClick) {
        Button b = chip(s, selected);
        b.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { onClick.run(); }
        });
        LinearLayout.LayoutParams p = lp(0, dp(40));
        p.weight = 1f;
        p.rightMargin = dp(6);
        b.setLayoutParams(p);
        return b;
    }

    private android.graphics.drawable.Drawable ripple(GradientDrawable base) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            try {
                return new android.graphics.drawable.RippleDrawable(
                        android.content.res.ColorStateList.valueOf(0x33FFFFFF), base, null);
            } catch (Throwable ignored) { }
        }
        return base;
    }
}
