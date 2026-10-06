# 启幕 · 安卓版：制作 + 刷入

PC 端（`启动.cmd`）与安卓端都能**制作** `bootanimation.zip`，安卓端还负责**刷入**。

| | PC 端 | 安卓端 |
|---|---|---|
| 制作 | 完整功能：多段拆分、每段循环次数/暂停、输出格式二选一、Magisk 模块 | 基础功能：单段、分辨率/帧率/命名可调 |
| 刷入 | — | 扫描路径、Root 安装、自动备份、一键还原 |
| 适合 | 长视频、复杂分段、批量 | 外出时"截几秒 + 改成手表分辨率 + 直接装上" |

---

## 一、制作（安卓端）

主界面「制作开机动画」→ 选视频 → 目标分辨率 → 帧率 → 帧命名 → 生成。

### 技术选择与原因

| 决定 | 原因 |
|---|---|
| 用 `MediaMetadataRetriever` 取帧 | 框架 API，零第三方库；`getFrameAtTime(t, OPTION_CLOSEST)` 能按时间点取帧，精度足够做开机动画 |
| **自己写 PNG 编码器** | `Bitmap.compress(PNG)` 历史上支持并不稳定、不同 ROM 行为不一致，而本机没有真机可测。自己编码只用 `Deflater` + `CRC32`，从 Android 4.4 到最新版行为完全一致 |
| **自己写 STORE zip 写入器** | `ZipOutputStream` 强制 DEFLATE，而开机动画规范要求 STORE（`zip -0`）。且必须"流式"：1080p 一帧 ARGB 就 8 MB，几百帧不可能全放内存 |
| 解码长边限 1280 | 内存峰值可控；最终输出尺寸由等比缩放负责，画质上限不受影响 |
| 保持"绝不拉伸" | 与 PC 端同一条铁律：等比缩放 + 居中留边（留边填背景色） |
| 帧命名可配 | 默认「纯数字 001.png」（很多安卓手表用这种），也可切 `frame_00000.png` |

### 旋转元数据的处理

竖屏视频常以横向存储 + `rotation=90` 标记。不同 Android 版本的 `getFrameAtTime` 对旋转处理并不一致（有的已转好、有的没转）。这里不去猜版本，而是**比对尺寸**：先按元数据算出期望的显示尺寸，再看实际拿到的是否已经是它 —— 是就不再重复旋转。新旧行为都能正确。

### 产物自检

生成后立刻用 `BootCore`（就是刷入前用的同一份校验代码）反过来读一遍，确认 `desc.txt`、帧编号、格式都合法，才提示完成。

---

## 二、刷入（安卓端）

| 功能 | 说明 |
|---|---|
| **扫描现状** | 一次列清所有候选路径：哪个真的存在、多大、什么权限、什么 SELinux 上下文、是不是 zip |
| **安装前校验** | 解包检查：是传统帧序列还是视频版、`desc.txt` 是否合法、帧编号是否连续、视频版 moov 是否前置 |
| **一键安装** | 自动备份 → 复制到 `/data/local/tmp` → root 写入目标路径 → `chown 0:0` + `chmod 0644` + `chcon` 上下文 → 复核 |
| **自动备份** | 每次安装前强制备份；额外永久保留一份「首次备份」，任何事后都能退回原状 |
| **一键还原** | 从备份列表里选一个还原回去 |
| **Magisk 检测** | 如果已有模块提供了 bootanimation，会提示先卸载对应模块，避免互相覆盖 |
| **圆屏适配** | 自动识别圆屏并把内容收进内切圆安全区；判断错了可在设置里强制圆形/方形 |

---

## 圆屏适配

手表上靠近四角的内容会被物理裁掉，所以圆屏必须把内容收进**内切圆**。

- 判断顺序：**用户手动设置** → `Configuration.isScreenRound()`（API 23+）→ `UiModeManager` 是手表且屏幕接近正方形（旧版本回退）
- 安全区算法：内切圆里最大的正方形边长是 `直径/√2 ≈ 0.707·直径`，所以左右各留 ≈14.6%；实现里留到 **16%** 更舒服，并保证至少 16dp、不超过短边的 1/3
- 设置里三个选项：**自动识别**（会显示系统判断结果）、**强制圆形**、**强制方形** —— 切换后立即重排，不用重启

---

## 向下兼容

| 项 | 值 |
|---|---|
| minSdkVersion | **19（Android 4.4）** |
| targetSdkVersion | 30（本机 SDK 上限；高版本 Android 靠运行时判断适配） |
| 签名 | v1 + v2 + v3（v1 是为了让 Android 4.4–6.0 也能装） |
| 语言特性 | Java 8（`-source/-target 8`），**不用 lambda**（匿名内部类更稳） |

兼容性上的具体处理：

