# BootAnimForge v1.2.0

**安卓端 App 来了**：以前只负责"生成"，现在还能"装进设备"。

## 这个版本新增

### 安卓端 App（`android/`，APK 60.8 KB）

一个**刷入器**：选现成的 `bootanimation.zip` → 校验 → root 安装 → 备份 / 一键还原。

为什么安卓端做这个而不是再做一遍视频转换：安卓端跑的就是要装动画的那台设备，它最缺的是
**"文件该放哪、权限怎么设、装错了怎么退"** —— 这三点做掉，比在手机上重新实现视频转帧有价值得多。

| 功能 | 说明 |
|---|---|
| 扫描现状 | 一次列清所有候选路径：哪个存在、多大、什么权限、SELinux 上下文、是不是 zip |
| 安装前校验 | 传统帧序列 / 视频版识别、`desc.txt` 合法性、帧编号连续性、视频版 moov 是否前置 |
| 一键安装 | 自动备份 → `/data/local/tmp` → root 写入 → `chown 0:0` + `chmod 0644` + `chcon` → 复核 |
| 自动备份 | 每次安装前强制备份，另永久保留一份"首次备份"，任何时候都能退回原状 |
| 一键还原 | 从备份列表选一个还原 |
| Magisk 检测 | 已有模块提供 bootanimation 时提示先卸载，避免互相覆盖 |

### 圆屏适配（设置里可切换）

- 判断顺序：**用户手动设置** → `Configuration.isScreenRound()`（API 23+）→ `UiModeManager` 手表 + 近正方形（旧版本回退）
- 三个选项：**自动识别**（显示系统判断结果）/ **强制圆形** / **强制方形**，切换立即重排
- 安全区：内切圆里最大正方形是 `直径/√2 ≈ 0.707·直径`，左右各留 16%，保证四角不被裁掉

### 向下兼容到 Android 4.4

| 项 | 值 |
|---|---|
| minSdkVersion | **19（Android 4.4）** |
| targetSdkVersion | 30 |
| 签名 | v1 + v2 + v3（v1 让 Android 4.4–6.0 也能装） |
| 语言特性 | Java 8，不用 lambda/stream |

兼容处理：圆屏判断双路径、`RippleDrawable` 有版本判断、用 `od` 而非 `xxd` 读文件头（精简 ROM 常无 xxd）、
su 路径 7 个候选、存储权限限定 `maxSdkVersion`、不申请 `MANAGE_EXTERNAL_STORAGE`。

### 构建不需要 Gradle

本机 Maven 仓库不可达，拿不到 AGP，所以直接用 SDK 工具链：
`aapt2 compile` → `javac` → `d8` → `aapt2 link` → 注入 `classes.dex` → `zipalign` → `apksigner`。

## 下载哪个

| 文件 | 说明 |
|---|---|
| `BootAnimForge-1.2.0-portable.zip`（83.3 MB） | **推荐**。含 PC 端（Node + ffmpeg，解压即用）**和安卓端 APK** |
| `BootAnimForge-Android-1.2.0-debug.apk`（60.8 KB） | 只要安卓端 |

## 验证情况

| 套件 | 结果 |
|---|---|
| PC 后端端到端 `tools/selftest.js` | **94 / 94** |
| PC 界面全流程 `tools/uicheck.js --flow` | **47 / 47**，控制台零错误 |
| PC 动效 `tools/uicheck.js --anim` | **14 / 14** |
| 安卓 APK 静态 `tools/verify-android.js` | **43 / 43** |
| 安卓包解析逻辑 `tools/coretest-android.js` | **31 / 31** |

安卓端最值得说的一点：包解析逻辑抽成了 `BootCore.java`（**纯 JDK、无 Android 依赖**），
所以能在 PC 上**真跑**，而不是靠看代码猜：

- 手表风格样本（纯数字 `001.png`，两段）→ 正确识别 480×480/60fps、编号 1–12
- 通用风格 `frame_00000.png` → 编号 0–19 连续
- 编号不连续 → 告警但不阻断；缺帧目录 / 多套一层 / 非 zip / desc.txt 首行非法 → 分别报错并说明原因
- 视频版 moov 前置 → 通过；moov 后置 → 告警
- **PC 端真实产物**跨端一致（`test-watch.zip` / `test-video.zip` / `ui-watch.zip`）
- **你上次给的手表样本** `bootanimation.zip` → 480×480/60fps，判定合法

### ⚠ 未能验证的部分

本机没有 adb、也没有连接真机，以下我不会假装验过，需要你装到设备上确认：

- 真机安装与启动
- root 授权流程（su 弹窗、不同 ROM 的实际 su 路径）
- 写入系统分区后的权限与 SELinux 上下文是否真被系统接受
- **圆屏安全区的视觉效果**（16% 缩进是算出来的，好不好看要肉眼看）
- 手机与手表各自的布局观感

## 已知限制

- 安卓端目前**只做刷入**，不生成动画（生成请在 PC 端做）
- 需要 root（Magisk / SuperSU 均可）；没 root 只能看状态、不能装
- APK 用自动生成的调试密钥签名，正式分发请换成自己的 keystore
- 视频版格式只被 Android 12+ 的部分机型识别；黑屏就换回传统帧序列版
