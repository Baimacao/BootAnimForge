package com.baimacao.bootanimforge;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * MainActivity —— 启幕（安卓版）：刷入 / 备份 / 还原。
 *
 * 为什么安卓版做「刷入器」而不是「转换器」：
 *   安卓端跑的就是要装动画的那台设备，所以它最缺的不是算力，而是
 *   「文件该放哪、权限怎么设、装错了怎么退回去」。这三点做好了，
 *   比在手机上重新实现一遍视频转帧要有价值得多。
 *
 * 兼容性：minSdk 19（Android 4.4）。所有新 API 都做了版本判断或 try/catch，
 *         高版本 Android 的存储/权限变化都在运行时处理。
 * 圆屏：  ScreenShape 统一判断，设置里可手动覆盖。
 */
public class MainActivity extends Activity {

    /* MD3 令牌（与 PC 端 app.css 一致） */
    private static final int C_PRIMARY = Palette.PRIMARY;
    private static final int C_ON_PRIMARY = Palette.ON_PRIMARY;
    private static final int C_PRIMARY_CONT = Palette.PRIMARY_CONTAINER;
    private static final int C_ON_PRIMARY_CONT = Palette.ON_PRIMARY_CONTAINER;
    private static final int C_SECONDARY_CONT = Palette.SECONDARY_CONTAINER;
    private static final int C_ON_SECONDARY_CONT = Palette.ON_SECONDARY_CONTAINER;
    private static final int C_SURFACE = Palette.SURFACE;
    private static final int C_SURF_LOW = Palette.SURFACE_LOW;
    private static final int C_SURF_HIGH = Palette.SURFACE_HIGH;
    private static final int C_SURF_HIGHEST = Palette.SURFACE_HIGHEST;
    private static final int C_ON_SURFACE = Palette.ON_SURFACE;
    private static final int C_ON_SURF_VAR = Palette.ON_SURFACE_VARIANT;
    private static final int C_OUTLINE = Palette.OUTLINE;
    private static final int C_ERROR = Palette.ERROR;
    private static final int C_ERROR_CONT = Palette.ERROR_CONTAINER;
    private static final int C_ON_ERROR_CONT = Palette.ON_ERROR_CONTAINER;
    private static final int C_SUCCESS_CONT = Palette.SUCCESS_CONTAINER;
    private static final int C_ON_SUCCESS_CONT = Palette.ON_SUCCESS_CONTAINER;
    private static final int C_WARN_CONT = Palette.WARN_CONTAINER;
    private static final int C_WARN = Palette.WARN;

    private static final int REQ_PICK = 1001;

    private final Handler ui = new Handler(Looper.getMainLooper());

    private LinearLayout content;
    private TextView statusRootValue, statusCurrentValue, statusPathValue;
    private LinearLayout reportBox, backupRow, pathRow;
    private Button installBtn, restoreBtn;

    private boolean rooted;
    private List<BootScanner.Found> found = new ArrayList<BootScanner.Found>();
    private BootScanner.Found active;
    private String targetPath;
    private int animTarget = AnimTarget.BOOT;      // 当前操作的是开机还是关机动画
    private LinearLayout targetRow;
    private Button previewBtn;
    private File staged;                        // 已复制到应用目录、待安装的包
    private BootCore.Report stagedReport;

