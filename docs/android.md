# 安卓版：把开机动画装进设备

PC 端（`启动.cmd`）负责**生成** `bootanimation.zip`；安卓端负责**刷入**。

## 为什么安卓端做的是「刷入器」而不是「转换器」

安卓端跑的就是要装动画的那台设备。所以它最缺的不是算力，而是这三件事：

1. **文件该放哪** —— 不同厂商路径完全不同（`/system/media`、`/product/media`、`/oem/media`…），找错就黑屏
2. **权限怎么设** —— 权限不对（不是 `0644`）或 SELinux 上下文不对，同样黑屏
3. **装错了怎么退** —— 手边没有原文件，就只能去 ROM 包里重新提取

这个 App 把这三件事做掉了。视频转帧仍然在 PC 上做（那里有 ffmpeg 和更好的界面）。

## 功能

| 功能 | 说明 |
|---|---|
| **扫描现状** | 一次列清所有候选路径：哪个真的存在、多大、什么权限、什么 SELinux 上下文、是不是 zip |
| **安装前校验** | 解包检查：是传统帧序列还是视频版、`desc.txt` 是否合法、帧编号是否连续、视频版 moov 是否前置 |
| **一键安装** | 自动备份 → 复制到 `/data/local/tmp` → root 写入目标路径 → `chown 0:0` + `chmod 0644` + `chcon` 上下文 → 复核 |
| **自动备份** | 每次安装前强制备份；额外永久保留一份「首次备份」，任何事后都能退回原状 |
| **一键还原** | 从备份列表里选一个还原回去 |
| **Magisk 检测** | 如果已有模块提供了 bootanimation，会提示先卸载对应模块，避免互相覆盖 |
| **圆屏适配** | 自动识别圆屏并把内容收进内切圆安全区；判断错了可在设置里强制圆形/方形 |

## 圆屏适配

手表上靠近四角的内容会被物理裁掉，所以圆屏必须把内容收进**内切圆**。

- 判断顺序：**用户手动设置** → `Configuration.isScreenRound()`（API 23+）→ `UiModeManager` 是手表且屏幕接近正方形（旧版本回退）
- 安全区算法：内切圆里最大的正方形边长是 `直径/√2 ≈ 0.707·直径`，所以左右各留 ≈14.6%；实现里留到 **16%** 更舒服，并保证至少 16dp、不超过短边的 1/3
- 设置里三个选项：**自动识别**（会显示系统判断结果）、**强制圆形**、**强制方形** —— 切换后立即重排，不用重启

## 向下兼容

| 项 | 值 |
|---|---|
| minSdkVersion | **19（Android 4.4）** |
| targetSdkVersion | 30（本机 SDK 上限；高版本 Android 靠运行时判断适配） |
| 签名 | v1 + v2 + v3（v1 是为了让 Android 4.4–6.0 也能装） |
| 语言特性 | Java 8（`-source/-target 8`），不用 lambda/stream |

兼容性上的具体处理：

- **圆屏判断**：API 23+ 用 `isScreenRound()`，更早的版本回退到 `UiModeManager`
- **水波纹**：`RippleDrawable` 只在 API 21+ 使用，低版本回退到纯色圆角
- **文件头读取**：用 `od` 而不是 `xxd`（很多精简 ROM 没有 xxd）
- **su 路径**：`su` / `/system/bin/su` / `/system/xbin/su` / `/sbin/su` / `/su/bin/su` / `/magisk/.core/bin/su` / `/debug_ramdisk/su` 逐个尝试
- **存储权限**：`READ_EXTERNAL_STORAGE` 限 `maxSdkVersion=32`、`WRITE` 限 `29`；读用户选的 zip 走 `ContentResolver`，不需要存储权限
- **不申请** `MANAGE_EXTERNAL_STORAGE`（那是危险权限，没必要）

## 构建

不需要 Gradle / AGP —— 本机 Maven 仓库不可达，所以直接用 SDK 自带工具链：

```bash
node tools/build-android.js          # 产出 dist/android/BootAnimForge-Android-<版本>-debug.apk
node tools/verify-android.js         # 静态验证：清单/权限/类/字符串/签名/对齐
node tools/coretest-android.js       # 在 PC 上直接跑安卓端的包解析逻辑
```

流水线：`aapt2 compile` → `javac` → `d8` → `aapt2 link` → 自己写 zip 注入 `classes.dex` → `zipalign` → `apksigner`

踩过的坑（都写进代码注释了）：

- Windows 上 `.bat`/`.cmd` 不能被 `CreateProcess` 直接执行，必须走 shell
- d8 的 `@argfile` **不会去掉引号**，带引号的路径会被当成含 `"` 的非法路径
- d8 不接受「目录」作为 program input（`Unsupported source file type`），要打成 jar
- 类文件几百个直接当参数传会触发 Windows 的 `spawn EINVAL`
- `javac` 的 `-J` 选项不能写在 `@argfile` 里
- `android:windowIsRound` **不是**主题属性，写进 styles.xml 会让 aapt2 链接失败

## 验证情况

| 套件 | 结果 |
|---|---|
| `tools/verify-android.js`（APK 静态） | **43 / 43** |
| `tools/coretest-android.js`（包解析逻辑，PC 上真跑） | **31 / 31** |

包解析逻辑是用 `BootCore.java` 单独抽出来的（纯 JDK，无 Android 依赖），所以**能在 PC 上真跑**，而不是只靠看代码：

- 手表风格样本（纯数字 `001.png`，两段 `p 1 0 part0` / `p 0 0 part1`）→ 正确识别 480×480/60fps、两段、编号 1–12
- 通用风格（`frame_00000.png`）→ 编号 0–19 连续
- 编号不连续 → 告警但不阻断
- 缺帧目录 / 多套一层目录 / 非 zip / desc.txt 首行非法 → 分别报错并给出原因
- 视频版 moov 前置 / 后置 → 分别通过 / 告警
- **PC 端真实产物**（`test-watch.zip`、`test-video.zip`、`ui-watch.zip`）跨端一致
- **用户提供的手表样本** `bootanimation.zip` → 正确识别 480×480/60fps 且判定合法

### 未能验证（本机没有 adb、也没有真机）

这部分我不会假装验过，需要你装到设备上确认：

- 真机安装与启动
- root 授权流程（su 弹窗、不同 ROM 的实际 su 路径）
- 写入系统分区后的权限与 SELinux 上下文是否真的被系统接受
- **圆屏安全区的视觉效果**（16% 缩进是算出来的，好不好看只能肉眼看）
- 手机与手表各自的布局观感

## 安装

```bash
adb install -r dist/android/BootAnimForge-Android-1.2.0-debug.apk
```

或者把 APK 传到手机上点击安装（需要允许「安装未知来源应用」）。

debug 包用的是自动生成的调试密钥，正式分发请换成你自己的 keystore。

## 使用

1. 打开 App，等它检测 root 与扫描路径
2. 点「选择 bootanimation.zip」，挑一个包
3. 看校验结果：合法才会出现安装按钮；点它会先确认路径与包信息
4. 安装（自动备份）→ 重启
5. 万一开机看不到动画：回到 App 点「还原上一个备份」→ 重启
