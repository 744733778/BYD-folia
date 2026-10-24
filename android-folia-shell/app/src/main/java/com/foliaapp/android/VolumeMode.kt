package com.foliaapp.android

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * STREAM_MUSIC 到底能不能真的改响度。
 *
 * 判定口径**照 APlayer（remix.myplayer）**：它在这台车机上音量正常，而它对音量**什么都没做**——
 * 不判品牌、不判 automotive、不判 UiMode，默认 local 会话、无 VolumeProvider、不拦音量键，
 * 用户音量就是系统媒体音量（STREAM_MUSIC），滑杆直接读写它。
 *
 * 所以这里也**只问 Android 官方答案**：`AudioManager.isVolumeFixed`。
 * - true  = 这台机器的系统音量真的改不动 → 网页层必须自己接管（软件增益），否则完全没音量控制；
 * - false = 系统音量可写 → 网页层让位，响度交给系统（APlayer 的做法）。
 *
 * 之前那套「比亚迪/DiLink/UiMode=CAR/automotive 一律 fixed」的白名单是自己发明的车机特判：
 * 它把车机一律判成 fixed，网页层改用软件增益写 WebAudio 增益节点——而车机音量联动只认
 * 标准媒体通路，音频被 WebAudio 捕获后功放根本不跟随，于是滚轮怎么拧都没反应
 * （0.1.21~0.1.27 车机实测：事件到、判定对、档位跟手，响度不变）。
 * 现在按 APlayer 的口径：能写就写，网页让位。
 *
 * 唯一保留的额外信号是 `isVolumeFixed` 本身——APlayer 不需要它，是因为它没有网页层；
 * 网页层需要知道自己该不该让位，否则遇到真固定音量机型就只能哑着。
 */
object VolumeMode {

    const val FIXED = "fixed"
    const val ADJUSTABLE = "adjustable"

    @Volatile
    private var cached: String? = null

    fun resolve(context: Context): String {
        cached?.let { return it }
        // 调试钩子：`adb shell setprop debug.folia.fixedvolume 1` 强制按固定音量处理（进程重启生效）。
        // 作用是把「网页自己管音量」那条路搬到模拟器/可调机型上验证，免得每次都要装车才知道
        // 对方的滚轮接不接得上。正式包不设这个属性时完全无副作用。
        //
        // 0.1.22 车机实测教训：SystemProperties.get(key) 的**单参版本对未设置的键返回 ""**
        // 而不是 null，于是 `?.let` 恒成立、forced="" → 判成 ADJUSTABLE——所有判定都沦为死代码。
        // 必须把空白串视为"未设置"，钩子只在属性真的有值时才生效。
        readSystemProperty("debug.folia.fixedvolume")
            ?.takeIf { it.isNotBlank() }
            ?.let { forced ->
                val mode = if (forced == "1" || forced.equals("true", ignoreCase = true)) FIXED else ADJUSTABLE
                Log.d(TAG, "resolved=$mode (debug.folia.fixedvolume=$forced)")
                cached = mode
                return mode
            }
        val mode = try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (am.isVolumeFixed) {
                Log.d(TAG, "resolved=$FIXED (AudioManager.isVolumeFixed)")
                FIXED
            } else {
                // 系统音量写得进去 → 交给系统（APlayer 的做法）。网页层不该在这时候插手。
                Log.d(TAG, "resolved=$ADJUSTABLE (AudioManager.isVolumeFixed=false)")
                ADJUSTABLE
            }
        } catch (e: Exception) {
            Log.w(TAG, "probe failed, assume fixed: ${e.message}")
            FIXED
        }
        cached = mode
        Log.d(TAG, "resolved=$mode; device=${deviceTag()}")
        return mode
    }

    fun isFixed(context: Context): Boolean = resolve(context) == FIXED

    /**
     * 一行可读的诊断串，推给页面的会话日志。
     *
     * 车机上既没有 logcat 也没有 adb，这些判定值只能从应用里读出来拍照。
     * 有它就能分清"我们判成了可调、网页层让位给系统"和"判成固定、网页自己接管音量"。
     */
    fun describe(context: Context): String {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val streamMax = am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: -1
        val streamNow = am?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: -1
        return "mode=${resolve(context)} isVolumeFixed=${am?.isVolumeFixed} " +
            "streamMax=$streamMax streamVolume=$streamNow " +
            "sdk=${Build.VERSION.SDK_INT} device=${deviceTag()}"
    }

    private fun deviceTag(): String =
        listOf(Build.MANUFACTURER, Build.BRAND, Build.MODEL, Build.DEVICE, Build.PRODUCT)
            .joinToString(" ")
            .lowercase()

    /** 读 `debug.*` 系统属性（隐藏 API 反射）。注意：未设置时单参 get 返回 ""，由调用方 takeIf 过滤。 */
    private fun readSystemProperty(key: String): String? = try {
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, key) as? String
    } catch (_: Exception) {
        null
    }

    private const val TAG = "VolumeMode"
}