    /** 目标切换后，旧路径可能不属于当前目标（文件名不同），需要重选 */
    private boolean sameTarget(String path) {
        return AnimTarget.detectFromPath(path) == animTarget;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        refreshAll();
        handleExternalInstall(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleExternalInstall(intent);
    }

    /**
     * 从「制作」页跳回来时，它会把刚生成的 zip 路径带过来。
     * 这里复用既有的「校验 → 安装 → 自动备份」流程，不另开一套逻辑。
     */
    private void handleExternalInstall(Intent intent) {
        if (intent == null) return;
        final String path = intent.getStringExtra("install_path");
        if (path == null || path.length() == 0) return;
        intent.removeExtra("install_path");
        final File f = new File(path);
        if (!f.exists()) { toast("找不到刚生成的包"); return; }
        new Thread(new Runnable() {
            public void run() {
                final BootCore.Report rep = BootCore.validate(f);
                ui.post(new Runnable() {
                    public void run() {
                        staged = f;
                        stagedReport = rep;
                        showReport(rep);
                        toast(rep.valid ? "制作产物已就绪，可点安装" : "产物校验未通过");
                    }
                });
            }
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从设置/权限页回来时重新套用安全区（圆屏开关可能变了）
        applyShape();
    }

    /* ================================================================== */
    /* 界面构建                                                            */
    /* ================================================================== */

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(C_SURFACE);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);

        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(16), dp(20), dp(16), dp(28));
        scroll.addView(content, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // ---- 顶部标识 ----
        TextView title = text("启幕", 22, C_ON_SURFACE, true);
        content.addView(title);
        TextView sub = text("BootAnimForge · 安卓版 · 刷入 / 备份 / 还原", 12, C_ON_SURF_VAR, false);
        LinearLayout.LayoutParams subLp = lp(-1, -2);
        subLp.bottomMargin = dp(16);
        content.addView(sub, subLp);

        // ---- 目标切换：开机 / 关机 ----
        LinearLayout modeCard = card();
        modeCard.addView(sectionHead("操作对象"));
        modeCard.addView(text("开机与关机动画是两个独立的文件，可以分别替换。先选要处理哪一个。",
                12, C_ON_SURF_VAR, false));
        targetRow = new LinearLayout(this);
        targetRow.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams trLp = lp(-1, -2);
        trLp.topMargin = dp(10);
        modeCard.addView(targetRow, trLp);
        content.addView(modeCard);

        // ---- 预览当前动画 ----
        LinearLayout previewCard = card();
        previewCard.addView(sectionHead("预览当前动画"));
        previewCard.addView(text("在刷入之前先看一眼设备上现在用的是什么动画 —— 不用重启就能确认。",
                12, C_ON_SURF_VAR, false));
        previewBtn = tonalButton("预览当前动画");
        previewBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { previewCurrent(); }
        });
        LinearLayout.LayoutParams pvLp = lp(-1, dp(44));
        pvLp.topMargin = dp(10);
        previewCard.addView(previewBtn, pvLp);
        content.addView(previewCard);

