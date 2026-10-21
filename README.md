# foliaAPP

Folia 音乐播放器的**安卓移植版**，自带浏览器内核（**GeckoView** / Firefox 引擎），不依赖车机/低版本系统 WebView——炫酷可视化、现代 CSS/WebGL 特效在低版本 Android 车机上也能跑。

当前版本：**0.1.20（versionCode 20）** · 变更记录见 [CHANGELOG.md](CHANGELOG.md)

> 早期基于 Capacitor/系统 WebView 的方案已废弃（车机 WebView 版本太低），统一为「GeckoView 内嵌内核 + WebExtension 消息桥 + 本地 HTTP 服务」架构。

## 特性

- **自带 GeckoView 内核**：特效不受车机 WebView 版本限制
- **曲库走系统媒体扫描**：音乐放进 `Music/`（或 `我的音乐` / `车载音乐`），系统扫完 APP 直接查 MediaStore——不需要目录授权、不需要每次重选文件夹，重启即恢复
- **增量导入**：重启后按快照 diff，未变的歌直接复用库里的记录，只处理新增/改动的文件
- **本地音频流式播放**：`http://127.0.0.1:<port>/local?uri=…` 支持 Range，`<audio>` 边下边播、拖动进度条；不再把整首歌 base64 过桥
- **音量双模式 + 等响曲线**：普通机型滑杆直调系统 `STREAM_MUSIC`；车机（固定音量/OEM 判定）走等响曲线软件增益，系统滚轮与音量键始终有效——详见[车机音量](#车机音量实测铁律)
- **物理媒体键**：上一曲/下一曲/播放暂停，KeyEvent 与 MediaSession 两条路径统一去重，全屏歌词舞台界面同样响应
- **逐字歌词**：同目录 `.krc` / `.lrc` sidecar 与内嵌歌词，KRC 逐字显示；增强解析兼容词前/词后两种时间标签约定；在线歌词三源（网易云 / 酷狗 / QQ）
- **双 flavor 可共存**：`full`（3D 音乐墙，原包名 `com.foliaapp.android`）与 `flat`（2D 平面网格，独立包名 `com.foliaapp.android.flat`，启动带 `flat=1`）
- **阉割的杂项**：无引导弹窗、无电台页签（改为「设置」按钮）、资料库默认 grid 经典视图、静态背景、无 PC 向「思索」帮助系统

## 工程结构

```
android-folia-shell/                      # 安卓壳
  app/src/main/java/com/foliaapp/android/
    MainActivity.kt                       # GeckoView 集成 + 消息桥路由 + 音量/媒体库观察者 + 媒体键分发
    MediaLibrary.kt                       # MediaStore 曲库快照（音频 / 目录封面 / 同名歌词）
    LocalHttpServer.kt                    # 静态资源 + /cover + /local(Range)
    PlaybackService.kt                    # 前台服务（媒体通知 + MediaSession，常驻激活）
    AudioFocusManager.kt                  # AudioFocus 四态
    MediaKeys.kt / MediaKeyReceiver.kt    # 物理媒体键（KeyEvent 路径）
    VolumeMode.kt                         # 音量模式判定（fixed / adjustable）
    NativeEventHub.kt                     # 原生事件分发中枢
  app/src/main/assets/folia-bridge/       # WebExtension 三件套（manifest / background / content shim）
  app/src/main/assets/geckoview-config.yaml
  app/src/main/assets/folia/              # 前端构建产物（构建时拷入，仓库不保存）
folia-major-0.7.20/                       # 前端源码（Vite + React + TS）
  src/utils/audioVolumeCurve.ts           # 等响曲线（level ↔ 输出增益）
  src/hooks/useNativeMediaShellBridge.ts  # 原生壳桥（媒体键/音量/焦点事件）
  src/stores/useNativeVolumeMirrorStore.ts# 系统音量回显
```

## 通信链路

```
页面 shim (window.nativeLibrary / window.foliaBridge)
  → window.postMessage → content script（隔离世界，document_start 注入）
  → browser.runtime.sendMessage → background.js
  → browser.runtime.connectNative('browser') → 原生 PortDelegate
  → 原生处理 → port.postMessage 原路返回 → __nativeLibraryOnResult / __foliaBridgeOnResult
```

原生 → 页面是另一条推送通道（无 id，带 `push: true`）：

| method | payload | 用途 |
| --- | --- | --- |
| `mediaKey` | next / prev / play / pause / playpause | 方向盘、车机面板、蓝牙线控 |
| `volume` | 0..1 浮点 | 系统媒体音量变化（音量条回显） |
| `focus` | duck / unduck | 导航语音压低音量 |
| `seek` | 毫秒 | 车机进度条拖动 |
| `libraryChanged` | 时间戳 | 系统扫描完成，触发增量重扫 |

> 只有 `content script` 注入的那一套 shim 分发事件。前端曾有第二个页面桥模块（geckoNativeBridge）
> 也监听同一条 `__foliaBridge:'event'` 消息，导致一次按键分发两次（跳两首），已删除。

## 曲库

索引归系统媒体扫描器维护，APP 只查询：

- `MediaStore.Audio.Media.getContentUri(VOLUME_EXTERNAL)` 一次拿全所有外部卷（含 U 盘），
  每行再用自己的 `VOLUME_NAME` 拼 content uri，跨卷不会指错文件
- 默认只收 `Music / 音乐 / 我的音乐 / 车载音乐 / Audio / Audiobooks / Podcasts / Recordings` 顶层目录；
  一首都没命中时自动退化为"不限目录"，避免明明有歌却看不到
- 同目录 `cover/folder/front/album` 图片一次查询映射到每首曲目 → UI 走 `/cover?uri=`
- 同名 `.lrc` / `.krc` 仅在能按路径读到文件时才挂上（Android 11+ 需要"所有文件访问"才读得到非媒体文件）
- 快照 4s 内存缓存 + 生产一次全量 JSON；查询为空但缓存有货时返回缓存，绝不把整库当 0 首删掉

## 车机音量（实测铁律）

这套逻辑是拿比亚迪 DiLink 车机实测换回来的，改动前务必读完：

1. **MediaSession 永远 `setPlaybackToLocal(STREAM_MUSIC)`**，不挂 `VolumeProviderCompat`，
   `PlaybackState` 不声明任何音量动作——"什么都不接管"。
   0.1.18 曾挂 provider 并同步 `EXTRA_VOLUME`，结果 DiLink 把滚轮事件路由给会话却从不回调，
   系统侧又被会话接管，两头落空、音量彻底失灵；0.1.19 已回滚。同机实测 APlayer 正是如此才一切正常。
2. **音量键不拦截、不消费**（`dispatchKeyEvent` 仅做诊断），媒体键才走 KeyEvent + MediaSession 双路径。
3. **模式判定**（`VolumeMode.kt`，顺序即优先级）：
   `AudioManager.isVolumeFixed` → 车机 OEM 白名单（byd / dilink / denza / 腾势 / 小迪…）→ 写入—回读探测兜底。
   注意 DiLink 上"写入—回读"探测会**假通过**（值被 AudioService 缓存），所以 OEM 身份优先于探测。
4. **adjustable（普通手机）**：滑杆直接映射系统 `STREAM_MUSIC` 档位。
5. **fixed（车机）**：滑杆走等响曲线软件增益（`audioVolumeCurve.ts`，40dB 动态：
   0% 静音 / 50% ≈ -20dB / 100% 满功率，UI 百分比语义不变）；系统滚轮/音量键照旧实时调整系统媒体音量，
   两条路各管一层，互不抢占。
6. **调试**：`adb shell setprop debug.folia.fixedvolume 1` 可强制 fixed 分支（进程重启生效），
   用于在模拟器/可调机型上验证车机代码路径。

## 构建（Windows）

1. **前端类型检查 + 构建**（生成 dist）：

   ```powershell
   Set-Location folia-major-0.7.20
   npm run typecheck                      # tsc --noEmit，先过类型关
   $env:ELECTRON="true"
   $env:VITE_ANDROID_SHELL="1"
   $env:VITE_NETEASE_API_BASE="extension"; $env:VITE_KUGOU_API_BASE="extension"; $env:VITE_QQ_API_BASE="extension"
   node node_modules\vite\bin\vite.js build --outDir dist-androidN
   ```

   > 用独立 outDir 是为了避开 vite 清空 1800+ 文件目录时的安全删除保护。

2. **拷 dist 入壳**：`android-folia-shell\app\src\main\assets\folia`
   （vite 产物带内容 hash，直接覆盖拷贝会留下旧 hash 僵尸文件，需一并清理）

3. **安卓打包**（full / flat 二选一或都要）：

   ```powershell
   Set-Location android-folia-shell
   $env:JAVA_HOME="C:\Android\jdk-21.0.12.1+1"; $env:ANDROID_HOME="C:\Android\Sdk"
   .\gradlew.bat assembleFullDebug --no-daemon -x checkFullDebugAarMetadata -x checkFlatDebugAarMetadata
   .\gradlew.bat assembleFlatDebug --no-daemon -x checkFullDebugAarMetadata -x checkFlatDebugAarMetadata
   ```

   > 必须带 `-x check*AarMetadata`：GeckoView 158 的 AAR 声明 minCompileSdk=37，本机 SDK 最高 android-36；跳过不影响真实编译。
   > 另需 `androidx.core` 锁 1.18.0（见 app/build.gradle 尾部 resolutionStrategy）。

4. APK 输出：`app\build\outputs\apk\<flavor>\debug\`（arm64-v8a 单 ABI，含 GeckoView 内核，体积较大）

## 车机上排查

```bash
adb logcat -s foliaAPP MediaLibrary LocalHttpServer PlaybackService VolumeMode
```

- 曲库为空：先确认系统扫描器已收录（`adb shell content query --uri content://media/external/audio/media --projection _id:_display_name:relative_path`）
- 播放无声：确认 `/local` 返回 200/206 且 `Content-Type` 是 `audio/*`
- 按键无效：`foliaAPP` 日志里应有 `native port connected`；`dispatchKeyEvent` 已消费媒体键，不会再传给 Gecko
- 音量异常：`VolumeMode` 日志有 `resolved=fixed/adjustable … device=…` 一行判定摘要；车机上无 logcat 时可用会话里的 `describe()` 诊断串拍照

## 已知注意

- **更新 WebExtension 需升扩展版本号**（`assets/folia-bridge/manifest.json` 的 `version`）：GeckoView 内置扩展随应用数据持久化，仅改文件不会重装
- GeckoView 的 profile 与 Web 存储按 origin 隔离，本地服务器因此固定端口（47777-47781），**不要改成随机端口**，否则 IndexedDB 曲库等于清空
- MediaSession 由 `PlaybackService` 持有并常驻激活：服务活着媒体键就路由得到；杀进程后失效
- flat 版通过启动 URL 参数 `flat=1` 走 2D 音乐墙，与 full 版可同时安装
- 本仓库不保存任何构建产物：`node_modules/`、`dist-android*/`、`build/`、`*.apk`、`local.properties` 均已被 `.gitignore` 排除

## 许可与致谢

- 前端源码 `folia-major-0.7.20/` 为 [folia-major](https://github.com/chthollyphile/folia-major) 的衍生代码，遵循 **AGPL-3.0**（完整许可证见该目录下 `LICENSE`）；分发与二次开发请遵守 AGPL 条款。
- 安卓壳与移植层代码（`android-folia-shell/`）为本项目作者所有。
- 本移植版基于开源项目构建，向以下作者与项目致以感谢：
  - **folia 原作者 [chthollyphile](https://github.com/chthollyphile)**：Folia 音乐播放器的核心开发与维护，炫酷的逐字歌词、可视化与播放体验均源于该项目。
  - **[Timingyyds](https://github.com/Timingyyds)** 的 [folia-android](https://github.com/Timingyyds/folia-android)：安卓端目录选择等思路，本项目从中吸取了不少参考。
  - **SaltPlayer / Moriafly 的 media-kit（`MiPlayAudioSupport`）**：车机 OEM 音量能力靠身份白名单判定而非通用 API 的思路来源。
