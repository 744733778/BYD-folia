# 变更记录（移植版）

本文件记录 foliaAPP 安卓移植版的版本变更，版本号与 `android-folia-shell/app/build.gradle`
的 `versionName` / `versionCode` 一一对应。前端改动同步反映在 `folia-major-0.7.20/` 子树中。

## 0.1.20（versionCode 20）

- **移除「思索」（Ponder）帮助系统**：整个 PC 向帮助/提示链路约 16.8k 行随组件目录、
  hooks、store、类型定义、`mods/folium` 文本模块一并删除；三语言 i18n 各清理约 1200 行词条；
  集成点（App 宿主、命令面板、设置页、启动门控、motion signals 等）全部摘除，
  界面右上角不再出现思索按钮
- E2E 批量测试标记改中立命名：`data-page-scope`（页面域）、`data-panel-tab-button`（面板页签）、
  `data-metadata-match`（元数据匹配），不再与已拆除的 Ponder 功能耦合
- 清理随移除产生的死代码（UserGuideModal、SettingsHelpActions、PonderHintSettingsSection 等）
- 全量 `tsc --noEmit` 与单元测试通过（剩余失败项均为上游既有：在线歌词 Provider 网络用例等）

## 0.1.19（versionCode 19）

- **音量回滚到「不接管」策略**：`PlaybackService` 的 MediaSession 永远
  `setPlaybackToLocal(STREAM_MUSIC)`，删除 `VolumeProviderCompat` 与 `EXTRA_VOLUME` 同步逻辑；
  音量键不再拦截消费（仅保留诊断日志）
- 背景：0.1.18 挂接 remote provider 后，比亚迪 DiLink 把滚轮事件路由给媒体会话却从不回调，
  系统侧音量又被会话接管，导致音量彻底失灵。实测同机 APlayer「什么都不接管」调节音量与切歌均正常，
  据此对齐。等响曲线与 fixed 模式软件增益（滑杆）保留
- 清理 `VolumeMode` 调试开关之外的实验代码

## 0.1.18（versionCode 18）

- **新增等响音量曲线** `src/utils/audioVolumeCurve.ts`：`levelToOutputGain` 按
  `10^((v-1)×40/20)` 映射（0% 静音 / 50% ≈ -20dB / 100% 满功率），解决 20% 滑杆比别家 50%
  还响的线性振幅问题；UI 百分比语义不变
- **`VolumeMode.kt`**：fixed / adjustable 三级判定（`isVolumeFixed` → 车机 OEM 白名单 →
  写入—回读探测），附 `debug.folia.fixedvolume` 强制开关；DiLink 上写入—回读探测会假通过，
  故 OEM 身份优先
- 前端音量同步逻辑改为不过曲线的相对衰减（duck），系统音量回显改走
  `useNativeVolumeMirrorStore`
- （其中的 MediaSession remote volume provider 与 `EXTRA_VOLUME` 同步已在 0.1.19 回滚）

## 0.1.17（versionCode 17）

- **舞台（全屏歌词）界面媒体键失灵修复**：
  - `useMediaSessionBridge` 移除 `onNativeMediaKey` 的 `isNowPlayingControlDisabled` 早退，
  舞台界面不再吞掉媒体键
  - `usePlaybackQueueController` 的 next/prev 支持 `ignoreStageGuard` 跳过 stage 影子曲目守卫；
    key 匹配失败时按「标题 + 主歌手」做次级匹配
  - 无目标曲目时输出单行 `[Queue]` 诊断日志，便于车机拍照排查
- 修复舞台界面"上一曲"无效（影子曲目 key 为 `stage:xxx` 导致队列匹配失败）

## 0.1.16 及以前（初始移植系列）

- GeckoView 自带内核架构：彻底替换早期 Capacitor/系统 WebView 方案
- WebExtension 消息桥（manifest / background / content shim 三件套）与原生 PortDelegate
- 本地 HTTP 服务：静态资源 + `/cover` 封面 + `/local` Range 流式播放（替换 base64 整曲过桥）
- 曲库：系统媒体扫描（MediaStore 多外部卷查询）+ 快照 diff 增量导入 + 目录封面映射
- 逐字歌词：同目录 `.krc` / `.lrc` sidecar 与内嵌歌词；在线歌词三源（网易云 / 酷狗 / QQ）
- 物理媒体键：KeyEvent 与 MediaSession 双路径统一去重
- AudioFocus 四态 + 前台服务媒体通知
- 车机向阉割：无引导弹窗、无电台页签、grid 经典视图、静态背景
