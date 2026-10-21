package com.foliaapp.android

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * STREAM_MUSIC 到底能不能真的改响度。
 *
 * 这里刻意**不把探测当唯一依据**。`isVolumeFixed` 之外那套"写入—回读"探测在比亚迪 DiLink 上
 * 会假通过：`setStreamVolume` 写进去的值被 AudioService 原样缓存，`getStreamVolume` 也照样
 * 回读得出来，可真实的增益在功放里、APP 根本碰不到。于是应用以为"系统音量可用"，把响度交回系统，
 * 结果是永远最大声、滑杆和方向盘音量键全都无效。
 *
 * 所以判定顺序改成：先看身份，再看能力，最后才用探测兜底。
 * 1. `AudioManager.isVolumeFixed` 明确说固定 → fixed；
 * 2. 车机 OEM（比亚迪/DiLink/腾势…）→ 一律 fixed，不问系统；
 * 3. 其余机型才做写入—回读探测。
 *
 * 第 2 条是抄 SaltPlayer（Moriafly/media-kit 的 `MiPlayAudioSupport`）的做法：OEM 差异
 * 靠白名单/身份判定，不指望通用 API 能问出来。
 */
object VolumeMode {

    const val FIXED = "fixed"
    const val ADJUSTABLE = "adjustable"

    @Volatile
    private var cached: String? = null

    fun resolve(context: Context): String {
        cached?.let { return it }
        // 调试钩子：`adb shell setprop debug.folia.fixedvolume 1` 强制按固定音量处理（进程重启生效）。
        // 作用是把车机那条路（自建软件增益 + 会话 remote volume）搬到模拟器/可调机型上验证，
        // 免得每次都要装车才知道 provider 有没有被回调。正式包不设这个属性时完全无副作用。
        readSystemProperty("debug.folia.fixedvolume")?.let { forced ->
            val mode = if (forced == "1" || forced.equals("true", ignoreCase = true)) FIXED else ADJUSTABLE
            Log.d(TAG, "resolved=$mode (debug.folia.fixedvolume=$forced)")
            cached = mode
            return mode
        }
        val mode = try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            when {
                am.isVolumeFixed -> {
                    Log.d(TAG, "resolved=$FIXED (AudioManager.isVolumeFixed)")
                    FIXED
                }
                isCarHeadUnit() -> {
                    Log.d(TAG, "resolved=$FIXED (OEM=${deviceTag()})")
                    FIXED
                }
                probeWritable(am) -> ADJUSTABLE
                else -> FIXED
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
     * 有它就能分清"我们判成了 fixed 所以自己接管音量"和"判成 adjustable 才把音量交还给系统"。
     */
    fun describe(context: Context): String {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val streamMax = am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: -1
        val streamNow = am?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: -1
        return "mode=${resolve(context)} isVolumeFixed=${am?.isVolumeFixed} " +
            "streamMax=$streamMax streamVolume=$streamNow " +
            "sdk=${Build.VERSION.SDK_INT} device=${deviceTag()}"
    }

    /** 车机 OEM 身份：命中就不必再信 AudioManager 的自述。 */
    private fun isCarHeadUnit(): Boolean = CAR_BRANDS.any { deviceTag().contains(it) }

    private fun deviceTag(): String =
        listOf(Build.MANUFACTURER, Build.BRAND, Build.MODEL, Build.DEVICE, Build.PRODUCT)
            .joinToString(" ")
            .lowercase()

    /** 读 `debug.*` 系统属性（隐藏 API 反射；失败一律当没设）。 */
    private fun readSystemProperty(key: String): String? = try {
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, key) as? String
    } catch (_: Exception) {
        null
    }

    private val CAR_BRANDS = listOf(
        "byd", "dilink", "denza", "腾势", "比亚迪", "xiaodi", "小迪",
        "x-peng", "nio", "geely", "lynkco",
    )

    private fun probeWritable(am: AudioManager): Boolean {
        val stream = AudioManager.STREAM_MUSIC
        val max = am.getStreamMaxVolume(stream)
        // 只有一档的流本来就是不可调的（车载/固定音量设备的典型特征）。
        if (max <= 1) {
            Log.d(TAG, "probe: max=$max <= 1 → not adjustable")
            return false
        }
        val original = am.getStreamVolume(stream)
        val probe = if (original > 0) original - 1 else original + 1
        return try {
            am.setStreamVolume(stream, probe, 0)
            val readBack = am.getStreamVolume(stream)
            Log.d(TAG, "probe: max=$max original=$original probe=$probe readBack=$readBack")
            readBack == probe
        } catch (e: Exception) {
            Log.d(TAG, "probe threw: ${e.message}")
            false
        } finally {
            // 还原：探测不能让用户的车机音量停在别处。
            try {
                am.setStreamVolume(stream, original, 0)
            } catch (_: Exception) {
            }
        }
    }

    private const val TAG = "VolumeMode"
}
