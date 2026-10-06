package com.baimacao.bootanimforge;

import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

/**
 * ScreenShape —— 屏幕形状判断与圆形安全区。
 *
 * 为什么要单独做：
 *   · 圆屏手表上，靠近四角的内容会被物理裁掉，必须把内容收进内切圆
 *   · 系统只提供「是不是圆」这个信息，判断方式还随版本变化
 *   · 用户可能想手动覆盖（例如系统判断错了、或想预览手机布局）
 *
 * 判断优先级：
 *   1. 用户手动设置（自动 / 强制圆形 / 强制方形）
 *   2. Configuration.isScreenRound()            —— API 23+，最可靠
 *   3. UiModeManager 是手表且屏幕接近正方形      —— 旧版本回退
 *   4. 默认方形
 */
final class ScreenShape {

    static final int MODE_AUTO = 0;
    static final int MODE_ROUND = 1;
    static final int MODE_SQUARE = 2;

    private static final String PREFS = "bootanimforge";
    private static final String KEY_MODE = "screen_shape_mode";

    private ScreenShape() { }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static int getMode(Context c) {
        return prefs(c).getInt(KEY_MODE, MODE_AUTO);
    }

    static void setMode(Context c, int mode) {
        prefs(c).edit().putInt(KEY_MODE, mode).commit();
    }

    static String modeLabel(int mode) {
        switch (mode) {
            case MODE_ROUND: return "强制圆形";
            case MODE_SQUARE: return "强制方形";
            default: return "自动识别";
        }
    }

    /** 是否按圆形布局处理 */
    static boolean isRound(Context c) {
        int mode = getMode(c);
        if (mode == MODE_ROUND) return true;
        if (mode == MODE_SQUARE) return false;
        return detectRound(c);
    }

    /** 自动判断。每一步都做了版本保护，低版本不会崩 */
    static boolean detectRound(Context c) {
        // API 23+：直接问系统
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Configuration cfg = c.getResources().getConfiguration();
                if (cfg.isScreenRound()) return true;
            } catch (Throwable ignored) { }
        }
        // 旧版本回退：是手表设备 + 屏幕接近正方形 → 大概率圆屏
        try {
            UiModeManager um = (UiModeManager) c.getSystemService(Context.UI_MODE_SERVICE);
            if (um != null && um.getCurrentModeType() == Configuration.UI_MODE_TYPE_WATCH) {
                DisplayMetrics dm = c.getResources().getDisplayMetrics();
                if (dm.widthPixels > 0 && dm.heightPixels > 0) {
                    float ratio = (float) dm.widthPixels / (float) dm.heightPixels;
                    if (ratio > 0.9f && ratio < 1.1f) return true;
                }
            }
        } catch (Throwable ignored) { }
        return false;
    }

    /**
     * 圆屏安全区内边距。
     * 内切圆里最大的正方形边长是 直径/√2 ≈ 0.707·直径，
     * 所以左右各留 (1 - 0.707)/2 ≈ 14.6% 的宽度，才能保证四角不被切掉。
     * 这里再留一点余量到 16%，视觉上更舒服。
     */
    static int safeInset(Context c) {
        int w = c.getResources().getDisplayMetrics().widthPixels;
        int h = c.getResources().getDisplayMetrics().heightPixels;
        int min = Math.min(w, h);
        int inset = (int) (min * 0.16f);
        // 手表屏幕小，至少给 16dp；但也不能超过短边的 1/3
        int minDp = dp(c, 16);
        if (inset < minDp) inset = minDp;
        if (inset > min / 3) inset = min / 3;
        return inset;
    }

    static int dp(Context c, float v) {
        return (int) (v * c.getResources().getDisplayMetrics().density + 0.5f);
    }

    /**
     * 把内容收进圆形安全区：调整 padding。
     * 非圆屏时把 padding 复位，所以同一个布局可以来回切换。
     *
     * @param content 需要加安全区的内容容器
     * @param baseLeft 等：本来就需要的额外边距（普通 16dp 之类）
     */
    static void applySafeArea(Context c, View content, int baseH, int baseTop, int baseBottom) {
        if (content == null) return;
        if (isRound(c)) {
            int inset = safeInset(c);
            content.setPadding(inset, Math.max(inset, baseTop), inset, Math.max(inset, baseBottom));
        } else {
            content.setPadding(baseH, baseTop, baseH, baseBottom);
        }
        if (content.getLayoutParams() instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) content.getLayoutParams();
            lp.gravity = android.view.Gravity.CENTER_HORIZONTAL | android.view.Gravity.TOP;
            content.setLayoutParams(lp);
        }
    }

    /** 圆屏时限制宽度上限，避免平板/手机上被拉太宽 */
    static void limitWidth(Context c, ViewGroup view, int maxDp) {
        int max = dp(c, maxDp);
        int w = c.getResources().getDisplayMetrics().widthPixels;
        if (w > max) {
            ViewGroup.LayoutParams lp = view.getLayoutParams();
            if (lp != null) {
                lp.width = max;
                view.setLayoutParams(lp);
            }
        }
    }
}
