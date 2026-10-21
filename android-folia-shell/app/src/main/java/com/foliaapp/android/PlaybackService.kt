package com.foliaapp.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.media.MediaBrowserServiceCompat

/**
 * 播放前台服务：**MediaSession 与 AudioFocus 的唯一持有者**。
 *
 * 为什么必须在 Service 里：DiLink（以及多数车机）只把方向盘媒体键交给"当前活跃媒体会话"，
 * 而活跃 = 有前台服务承载 + session isActive + 正在放 + 持有音频焦点。会话挂在 Activity 上时，
 * 页面一退到后台或 Activity 重建，会话就掉出激活列表，方向盘上一曲/下一曲直接没有事件。
 *
 * 会话一直激活（暂停也不 release），保证暂停后按方向盘播放键还能唤回；
 * 播放中维持前台通知，避免服务被系统回收后会话消失。
 * 媒体键事件经 [NativeEventHub] 交给 Activity 的网页桥，不在这里碰前端。
 *
 * 同时它是一个 [MediaBrowserServiceCompat]：车机（DiLink、各类 Android Automotive 桌面）找
 * "媒体应用"时先看有没有 `android.media.browse.MediaBrowserService`，只挂 MediaSession 的
 * 应用在部分车机上根本进不了方向盘按键的路由表。内容树留空——我们不需要被浏览，只需要被识别。
 */
class PlaybackService : MediaBrowserServiceCompat() {

    companion object {
        const val CHANNEL_ID = "folia_playback"
        const val ACTION_INIT = "com.foliaapp.android.PLAYBACK_INIT"
        const val ACTION_START = "com.foliaapp.android.PLAYBACK_START"
        const val ACTION_PAUSE = "com.foliaapp.android.PLAYBACK_PAUSE"
        /** 只换通知内容（切歌/封面解完），不重新 startForeground */
        const val ACTION_UPDATE = "com.foliaapp.android.PLAYBACK_UPDATE"
        /** 完整播放状态（playing/元数据/进度），由 MainActivity 从 reportMediaState 转发 */
        const val ACTION_STATE = "com.foliaapp.android.PLAYBACK_STATE"
        const val ACTION_COVER = "com.foliaapp.android.PLAYBACK_COVER"
        const val ACTION_STOP = "com.foliaapp.android.PLAYBACK_STOP"
        const val ACT_NEXT = "com.foliaapp.android.ACT_NEXT"
        const val ACT_PREV = "com.foliaapp.android.ACT_PREV"
        const val ACT_PLAYPAUSE = "com.foliaapp.android.ACT_PLAYPAUSE"

        const val EXTRA_PLAYING = "playing"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_ALBUM = "album"
        const val EXTRA_DURATION = "durationMs"
        const val EXTRA_POSITION = "positionMs"

        /** 前台通知 id（startForeground / notify 必须一致，否则会出现两条通知） */
        const val FOREGROUND_ID = 1

        /** MediaBrowser 的根 id（内容为空，只为让车机认到"这是个媒体应用"） */
        const val BROWSER_ROOT_ID = "folia_root"

        /** 诊断用：服务是否活着（Activity 侧只读，不参与任何播放判断）。 */
        @Volatile
        var isRunning: Boolean = false
            private set

        /** 真的在出声。广播接收器靠它判断"现在该不该接这个媒体键"，避免抢别的播放器的键。 */
        @Volatile
        var isPlayingNow: Boolean = false
            private set

        /** 服务持有的会话；MainActivity 只读（不再自建会话）。 */
        @Volatile
        var session: MediaSessionCompat? = null
            private set

        @Volatile
        var title: CharSequence? = null

        @Volatile
        var subtitle: CharSequence? = null

        @Volatile
        var cover: Bitmap? = null

        /**
         * 一行诊断：**系统到底认没认我们**。
         *
         * `active=0` 或 `state=-1` → 会话没进系统的活跃媒体列表，状态栏不会显示我们、
         * 方向盘按键也不会派过来（问题不在按键映射，而在注册）。
         * `notif=0` → 前台/媒体通知没发出去，很多车机是靠通知认定"当前播放器"的。
         * `svc=0` → 服务根本没起来，前面几项都无从谈起。
         */
        fun describe(context: Context): String {
            val s = session
            val state = try {
                s?.controller?.playbackState?.state ?: -1
            } catch (_: Exception) {
                -1
            }
            val notif = try {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                    .activeNotifications.size
            } catch (_: Exception) {
                -1
            }
            return "reg active=${s?.isActive} state=$state svc=$isRunning " +
                "playing=$isPlayingNow notif=$notif mode=${runCatching { VolumeMode.resolve(context) }.getOrDefault("?")}"
        }
    }