- **圆屏判断**：API 23+ 用 `isScreenRound()`，更早的版本回退到 `UiModeManager`
- **水波纹**：`RippleDrawable` 只在 API 21+ 使用，低版本回退到纯色圆角
- **文件头读取**：用 `od` 而不是 `xxd`（很多精简 ROM 没有 xxd）
- **su 路径**：`su` / `/system/bin/su` / `/system/xbin/su` / `/sbin/su` / `/su/bin/su` / `/magisk/.core/bin/su` / `/debug_ramdisk/su` 逐个尝试
- **存储权限**：`READ_EXTERNAL_STORAGE` 限 `maxSdkVersion=32`、`WRITE` 限 `29`；读写都走 `ContentResolver` 与应用私有目录，**不需要存储权限**
- **不申请** `MANAGE_EXTERNAL_STORAGE`

---

## 构建

不需要 Gradle / AGP —— 本机 Maven 仓库不可达，所以直接用 SDK 自带工具链：

```bash
node tools/make-icons.js             # 生成图标（弧 + 点）到各密度
node tools/build-android.js          # 产出 dist/android/*.apk
node tools/verify-android.js         # 静态验证：清单/权限/类/字符串/签名/对齐
node tools/coretest-android.js       # 在 PC 上跑包解析逻辑
node tools/creatortest-android.js    # 在 PC 上跑制作核心（PNG/zip/缩放）
```

流水线：`aapt2 compile` → `javac` → `d8` → `aapt2 link` → 自己写 zip 注入 `classes.dex` → `zipalign` → `apksigner`

踩过的坑（都写进代码注释了）：

- Windows 上 `.bat`/`.cmd` 不能被 `CreateProcess` 直接执行，必须走 shell
- d8 的 `@argfile` **不会去掉引号**，带引号的路径会被当成含 `"` 的非法路径
- d8 不接受「目录」作为 program input（`Unsupported source file type`），要打成 jar
- 类文件几百个直接当参数传会触发 Windows 的 `spawn EINVAL`
- `javac` 的 `-J` 选项不能写在 `@argfile` 里
- `android:windowIsRound` **不是**主题属性，写进 styles.xml 会让 aapt2 链接失败
- `static final int` 常量会被 javac **内联**，DEX 里搜不到名字 —— 拿它当断言会得到假失败

---

## 验证情况

| 套件 | 结果 |
|---|---|
| `tools/verify-android.js`（APK 静态） | **66 / 66** |
| `tools/coretest-android.js`（包解析逻辑，PC 上真跑） | **31 / 31** |
| `tools/creatortest-android.js`（制作核心，PC 上真跑） | **34 / 34** |

**制作核心为什么能在 PC 上验**：取帧被抽象成 `FrameSource` 接口，`Creator` / `PngEncoder` / `ZipStoreWriter` 全是纯 JDK 代码。于是可以：

- 让**手写的 PNG 编码器**产出文件，交给 **ffmpeg 当裁判**逐像素核对（红底 / 绿块 / 四角蓝全部对上）
- 让**手写的 STORE zip** 被自己的读取器 + `BootCore`（App 内同一份代码）双重校验
- 验证"绝不拉伸"：源 200×100 → 目标 100×100 时，四角必须是黑色留边、中心必须是画面内容

**包解析逻辑**同样在 PC 上真跑，覆盖：手表风格样本（纯数字 `001.png`，两段）、通用风格（`frame_00000.png`）、编号不连续告警、缺帧目录 / 多套一层 / 非 zip / desc.txt 首行非法报错、视频版 moov 位置、以及**跨端一致性**（PC 端产物 + 用户提供的手表样本）。

### 未能验证（本机没有 adb、也没有真机）

这部分我不会假装验过，需要你装到设备上确认：

- 真机安装与启动
- **`MediaMetadataRetriever` 的实际取帧效果**（尤其竖屏视频的旋转方向对不对）
- 制作速度与内存表现（大视频、高帧率时）
- root 授权流程（su 弹窗、不同 ROM 的实际 su 路径）
- 写入系统分区后的权限与 SELinux 上下文是否真被系统接受
- **圆屏安全区的视觉效果**（16% 缩进是算出来的，好不好看只能肉眼看）

---

## 安装

```bash
adb install -r dist/android/BootAnimForge-Android-1.3.0-debug.apk
```

或者把 APK 传到手机上点击安装（需要允许「安装未知来源应用」）。

debug 包用的是自动生成的调试密钥，正式分发请换成你自己的 keystore。

---

## 使用

**制作**：主界面「制作开机动画」→ 选视频 → 选目标分辨率（手机/手表预设或自定义）→ 选帧率 → 按需改帧命名 → 开始制作。生成后会自检并提示，可直接「去安装」。

**刷入**：主界面点「选择 bootanimation.zip」→ 看校验结果 → 安装（自动备份）→ 重启。

**出问题**：回到主界面点「还原上一个备份」→ 重启。
