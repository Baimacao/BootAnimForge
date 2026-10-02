# BootAnimForge v1.0.0

把 MP4 等视频转成安卓开机动画（`bootanimation.zip`）的 Windows 工具。Material Design 3 界面，本地 ffmpeg 引擎，零 npm 依赖、无构建步骤。

## 下载哪个

| 文件 | 说明 |
|---|---|
| `BootAnimForge-1.0.0-portable.zip`（50.5 MB） | **推荐**。已内置 ffmpeg 引擎，解压即用，不需要联网下载 |
| 源码（Source code） | 不含引擎，首次运行 `启动.cmd` 会自动从 npm 镜像下载（约 115 MB，实测几秒） |

运行要求：Windows 10/11 + [Node.js 18+](https://nodejs.org/) + Edge 或 Chrome。

## 这个版本能做什么

**两种输出格式**
- **传统帧序列**：`desc.txt` + `partN/` PNG 帧，Android 4–14 通吃
- **视频版（Android 12+）**：`bootanimation.mp4`，体积通常只有帧序列的 1/10。自动保证 **moov 前置 + yuv420p + Main profile + 无 B 帧**，并在编码后校验 profile，不达标自动重编

**一键生成 Magisk 模块**
额外产出一个可直接刷入的模块 zip（`module.prop` + `customize.sh` + 系统载荷 + 中文说明）。挂载替换，卸载即恢复原开机动画，不动系统分区、不影响 OTA。

**永不拉伸**
等比缩放 + 居中留边（可配背景色），或等比放大 + 居中裁切。拉伸只是给高级用户的显式选项，且带警告。

**分段与循环**
时间轴上随时切分，每段独立设置 `p/c/f` 类型、循环次数（0 = 无限）、暂停帧数、淡出帧数、背景色。可以按 `desc.txt` 的真实播放逻辑**试播**一遍。

**易用性**
内置教程（`F1`）、每个参数旁的解释气泡、导出前预检、实时预览与产出摘要、27 个机型分辨率预设。

## 验证情况

- 后端端到端自检 **75 项断言全通过**（`node tools/selftest.js`）
  - 用 ffmpeg 合成测试素材，解出 zip 里的真实帧做**像素级**检查，证明四角是背景色、中心是视频内容 —— 即确实没有拉伸
  - 旋转元数据两种来源、alpha 通道、JPEG 模式、视频版编码参数、Magisk 模块结构、任务取消、参数拦截
- 界面端到端 **28 项断言全通过**（`node tools/uicheck.js --flow`）
  - 无头 Edge + DevTools 协议驱动真实界面，跑完传统格式与「视频版 + Magisk」两条完整流程，控制台零错误

## 已知限制

- 浏览器安全限制导致拖入文件时拿不到磁盘路径，程序会引导你按路径选择（读原文件，不复制不上传）
- 视频版格式只被 Android 12+ 的部分机型识别；黑屏就换回传统格式
- 随包的 ffmpeg 是 2018 年构建（N-92722），功能足够；换成新版 ffmpeg 也能直接用

## 许可

代码 MIT。ffmpeg/ffprobe 来自 `@ffmpeg-installer` / `@ffprobe-installer` 的官方构建，许可（LGPL/GPL）独立于本项目，详见包内 `runtime/FFMPEG-LICENSE.txt`。
