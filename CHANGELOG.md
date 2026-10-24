# 变更记录（移植版）

本文件记录 foliaAPP 安卓移植版的版本变更，版本号与 `android-folia-shell/app/build.gradle`
的 `versionName` / `versionCode` 一一对应。前端改动同步反映在 `folia-major-0.7.20/` 子树中。

## 0.1.29（versionCode 29）

- **车机音量：整体照抄 APlayer（remix.myplayer）的模型，不再自己发明**。APlayer 在同一台车机上
  音量正常，而它对音量**什么都没做**：用户音量就是系统媒体音量（STREAM_MUSIC），滑杆直接读写它，
  播放器自己的音量（`ExoPlayer.volume`）只用于淡入淡出与 duck；不判品牌、不判 automotive、
  不挂 VolumeProvider、不拦音量键。folia 现在是同一套模型。
- **原生判定回到 APlayer 口径**（`VolumeMode.kt`）：只问 `AudioManager.isVolumeFixed`。
  删掉自制的「比亚迪/DiLink/UiMode=CAR/automotive 一律 fixed」白名单——它把车机一律判成 fixed，
  网页层改用软件增益写 WebAudio 增益节点，而车机音量联动只认标准媒体通路，音频被 WebAudio
  捕获后功放根本不跟随，于是滚轮怎么拧都没反应（0.1.21~0.1.27 车机实测：事件到、判定对、
  档位跟手，响度不变）。
- **网页侧判据同步收敛**（`nativeVolumeMode.ts`）：`systemVolumeGoverns()` 去掉「系统音量读数必须
  低于满档」这条自制实证条件——能写就写、网页让位（读数为满档就改判，正是老症状的另一半）。
- **新增「车机直通模式」（原生壳默认开）**：不建 WebAudio 图，deck 元素不抓进图，声音走 Gecko 的
  标准媒体通路（USAGE_MEDIA → AudioService → 功放），与 APlayer 的 ExoPlayer 同路 → 车机滚轮
  直接作用到功放。代价（开发者选项里已写明）：可视化退化为呼吸动画、均衡器/音效失效、
  淡入淡出退化为硬切、自动混音不可用；关掉则保留完整 WebAudio 音效链。
- **所有音量控件统一写入口**（新增 `services/userVolume.ts`）：系统音量模式下写 STREAM_MUSIC，
  软件增益模式下写应用内档位。设置面板、控制栏、播放页、音乐墙工具、命令面板、方向盘音量键
  全部走这一个出口——此前它们各写各的，一旦切到系统音量模式就会出现"某个滑杆拖了没反应"。
  系统音量模式下应用内档位改为系统音量的镜像（原生 volume 事件回填），界面数字与车机实际档位一致。
- 单测：nativeVolumeMode 11/11 通过（判据变更同步更新用例与 storeContract 快照）；tsc 零错误。
- build.gradle: versionCode 29 / versionName 0.1.29。

## 0.1.28（versionCode 28)

- **车机滚轮音量仍不可控——加决定性诊断 + 两处真实断点加固**。用户实测 0.1.27：滚轮事件到达
  （`[CarKeys] native → volume` 随滚轮变化）、模式判定正确（`mode=fixed`）、APP 档位跟手
  （`wheel Δ → app=0.923/0.872/…`），但响度不变。静态逐行核查整条写入链
  （事件→store→effect→syncOutputGain→gainNode/deckVolumeSink）均正确，故断点在运行时状态，
  本版不盲改，补可观测性并修掉两条能让"写入落空"的真实路径：
- **诊断（会话日志可读，车机无 adb）**：
  - `[Volume] write → x.xxx sink=graph|element ctx=… gainNode=…`：每次音量变化落在哪一层、
    目标值、写回读值、上下文状态。落点与目标不一致 = 写入层断了；
  - `[Volume] self-check: peak=… prev=… ctx=… gainNode=… elVol=… storeVol=…`：音量落下去
    600ms 后实测 AnalyserNode 峰值——串在音量/淡化节点之后，读到什么功放放大什么。
    峰值随档位走 = 链路通；档位动而峰值不动 = 音频不走这条图；
  - `[AudioContext] graph ready / resume attempt / resumed`：图建成时上下文状态、几只 deck 接上；
  - `[Volume] analyser reads silence while playing: …`：静音自检激活时的完整状态。
- **加固 1（closed 上下文不再弄死音量 effect）**：`applyOutputGain` 原先只判
  `gainNodeRef && audioContextRef` 存在，上下文被内核回收（closed）时 AudioParam 写入会抛
  InvalidStateError，异常顺着 syncOutputGain 冒泡把整个音量 effect 弄死——之后所有音量变化
  （滚轮/滑杆/启动初值）都写不进去，正是"怎么调都没反应"。改为单独判 `state !== 'closed'`
  并兜 try/catch，退回元素音量层。
