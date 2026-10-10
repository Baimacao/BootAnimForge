package com.baimacao.bootanimforge;

import android.graphics.Color;

/**
 * Palette — 单一颜色来源（瑞士国际主义风格）。
 *
 * 为什么要有这个类：MainActivity 与 CreatorActivity 原先**各自重复定义**了同一套
 * 20 个 MD3 色值（实测 MainActivity 20 个、CreatorActivity 15 个），改一次颜色要改两处、
 * 且极易漏改导致两端不一致。这里收敛为唯一来源，两个 Activity 各自保留原有常量名作为
 * 到本类的别名，因此调用点零改动。
 *
 * 配色规则（仅三色，全部平涂）：
 *   黑   #1A1A1A   文字、线、深色块
 *   米白 #F5F2ED   表面、底色
 *   红   #DA291C   强调：关键操作与核心信息点
 *
 * 层级一律靠透明度、间距、字号、线宽表达，不引入第二强调色。
 */
final class Palette {

    private Palette() { }

    /* ---- 三色基色 ---- */
    static final int BLACK = 0xFF1A1A1A;
    static final int PAPER = 0xFFF5F2ED;
    static final int RED = 0xFFDA291C;

    /** 1px 细线：黑 20% 透明度 */
    static final int LINE = 0x331A1A1A;

    /* ---- 语义色 ---- */
    /** 强调（原 MD3 primary） */
    static final int PRIMARY = RED;
    static final int ON_PRIMARY = PAPER;
    /** 强调容器：红 12% 底 —— 用于选中态 */
    static final int PRIMARY_CONTAINER = 0x1FDA291C;
    static final int ON_PRIMARY_CONTAINER = BLACK;

    /** 次级：黑 72% 文字 / 黑 8% 底 */
    static final int SECONDARY_CONTAINER = 0x141A1A1A;
    static final int ON_SECONDARY_CONTAINER = BLACK;

    /* ---- 表面：全部平涂米白，层级只靠细线与留白 ---- */
    static final int SURFACE = PAPER;
    static final int SURFACE_DIM = 0xFFE8E4DD;
    static final int SURFACE_LOW = PAPER;
    static final int SURFACE_HIGH = 0xFFEFEBE4;
    static final int SURFACE_HIGHEST = 0xFFE8E4DD;

    /** 正文黑；次级文字黑 72% */
    static final int ON_SURFACE = BLACK;
    static final int ON_SURFACE_VARIANT = 0xB81A1A1A;

    static final int OUTLINE = 0x8F1A1A1A;
    static final int OUTLINE_VARIANT = LINE;

    /* ---- 状态：受三色约束，靠透明度区分强度，不新增色相 ---- */
    static final int ERROR = RED;
    static final int ERROR_CONTAINER = 0x1FDA291C;
    static final int ON_ERROR_CONTAINER = BLACK;

    static final int SUCCESS_CONTAINER = 0x141A1A1A;
    static final int ON_SUCCESS_CONTAINER = BLACK;

    static final int WARN = BLACK;
    static final int WARN_CONTAINER = 0x0A1A1A1A;

    /* ---- 形状：瑞士风格圆角为 0 ---- */
    static final int RADIUS = 0;

    /** 颜色叠加 alpha（0..1），用于状态色分层而不引入新色相 */
    static int alpha(int color, float a) {
        int al = Math.round(Math.max(0f, Math.min(1f, a)) * 255);
        return (color & 0x00FFFFFF) | (al << 24);
    }

    /** 判断底色是浅色还是深色，用于自动选前景色（米白底 → 黑字） */
    static boolean isLight(int color) {
        double lum = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255.0;
        return lum > 0.5;
    }
}
