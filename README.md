# foliaAPP

Folia 音乐播放器的**安卓移植版**，自带浏览器内核（**GeckoView** / Firefox 引擎），不依赖车机/低版本系统 WebView——炫酷可视化、现代 CSS/WebGL 特效在 Android 11+ 车机上完整可用。

> 本仓库已彻底重写：早期基于 Capacitor/系统 WebView 的方案（在线歌词需依赖系统 WebView + 扩展桥）已废弃，统一为「GeckoView 内嵌内核 + WebExtension 消息桥」架构。

## 特性

- **自带 GeckoView 内核**：特效不受车机 WebView 版本限制
- **本地曲库**：SAF 目录选择（磁盘权限 + 手动指定文件夹），扫描同名同目录的 `.krc` 歌词，**KRC 逐字歌词**逐字显示
- **炫酷歌词可视化**：默认 classic，低负载帧率优化（60fps）
- **在线歌词**：网易云 / 酷狗 / QQ 三源搜索与歌词拉取；网易云扫码登录（会话 cookie 持久化，跨重启保留）
- **阉割的杂项**：无引导弹窗、无电台页签（改为「设置」按钮）、资料库默认 grid 经典视图、静态背景

## 工程结构

```
android-folia-shell/      # 安卓壳（Kotlin + GeckoView + WebExtension 桥 + 本地 HTTP server）
  app/src/main/java/com/foliaapp/android/MainActivity.kt   # GeckoView 集成 + 原生桥（目录/在线歌词路由/自建 CookieStore）
  app/src/main/assets/folia-bridge/                        # WebExtension 三件套（manifest + background + content shim）
  app/src/main/assets/folia/                               # 前端构建产物 dist（构建时拷入，仓库不保存）
  app/build.gradle                                        # GeckoView arm64 依赖
folia-major-0.7.20/       # 前端源码（Vite + React + TS）
  src/                    # 前端桥模块：services/foliaExtensionBridge.ts、netease.ts、kugou/qq 接入
```

## JS↔原生通信（WebExtension 消息桥）

GeckoView 不支持 `addJavascriptInterface`，采用五段链路：

```
页面 world shim (window.nativeLibrary / window.foliaBridge)
  → window.postMessage → content script（隔离世界，document_start 注入 shim）
  → browser.runtime.sendMessage → background.js
  → browser.runtime.connectNative → 原生 PortDelegate
  → 处理（SAF 目录 / 在线 HTTP 转发 / 自建 CookieStore）
  → port.postMessage 原路返回 → 页面回调 __nativeLibraryOnResult / __foliaBridgeOnResult
```

- 在线歌词原生代理：`HttpURLConnection` 按 method/headers/body 转发真实网易云/酷狗/QQ API，响应 Set-Cookie 写入自建持久化 CookieStore（SharedPreferences 落盘）
- 已验证端点：网易云 legacy 明文（搜索/歌词/扫码登录）、酷狗 `lyrics.kugou.com/search` + `download`、QQ smartbox

## 构建（Windows）

前置：JDK、Android SDK（compileSdk 36）。

1. **前端**（生成 dist）：
   ```powershell
   Set-Location folia-major-0.7.20
   $env:ELECTRON="true"
   $env:VITE_NETEASE_API_BASE="extension"; $env:VITE_KUGOU_API_BASE="extension"; $env:VITE_QQ_API_BASE="extension"
   node "C:\Program Files\nodejs\node.exe" node_modules\vite\bin\vite.js build
   ```
   typecheck：`node node_modules\typescript\bin\tsc --noEmit`

2. **拷 dist 入壳**：清空重拷 `android-folia-shell\app\src\main\assets\folia`

3. **安卓打包**：
   ```powershell
   Set-Location android-folia-shell
   $env:JAVA_HOME="C:\Android\jdk-21.0.12.1+1"; $env:ANDROID_HOME="C:\Android\Sdk"
   .\gradlew.bat assembleDebug --no-daemon -x checkDebugAarMetadata
   ```
   > ⚠️ 必须带 `-x checkDebugAarMetadata`：GeckoView 158 的 AAR 声明 minCompileSdk=37，本机 SDK 最高 android-36；跳过该校验不影响真实编译（详见 `gradle.properties` 注释）。

4. APK 输出：`app\build\outputs\apk\debug\app-debug.apk`（arm64-v8a 单 ABI）

## 已知注意

- **更新 WebExtension 需升扩展版本号**：GeckoView 内置扩展随应用数据持久化，仅改文件不会重装。
- APK 体积约 200MB（GeckoView 原生库未压缩打包，属内核固有）。