- **加固 2（deck 元素重挂后音量不再钉死 1）**：`applyElementVolume` 原先只看 chainsRef 判断
  "元素在图里、element.volume 保持 1"。React 重挂会让 deck 换成没被抓过的新元素，旧链仍在 →
  新元素被误钉在 1、gainNode 又管不到它 ⇒ 音量全死。新增 capturedElementRef 记录每个 deck
  真正被抓进图的元素，身份不符时改写元素音量；bindDeck 对重挂做旧链清理 + 图还活着就重接。
- build.gradle: versionCode 28 / versionName 0.1.28。

## 0.1.27（versionCode 27）

- **修复在线匹配封面始终不显示（真根因）**：日志实锤 `[CoverPlay] after match coverUrl=null onlineMeta.coverUrl=undefined useOnline=false`
  ——匹配只产出歌词、从未产出封面 URL，`/fetch` 代理根本没被调用（不是下载问题）。
  根因：安卓原生桥把 `/cloudsearch` 映射到旧接口 `/api/search/get/web`，其返回的 album 只有
  `picId`、没有 `picUrl`（沙箱实测确认；`/api/song/detail` 才有 picUrl），于是搜索结果的封面全为空。
- MainActivity.kt：`/cloudsearch` 改走新版 `POST /api/cloudsearch/pc`（返回 album.picUrl，
  响应结构一致），失败时回退旧接口保底。
- localMusicService.ts：安全网——匹配候选缺封面且为 netease 时补拉一次 `/song/detail` 取 picUrl，
  仅缺封面时触发、正常路径零额外请求。
- build.gradle: versionCode 27 / versionName 0.1.27。

## 0.1.26（versionCode 26）

- **在线封面诊断 + 加固**：本地内嵌封面已能显示（0.1.25），但播放中无内嵌封面的歌联网匹配封面仍不出。
  静态核查整条链路（/fetch 路由→原生下载→coverUrl 提取→持久化→显示）每一环均正常，且实测网易/QQ
  封面仅 UA 即可下到（200/JPEG），故怀疑为运行时问题。本版不盲改，先加可观测性 + 健壮性：
- LocalHttpServer `/fetch`：加 logcat 日志（tag `CoverFetch`：GET/OK/FAIL/NOT-IMAGE + 字节数），
  **魔数校验**（认不出 JPEG/PNG/WebP/GIF 直接 502，杜绝把 CDN 403/错误页当封面缓存→整片灰），
  并按 host 补 **Referer 重试**（网易/QQ/酷狗图片域偶发校验来源，抄 APlayer 的下载健壮性）。
- 前端 `[Cover]`/`[CoverPlay]` 诊断日志：debug 构建经 `consoleOutput(true)` 已进 logcat（tag GeckoConsole），
  打印代理路由、/fetch 响应码、blob 大小、播放初始/匹配后封面 URL 与 useOnlineCover 状态。
- 目标：用户抓一次 logcat 即可定位在线封面断在哪一环（匹配没出 coverUrl / /fetch 502 / 显示没接上）。

## 0.1.25（versionCode 25）

- **封面核心缺口修复（抄 APlayer 的 EmbeddedFetcher）**：folia 媒体模式此前只认目录 cover.jpg 和
  MediaStore 专辑图，完全不读音频文件**内嵌封面**——而绝大多数歌的封面正是内嵌在文件里的，
  这才是"大部分没封面"真正的核心原因（之前的专辑图兜底/CORS 代理都在外围打转）。
- MediaLibrary.kt：扫描每首歌时用 `MediaMetadataRetriever.embeddedPicture` 直接从音频文件抠内嵌图，
  写缓存文件给 `file://` URI，经现有 `/cover` 同源出图（离线零网络）。
- 关键防护：**只在确实取到字节时才写 coverUri**，无内嵌图的歌保持 coverUri 为空 → 在线匹配仍可用，
  彻底绕开 0.1.22 那种"盲写 coverUri 导致跳过在线兜底、整片灰"的坑。
- 缓存按 (音频contentUri+大小+修改时间) 做键，首次扫描逐文件探测（io 线程不卡 UI），重扫瞬间完成；
  无图歌曲用 .none 哨兵避免重复探测。
- build.gradle: versionCode 25 / versionName 0.1.25。

## 0.1.24（versionCode 24）

- 修复自动匹配封面整片缺失（下载问题，非匹配速度）。安卓壳里 coverCache 用浏览器 fetch 直抓
  外部封面 CDN，而网易/QQ/酷狗封面 CDN 普遍不带 CORS 头，webview fetch 直接失败；歌词走原生桥
  服务端抓取所以秒到，封面却拿不到——这就是"歌词立刻到位、封面始终不见"的根因。
  - LocalHttpServer 新增同源 `/fetch?url=` 代理端点：原生 HttpURLConnection 代抓图片、同源回传，
    绕开 webview CORS；仅放行 http/https、响应 ≤ 8MB。
  - coverCache.buildCoverRequestUrl：前端由 127.0.0.1 同源加载时，所有封面下载改走 `/fetch` 代理
    （不再裸 fetch 跨源），Electron 与常规 web 部署行为不变。

## 0.1.23（versionCode 23）