        // ---- 制作入口 ----
        LinearLayout makeCard = card();
        makeCard.addView(sectionHead("制作开机动画"));
        makeCard.addView(text("在手机上把一段视频做成 bootanimation.zip。适合「截几秒 + 改成手表分辨率 + 直接装上」这种场景；"
                + "长视频与多段拆分建议用电脑端。", 12, C_ON_SURF_VAR, false));
        Button makeBtn = primaryButton("打开制作");
        makeBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                try {
                    startActivity(new Intent(MainActivity.this, CreatorActivity.class));
                } catch (Throwable t) {
                    toast("打不开制作页：" + t.getMessage());
                }
            }
        });
        LinearLayout.LayoutParams mbLp = lp(-1, dp(48));
        mbLp.topMargin = dp(12);
        makeCard.addView(makeBtn, mbLp);
        content.addView(makeCard);

        // ---- 状态卡片 ----
        LinearLayout statusCard = card();
        statusCard.addView(sectionHead("设备状态"));
        statusRootValue = row(statusCard, "Root 权限", "检测中…");
        statusCurrentValue = row(statusCard, "当前动画", "检测中…");
        statusPathValue = row(statusCard, "安装路径", "检测中…");
        content.addView(statusCard);

        // ---- 安装卡片 ----
        LinearLayout installCard = card();
        installCard.addView(sectionHead("安装开机动画"));
        TextView tip = text("选一个 bootanimation.zip → 校验 → 安装。安装前会自动备份当前动画。",
                12, C_ON_SURF_VAR, false);
        LinearLayout.LayoutParams tipLp = lp(-1, -2);
        tipLp.bottomMargin = dp(12);
        installCard.addView(tip, tipLp);

        installBtn = primaryButton("选择 bootanimation.zip");
        installBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { pickPackage(); }
        });
        installCard.addView(installBtn);

        reportBox = new LinearLayout(this);
        reportBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams rbLp = lp(-1, -2);
        rbLp.topMargin = dp(12);
        installCard.addView(reportBox, rbLp);

        restoreBtn = tonalButton("还原上一个备份");
        restoreBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { confirmRestore(); }
        });
        LinearLayout.LayoutParams rLp = lp(-1, -2);
        rLp.topMargin = dp(12);
        installCard.addView(restoreBtn, rLp);
        content.addView(installCard);

        // ---- 安装路径选择 ----
        LinearLayout pathCard = card();
        pathCard.addView(sectionHead("安装路径"));
        pathCard.addView(text("不确定就保持默认。程序会优先覆盖设备上已存在的那一个。",
                12, C_ON_SURF_VAR, false));
        pathRow = new LinearLayout(this);
        pathRow.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams prLp = lp(-1, -2);
        prLp.topMargin = dp(10);
        pathCard.addView(pathRow, prLp);
        content.addView(pathCard);

        // ---- 显示设置（圆屏适配）----
        LinearLayout shapeCard = card();
        shapeCard.addView(sectionHead("屏幕形状（圆屏适配）"));
        shapeCard.addView(text("圆屏手表上四角会被裁掉，开启圆形布局可把内容收进安全区。判断错了就手动指定。",
                12, C_ON_SURF_VAR, false));

        RadioGroup group = new RadioGroup(this);
        group.setOrientation(RadioGroup.VERTICAL);
        LinearLayout.LayoutParams gLp = lp(-1, -2);
        gLp.topMargin = dp(8);
        String detected = ScreenShape.detectRound(this) ? "系统报告：圆屏" : "系统报告：方形";
        int[] modes = { ScreenShape.MODE_AUTO, ScreenShape.MODE_ROUND, ScreenShape.MODE_SQUARE };
        for (int i = 0; i < modes.length; i++) {
            final int mode = modes[i];
            RadioButton rb = new RadioButton(this);
            String label = ScreenShape.modeLabel(mode);
            if (mode == ScreenShape.MODE_AUTO) label += "（" + detected + "）";
            rb.setText(label);
            rb.setTextColor(C_ON_SURFACE);
            rb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            rb.setId(1000 + i);
            rb.setChecked(ScreenShape.getMode(this) == mode);
            rb.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    ScreenShape.setMode(MainActivity.this, mode);
                    applyShape();
                    rebuildPathRows();
                    toast("已切换为" + ScreenShape.modeLabel(mode));
                }
            });
            group.addView(rb);
        }
        shapeCard.addView(group, gLp);
        content.addView(shapeCard);

        // ---- 备份卡片 ----
        LinearLayout backupCard = card();
        backupCard.addView(sectionHead("备份"));
        backupCard.addView(text("每次安装前都会自动备份当前动画。备份放在应用的私有目录里，不会占用系统分区。",
                12, C_ON_SURF_VAR, false));
        backupRow = new LinearLayout(this);
        backupRow.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams bLp = lp(-1, -2);
        bLp.topMargin = dp(10);
        backupCard.addView(backupRow, bLp);
        content.addView(backupCard);

        // ---- 底部说明 ----
        TextView foot = text("需要 root（Magisk / SuperSU 均可）。本程序只替换开机动画文件，不修改分区表、不动 boot 分区。",
                11, C_ON_SURF_VAR, false);
        LinearLayout.LayoutParams fLp = lp(-1, -2);
        fLp.topMargin = dp(8);
        content.addView(foot, fLp);

        setContentView(root);
        applyShape();
        rebuildTargetRow();
    }

    /** 开机 / 关机 切换 */
    private void rebuildTargetRow() {
        if (targetRow == null) return;
        targetRow.removeAllViews();
        int[] targets = { AnimTarget.BOOT, AnimTarget.SHUTDOWN };
        for (int i = 0; i < targets.length; i++) {
            final int t = targets[i];
            boolean sel = animTarget == t;
            Button b = styledButton((sel ? "● " : "○ ") + AnimTarget.label(t)
                            + "　" + AnimTarget.fileName(t),
                    sel ? C_PRIMARY_CONT : C_SURF_HIGH,
                    sel ? C_ON_PRIMARY_CONT : C_ON_SURFACE);
            b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    if (animTarget == t) return;
                    animTarget = t;
                    targetPath = null;              // 路径要按新目标重选
                    active = null;
                    rebuildTargetRow();
                    refreshAll();
                }
            });
            LinearLayout.LayoutParams bl = lp(-1, dp(44));
            bl.bottomMargin = dp(6);
            targetRow.addView(b, bl);
        }
    }

    /**
     * 预览当前动画：从已安装的 zip 里取几帧出来看。
     * 直接用 root 把系统文件复制到应用目录再解包 —— 避免为了看一帧就整包读进内存。
     */
    private void previewCurrent() {
        final String path = targetPath != null ? targetPath : (active != null ? active.path : null);
        if (path == null) { toast("还没有确定要预览的文件路径"); return; }

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("预览 " + AnimTarget.label(animTarget))
                .setMessage("正在读取…")
                .setPositiveButton("好", null)
                .create();
        dialog.show();

        new Thread(new Runnable() {
            public void run() {
                File tmp = new File(getExternalFilesDir(null) != null ? getExternalFilesDir(null) : getFilesDir(),
                        "preview/current.zip");
                final FramePreview.Result res;
                String err = null;
                try {
                    // 清掉上次的
                    File dir = tmp.getParentFile();
                    if (dir != null && dir.exists()) {
                        File[] old = dir.listFiles();
                        if (old != null) for (File f : old) f.delete();
                    }
                    if (dir != null) dir.mkdirs();

                    RootShell.FileInfo fi = RootShell.statFile(path);
                    if (!fi.exists) {
                        err = "文件不存在：" + path;
                        res = null;
                    } else {
                        RootShell.Result cp = RootShell.pullTo(path, tmp.getAbsolutePath());
                        if (!cp.ok() || !tmp.exists() || tmp.length() == 0) {
                            err = "复制失败：" + cp.text();
                            res = null;
                        } else {
                            res = FramePreview.load(tmp, 6);
                        }
                    }
                } catch (Throwable t) {
                    err = t.getMessage();
                    final String cerr = err;
                    ui.post(new Runnable() {
                        public void run() {
                            dialog.dismiss();
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("预览失败").setMessage(cerr)
                                    .setPositiveButton("知道了", null).show();
                        }
                    });
                    return;
                }

                final FramePreview.Result fres = res;
                final String ferr = err;
                ui.post(new Runnable() {
                    public void run() {
                        dialog.dismiss();
                        if (ferr != null) {
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("预览失败").setMessage(ferr)
                                    .setPositiveButton("知道了", null).show();
                            return;
                        }
                        showPreviewResult(fres);
                    }
                });
            }
        }).start();
    }

    private void showPreviewResult(FramePreview.Result res) {
        if (res == null) return;
        StringBuilder head = new StringBuilder();
        head.append("位置：").append(targetPath).append('\n');
        if (res.info != null && res.info.length() > 0) head.append(res.info).append('\n');
        if (res.error != null) head.append("\n").append(res.error);
        if (res.frames.isEmpty()) {
            new AlertDialog.Builder(this)
                    .setTitle("预览")
                    .setMessage(head.toString())
                    .setPositiveButton("关闭", null).show();
            return;
        }

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(12), dp(12), dp(12), dp(12));
        TextView info = text(head.toString(), 12, C_ON_SURF_VAR, false);
        box.addView(info);
        for (int i = 0; i < res.frames.size(); i++) {
            FramePreview.Frame f = res.frames.get(i);
            TextView label = text(f.label, 11, C_ON_SURF_VAR, false);
            LinearLayout.LayoutParams ll = lp(-1, -2);
            ll.topMargin = dp(8);
            box.addView(label, ll);
            android.widget.ImageView iv = new android.widget.ImageView(this);
            iv.setImageBitmap(f.bitmap);
            iv.setAdjustViewBounds(true);
            iv.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
            box.addView(iv, lp(-1, dp(170)));
        }
        ScrollView sv = new ScrollView(this);
        sv.addView(box);
        new AlertDialog.Builder(this)
                .setTitle("预览 · " + AnimTarget.label(animTarget))
                .setView(sv)
                .setPositiveButton("关闭", null)
                .show();
    }

    /** 圆屏安全区：每次形状设置变化后重新套用 */
    private void applyShape() {
        ScreenShape.applySafeArea(this, content, dp(16), dp(20), dp(28));
    }

    private void rebuildPathRows() {
        if (pathRow == null) return;
        pathRow.removeAllViews();
        if (!rooted) {
            pathRow.addView(text("需要 root 才能读写系统媒体目录。", 13, C_WARN, false));
            return;
        }
        if (found.isEmpty()) {
            pathRow.addView(text("没有扫描到可用的系统路径。", 13, C_ON_SURF_VAR, false));
            return;
        }
        // 只列出「已存在」以及最常见的两个候选，避免把十个路径全糊上去
        List<BootScanner.Found> show = new ArrayList<BootScanner.Found>();
        for (BootScanner.Found f : found) {
            if (f.exists) show.add(f);
        }
        for (String must : AnimTarget.candidates(animTarget)) {
            if (show.size() >= 4) break;
            boolean already = false;
            for (BootScanner.Found s : show) if (s.path.equals(must)) already = true;
            if (already) continue;
            for (BootScanner.Found f : found) {
                if (f.path.equals(must)) { show.add(f); break; }
            }
        }
        for (final BootScanner.Found f : show) {
            Button b = pathButton(f, f.path.equals(targetPath));
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    targetPath = f.path;
                    rebuildPathRows();
                    updateStatus();
                }
            });
            LinearLayout.LayoutParams lp = lp(-1, dp(40));
            lp.bottomMargin = dp(6);
            pathRow.addView(b, lp);
        }
    }

    /* ================================================================== */
    /* 状态刷新                                                            */
    /* ================================================================== */

    private void refreshAll() {
        setStatusLine("正在检测 root…", C_ON_SURF_VAR);
        new Thread(new Runnable() {
            public void run() {
                RootShell.resetCache();
                final boolean isRooted = RootShell.available();
                final List<BootScanner.Found> list = BootScanner.scan(isRooted, animTarget);
                ui.post(new Runnable() {
                    public void run() {
                        rooted = isRooted;
                        found = list;
                        active = BootScanner.pickActive(list);
                        if (targetPath == null || !sameTarget(targetPath)) {
                            targetPath = active != null ? active.path
                                    : AnimTarget.candidates(animTarget)[0];
                        }
                        updateStatus();
                        rebuildPathRows();
                        refreshBackups();
                    }
                });
            }
        }).start();
    }

    private void setStatusLine(String text, int color) {
        statusCurrentValue.setText(text);
        statusCurrentValue.setTextColor(color);
    }

    private void updateStatus() {
        statusRootValue.setText(rooted ? "已获取" : "未获取");
        statusRootValue.setTextColor(rooted ? C_ON_SUCCESS_CONT : C_ERROR);

        TextView curVal = statusCurrentValue;
        if (curVal != null) {
            if (active == null) {
                curVal.setText("未检测到已有动画（可能是路径特殊）");
                curVal.setTextColor(C_WARN);
            } else {
                curVal.setText(active.title() + " · " + BootCore.mb(active.size)
                        + " · " + (active.isZip() ? "zip" : "其他"));
                curVal.setTextColor(C_ON_SURFACE);
            }
        }

        statusPathValue.setText(targetPath == null ? "—" : targetPath);
        statusPathValue.setTextColor(C_ON_SURFACE);

        if (!rooted) {
            installBtn.setText("未获取 root —— 点此重试");
            installBtn.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { refreshAll(); }
            });
        } else {
            installBtn.setText("选择 bootanimation.zip");
            installBtn.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { pickPackage(); }
            });
        }
    }

    /* ================================================================== */
    /* 选择与校验                                                          */
    /* ================================================================== */

    private void pickPackage() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(intent, "选择 bootanimation.zip"), REQ_PICK);
        } catch (Throwable t) {
            toast("无法打开文件选择器：" + t.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || resultCode != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) { toast("没有拿到文件"); return; }
        stageAndValidate(uri);
    }

    /** 把选中的文件复制到应用私有目录，然后校验 */
    private void stageAndValidate(final Uri uri) {
        showReport(null);   // 先显示"处理中"
        new Thread(new Runnable() {
            public void run() {
                File dir = new File(getExternalFilesDir(null) != null
                        ? getExternalFilesDir(null) : getFilesDir(), "stage");
                if (!dir.exists()) dir.mkdirs();
                // 清掉上一次的暂存，避免混淆
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();

                final File out = new File(dir, "bootanimation.zip");
                String err = null;
                try {
                    InputStream in = getContentResolver().openInputStream(uri);
                    if (in == null) throw new Exception("无法打开所选文件");
                    OutputStream os = new FileOutputStream(out);
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    os.flush(); os.close(); in.close();
                } catch (Throwable t) {
                    err = t.getMessage();
                }

                final String ferr = err;
                final BootCore.Report rep = ferr == null ? BootCore.validate(out) : null;
                ui.post(new Runnable() {
                    public void run() {
                        if (ferr != null) {
                            showReport(null);
                            toast("读取失败：" + ferr);
                            installBtn.setText("选择 bootanimation.zip");
                            return;
                        }
                        staged = out;
                        stagedReport = rep;
                        showReport(rep);
                    }
                });
            }
        }).start();
    }

    /** 显示校验结果，并在合法时提供安装按钮 */
    private void showReport(final BootCore.Report rep) {
        reportBox.removeAllViews();
        if (rep == null) {
            reportBox.addView(text("正在读取并校验…", 12, C_ON_SURF_VAR, false));
            return;
        }

        int tone = rep.valid ? C_SUCCESS_CONT : C_ERROR_CONT;
        int toneText = rep.valid ? C_ON_SUCCESS_CONT : C_ON_ERROR_CONT;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(roundRect(tone, Palette.RADIUS, 0, 0));
        box.setPadding(dp(12), dp(12), dp(12), dp(12));

        TextView head = text(rep.valid ? "校验通过 · " + rep.kindLabel() : "校验未通过", 14, toneText, true);
        box.addView(head);

        if (rep.kind == BootCore.KIND_CLASSIC) {
            box.addView(text("分辨率 " + rep.width + "×" + rep.height + " · " + rep.fps + " fps"
                    + (rep.hasProgress ? " · 显示进度条" : ""), 12, toneText, false));
            for (BootCore.FrameInfo p : rep.parts) {
                box.addView(text(p.dir + "：" + p.count + " 帧（编号 " + p.range() + "）",
                        12, toneText, false));
            }
        } else if (rep.kind == BootCore.KIND_VIDEO) {
            box.addView(text("视频版格式：只有 Android 12+ 的部分机型会读取它", 12, toneText, false));
        }

        for (String e : rep.errors) box.addView(bullet("✕ " + e, toneText));
        for (String w : rep.warnings) box.addView(bullet("! " + w, toneText));
        for (String nn : rep.notes) box.addView(bullet("· " + nn, toneText));

        LinearLayout.LayoutParams boxLp = lp(-1, -2);
        reportBox.addView(box, boxLp);

        if (rep.valid) {
            Button b = primaryButton("安装到 " + shortPath(targetPath));
            b.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { confirmInstall(rep); }
            });
            LinearLayout.LayoutParams bLp = lp(-1, dp(48));
            bLp.topMargin = dp(10);
            reportBox.addView(b, bLp);
        }
    }

    /* ================================================================== */
    /* 安装                                                               */
    /* ================================================================== */

    private void confirmInstall(final BootCore.Report rep) {
        final String dest = targetPath;
        if (dest == null) { toast("没有选择安装路径"); return; }

        StringBuilder msg = new StringBuilder();
        msg.append("即将安装到：\n").append(dest).append("\n\n");
        msg.append("包类型：").append(rep.kindLabel()).append("\n");
        if (rep.kind == BootCore.KIND_CLASSIC) {
            msg.append("分辨率：").append(rep.width).append("×").append(rep.height)
               .append(" ").append(rep.fps).append("fps\n");
            msg.append("总帧数：").append(rep.totalFrames).append("\n");
        }
        msg.append("\n安装前会自动备份当前动画。\n");
        msg.append("\n⚠ 如果当前设备读取的是另一种格式，替换后开机可能看不到动画（系统仍能正常启动）。");
        msg.append("真出问题时用本程序的「还原上一个备份」即可恢复。");

        new AlertDialog.Builder(this)
                .setTitle("确认安装")
                .setMessage(msg.toString())
                .setNegativeButton("取消", null)
                .setPositiveButton("安装", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int w) { doInstall(dest, rep); }
                })
                .show();
    }

    private void doInstall(final String dest, final BootCore.Report rep) {
        installBtn.setEnabled(false);
        installBtn.setText("正在安装…");
        new Thread(new Runnable() {
            public void run() {
                final StringBuilder log = new StringBuilder();
                String err = null;
                try {
                    // 1) 备份当前动画
                    String backupMsg = BackupManager.backup(MainActivity.this, dest, active);
                    log.append(backupMsg).append('\n');

                    // 2) 暂存文件复制到 root 可读的位置
                    String stagePath = staged.getAbsolutePath();
                    RootShell.Result cp = RootShell.copy(stagePath, "/data/local/tmp/baf-install.zip");
                    if (!cp.ok()) throw new Exception("复制到临时目录失败：" + cp.text());
                    log.append("已暂存到 /data/local/tmp/baf-install.zip\n");

                    // 3) 安装（含权限与 SELinux 上下文）
                    String ctx = active != null && active.context != null ? active.context : "";
                    if (ctx.length() == 0) ctx = dest.startsWith("/product") ? "u:object_r:system_file:s0" : "u:object_r:system_file:s0";
                    RootShell.Result ins = RootShell.installFile("/data/local/tmp/baf-install.zip", dest, ctx);
                    log.append(ins.out);
                    if (!ins.ok()) throw new Exception("安装失败：" + ins.text());
                    RootShell.delete("/data/local/tmp/baf-install.zip");

                    // 4) 复核
                    RootShell.FileInfo fi = RootShell.statFile(dest);
                    if (!fi.exists) throw new Exception("安装后文件不存在，可能路径不可写");
                    log.append("安装完成：").append(dest)
                       .append("  大小 ").append(BootCore.mb(fi.size))
                       .append("  权限 ").append(fi.perms)
                       .append("  属主 ").append(fi.owner).append('\n');
                } catch (Throwable t) {
                    err = t.getMessage();
                }

                final String ferr = err;
                final String flog = log.toString();
                ui.post(new Runnable() {
                    public void run() {
                        installBtn.setEnabled(true);
                        installBtn.setText("选择 bootanimation.zip");
                        if (ferr == null) {
                            successDialog("安装成功", flog + "\n重启后生效。");
                        } else {
                            errorDialog("安装失败", ferr + "\n\n执行记录：\n" + flog);
                        }
                        refreshAll();
                    }
                });
            }
        }).start();
    }

    private void confirmRestore() {
        final List<File> list = BackupManager.list(this);
        if (list.isEmpty()) {
            toast("还没有任何备份");
            return;
        }
        String[] names = new String[list.size()];
        for (int i = 0; i < list.size(); i++) {
            names[i] = list.get(i).getName();
        }
        new AlertDialog.Builder(this)
                .setTitle("选择要还原的备份")
                .setItems(names, new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int which) {
                        doRestore(list.get(which));
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void doRestore(final File backup) {
        final String dest = targetPath;
        if (dest == null) { toast("没有选择安装路径"); return; }
        restoreBtn.setEnabled(false);
        restoreBtn.setText("正在还原…");
        new Thread(new Runnable() {
            public void run() {
                String err = null;
                String detail = "";
                try {
                    RootShell.Result r = BackupManager.restore(backup, dest);
                    detail = r.out;
                    if (!r.ok()) throw new Exception(r.text());
                } catch (Throwable t) {
                    err = t.getMessage();
                }
                final String ferr = err;
                final String fdetail = detail;
                ui.post(new Runnable() {
                    public void run() {
                        restoreBtn.setEnabled(true);
                        restoreBtn.setText("还原上一个备份");
                        if (ferr == null) successDialog("还原成功", fdetail + "\n重启后生效。");
                        else errorDialog("还原失败", ferr);
                        refreshAll();
                    }
                });
            }
        }).start();
    }

    /* ================================================================== */
    /* 备份列表显示                                                        */
    /* ================================================================== */

    private void refreshBackups() {
        if (backupRow == null) return;
        backupRow.removeAllViews();
        List<File> list = BackupManager.list(this);
        if (list.isEmpty()) {
            backupRow.addView(text("暂无备份", 13, C_ON_SURF_VAR, false));
            restoreBtn.setEnabled(false);
            restoreBtn.setAlpha(0.5f);
            return;
        }
        restoreBtn.setEnabled(true);
        restoreBtn.setAlpha(1f);
        for (int i = 0; i < list.size() && i < 5; i++) {
            File f = list.get(i);
            String when = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
                    .format(new Date(f.lastModified()));
            backupRow.addView(text("· " + when + "   " + BootCore.mb(f.length()), 12, C_ON_SURF_VAR, false));
        }
        if (list.size() > 5) {
            backupRow.addView(text("…共 " + list.size() + " 个备份", 12, C_ON_SURF_VAR, false));
        }
    }

    /* ================================================================== */
    /* 对话框与控件助手                                                    */
    /* ================================================================== */

    private void successDialog(String title, String msg) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(msg)
                .setPositiveButton("好", null).show();
    }

    private void errorDialog(String title, String msg) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(msg)
                .setPositiveButton("知道了", null).show();
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    private int dp(float v) { return ScreenShape.dp(this, v); }

    private static LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        t.setLineSpacing(dp(3), 1f);
        return t;
    }

    private TextView bullet(String s, int color) {
        TextView t = text(s, 12, color, false);
        t.setPadding(0, dp(2), 0, 0);
        return t;
    }

    private TextView sectionHead(String s) {
        TextView t = text(s, 15, C_PRIMARY, true);
        LinearLayout.LayoutParams p = lp(-1, -2);
        p.bottomMargin = dp(10);
        t.setLayoutParams(p);
        return t;
    }

    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setBackground(roundRect(C_SURF_LOW, Palette.RADIUS, C_OUTLINE, dp(1)));
        c.setPadding(dp(16), dp(16), dp(16), dp(16));
        LinearLayout.LayoutParams p = lp(-1, -2);
        p.bottomMargin = dp(12);
        c.setLayoutParams(p);
        return c;
    }

    /** 一行「标签 —— 值」，返回「值」那个 TextView 供后续更新 */
    private TextView row(LinearLayout parent, String label, String value) {
        LinearLayout line = new LinearLayout(this);
        line.setOrientation(LinearLayout.HORIZONTAL);
        line.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lLp = lp(-1, -2);
        lLp.bottomMargin = dp(6);
        parent.addView(line, lLp);

        TextView l = text(label, 13, C_ON_SURF_VAR, false);
        LinearLayout.LayoutParams lw = lp(0, -2);
        lw.weight = 1f;
        line.addView(l, lw);

        TextView v = text(value, 13, C_ON_SURFACE, true);
        v.setGravity(Gravity.END);
        line.addView(v);
        return v;
    }

    private Button primaryButton(String s) {
        return styledButton(s, C_PRIMARY, C_ON_PRIMARY);
    }

    private Button tonalButton(String s) {
        return styledButton(s, C_SECONDARY_CONT, C_ON_SECONDARY_CONT);
    }

    private Button styledButton(String s, int bg, int fg) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setBackground(ripple(roundRect(bg, dp(11), 0, 0)));   // 按钮保留小圆角以表达可点性
        b.setPadding(dp(16), 0, dp(16), 0);
        b.setMinHeight(dp(48));
        LinearLayout.LayoutParams p = lp(-1, dp(48));
        b.setLayoutParams(p);
        return b;
    }

    private Button pathButton(BootScanner.Found f, boolean selected) {
        StringBuilder label = new StringBuilder();
        label.append(selected ? "● " : "○ ");
        label.append(f.path);
        if (f.exists) label.append("  （").append(BootCore.mb(f.size)).append("）");
        else label.append("  （不存在，将新建）");
        Button b = styledButton(label.toString(),
                selected ? C_PRIMARY_CONT : C_SURF_HIGH,
                selected ? C_ON_PRIMARY_CONT : C_ON_SURFACE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        b.setAllCaps(false);
        return b;
    }

    private GradientDrawable roundRect(int color, int radius, int stroke, int strokeW) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(color);
        d.setCornerRadius(radius);
        if (strokeW > 0) d.setStroke(strokeW, stroke);
        return d;
    }

    /** API 21+ 用 RippleDrawable；低版本直接返回原背景，避免崩溃 */
    private android.graphics.drawable.Drawable ripple(GradientDrawable base) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            try {
                return new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), base, null);
            } catch (Throwable ignored) { }
        }
        return base;
    }

    private String shortPath(String p) {
        if (p == null) return "—";
        if (p.length() <= 32) return p;
        return "…" + p.substring(p.length() - 30);
    }
}
