package com.foliaapp.android

/**
 * 进程内事件泵：MediaSession / AudioFocus 现在活在 [PlaybackService] 里，而网页桥只在
 * Activity 里。Service 通过这里把媒体键、焦点事件交给"当前" Activity 推给页面，
 * 两边不互相持有引用（Activity 销毁后 sink 自动为空，事件丢弃即可）。
 */
object NativeEventHub {

    /** Activity 在前台/存活时注册；内部已做 400ms 同键去重。 */
    @Volatile
    var sink: ((method: String, payload: String) -> Unit)? = null

    fun emit(method: String, payload: String) {
        try {
            sink?.invoke(method, payload)
        } catch (_: Exception) {
        }
    }
}