- **修复 0.1.22 封面整片灰（回归）**：`MediaLibrary.kt` 的专辑图兜底误判——`album_id` 对"无内嵌封面"
  的歌也照样 `>0`，于是给**所有**歌都写了 `content://.../albumart/<id>` 这个 URI；没图的专辑该 URI
  打开是空、`/cover` 出图失败变灰，而且 `hasLocalSongCover()` 现在认 `nativeCoverUrl` 会据此**跳过在线
  匹配**，结果整片灰且无兜底（模拟器里尤其明显，测试曲大多无内嵌图）。修正：新增 `albumArtExists()`，
  写入前用 `openInputStream` 实测该 albumart URI 能否取到字节，按 `albumId` 缓存（同专辑只探测一次）；
  没图的专辑不再写 `coverUri`，回退到在线匹配。有图专辑仍享受零网络瞬时封面。

## 0.1.22（versionCode 22）

- **修复车机音量滚轮/滑杆仍无效（手动切软件增益才出声）**：根因是 `VolumeMode.kt` 的调试钩子
  `SystemProperties.get(key)` 对未设置的键返回 `""` 而非 `null`，导致 `?.let` 恒成立、把车机
  强制判成 `adjustable`，OEM 白名单 / UiModeManager=CAR / automotive 特性检测全部沦为死代码，
  DiLink 上永远走不到 fixed。车机一旦被误判 adjustable，`systemGoverns=true` 就**关闭了网页层
  的滚轮映射**，实体滚轮和滑杆当然都没反应。修正为 `?.takeIf { it.isNotBlank() }`，空白串视为
  「未设置」；车机现在正确判成 fixed，网页接管音量、滚轮映射自动激活——无需再手动切软件增益。
- `usePlaybackAudioBridge.ts` 新增滚轮映射诊断日志（`wheel mapping active/inactive` 与每次
  调整的 `wheel Δ±x.xxx → app=y.yyy`），方便车机无 adb 时从会话日志确认滚轮是否真的在调 APP 音量。
- **封面匹配大幅提速（抄 APlayer 思路，本地零网络）**：`MediaLibrary.kt` 在扫描时读取
  `MediaStore.Audio.Media.ALBUM_ID`，无目录封面时用系统已缓存的专辑图
  `content://media/external/audio/albumart/<id>` 作为 `coverUri` 兜底。绝大多数字有标签的音乐
  因此在扫描阶段就拿到了**本地封面**，经壳层 `LocalHttpServer /cover?uri=...` 即时出图，
  不再依赖慢速在线匹配。
- 修正 `hasLocalSongCover()`：原先只认 `localCoverAssetId`，漏掉了原生/目录/专辑图封面
  （`nativeCoverUrl`），导致车机上明明有本地图的歌在首次播放时仍要去等一次在线搜索——这正是
  「很久匹配不到正在播放的」主要来源之一。现在 `nativeCoverUrl` 也算本地封面，命中即跳过在线匹配。
- 说明：专辑图是在**扫描时**写入快照的，旧库需要重新扫描一次才能补齐；重新扫后音乐墙与正在
  播放的封面都会即时显示。正在播放优先、其次音乐墙可见的匹配顺序本就由播放管线保证
  （播放即异步匹配、队列邻居预取），专辑图兜底后长尾（无标签/无专辑图）才走在线匹配。

## 0.1.21（versionCode 21）

- **修复车机音量全失效（恒最大声）**：根因是 `getVolumeMode()` 返回 `null`（车机持久化旧版桥扩展
  缺该方法 / 冷启动竞争）被前端当成 `adjustable` 写死，导致 `systemGoverns=true`、网页增益钉死 1、
  滑杆与实体音量键全部无效。新模块 `src/utils/nativeVolumeMode.ts` 统一解析：重试 + **null 永不写死
  adjustable** + 用户覆盖项；`systemVolumeGoverns()` 判据收敛到「原生壳 + 非 fixed + 系统档位 <0.999」
- `usePlaybackAudioBridge.ts` / `App.tsx` 改用统一决策；fixed / 未知模式下把滚轮 `volume` 事件
  映射为应用内档位（0.02 步长 + 防抖），让没有系统音量的车机也能用方向盘滚轮调 APP 音量
- `VolumeMode.kt` 增强判定：增 `UI_MODE_TYPE_CAR`（UiModeManager）与 `android.hardware.type.automotive`
  特性检测，`describe()` 输出判定依据，便于车机排查
- **桥扩展 `manifest.json` 2.0 → 2.1**：强制车机重装持久化的旧版扩展，根治缺 `getVolumeMode` 的
  旧扩展导致的判定失效
- **开发者选项新增「音量模式」卡片**（仅原生壳）：显示检测/生效状态 + 自动/软件增益/系统音量三选一
  覆盖，作为车机无 adb 时的自救入口；`volume` 系统事件接入会话日志
- 三语言 i18n 新增音量模式词条；单测 `nativeVolumeMode.test.ts` 11/11 通过，`tsc --noEmit` 零错误

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
