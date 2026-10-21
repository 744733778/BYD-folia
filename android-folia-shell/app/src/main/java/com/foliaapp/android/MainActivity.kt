package com.foliaapp.android

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebExtension
import java.io.BufferedReader
import java.io.FileInputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * Folia 安卓壳 —— GeckoView 内核 + WebExtension 消息桥。
 *
 * 通信链路：
 *   页面主世界 window.foliaBridge / window.nativeLibrary（由 content.js 注入的主世界 shim 定义）
 *     --window.postMessage({__foliaBridge:"request", ns, method, requestId, arg})--> 隔离世界 content.js
 *     --browser.runtime.sendMessage({target:"background", id, ns, method, requestId, arg})--> background.js
 *     --connectNative("browser") port.postMessage({id, ns, method, requestId, arg})--> 本类 onPortMessage
 *   本类按 ns 路由（foliaBridge 在线 HTTP 转发 / nativeLibrary 本地曲库 / media 播放状态）
 *     --port.postMessage({id, ns, requestId, ok, payload})--> 回传
 *
 * 曲库：MediaStore（系统媒体扫描器）是唯一来源，见 [MediaLibrary]。
 * 本地音频由 [LocalHttpServer] 的 /local 端点以支持 Range 的方式直供 <audio>，
 * 不再把整首歌 base64 过桥（车机上几十 MB 的临时字符串会直接卡死/爆内存）。
 */
class MainActivity : AppCompatActivity() {

    private val TAG = "foliaAPP"

    companion object {
        /** GeckoRuntime 每进程只能 create 一次：static 持有，Activity 重建只 close session */
        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var sRuntime: GeckoRuntime? = null
    }

    private lateinit var geckoView: GeckoView
    private var session: GeckoSession? = null
    private var webExtension: WebExtension? = null

    /** content script 经 background connectNative 建立的端口；原生经它回传结果 */
    private var nativePort: WebExtension.Port? = null

    /** 媒体键去重窗口：dispatchKeyEvent / Service 的 MediaSession 回调可能多路触发 */
    private val lastPush = java.util.HashMap<String, Long>()

    /**
     * 原生 → 页面的事件队列（拉取通道的载体）。
     *
     * 推送链路是「原生 port → background → content script → postMessage → 页面」，四跳，
     * 任一跳断掉所有事件都会静默消失，且车机上没有 logcat 无法定位。而「页面发请求、原生回包」
     * 这条反向链路是首页 RPC（httpRequest / getVolumeMode）一直在用的，本身已被证实可用。
     *
     * 所以每条事件都先进这个环形队列，页面定时用 pollEvents 拉走（带 seq 去重）；
     * port 那条快捷通道保留，通了就即时到达，不通也不会丢。
     */
    private val eventLog = java.util.ArrayDeque<JSONObject>()
    private var eventSeq = 0L
    private val eventLock = Any()

    /** 事件在队列里留多久。超过就丢，避免长时间运行后越积越多。 */
    private val EVENT_TTL_MS = 30_000L

    /** 首次拉取（since=0）只回放这么新的事件：避免重载页面时把几秒前的上一曲又补跳一次。 */
    private val EVENT_REPLAY_MS = 8_000L

    /** 启动诊断推了几次（端口未就绪时不计入）；到 3 次就不再刷。 */
    private var diagAttempts = 0

    /** 拔耳机/车机断电自动暂停（Auxio：丢弃注册后首个虚假 HEADSET_PLUG 广播） */
    private var headsetPlugFirstEventHandled = false

