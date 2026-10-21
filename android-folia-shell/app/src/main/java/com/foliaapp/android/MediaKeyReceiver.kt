package com.foliaapp.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.KeyEvent

/**
 * MEDIA_BUTTON 广播入口：老车机（以及部分车厂的方控适配层）不走会话回调，直接把按键
 * 以普通广播发出来。
 *
 * **不能**用 androidx 的 `androidx.media.session.MediaButtonReceiver`：那个类只是把 Intent
 * 转给 MediaBrowserService 的 onStartCommand，而 `MediaBrowserServiceCompat` 并不会把
 * `ACTION_MEDIA_BUTTON` 当会话事件处理——事件最终落在 onStartCommand 的 when 之外被静默丢弃。
 * 这正是"日志里 keyDiag 和 mediabutton 两条都空"的来源之一。
 *
 * 这里自己解 KeyEvent，只在本应用确实在播时接（否则会在别的播放器放歌时抢键）。
 */
class MediaKeyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MEDIA_BUTTON) return
        val event = extractKeyEvent(intent) ?: return

        // 诊断：这条日志出现，说明车厂走的是广播通路（不是会话回调，也不是窗口 KeyEvent）。
        NativeEventHub.emit(
            "diag",
            "broadcast ${event.keyCode}/${KeyEvent.keyCodeToString(event.keyCode)} action=${event.action}"
        )

        if (!PlaybackService.isPlayingNow) return
        MediaKeys.handle(event)
    }

    private fun extractKeyEvent(intent: Intent): KeyEvent? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
        }
    } catch (_: Exception) {
        null
    }
}
