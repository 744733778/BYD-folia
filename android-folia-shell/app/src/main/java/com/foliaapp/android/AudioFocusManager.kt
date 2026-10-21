package com.foliaapp.android

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/**
 * 显式 AudioFocus 四态管理（照 RetroMusicPlayer AudioManagerPlayback 范式）：
 * - GAIN：TRANSIENT 暂停过则自动续播；CAN_DUCK 结束则 unduck；
 * - LOSS_TRANSIENT（来电/导航）：暂停并记录，GAIN 时续播；
 * - LOSS_TRANSIENT_CAN_DUCK：不暂停，推 duck 事件（前端降增益 0.2f）；
 * - LOSS（无界）：暂停，不自动恢复。
 * 播放开始 request、停止 abandon。事件回调给 MainActivity 经桥推前端。
 *
 * 两条容易踩的坑，都在这里补上了：
 * 1. 必须带 `AudioAttributes(USAGE_MEDIA / CONTENT_TYPE_MUSIC)`。不带的话默认是
 *    USAGE_UNKNOWN，部分车机据此判断"这不是媒体应用"，状态栏/媒体面板不认，
 *    媒体键也优先给别的应用。
 * 2. 用 AudioFocusRequest 申请的， abandon 必须用 abandonAudioFocusRequest；
 *    用旧接口 abandon 会留下一条悬空的焦点记录。
 */
class AudioFocusManager(private val context: Context, private val onEvent: (String) -> Unit) {

    companion object {
        const val EVENT_PAUSE = "pause"
        const val EVENT_PLAY = "play"
        const val EVENT_DUCK = "duck"
        const val EVENT_UNDUCK = "unduck"
    }

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var hasFocus = false
    private var transientPaused = false
    private var ducking = false
    /** API 26+ 的焦点请求对象，abandon 时要用同一个。 */
    private var focusRequest: AudioFocusRequest? = null

    val isHeld: Boolean get() = hasFocus

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (ducking) {
                    ducking = false
                    onEvent(EVENT_UNDUCK)
                }
                if (transientPaused) {
                    transientPaused = false
                    onEvent(EVENT_PLAY)
                }
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                hasFocus = false
                // 无界失焦：停止，不自动恢复
                onEvent(EVENT_PAUSE)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                transientPaused = true
                onEvent(EVENT_PAUSE)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                ducking = true
                onEvent(EVENT_DUCK)
            }
        }
    }

    fun request() {
        // 播放中前端每秒上报一次状态，别每次都重建 AudioFocusRequest
        if (hasFocus) return
        try {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(listener)
                    .build()
                focusRequest = req
                am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                requestLegacy()
            }
            hasFocus = granted
            if (hasFocus && ducking) {
                ducking = false
                onEvent(EVENT_UNDUCK)
            }
        } catch (_: Exception) {
        }
    }

    fun abandon() {
        if (!hasFocus) return
        try {
            val req = focusRequest
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && req != null) {
                am.abandonAudioFocusRequest(req)
            } else {
                abandonLegacy()
            }
        } catch (_: Exception) {
        }
        hasFocus = false
        transientPaused = false
        ducking = false
        focusRequest = null
    }

    @Suppress("DEPRECATION")
    private fun requestLegacy(): Boolean =
        am.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) ==
            AudioManager.AUDIOFOCUS_REQUEST_GRANTED

    @Suppress("DEPRECATION")
    private fun abandonLegacy() {
        am.abandonAudioFocus(listener)
    }
}
