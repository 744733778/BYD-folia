package com.foliaapp.android

import android.view.KeyEvent

/**
 * 媒体键 → 前端动作的**唯一**映射表。
 *
 * 车机上的媒体键有三条可能的到达路径：Activity 的 dispatchKeyEvent（前台时系统仍把
 * KeyEvent 给焦点窗口）、MediaSession 的会话回调、以及 MEDIA_BUTTON 广播。
 * 以前三处各写一份 when，改一处漏两处；现在统一走这里，行为不会再分叉。
 */
object MediaKeys {

    fun actionOf(keyCode: Int): String? = when (keyCode) {
        KeyEvent.KEYCODE_MEDIA_NEXT,
        KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD,
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "next"

        KeyEvent.KEYCODE_MEDIA_PREVIOUS,
        KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD,
        KeyEvent.KEYCODE_MEDIA_REWIND -> "prev"

        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_HEADSETHOOK -> "playpause"

        KeyEvent.KEYCODE_MEDIA_PLAY -> "play"

        KeyEvent.KEYCODE_MEDIA_PAUSE,
        KeyEvent.KEYCODE_MEDIA_STOP -> "pause"

        else -> null
    }

    /**
     * @return true 表示这是媒体键且已转给前端（调用方应消费掉该事件）。
     *
     * 只认 ACTION_DOWN：车机常把同一个键同时按「按下 + 抬起」送两遍，
     * 只处理 DOWN 才能避免一次按键跳两首。
     */
    fun handle(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return false
        val action = actionOf(event.keyCode) ?: return false
        NativeEventHub.emit("mediaKey", action)
        return true
    }
}
