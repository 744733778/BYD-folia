package com.foliaapp.android

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioManager
import android.app.UiModeManager
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
 * 3. 车机 UI 模式（UiModeManager=CAR）或 Android Automotive 系统特性 → fixed；
 * 4. 其余机型才做写入—回读探测。
 *
 * 第 2、3 条是抄 SaltPlayer（Moriafly/media-kit 的 `MiPlayAudioSupport`）的做法：OEM 差异
 * 靠白名单/身份判定，不指望通用 API 能问出来。身份信号宁可多一路——白名单漏掉的无名车机
 * （Build 字段里既没有品牌、也不是 Automotive 一体机）还有第 3 条兜底；
 * 再漏，前端还有 null=未知时网页层接管的兜底和用户覆盖开关。
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
        //
        // 0.1.22 车机实测教训：SystemProperties.get(key) 的**单参版本对未设置的键返回 ""
        // 而不是 null**，于是 `?.let` 恒成立、forced="" → 判成 ADJUSTABLE——OEM 白名单、
        // UiModeManager、automotive 检测全部沦为死代码，DiLink 上永远走不到 fixed。
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
            when {
                am.isVolumeFixed -> {
                    Log.d(TAG, "resolved=$FIXED (AudioManager.isVolumeFixed)")
                    FIXED
                }
                isCarHeadUnit() -> {
                    Log.d(TAG, "resolved=$FIXED (OEM=${deviceTag()})")
                    FIXED
                }
                isCarUiMode(context) -> {
                    Log.d(TAG, "resolved=$FIXED (UiModeManager=CAR)")
                    FIXED
                }
                hasAutomotiveFeature(context) -> {
                    Log.d(TAG, "resolved=$FIXED (android.hardware.type.automotive)")
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
            "sdk=${Build.VERSION.SDK_INT} device=${deviceTag()} " +
            "uiMode=${uiModeTypeName(context)} automotive=${hasAutomotiveFeature(context)}"
    }

    /** 车机 OEM 身份：命中就不必再信 AudioManager 的自述。 */
    private fun isCarHeadUnit(): Boolean = CAR_BRANDS.any { deviceTag().contains(it) }

    /**
     * 车机 UI 模式（UiModeManager.currentModeType == UI_MODE_TYPE_CAR）。
     * 比品牌白名单更硬的信号：车载桌面/Android Automotive 一体机都会置这个模式，
     * 不依赖 Build 字段里恰好出现某个品牌字符串。
     */
    private fun isCarUiMode(context: Context): Boolean = try {
        val um = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        um?.currentModeType == Configuration.UI_MODE_TYPE_CAR
    } catch (e: Exception) {
        false
    }

    private fun uiModeTypeName(context: Context): String = try {
        when ((context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType) {
            Configuration.UI_MODE_TYPE_CAR -> "car"
            Configuration.UI_MODE_TYPE_DESK -> "desk"
            Configuration.UI_MODE_TYPE_TELEVISION -> "tv"
            Configuration.UI_MODE_TYPE_APPLIANCE -> "appliance"
            Configuration.UI_MODE_TYPE_WATCH -> "watch"
            Configuration.UI_MODE_TYPE_NORMAL -> "normal"
            Configuration.UI_MODE_TYPE_UNDEFINED -> "undefined"
            else -> "?"
        }
    } catch (e: Exception) {
        "?"
    }

    /** Android Automotive 系统特性：命中即为车载设备。 */
    private fun hasAutomotiveFeature(context: Context): Boolean = try {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)
    } catch (e: Exception) {
        false
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