    private val becomingNoisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            pushSystemEvent("mediaKey", "pause")
        }
    }

    private val headsetPlugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (!headsetPlugFirstEventHandled) {
                headsetPlugFirstEventHandled = true
                return
            }
            if ((intent?.getIntExtra("state", -1) ?: -1) == 0) pushSystemEvent("mediaKey", "pause")
        }
    }

    /** 本地 http server：file:// 下 ES module 不执行，改走 http://127.0.0.1 加载前端 */
    private var httpServer: LocalHttpServer? = null

    private val ioExecutor = Executors.newCachedThreadPool()

    private lateinit var mediaLibrary: MediaLibrary
    private lateinit var cookieStore: CookieStore

    /** 媒体库变更监听（系统扫描完成后立刻通知前端刷新，不必等用户手点扫描） */
    private var libraryObserver: ContentObserver? = null

    /** 系统媒体音量监听（车机旋钮/方向盘音量键 → 推给前端音量条，替代 600ms 轮询） */
    private val volumeObservers = ArrayList<ContentObserver>()

    /** AudioFocus 四态管理器（playing 时 request、停止 abandon） */
    private val foliaTimeoutSec = 25L

    /** NavigationDelegate 回调缓存的历史后退能力（GeckoView 无同步 canGoBack()） */
    private var canGoBack = false

    /** 已发出/在途的 content 侧 bridge id；worker 与 watchdog 竞争回传权，谁先 remove 谁回 */
    private val pendingBridgeIds =
        Collections.newSetFromMap(ConcurrentHashMap<Int, Boolean>())

    private val uaMobileChrome =
        "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    /** 上次上报的曲目身份：避免每秒重复解码封面/重建通知 */
    private var lastReportedKey: String? = null
    private var lastCoverKey: String? = null
    private var lastCoverBitmap: Bitmap? = null
    private var serviceRunning = false
    private var lastVolumePushed = -1f

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * 原生启动遮罩：GeckoRuntime 初始化 + 扩展安装 + 首帧合成之前，GeckoView 只是一块白布。
     * 车机上这段要 2~4 秒，白屏很刺眼，所以 onCreate 里立刻盖一层深色 FOLIA，
     * 等页面真正合成第一帧（ContentDelegate.onFirstComposite）再淡出。
     */
    private var splashOverlay: View? = null

    /** 冷启动计时基准（日志用，定位启动慢在哪一段） */
    private val launchAt = SystemClock.elapsedRealtime()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mediaLibrary = MediaLibrary(applicationContext)
        cookieStore = CookieStore(applicationContext)

        // 1) GeckoRuntime（每进程一次，static 复用）。ALLOW_ALL：Gecko 自有网络栈，
        //    不受 Android networkSecurityConfig 控制，本地 http://127.0.0.1 必须显式放行。
        var rt = sRuntime
        if (rt == null) {
            val settingsBuilder = GeckoRuntimeSettings.Builder()
                .allowInsecureConnections(GeckoRuntimeSettings.ALLOW_ALL)
                // 页面 console 同步到 logcat（tag GeckoConsole）。车机上没 adb，但模拟器/开发机
                // 能直接看到 [CarKeys] 这类页面日志，排查原生→页面这条链路时不用靠拍照。
                .consoleOutput(BuildConfig.DEBUG)
                .remoteDebuggingEnabled(BuildConfig.DEBUG)
            // 自动播放策略交给内核配置（assets/geckoview-config.yaml）：车机冷启动没有
            // 用户手势，只靠 PermissionDelegate 放行 media element 不够，AudioContext 仍会
            // 以 suspended 创建 → 进度条在走但一点声音都没有。
            ensureGeckoConfigFile()?.let { settingsBuilder.configFilePath(it) }
            val runtimeSettings = settingsBuilder.build()
            // 配置文件解析失败会在这里抛：宁可退回默认内核设置，也不能让 APP 起不来。
            rt = try {
                GeckoRuntime.create(this, runtimeSettings)
            } catch (e: Exception) {
                Log.w(TAG, "GeckoRuntime create failed, retry without config: ${e.message}")
                GeckoRuntime.create(
                    this,
                    GeckoRuntimeSettings.Builder()
                        .allowInsecureConnections(GeckoRuntimeSettings.ALLOW_ALL)
                        .remoteDebuggingEnabled(BuildConfig.DEBUG)
                        .build()
                )
            }
            sRuntime = rt
            Log.d(TAG, "GeckoRuntime created +${SystemClock.elapsedRealtime() - launchAt}ms")
        } else {
            Log.d(TAG, "GeckoRuntime reused +${SystemClock.elapsedRealtime() - launchAt}ms")
        }
        val runtime = rt

        // 2) 本地 http server 先起来
        httpServer = LocalHttpServer(applicationContext).also { it.start() }
        val port = httpServer?.port ?: 0

        // 3) 播放服务：MediaSession + AudioFocus 全部由它持有（车机只认"服务里的活跃会话"）。
        //    这里只负责把服务叫起来并挂上进程内事件泵，Activity 重建不影响会话。
        startPlaybackServiceInit()

        // 4) 服务里的媒体键/焦点事件 → 当前 Activity 的网页桥
        NativeEventHub.sink = { method, payload -> pushSystemEvent(method, payload) }

        // 5) 注册耳机插拔/断电广播 + 媒体库/系统音量观察者
        registerMediaReceivers()
        registerLibraryObserver()
        registerVolumeObserver()

        // 6) GeckoView 控件（程序化构造，无需 layout XML）。
        //    深色底 + 原生启动遮罩：内核起来之前不要给用户看白屏。
        geckoView = GeckoView(this).apply { setBackgroundColor(Color.parseColor("#09090B")) }
        val rootView = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#09090B")) }
        rootView.addView(
            geckoView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        splashOverlay = buildSplashOverlay().also {
            rootView.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(rootView)
        // 兜底：页面若 15 秒还没合成（加载失败/内核异常），撤掉遮罩，至少能看到错误页。
        mainHandler.postDelayed({ hideSplash() }, 15_000)
        Log.d(TAG, "onCreate ready +${SystemClock.elapsedRealtime() - launchAt}ms")

        // 7) 创建 session + 导航委托 + 空 ContentDelegate（Bug 1758212：不挂空 delegate 会崩）
        val s = GeckoSession()
        s.setContentDelegate(object : GeckoSession.ContentDelegate {
            override fun onFirstComposite(session: GeckoSession) {
                // Gecko 线程回调；撤遮罩要回主线程。
                // 稍等 450ms：首帧只是 HTML 的深色底，React 通常紧接着才画出来，
                // 同色背景下多盖一会儿，淡出时下面已经是界面而不是空底。
                Log.d(TAG, "first composite +${SystemClock.elapsedRealtime() - launchAt}ms")
                mainHandler.postDelayed({ hideSplash() }, 450)
                // 首帧之后再等几秒：React 那时才挂上 native 事件监听，更早推会掉在空里，
                // 所以按 2.5s / 7s / 15s 补推三次（详见 scheduleCarDiag）。
                scheduleCarDiag()
            }
        })
        s.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                this@MainActivity.canGoBack = canGoBack
            }
        }

        // 冷启动自动续播：页面此时没有任何用户手势，Gecko 默认会拦下有声自动播放
        // （audio.play() 直接 NotAllowedError，前端弹"点击继续播放"）。
        // 本地 127.0.0.1 页面就是本站曲库，AUTOPLAY 权限直接放行；
        // 其余网页权限保持引擎默认（不额外放权）。
        s.permissionDelegate = object : GeckoSession.PermissionDelegate {
            override fun onContentPermissionRequest(
                session: GeckoSession,
                perm: GeckoSession.PermissionDelegate.ContentPermission
            ): GeckoResult<Int>? = when (perm.permission) {
                GeckoSession.PermissionDelegate.PERMISSION_AUTOPLAY_AUDIBLE,
                GeckoSession.PermissionDelegate.PERMISSION_AUTOPLAY_INAUDIBLE ->
                    GeckoResult.fromValue(GeckoSession.PermissionDelegate.ContentPermission.VALUE_ALLOW)
                else -> super.onContentPermissionRequest(session, perm)
            }
        }

        // 8) 安装/确保内置扩展；扩展就绪后挂消息委托、open、loadUri。
        runtime.webExtensionController
            .ensureBuiltIn(
                "resource://android/assets/folia-bridge/",
                "folia-bridge@folia.app"
            )
            .accept(
                { ext ->
                    val e = ext ?: run {
                        Log.e(TAG, "extension install returned null")
                        return@accept
                    }
                    webExtension = e
                    e.setMessageDelegate(bridgeMessageDelegate, "browser")
                    s.webExtensionController.setMessageDelegate(e, bridgeMessageDelegate, "browser")
                    geckoView.setSession(s)
                    s.open(runtime)
                    session = s
                    // splash=0：网页里那层启动遮罩不渲染——安卓壳已经有一层原生遮罩（见 buildSplashOverlay），
                    // 两层叠着会先 FOLIA、再暗一下、再 FOLIA 一次。桌面/浏览器仍用网页那层。
                    // flat=1：2D 变体（平铺音乐墙），同一份前端资源按启动参数切换。
                    val flatQuery = if (BuildConfig.FLAVOR == "flat") "&flat=1" else ""
                    s.loadUri("http://127.0.0.1:$port/index.html?splash=0$flatQuery")
                    Log.d(TAG, "extension ready, frontend loaded +${SystemClock.elapsedRealtime() - launchAt}ms (port $port)")
                },
                { e -> Log.e(TAG, "Error registering WebExtension", e) }
            )

        // 冷启动就把媒体权限问一次（MediaStore 查询需要）
        maybeRequestMediaAccess()
    }

    override fun onResume() {
        super.onResume()
        maybeRequestMediaAccess()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val s = session
        if (s != null && canGoBack) s.goBack() else super.onBackPressed()
    }

    // ==================== 媒体键 ====================

    /**
     * 车机物理键：方向盘上一曲/下一曲/播放暂停。
     *
     * 命中后必须 return true 消费掉——否则 GeckoView 内部还有一套 media session 会把同一个
     * 按键再处理一次，前端表现为"按一下跳两首"。音量键不在这里拦，交给系统。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            // 诊断：车机上没有 logcat 可看，键盘事件先推一行到页面的会话日志里。
            // 按了方向盘却读不到对应的 keyDiag，就证明车厂压根没把按键派给我们。
            // 只记首次按下（长按会每 50ms 重发一次，记了只会刷屏）。
            if (event.repeatCount == 0) {
                // 带上数字：车厂自有的方向盘键常常没有名字，keyCodeToString 只会给个 KEYCODE_xxx，
                // 数字才能对着 dumpsys/厂商文档查。
                pushSystemEvent(
                    "keyDiag",
                    "${event.keyCode}/${KeyEvent.keyCodeToString(event.keyCode)}"
                )
            }
            // 音量键**不拦**（与 APlayer 一致）：车机把滚轮/音量键直接调功放（调的是全局
            // 音量，不经 STREAM_MUSIC）。我们若在这里接住改软件音量，功放和软件增益会双重
            // 调节；0.1.16-0.1.18 的教训是只要我们声明接管音量（remote provider 或这里拦键），
            // 车机就不再调功放，而它又不真把音量回调给我们 → 大小都调不了。
            if (handleMediaKeyEvent(event)) return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** @return true 表示这是媒体键且已被处理（调用方应消费事件） */
    private fun handleMediaKeyEvent(event: KeyEvent): Boolean = MediaKeys.handle(event)

    /**
     * 原生 → 页面推送。媒体键 400ms 内同 key 去重，避免多路触发时连跳；
     * 音量键只留 60ms——钥匙扣按住不放时系统会每 ~50ms 重发一次，窗口太长会把连按吞掉。
     */
    private fun pushSystemEvent(method: String, payload: String) {
        val now = System.currentTimeMillis()
        val k = "$method/$payload"
        val last = lastPush[k] ?: 0L
        // 诊断行不去重：两次连按同一个键本来就该看到两行，吞掉一行反而看不出"系统在重复派发"。
        val window = when (method) {
            "volumeKey" -> 60L
            "keyDiag", "diag" -> 0L
            else -> 400L
        }
        if (now - last < window) return
        lastPush[k] = now
        // 先入队（拉取通道），再试着即时推。端口没连上时即时推送直接跳过，
        // 但事件已经躺在队列里，页面 400ms 内会自己拉走——不再依赖那条四跳链路。
        val seq = appendEvent(method, payload)
        Log.d(TAG, "evt $method/$payload seq=$seq port=${nativePort != null}")
        val port = nativePort ?: return
        try {
            port.postMessage(
                JSONObject()
                    .put("push", true)
                    .put("seq", seq)
                    .put("ns", "system")
                    .put("method", method)
                    .put("payload", payload)
            )
        } catch (_: Exception) {
        }
    }

    /** 事件入队并返回自增序号（页面据此去重、续拉）。 */
    private fun appendEvent(method: String, payload: String): Long {
        synchronized(eventLock) {
            eventSeq += 1
            val e = JSONObject()
                .put("s", eventSeq)
                .put("m", method)
                .put("p", payload)
                .put("t", System.currentTimeMillis())
            eventLog.addLast(e)
            val cutoff = System.currentTimeMillis() - EVENT_TTL_MS
            while (eventLog.isNotEmpty() && eventLog.peekFirst().optLong("t") < cutoff) {
                eventLog.pollFirst()
            }
            return eventSeq
        }
    }

    /**
     * 拉取 seq 之后的事件。arg 为上次的 seq（字符串或数字，空/0 视为首次）。
     * 返回 {"seq": 最新序号, "events": [{s,m,p}...]}。
     */
    private fun pollEvents(since: Long): String {
        synchronized(eventLock) {
            val now = System.currentTimeMillis()
            val floor = if (since <= 0) now - EVENT_REPLAY_MS else 0L
            val arr = JSONArray()
            for (e in eventLog) {
                if (e.optLong("s") <= since) continue
                if (e.optLong("t") < floor) continue
                arr.put(
                    JSONObject()
                        .put("s", e.optLong("s"))
                        .put("m", e.optString("m"))
                        .put("p", e.optString("p"))
                )
            }
            // 只在真的带事件或首次拉取时打一行：既能确认轮询在跑，又不会每 400ms 刷屏。
            if (arr.length() > 0 || since <= 0) {
                Log.d(TAG, "poll since=$since -> ${arr.length()} evt, seq=$eventSeq")
            }
            return JSONObject().put("seq", eventSeq).put("events", arr).toString()
        }
    }

    /**
     * 启动诊断：把音量判定与会话状态推到页面会话日志（设置 → 开发者选项）。
     *
     * 车机上没有 logcat 也没有 adb，这几个值决定了问题出在"判定"还是"派发"：
     * `vol …` 是音量归谁管，`reg …` 是系统有没有把我们注册成活跃媒体。
     *
     * 两处坑都在这里绕开：
     * 1. 端口还没连上时 [pushSystemEvent] 会静默丢弃 —— 不能先置一次性标志，
     *    否则这一版永远看不到诊断（以前就是这样，第一次掉在空里就再没补过）；
     * 2. content.js 只在 `window.__foliaOnEvent` 已经存在时投递事件，React 挂载稍晚就会掉，
     *    所以按几个时间点补推，最多 3 次。车机上多两行日志，好过一条都没有。
     */
    private fun pushCarDiag() {
        if (nativePort == null) return
        if (diagAttempts >= 3) return
        diagAttempts++
        try {
            pushSystemEvent("diag", "vol ${VolumeMode.describe(this)}")
            pushSystemEvent("diag", PlaybackService.describe(this))
        } catch (e: Exception) {
            Log.w(TAG, "push car diag failed: ${e.message}")
        }
    }

    /** 首帧之后按几个时间点补推：页面越晚就绪，越靠后的那次才落得进日志。 */
    private fun scheduleCarDiag() {
        for (delay in longArrayOf(2500L, 7000L, 15000L)) {
            mainHandler.postDelayed({ pushCarDiag() }, delay)
        }
    }

    private fun registerMediaReceivers() {        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            Context.RECEIVER_NOT_EXPORTED else 0
        registerReceiver(becomingNoisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), flags)
        registerReceiver(headsetPlugReceiver, IntentFilter("android.intent.action.HEADSET_PLUG"), flags)
    }

    // ==================== 系统观察者 ====================

    /** 媒体库变更：系统扫描器插完 U 盘/拷完歌会打这条通知，前端收到后做一次增量重扫 */
    private fun registerLibraryObserver() {
        try {
            val observer = object : ContentObserver(mainHandler) {
                override fun onChange(selfChange: Boolean, uri: Uri?) {
                    mediaLibrary.invalidate()
                    pushSystemEvent("libraryChanged", System.currentTimeMillis().toString())
                }
            }
            contentResolver.registerContentObserver(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, observer
            )
            libraryObserver = observer
        } catch (e: Exception) {
            Log.w(TAG, "register library observer failed", e)
        }
    }

    /**
     * 系统媒体音量（STREAM_MUSIC）变化 → 推给前端音量条。
     * 用观察者替代前端 600ms 轮询：UI 跟手、桥消息从 ~1.7 次/秒降到 0。
     */
    private fun registerVolumeObserver() {
        try {
            // volume_music_speaker 是 STREAM_MUSIC 的 Settings 键；整表再挂一个兜底，
            // 覆盖把音量写进其他同名键的 ROM。
            val uri = Settings.System.getUriFor("volume_music_speaker")
            val onVolume = object : ContentObserver(mainHandler) {
                override fun onChange(selfChange: Boolean) { pushVolumeLevel() }
            }
            contentResolver.registerContentObserver(uri, false, onVolume)
            volumeObservers.add(onVolume)
            val onAnySetting = object : ContentObserver(mainHandler) {
                override fun onChange(selfChange: Boolean) { pushVolumeLevel() }
            }
            contentResolver.registerContentObserver(Settings.System.CONTENT_URI, true, onAnySetting)
            volumeObservers.add(onAnySetting)
        } catch (e: Exception) {
            Log.w(TAG, "register volume observer failed", e)
        }
    }

    private fun pushVolumeLevel() {
        try {
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            if (max <= 0) return
            val level = am.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max
            if (kotlin.math.abs(level - lastVolumePushed) < 0.001f) return
            lastVolumePushed = level
            pushSystemEvent("volume", String.format(java.util.Locale.US, "%.3f", level))
        } catch (_: Exception) {
        }
    }

    // ==================== 启动遮罩 ====================

    /**
     * 与网页 index.html 里那层 #app-splash 同款：深色底 + FOLIA 字标。
     * 纯原生 View，随 Activity 首帧一起绘制，不依赖 Gecko、不依赖任何资源文件。
     */
    private fun buildSplashOverlay(): View {
        val title = TextView(this).apply {
            text = "FOLIA"
            setTextColor(Color.parseColor("#E6FFFFFF"))
            textSize = 30f
            letterSpacing = 0.18f
            gravity = Gravity.CENTER
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        return FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#09090B"))
            isClickable = true // 遮罩期间不把点击漏给还没加载完的 GeckoView
            addView(
                title,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER
                )
            )
        }
    }

    /** 首帧合成后淡出并移除遮罩；重复调用安全。 */
    private fun hideSplash() {
        val overlay = splashOverlay ?: return
        splashOverlay = null
        val parent = overlay.parent as? ViewGroup
        overlay.animate()
            .alpha(0f)
            .setDuration(180)
            .withEndAction { parent?.removeView(overlay) }
            .start()
        // animate 在极端情况下不回调（View 已 detach），兜底移除
        mainHandler.postDelayed({ parent?.removeView(overlay) }, 400)
    }

    override fun onDestroy() {
        session?.close()
        httpServer?.stop()
        try { unregisterReceiver(becomingNoisyReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(headsetPlugReceiver) } catch (_: Exception) {}
        try { libraryObserver?.let { contentResolver.unregisterContentObserver(it) } } catch (_: Exception) {}
        volumeObservers.forEach { obs ->
            try { contentResolver.unregisterContentObserver(obs) } catch (_: Exception) {}
        }
        volumeObservers.clear()
        NativeEventHub.sink = null
        lastCoverBitmap = null
        super.onDestroy()
        // runtime 不 destroy：每进程只 create 一次，重建 Activity 时复用
    }

    // ==================== WebExtension 消息桥 ====================

    private val bridgeMessageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            Log.d(TAG, "native port connected")
            nativePort = port
            port.setDelegate(object : WebExtension.PortDelegate {
                override fun onPortMessage(message: Any, port: WebExtension.Port) {
                    handleBridgeMessage(message)
                }

                override fun onDisconnect(port: WebExtension.Port) {
                    if (port === nativePort) nativePort = null
                }
            })
            // 端口就绪后补推一次当前音量，前端首帧音量条不留空
            mainHandler.post { pushVolumeLevel() }
        }
    }

    /**
     * background 中继来的 {id, ns, method, requestId, arg}。
     * id 是 content 侧自增配对号（原样回传，background 据此 resolve pending promise）；
     * ns 区分 foliaBridge / nativeLibrary / media。
     */
    private fun handleBridgeMessage(message: Any) {
        if (message !is JSONObject) return
        val id = message.optInt("id", -1)
        val ns = message.optString("ns")
        val requestId = message.optInt("requestId", -1)
        if (id < 0 || requestId < 0) return
        val method = message.optString("method")
        val arg = if (message.has("arg")) message.opt("arg") else null
        try {
            when (ns) {
                "nativeLibrary" -> handleNativeLibrary(id, requestId, method, arg)
                "foliaBridge" -> handleFoliaBridge(id, requestId, method, arg)
                "media" -> handleMediaBridge(id, requestId, method, arg)
            }
        } catch (e: Exception) {
            Log.e(TAG, "bridge error", e)
            sendBridgeResult(ns, id, requestId, false, e.message ?: "bridge error")
        }
    }

    /** 统一回传：{id, ns, requestId, ok, payload}，切 UI 线程发（port 只能在 UI 线程用） */
    private fun sendBridgeResult(ns: String, id: Int, requestId: Int, ok: Boolean, payload: String) {
        runOnUiThread {
            val p = nativePort ?: return@runOnUiThread
            val obj = JSONObject()
            obj.put("id", id)
            obj.put("ns", ns)
            obj.put("requestId", requestId)
            obj.put("ok", ok)
            obj.put("payload", payload)
            try {
                p.postMessage(obj)
            } catch (e: Exception) {
                Log.e(TAG, "port.postMessage failed", e)
            }
        }
    }

    // ==================== 目录桥 nativeLibrary ====================

    private fun handleNativeLibrary(id: Int, requestId: Int, method: String, arg: Any?) {
        when (method) {
            // 曲库快照：MediaStore 查询，几百行毫秒级；前端据此重建内存目录树 + 增量导入
            "listSnapshot" -> {
                runOnUiThread { maybeRequestMediaAccess() }
                ioExecutor.submit {
                    try {
                        sendBridgeResult("nativeLibrary", id, requestId, true, mediaLibrary.snapshot().toString())
                    } catch (e: Exception) {
                        sendBridgeResult("nativeLibrary", id, requestId, false, e.message ?: "snapshot error")
                    }
                }
            }

            // 强制重查（用户点"重新扫描"）：绕过快照缓存
            "refreshSnapshot" -> {
                ioExecutor.submit {
                    try {
                        sendBridgeResult("nativeLibrary", id, requestId, true, mediaLibrary.snapshot(force = true).toString())
                    } catch (e: Exception) {
                        sendBridgeResult("nativeLibrary", id, requestId, false, e.message ?: "snapshot error")
                    }
                }
            }

            // 只用于歌词/自动混音等小文件；音频播放走 LocalHttpServer /local，不再过桥
            "readFile" -> {
                val key = arg?.toString() ?: ""
                ioExecutor.submit {
                    try {
                        val bytes = readLocalBytes(key)
                        if (bytes == null) {
                            sendBridgeResult("nativeLibrary", id, requestId, false, "not found: $key")
                        } else {
                            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                            sendBridgeResult("nativeLibrary", id, requestId, true, b64)
                        }
                    } catch (e: Exception) {
                        sendBridgeResult("nativeLibrary", id, requestId, false, e.message ?: "read error")
                    }
                }
            }

            // 媒体权限引导：立即回包，不等系统设置页返回
            "ensureStorageAccess" -> {
                runOnUiThread { maybeRequestMediaAccess() }
                sendBridgeResult("nativeLibrary", id, requestId, true, "")
            }
        }
    }

    /**
     * 读本地文件字节。content:// 走 ContentResolver，绝对路径/file:// 走 FileInputStream。
     * 大文件硬上限 48MB：过去的实现会把整首无损塞进 base64 字符串，车机上直接 OOM。
     */
    private fun readLocalBytes(key: String): ByteArray? {
        if (key.isEmpty()) return null
        return when {
            key.startsWith("content://") -> {
                val uri = Uri.parse(key)
                val pfd = contentResolver.openFileDescriptor(uri, "r") ?: return null
                pfd.use { d ->
                    if (d.statSize > MAX_BRIDGE_BYTES) throw java.io.IOException("file too large for bridge: ${d.statSize}")
                    FileInputStream(d.fileDescriptor).use { it.readBytes() }
                }
            }
            key.startsWith("/") || key.startsWith("file://") -> {
                val path = if (key.startsWith("file://")) key.substring(7) else key
                val f = java.io.File(path)
                if (!f.isFile) return null
                if (f.length() > MAX_BRIDGE_BYTES) throw java.io.IOException("file too large for bridge: ${f.length()}")
                f.readBytes()
            }
            else -> null
        }
    }

    // ==================== 媒体状态上报（前端 reportMediaState） ====================

    private fun handleMediaBridge(id: Int, requestId: Int, method: String, arg: Any?) {
        if (method == "state") {
            val json = arg?.toString() ?: "{}"
            // MediaSession / 通知 / 前台服务都要求主线程；这里只做轻活，封面解码另派后台。
            runOnUiThread {
                try { handleMediaState(json) } catch (e: Exception) { Log.e(TAG, "handleMediaState", e) }
            }
        }
        // fire-and-forget，立即回包 resolve 前端 pending promise
        sendBridgeResult("media", id, requestId, true, "")
    }

    private fun handleMediaState(raw: String) {
        val json = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
        val playing = json.optBoolean("playing")
        val title = json.optString("title", "")
        val artist = json.optString("artist", "")
        val album = json.optString("album", "")
        val durationMs = json.optLong("durationMs")
        val positionMs = json.optLong("positionMs")
        val contentUri = json.optString("contentUri", "")

        val stateKey = "$title|$artist|$album|$contentUri|$durationMs"
        val trackChanged = stateKey != lastReportedKey

        if (trackChanged) {
            lastReportedKey = stateKey
            // 切歌先清掉上一首的封面，别让新歌顶着旧图（后台解出新图会再补一次）
            if (contentUri != lastCoverKey) {
                lastCoverBitmap = null
                PlaybackService.cover = null
            }
            lastCoverBitmap?.let { PlaybackService.cover = it }
            if (contentUri.isNotEmpty() && contentUri != lastCoverKey) {
                lastCoverKey = contentUri
                ioExecutor.submit {
                    val bmp = decodeCoverBitmap(contentUri)
                    lastCoverBitmap = bmp
                    if (bmp != null) {
                        runOnUiThread {
                            if (lastCoverKey != contentUri) return@runOnUiThread
                            // 封面只喂给 Service：元数据/通知都在它手里
                            PlaybackService.cover = bmp
                            startService(
                                Intent(this, PlaybackService::class.java).apply {
                                    action = PlaybackService.ACTION_COVER
                                }
                            )
                        }
                    }
                }
            }
        }

        // 状态/元数据/焦点/前台通知统一交给 Service —— Activity 不再直接持有会话
        val i = Intent(this, PlaybackService::class.java).apply {
            action = PlaybackService.ACTION_STATE
            putExtra(PlaybackService.EXTRA_PLAYING, playing)
            putExtra(PlaybackService.EXTRA_TITLE, title)
            putExtra(PlaybackService.EXTRA_ARTIST, artist)
            putExtra(PlaybackService.EXTRA_ALBUM, album)
            putExtra(PlaybackService.EXTRA_DURATION, durationMs)
            putExtra(PlaybackService.EXTRA_POSITION, positionMs)
        }
        try {
            if (playing && !serviceRunning) {
                serviceRunning = true
                startForegroundService(i)
                ensureNotificationPermission()
            } else {
                startService(i)
            }
        } catch (_: Exception) {
            try { startService(i) } catch (_: Exception) {}
        }
    }

    /**
     * 封面：音频文件里的内嵌图（MTR），降采样到 512。
     * 旧实现用 BitmapFactory 直接解码音频流，永远拿不到图 —— 车机通知一直是空白封面。
     */
    private fun decodeCoverBitmap(uriStr: String): Bitmap? {
        val uri = try { Uri.parse(uriStr) } catch (_: Exception) { return null }
        val mmr = MediaMetadataRetriever()
        return try {
            if (uriStr.startsWith("content://")) {
                mmr.setDataSource(applicationContext, uri)
            } else {
                val path = if (uriStr.startsWith("file://")) uriStr.substring(7) else uriStr
                mmr.setDataSource(path)
            }
            val bytes = mmr.embeddedPicture ?: return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            val maxDim = maxOf(bounds.outWidth, bounds.outHeight)
            while (maxDim > 0 && maxDim / sample > 512) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        } catch (_: Exception) {
            null
        } finally {
            try { mmr.release() } catch (_: Exception) {}
        }
    }

    /**
     * 冷启动就把播放服务叫起来（普通 startService，不进前台）：MediaSession 需要在进程
     * 一起床就 isActive，车机才会把方向盘媒体键算到本应用头上。
     */
    private fun startPlaybackServiceInit() {
        try {
            startService(Intent(this, PlaybackService::class.java).apply { action = PlaybackService.ACTION_INIT })
        } catch (e: Exception) {
            Log.w(TAG, "start playback service failed: ${e.message}")
        }
    }

    /**
     * 把 assets 里的内核配置复制到应用私有目录，返回绝对路径。
     *
     * GeckoRuntimeSettings.configFilePath 只接受应用目录内的路径（assets 不能直接当文件读），
     * 所以先落一份到 filesDir。内容变了才重写，避免每次启动做无用的 IO。
     */
    private fun ensureGeckoConfigFile(): String? {
        val target = java.io.File(filesDir, "geckoview-config.yaml")
        return try {
            val bytes = assets.open("geckoview-config.yaml").use { it.readBytes() }
            val upToDate = target.exists() && target.length() == bytes.size.toLong()
            if (!upToDate) target.writeBytes(bytes)
            target.absolutePath
        } catch (e: Exception) {
            // 配置只是"更彻底地放开自动播放"的加固，拿不到也不该拦住启动（权限代理仍在）。
            Log.w(TAG, "geckoview config unavailable: ${e.message}")
            null
        }
    }

    /** Android 13+ 通知运行时权限：首次播放时请求 */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
    }

    // ==================== 媒体权限 ====================

    /**
     * 运行时媒体权限：API33+ READ_MEDIA_AUDIO（封面用 READ_MEDIA_IMAGES），旧版 READ_EXTERNAL_STORAGE。
     * MediaStore 不需要 MANAGE_EXTERNAL_STORAGE；manifest 里保留它只是为了让老设备/特殊 ROM
     * 还能按路径读同名歌词。
     */
    private fun maybeRequestMediaAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val missing = ArrayList<String>()
            if (checkSelfPermission(android.Manifest.permission.READ_MEDIA_AUDIO) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) missing.add(android.Manifest.permission.READ_MEDIA_AUDIO)
            if (checkSelfPermission(android.Manifest.permission.READ_MEDIA_IMAGES) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) missing.add(android.Manifest.permission.READ_MEDIA_IMAGES)
            if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1002)
        } else if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE), 1003)
        }
    }

    // ==================== foliaBridge：在线源 HTTP 转发 + 系统音量 ====================

    private val neteaseBase = "https://music.163.com"
    private val neteaseReferer = "https://music.163.com/"
    private val qqReferer = "https://y.qq.com/"

    private data class HttpOutcome(
        val body: String,
        val status: Int,
        val setCookies: List<String>,
    )

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    private fun JSONObject.optStr(name: String): String? {
        val v = this.opt(name) ?: return null
        if (v == JSONObject.NULL) return null
        return v.toString().ifBlank { null }
    }

    private fun foliaUnsupported(provider: String, operation: String): String =
        JSONObject().apply {
            put("__foliaBridgeError", "UNSUPPORTED")
            put("provider", provider)
            put("operation", operation)
            put("message", "Unsupported operation: $provider/$operation")
        }.toString()

    private fun ensureCode200(body: String): String =
        try {
            val o = JSONObject(body)
            if (!o.has("code") || o.isNull("code")) o.put("code", 200)
            o.toString()
        } catch (_: Exception) {
            body
        }

    private fun execHttp(
        method: String,
        url: String,
        defaultReferer: String,
        callerHeaders: JSONObject,
        bodyText: String? = null,
        bodyContentType: String? = null,
        cookieOverride: String? = null,
    ): HttpOutcome {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12000
            readTimeout = 13000
            instanceFollowRedirects = false
        }
        try {
            var hasUa = false
            var hasReferer = false
            var hasCookie = false
            val itr = callerHeaders.keys()
            while (itr.hasNext()) {
                val k = itr.next()
                val v = callerHeaders.optString(k)
                when (k.lowercase()) {
                    "user-agent" -> hasUa = true
                    "referer" -> hasReferer = true
                    "cookie" -> hasCookie = true
                }
                conn.setRequestProperty(k, v)
            }
            if (!hasUa) conn.setRequestProperty("User-Agent", uaMobileChrome)
            if (!hasReferer && defaultReferer.isNotEmpty()) conn.setRequestProperty("Referer", defaultReferer)

            if (!hasCookie) {
                val cookie = cookieOverride ?: cookieStore.getCookie(url)
                if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)
            }

            if ((method.equals("POST", true) || method.equals("PUT", true)) && bodyText != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", bodyContentType ?: "application/x-www-form-urlencoded")
                OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(bodyText) }
            }

            val status = conn.responseCode
            val setCookies = ArrayList<String>()
            conn.headerFields.forEach { (k, values) ->
                if (k != null && k.equals("Set-Cookie", ignoreCase = true)) {
                    values?.forEach { setCookies.add(it) }
                }
            }

            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.let { s ->
                BufferedReader(InputStreamReader(s, Charsets.UTF_8)).use { it.readText() }
            } ?: ""

            for (sc in setCookies) {
                val normalized = if (sc.contains("Path=", ignoreCase = true)) sc else "$sc; Path=/"
                try { cookieStore.setCookie(url, normalized) } catch (_: Exception) {}
            }

            return HttpOutcome(body, status, setCookies)
        } finally {
            conn.disconnect()
        }
    }

    private fun routeNetease(path: String, query: JSONObject, headers: JSONObject): String {
        val cookieOverride = query.optStr("cookie")?.let {
            try { java.net.URLDecoder.decode(it, "UTF-8") } catch (_: Exception) { it }
        }

        return when (path) {
            "/cloudsearch" -> {
                val keywords = enc(query.optString("keywords"))
                val limit = query.optString("limit").ifBlank { "30" }
                val offset = query.optString("offset").ifBlank { "0" }
                val url = "$neteaseBase/api/search/get/web?s=$keywords&type=1&limit=$limit&offset=$offset"
                ensureCode200(execHttp("GET", url, neteaseReferer, headers, cookieOverride = cookieOverride).body)
            }

            "/lyric/new" -> {
                val id = enc(query.optString("id"))
                val url = "$neteaseBase/api/song/lyric?id=$id&lv=-1&kv=-1&tv=-1"
                ensureCode200(execHttp("GET", url, neteaseReferer, headers, cookieOverride = cookieOverride).body)
            }

            "/song/detail" -> {
                val ids = query.optString("ids").split(",").map { it.trim() }.filter { it.isNotEmpty() }
                if (ids.isEmpty()) return foliaUnsupported("netease", path)
                val first = ids[0]
                val idsJson = "[" + ids.joinToString(",") + "]"
                val url = "$neteaseBase/api/song/detail/?id=$first&ids=" + enc(idsJson)
                ensureCode200(execHttp("GET", url, neteaseReferer, headers, cookieOverride = cookieOverride).body)
            }

            "/login/qr/key" -> {
                val out = execHttp(
                    "POST", "$neteaseBase/api/login/qrcode/unikey", neteaseReferer, headers,
                    bodyText = "type=1", cookieOverride = cookieOverride,
                )
                val raw = JSONObject(out.body)
                JSONObject()
                    .put("code", raw.optInt("code", 200))
                    .put("data", JSONObject().put("unikey", raw.optString("unikey")))
                    .toString()
            }

            "/login/qr/create" -> {
                val key = query.optString("key")
                val qrurl = "$neteaseBase/login?codekey=$key"
                val qrimg = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + enc(qrurl)
                JSONObject()
                    .put("code", 200)
                    .put("data", JSONObject().put("qrurl", qrurl).put("qrimg", qrimg))
                    .toString()
            }

            "/login/qr/check" -> {
                val key = query.optString("key")
                val out = execHttp(
                    "POST", "$neteaseBase/api/login/qrcode/client/login", neteaseReferer, headers,
                    bodyText = "type=1&key=" + enc(key), cookieOverride = cookieOverride,
                )
                val obj = JSONObject(out.body)
                if (obj.optInt("code") == 803 && !obj.has("cookie") && out.setCookies.isNotEmpty()) {
                    obj.put("cookie", out.setCookies.joinToString("; ") { it.substringBefore(';').trim() })
                }
                obj.toString()
            }

            "/login/status" -> {
                val raw = JSONObject(
                    execHttp("GET", "$neteaseBase/api/nuser/account/get", neteaseReferer, headers, cookieOverride = cookieOverride).body
                )
                JSONObject()
                    .put("code", 200)
                    .put(
                        "data",
                        JSONObject()
                            .put("code", raw.optInt("code", 200))
                            .put("account", raw.opt("account"))
                            .put("profile", raw.opt("profile")),
                    ).toString()
            }

            "/user/account" ->
                execHttp("GET", "$neteaseBase/api/nuser/account/get", neteaseReferer, headers, cookieOverride = cookieOverride).body

            "/register/anonimous" ->
                execHttp(
                    "POST", "$neteaseBase/api/register/anonimous", neteaseReferer, headers,
                    bodyText = null, cookieOverride = "os=pc; appver=2.9.7",
                ).body

            "/logout" ->
                execHttp(
                    "POST", "$neteaseBase/api/logout", neteaseReferer, headers,
                    bodyText = "type=1", cookieOverride = cookieOverride,
                ).body

            else -> foliaUnsupported("netease", path)
        }
    }

    private fun routeQq(operation: String, params: JSONObject, headers: JSONObject): String =
        when (operation) {
            "search" -> {
                val w = enc(params.optStr("w") ?: "")
                val n = params.optStr("n") ?: "20"
                val p = params.optStr("p") ?: "1"
                val url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=$p&n=$n&w=$w&cr=1&aggr=0&lossless=1&new_json=1"
                execHttp("GET", url, qqReferer, headers).body
            }

            "lyric" -> {
                val songmid = enc(params.optStr("songmid") ?: "")
                val url =
                    "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=$songmid&format=json&nobase64=1" +
                        "&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8" +
                        "&notice=0&platform=yqq&needNewCode=0"
                execHttp("GET", url, qqReferer, headers).body
            }

            "smartbox" -> {
                val key = enc(params.optStr("key") ?: params.optStr("w") ?: "")
                val url = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&inCharset=utf-8&outCharset=utf-8&key=$key"
                execHttp("GET", url, qqReferer, headers).body
            }

            else -> foliaUnsupported("qq", operation)
        }

    private fun routeKugou(operation: String, params: JSONObject, headers: JSONObject): String =
        when (operation) {
            "search", "anonymous_search" -> {
                val keyword = enc(params.optStr("keyword") ?: "")
                val page = params.optStr("page") ?: "1"
                val pagesize = params.optStr("pagesize") ?: "20"
                val url = "http://mobilecdn.kugou.com/api/v3/search/song?keyword=$keyword&page=$page&pagesize=$pagesize&platform=web&tag=em&filter=10"
                execHttp("GET", url, "", headers).body
            }

            "search_lyric" -> {
                val keyword = enc(params.optStr("keyword") ?: "")
                val singer = enc(params.optStr("singer") ?: "")
                val url = "http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=$keyword&singer=$singer"
                execHttp("GET", url, "", headers).body
            }

            "lyric" -> {
                val id = enc(params.optStr("id") ?: "")
                val accesskey = enc(params.optStr("accesskey") ?: "")
                val fmt = params.optStr("fmt") ?: "krc"
                val url = "http://lyrics.kugou.com/download?ver=1&client=pc&id=$id&accesskey=$accesskey&fmt=$fmt"
                val raw = JSONObject(execHttp("GET", url, "", headers).body)
                var decoded = ""
                val content = raw.optString("content")
                if (content.isNotEmpty()) {
                    decoded = try {
                        String(Base64.decode(content, Base64.DEFAULT), Charsets.UTF_8)
                    } catch (_: Exception) {
                        content
                    }
                }
                JSONObject()
                    .put("status", raw.optInt("status", 1))
                    .put("decodeContent", decoded)
                    .put("contenttype", raw.opt("contenttype"))
                    .toString()
            }

            else -> foliaUnsupported("kugou", operation)
        }

    private fun routeQqRaw(headers: JSONObject, bodyObj: Any?): String {
        val bodyText = when (bodyObj) {
            null -> "{}"
            is JSONObject -> bodyObj.toString()
            else -> bodyObj.toString()
        }
        return execHttp(
            "POST", "https://u.y.qq.com/cgi-bin/musicu.fcg", qqReferer, headers,
            bodyText = bodyText, bodyContentType = "application/json",
        ).body
    }

    private fun handleFoliaRequest(requestJson: String): String {
        val req = JSONObject(requestJson)
        val provider = req.optString("provider")
        val operation = req.optString("operation")
        val path = req.optString("path").ifBlank { operation }
        val query = req.optJSONObject("query") ?: JSONObject()
        val params = req.optJSONObject("params") ?: JSONObject()
        val headers = req.optJSONObject("headers") ?: JSONObject()
        val bodyObj = if (req.has("body")) req.opt("body") else null

        return when (provider) {
            "netease" -> routeNetease(path, query, headers)
            "qq" -> routeQq(operation, params, headers)
            "kugou" -> routeKugou(operation, params, headers)
            "qq_raw" -> routeQqRaw(headers, bodyObj)
            else -> foliaUnsupported(provider, operation)
        }
    }

    /**
     * foliaBridge.httpRequest：丢后台线程执行，绝不阻塞 port 线程。
     * watchdog 在 foliaTimeoutSec 后兜底回传超时错误；worker 与 watchdog 谁先 remove
     * pendingBridgeIds 里的 id 谁负责回传，保证恰好回调一次。
     */
    private fun handleFoliaBridge(id: Int, requestId: Int, method: String, arg: Any?) {
        // 系统音量读写 <1ms，内联处理，不走 worker/watchdog
        when (method) {
            // 事件拉取：页面每 400ms 调一次，把原生推送队列里新增的事件取走。
            // 这是「页面请求 → 原生回包」方向，和 httpRequest 同一条链路，已证实可用；
            // 不依赖 port → background → content 那条四跳推送链（车机上它一直没通）。
            "pollEvents" -> {
                val since = arg?.toString()?.toLongOrNull() ?: 0L
                sendBridgeResult("foliaBridge", id, requestId, true, pollEvents(since))
                return
            }

            // 固定音量机型（比亚迪 DiLink 等）：AudioManager 的 STREAM_MUSIC 是空转的，
            // 硬件增益由 CarAudioService 全权接管。前端据此改走软件增益（gainNode）。
            "getVolumeMode" -> {
                try {
                    sendBridgeResult("foliaBridge", id, requestId, true, VolumeMode.resolve(this))
                } catch (e: Exception) {
                    sendBridgeResult("foliaBridge", id, requestId, false, e.message ?: "volume mode error")
                }
                return
            }

            "getSystemVolume" -> {
                try {
                    val am = getSystemService(AUDIO_SERVICE) as AudioManager
                    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                    val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
                    val level = if (max > 0) cur.toFloat() / max else 0f
                    lastVolumePushed = level
                    sendBridgeResult("foliaBridge", id, requestId, true,
                        String.format(java.util.Locale.US, "%.3f", level))
                } catch (e: Exception) {
                    sendBridgeResult("foliaBridge", id, requestId, false, e.message ?: "volume error")
                }
                return
            }

            "setSystemVolume" -> {
                try {
                    val lvl = arg?.toString()?.toFloatOrNull()
                    if (lvl == null) {
                        sendBridgeResult("foliaBridge", id, requestId, false, "bad volume arg")
                        return
                    }
                    val am = getSystemService(AUDIO_SERVICE) as AudioManager
                    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                    val target = (lvl * max).roundToInt().coerceIn(0, max)
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
                    val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
                    val level = if (max > 0) cur.toFloat() / max else 0f
                    lastVolumePushed = level
                    sendBridgeResult("foliaBridge", id, requestId, true,
                        String.format(java.util.Locale.US, "%.3f", level))
                } catch (e: Exception) {
                    sendBridgeResult("foliaBridge", id, requestId, false, e.message ?: "volume error")
                }
                return
            }
        }

        if (method != "httpRequest") return
        val requestJson = arg?.toString() ?: "{}"
        pendingBridgeIds.add(id)

        val worker = ioExecutor.submit {
            try {
                val payload = handleFoliaRequest(requestJson)
                if (pendingBridgeIds.remove(id)) {
                    sendBridgeResult("foliaBridge", id, requestId, true, payload)
                }
            } catch (e: Exception) {
                if (pendingBridgeIds.remove(id)) {
                    sendBridgeResult("foliaBridge", id, requestId, false, e.message ?: "bridge error")
                }
            }
        }

        ioExecutor.submit {
            try {
                TimeUnit.SECONDS.sleep(foliaTimeoutSec)
            } catch (_: InterruptedException) {
                return@submit
            }
            if (pendingBridgeIds.remove(id)) {
                try { worker.cancel(true) } catch (_: Exception) {}
                sendBridgeResult("foliaBridge", id, requestId, false, "request timeout after ${foliaTimeoutSec}s")
            }
        }
    }

    // ==================== 自建持久化 cookie 存储（代理层 cookie jar） ====================

    /**
     * 极简 cookie jar：domain -> (name -> value)。
     * 页面只访问 127.0.0.1，API 请求全走原生 HttpURLConnection，本 jar 即代理层 cookie 存储，
     * 扫码登录的 MUSIC_U 等跨重启保留。
     */
    private class CookieStore(private val context: Context) {
        private val prefs: SharedPreferences = context.getSharedPreferences("folia_cookies", Context.MODE_PRIVATE)
        private val store = ConcurrentHashMap<String, LinkedHashMap<String, String>>()

        init {
            val raw = prefs.getString("jar", null)
            if (!raw.isNullOrEmpty()) {
                try {
                    val root = JSONObject(raw)
                    val it = root.keys()
                    while (it.hasNext()) {
                        val domain = it.next()
                        val cookies = root.optJSONObject(domain) ?: continue
                        val map = LinkedHashMap<String, String>()
                        val cit = cookies.keys()
                        while (cit.hasNext()) {
                            val n = cit.next()
                            map[n] = cookies.optString(n)
                        }
                        store[domain] = map
                    }
                } catch (_: Exception) { /* 损坏则从空开始 */ }
            }
        }

        @Synchronized
        fun getCookie(url: String): String? {
            val host = try { URL(url).host } catch (_: Exception) { return null }
            val pairs = ArrayList<String>()
            for ((domain, map) in store) {
                if (host == domain || host.endsWith(".$domain")) {
                    for ((n, v) in map) pairs.add("$n=$v")
                }
            }
            return if (pairs.isEmpty()) null else pairs.joinToString("; ")
        }

        @Synchronized
        fun setCookie(url: String, cookieSpec: String) {
            val host = try { URL(url).host } catch (_: Exception) { return }
            val parts = cookieSpec.split(";").map { it.trim() }.filter { it.isNotEmpty() }
            if (parts.isEmpty()) return
            val pair = parts[0].split("=", limit = 2)
            if (pair.size < 2) return
            val name = pair[0].trim()
            val value = pair[1].trim()
            var domain = host
            for (attr in parts.drop(1)) {
                val kv = attr.split("=", limit = 2)
                if (kv[0].equals("domain", ignoreCase = true) && kv.size == 2) {
                    domain = kv[1].trim().removePrefix(".")
                }
            }
            val map = store.getOrPut(domain) { LinkedHashMap() }
            map[name] = value
            save()
        }

        @Synchronized
        private fun save() {
            val root = JSONObject()
            for ((domain, map) in store) {
                val o = JSONObject()
                for ((n, v) in map) o.put(n, v)
                root.put(domain, o)
            }
            prefs.edit().putString("jar", root.toString()).apply()
        }
    }
}

/** 过桥读字节的硬上限：超过就走 /local 流式，别把整首无损塞成 base64 */
private const val MAX_BRIDGE_BYTES = 48L * 1024 * 1024