    private var focus: AudioFocusManager? = null
    private var playing = false
        set(value) {
            field = value
            isPlayingNow = value
        }
    private var positionMs = 0L
    private var durationMs = 0L
    private var foreground = false
    /** 上一次推给日志的播放态，只在翻转时记一行（前端每秒上报一次，不能每帧都写）。 */
    private var lastStateSent = -1
    /** 前端每秒上报一次状态：内容没变就别再 setMetadata / notify，省 binder 与通知栏刷新 */
    private var lastMetadataKey: String? = null
    private var lastNotificationKey: String? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
            nm.createNotificationChannel(ch)
        }

        // 焦点跟会话同寿命：Service 活着就一直能申请/释放，Activity 重建不影响。
        focus = AudioFocusManager(this) { ev ->
            when (ev) {
                AudioFocusManager.EVENT_PAUSE -> NativeEventHub.emit("mediaKey", "pause")
                AudioFocusManager.EVENT_PLAY -> NativeEventHub.emit("mediaKey", "play")
                AudioFocusManager.EVENT_DUCK -> NativeEventHub.emit("focus", "duck")
                AudioFocusManager.EVENT_UNDUCK -> NativeEventHub.emit("focus", "unduck")
            }
        }

        if (session == null) {
            // 音量永远交给系统（setPlaybackToLocal），**不挂 VolumeProvider**。
            //
            // 0.1.18 曾在固定音量车机上 setPlaybackToRemote(ABSOLUTE provider)，想接住车机滚轮——
            // 实测适得其反：系统看到活跃会话声明"音量归我管"，就把滚轮/音量键路由给会话、
            // 不再调功放；而 DiLink 并不真回调 onAdjustVolume/onSetVolumeTo，结果两头都死
            //（"大小都调不了"）。APlayer 在同一台车机上音量、切歌都正常，它恰恰是
            // 什么都不接管：默认 local STREAM_MUSIC、无 provider、PlaybackState 不声明音量动作，
            // 滚轮由车机直接调功放（与 QQ 音乐一致）。
            // 应用内的音量滑杆（软件增益）与系统功放音量是两个独立维度，互不干扰。

            // 只挂会话，**不挂静态媒体键接收器**。
            //
            // 0.1.9 照 APlayer 用了四参构造（ComponentName + 只带 ACTION_MEDIA_BUTTON 的
            // PendingIntent）。问题在于那个 PendingIntent 带 FLAG_IMMUTABLE：系统投递按键时
            // 是用 fill-in Intent 把 EXTRA_KEY_EVENT 塞进去的，immutable 会把 fill-in 整体丢弃，
            // 接收器只收到 action、没有键码，什么也解不出来。
            // 更要命的是：会话一旦挂了 mbrIntent，框架就**只走广播**、不再回调会话，
            // 等于把唯一可靠的那条路也堵死 —— 表现就是按键全哑、两条通路都不打日志。
            // 现在让框架直接把 KeyEvent 派给 Callback.onMediaButtonEvent。
            val s = MediaSessionCompat(this, "folia").apply {
                setFlags(
                    MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                        MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
                )
                setPlaybackToLocal(android.media.AudioManager.STREAM_MUSIC)
                setSessionActivity(
                    PendingIntent.getActivity(
                        this@PlaybackService, 0,
                        Intent(this@PlaybackService, MainActivity::class.java),
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                    )
                )
                // 会话常驻激活，媒体键直接走 setCallback（onPlay/onSkipToNext…），
                // 框架不再经过任何 PendingIntent。
                setCallback(object : MediaSessionCompat.Callback() {
                    override fun onSkipToNext() = NativeEventHub.emit("mediaKey", "next")
                    override fun onSkipToPrevious() = NativeEventHub.emit("mediaKey", "prev")
                    override fun onPlay() = NativeEventHub.emit("mediaKey", "play")
                    override fun onPause() = NativeEventHub.emit("mediaKey", "pause")
                    override fun onStop() = NativeEventHub.emit("mediaKey", "pause")
                    override fun onSeekTo(pos: Long) = NativeEventHub.emit("seek", pos.toString())

                    /** 厂商自定义/蓝牙按键不一定映射到 onXxx，这里兜底解 KeyEvent */
                    @Suppress("DEPRECATION")
                    override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                        val ev = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT) as? KeyEvent
                        // 诊断：广播通路收到了什么键。它和 Activity 的 keyDiag 是两条独立入口，
                        // 车机走哪条、还是两条都不走，只有日志能分清楚。
                        if (ev != null) {
                            NativeEventHub.emit(
                                "diag",
                                "mediabutton ${ev.keyCode}/${KeyEvent.keyCodeToString(ev.keyCode)} action=${ev.action}"
                            )
                        }
                        if (ev != null && handleMediaKeyEvent(ev)) return true
                        return super.onMediaButtonEvent(mediaButtonIntent)
                    }
                })
                isActive = true
            }
            // 系统判断"这是个正在用的媒体应用"要同时看两样：会话 isActive、且有 PlaybackState。
            // 缺一个就不会被状态栏/媒体面板列出来。冷启动先给 PAUSED，按键也能直接唤回。
            s.setPlaybackState(buildState(PlaybackStateCompat.STATE_PAUSED, 0L))
            session = s
            // 车机/系统通过 MediaBrowser 连接时要靠这个 token 找到会话
            sessionToken = s.sessionToken
        }
        Log.d("PlaybackService", "session ready, active=${session?.isActive} fixed=${VolumeMode.isFixed(this)}")
    }

    // ==================== MediaBrowserServiceCompat ====================

    /**
     * 车机找"媒体应用"时先 bind 这个服务。我们不需要被浏览，内容树给空，
     * 只要有会话 token 就能接方向盘按键与媒体面板。
     */
    override fun onGetRoot(
        clientPackageName: String,
        clientUid: Int,
        rootHints: Bundle?,
    ): BrowserRoot = BrowserRoot(BROWSER_ROOT_ID, null)

    override fun onLoadChildren(
        parentId: String,
        result: Result<MutableList<MediaBrowserCompat.MediaItem>>,
    ) {
        result.sendResult(mutableListOf<MediaBrowserCompat.MediaItem>())
    }

    /** @return true 表示这是媒体键且已被处理 */
    private fun handleMediaKeyEvent(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return false
        when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                NativeEventHub.emit("mediaKey", "next"); return true
            }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD,
            KeyEvent.KEYCODE_MEDIA_REWIND -> {
                NativeEventHub.emit("mediaKey", "prev"); return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> {
                NativeEventHub.emit("mediaKey", "playpause"); return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> {
                NativeEventHub.emit("mediaKey", "play"); return true
            }
            KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP -> {
                NativeEventHub.emit("mediaKey", "pause"); return true
            }
        }
        return false
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACT_NEXT -> session?.controller?.transportControls?.skipToNext()
            ACT_PREV -> session?.controller?.transportControls?.skipToPrevious()
            ACT_PLAYPAUSE -> {
                if (playing) session?.controller?.transportControls?.pause()
                else session?.controller?.transportControls?.play()
            }
            // 仍有可能有 App/ROM 把 MEDIA_BUTTON 直接 startService 过来（androidx 的
            // MediaButtonReceiver 就是这么干的）。以前这里没分支，事件静默消失；现在接住。
            Intent.ACTION_MEDIA_BUTTON -> {
                @Suppress("DEPRECATION")
                val ev = intent?.getParcelableExtra(Intent.EXTRA_KEY_EVENT) as? KeyEvent
                if (ev != null) {
                    NativeEventHub.emit(
                        "diag",
                        "svc-key ${ev.keyCode}/${KeyEvent.keyCodeToString(ev.keyCode)} action=${ev.action}"
                    )
                    MediaKeys.handle(ev)
                }
            }
            ACTION_STATE -> applyState(intent)
            ACTION_COVER -> {
                applyMetadata()
                refreshNotification()
            }
            ACTION_START -> {
                playing = true
                focus?.request()
                setPlaybackState(PlaybackStateCompat.STATE_PLAYING)
                startForegroundCompat()
            }
            ACTION_PAUSE -> {
                playing = false
                focus?.abandon()
                setPlaybackState(PlaybackStateCompat.STATE_PAUSED)
                // 服务/会话保留：方向盘播放键还能把歌叫回来
                refreshNotification()
            }
            ACTION_UPDATE -> refreshNotification()
            ACTION_STOP -> {
                playing = false
                focus?.abandon()
                setPlaybackState(PlaybackStateCompat.STATE_STOPPED)
                if (foreground) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    foreground = false
                }
                stopSelf()
                return START_NOT_STICKY
            }
        }
        // INIT/UPDATE 之类首帧也要满足前台服务合约：只有真要出声时才进前台
        if (playing) startForegroundCompat()
        return START_STICKY
    }

    private fun applyState(intent: Intent) {
        playing = intent.getBooleanExtra(EXTRA_PLAYING, playing)
        positionMs = intent.getLongExtra(EXTRA_POSITION, positionMs)
        durationMs = intent.getLongExtra(EXTRA_DURATION, durationMs)
        title = intent.getStringExtra(EXTRA_TITLE) ?: title
        val artist = intent.getStringExtra(EXTRA_ARTIST).orEmpty()
        val album = intent.getStringExtra(EXTRA_ALBUM).orEmpty()
        subtitle = if (artist.isNotEmpty()) artist else album

        applyMetadata()
        setPlaybackState(
            if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        )
        if (playing) {
            focus?.request()
            startForegroundCompat()
        } else {
            focus?.abandon()
            refreshNotification()
        }
    }

    private fun applyMetadata() {
        val s = session ?: return
        val key = "${title}|${subtitle}|${durationMs}|${cover?.hashCode()}"
        if (key == lastMetadataKey) return
        lastMetadataKey = key
        val b = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title?.toString() ?: "")
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, subtitle?.toString() ?: "")
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
        cover?.let { b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        s.setMetadata(b.build())
    }

    private fun buildState(state: Int, position: Long): PlaybackStateCompat =
        PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                    PlaybackStateCompat.ACTION_STOP or
                    PlaybackStateCompat.ACTION_SEEK_TO
            )
            .setState(state, position, if (state == PlaybackStateCompat.STATE_PLAYING) 1.0f else 0f)
            .build()

    private fun setPlaybackState(state: Int) {
        val changed = state != lastStateSent
        lastStateSent = state
        session?.setPlaybackState(buildState(state, positionMs))
        // 状态翻转才记一行：前端每秒上报一次，不设门槛会把会话日志刷爆。
        if (changed) {
            NativeEventHub.emit(
                "diag",
                "state=$state active=${session?.isActive} playing=$playing"
            )
        }
    }

    private fun startForegroundCompat() {
        if (!foreground) {
            val n = buildNotification()
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(FOREGROUND_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                } else {
                    startForeground(FOREGROUND_ID, n)
                }
                foreground = true
            } catch (e: Exception) {
                // Android 12+ 后台启动限制：降级为普通通知
                Log.w("PlaybackService", "startForeground failed: ${e.message}")
                notifyQuiet(n)
            }
            return
        }
        refreshNotification()
    }

    private fun refreshNotification() {
        val key = "${title}|${subtitle}|${playing}|${cover?.hashCode()}"
        if (key == lastNotificationKey) return
        lastNotificationKey = key
        notifyQuiet(buildNotification())
    }

    private fun notifyQuiet(n: Notification) {
        try {
            getSystemService(NotificationManager::class.java).notify(FOREGROUND_ID, n)
        } catch (_: Exception) {
        }
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pi)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            // CATEGORY_TRANSPORT 是媒体通知的正式分类：部分车机/ROM 只把带这个分类的
            // MediaStyle 通知识别成"正在播放"，没有它就只在通知栏躺着、状态栏不认。
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        b.setContentTitle(title ?: "Folia")
        b.setContentText(subtitle ?: "")
        cover?.let { b.setLargeIcon(it) }
        val style = androidx.media.app.NotificationCompat.MediaStyle()
            .setMediaSession(session?.sessionToken)
            .setShowActionsInCompactView(0, 1, 2)
        b.setStyle(style)
        b.addAction(android.R.drawable.ic_media_previous, "上一曲", servicePi(ACT_PREV))
        if (playing) {
            b.addAction(android.R.drawable.ic_media_pause, "暂停", servicePi(ACT_PLAYPAUSE))
        } else {
            b.addAction(android.R.drawable.ic_media_play, "播放", servicePi(ACT_PLAYPAUSE))
        }
        b.addAction(android.R.drawable.ic_media_next, "下一曲", servicePi(ACT_NEXT))
        return b.build()
    }

    private fun servicePi(action: String): PendingIntent {
        val i = Intent(this, PlaybackService::class.java).apply { this.action = action }
        return PendingIntent.getService(
            this, action.hashCode(), i,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    override fun onDestroy() {
        isRunning = false
        isPlayingNow = false
        try { focus?.abandon() } catch (_: Exception) {}
        session?.let { s ->
            try { s.isActive = false } catch (_: Exception) {}
            try { s.release() } catch (_: Exception) {}
        }
        session = null
        foreground = false
        super.onDestroy()
    }
}
