# Android 开机动画格式说明

本文整理 `bootanimation.zip` 的权威格式，以及本工具在生成时的取舍。
主要依据 AOSP 官方文档 `frameworks/base/cmds/bootanimation/FORMAT.md`。

---

## 1. 文件位置

系统按顺序查找（不同厂商路径略有差异）：

```
/system/media/bootanimation.zip      ← 最常见
/product/media/bootanimation.zip
/oem/media/bootanimation.zip
```

早期版本还有 `/system/media/bootanimation-encrypted.zip`（`vold.decrypt=1` 时使用），现已基本废弃。

---

## 2. 目录结构

```
bootanimation.zip
├── desc.txt
├── part0/
│   ├── frame_00000.png
│   ├── frame_00001.png
│   └── …
├── part1/
│   └── …
└── （可选）trim.txt、audio.wav、clock_font.png、progress_font.png
```

- `partN` 目录里**除 `trim.txt` 和 `audio.wav` 之外**的每个文件都被当作一帧图片
- 帧必须**编号连续**并按顺序存进 zip，否则会闪帧或读不到

---

## 3. desc.txt

### 第一行：全局参数

```
WIDTH HEIGHT FPS [PROGRESS]
```

| 字段 | 含义 |
|---|---|
| `WIDTH` `HEIGHT` | 动画尺寸（像素）。系统会把动画**整体缩放**到屏幕大小 |
| `FPS` | 每秒播放帧数 |
| `PROGRESS` | 可选。非 0 时在最后一段上叠加开机进度百分比 |

> ⚠️ `WIDTH:HEIGHT` 的比例如果和屏幕不一致，系统会**直接拉伸**，画面就变形了。
> 这就是本工具把「绝不拉伸」做在**导出前**（等比缩放 + 留边 / 裁切）的原因。

### 之后每行：一段动画

```
TYPE COUNT PAUSE PATH [FADE] [#RRGGBB [CLOCK1 [CLOCK2]]]
```

| 字段 | 含义 |
|---|---|
| `TYPE` | `p` = 开机没结束就一直循环，可被打断<br>`c` = 必须播完，不受开机结束影响<br>`f` = 同 `p`，但被打断时淡出 `FADE` 帧 |
| `COUNT` | 播放次数。`0` = 一直循环到开机结束 |
| `PAUSE` | 本段播完后暂停的**帧数**（不是秒） |
| `PATH` | 帧所在目录，如 `part0` |
| `FADE` | 仅 `f` 类型：被打断时淡出的帧数。`0` 等价于 `p` |
| `#RRGGBB` | 可选，该段的背景色 |
| `CLOCK1/2` | 可选，绘制当前时间的坐标（手表用）。`c` = 居中，`n` = 距左/下 n 像素，`-n` = 距右/上 n 像素 |

还有特殊类型 `$SYSTEM`：加载并播放 `/system/media/bootanimation.zip`。

### 示例

```
1080 1920 30
p 0 0 part0
```
最经典的写法：一段，无限循环。

```
1080 2400 30 1
p 1 0 part0
c 1 0 part1
#1050
```
- 第一段：播 1 次（开场动画）
- 第二段：必须播完 1 次
- 最后一行是**注释**，系统解析时遇到无法解析的行会跳过，但更稳妥的做法是不要写注释

> 本工具不会生成注释行。给用户看的解释放在界面里，不进 `desc.txt`。

---

## 4. 打包方式：必须用 `zip -0`

AOSP 文档明确要求：

```bash
cd <path-to-pieces>
zip -0qry -i \*.txt \*.png \*.wav @ ../bootanimation.zip *.txt part*
```

原因：

1. PNG 本身已压缩，再压几乎没有收益
2. 开机动画在启动关键路径上，解压会拖慢开机
3. 部分设备的实现只按「存储」方式读取帧数据

本工具的 ZIP 写入器默认 `STORE`（压缩方式 0），并保证帧按序写入。
「压缩 zip」是个显式选项，默认关闭，并在界面上提示不推荐。

---

## 5. 可选增强

### trim.txt

按背景色裁剪纹理以省内存，每行一帧：

```
713x165+388+914
708x152+388+912
```

格式 `宽x高+X+Y`。没有这个文件时，每帧都按动画完整尺寸处理。

### audio.wav

每个 `part` 目录可放一个 `audio.wav`，播放到该段时播放。
现实中绝大多数手机在开机动画阶段不出声，这个功能主要给电视盒子、车机、定制设备用。

### 字体文件

`clock_font.png` 与 `progress_font.png` 用于绘制时间和进度文字，规格是
16 列 × 6 行，每行上下半分常规/粗体，共覆盖 ASCII 32–127。

---

## 6. Android 12+ 的视频版格式

部分新机型（尤其原生 Android 12+ 与部分厂商）改用**视频**作为开机动画：

```
bootanimation.zip
├── bootanimation.mp4     ← 视频格式的开机动画
└── audio.mp3             ← 可选音效
```

要点：

- 编码通常是 **H.264 Baseline（或 Main）**，`yuv420p`，无 B 帧，某些实现要求分辨率 ≤ 1080p
- 音轨为 AAC/MP3
- 没有 `desc.txt`，循环行为由系统控制（一般循环播放直到开机完成）

本工具生成的是**传统 PNG 序列**版本，兼容性最好（Android 4 到 14 通吃）。
如果你的设备属于视频分支，可以把导出的 MP4 直接放进上述结构（本工具的「取用区间 / 分辨率 / 帧率」设置同样可以先用它处理好素材）。

---

## 7. 退出机制

系统启动完成后会把属性 `service.bootanim.exit` 设为非零字符串，
开机动画进程收到后：

- 立即结束正在播放的 `p` 段
- 把尚未播完（甚至完全没播）的 `c` 段**完整播完**后退出

设计含义：

- 想让画面**自然中断**在任意时刻 → 用 `p`
- 想让结尾**一定播完**（比如一个 logo 定格动画）→ 用 `c`
- 想让中断更柔和 → 用 `f` 并给它一个淡出帧数

---

## 8. 性能与体积经验值

| 项目 | 建议 |
|---|---|
| 分辨率 | 不超过屏幕原生分辨率；1080p 以上收益很小、代价很大 |
| 帧率 | 24–30。60 会让帧数翻倍，低端机反而卡 |
| 总帧数 | 控制在 2000 帧以内，否则解包明显变慢 |
| 时长 | 3–10 秒。开机动画会一直播到系统启动完成，太长会显得开机慢 |
| 单帧内存 | `宽 × 高 × 4` 字节。1080×2400 一帧约 9.9 MB（系统按需解码，不必全量常驻） |

系统会为纹理预留内存。**过高分辨率 + 高帧率**是低端机开机卡顿甚至黑屏的主要原因。

---

## 参考

- [AOSP `cmds/bootanimation/FORMAT.md`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/cmds/bootanimation/FORMAT.md)
- [AOSP bootanimation 源码目录](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/cmds/bootanimation/)
