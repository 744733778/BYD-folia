// src/utils/audioVolumeCurve.ts
//
// 音量滑杆档位 → 输出增益（等响感知曲线）。
//
// 滑杆本身是 0..1 的"档位"（UI 上的百分比就是它），但 gainNode / element.volume 吃的是
// 线性振幅，而人耳对响度的感知接近对数。以前把档位直接当振幅写进去，车机上 20% 的听感
// 就比别家播放器 50% 还响——衰减 14dB 在耳朵里远不是"降到两成"。
//
// 这里把档位映射成 40dB 动态范围的振幅：
//   0%   → 0（静音）
//   50%  → 10^(-1) ≈ 0.10（-20dB）
//   100% → 1.0（0dB，满功率不缩水）
// 50% 落在 -20dB 附近，与 Android 系统媒体音量滑杆的听感基本对齐。百分比数字仍是线性档位，
// UI 语义不变；变的只是它落到音频图上时的那条曲线。

/** 滑杆满量程对应的动态范围（dB）。40dB ≈ 系统媒体音量 0..max 的典型落差。 */
export const VOLUME_CURVE_DB = 40;

/** 档位（0..1）→ 线性振幅增益（0..1）。 */
export const levelToOutputGain = (level: number): number => {
    const clamped = Math.min(1, Math.max(0, level));
    if (clamped <= 0) return 0;
    if (clamped >= 1) return 1;
    return Math.pow(10, ((clamped - 1) * VOLUME_CURVE_DB) / 20);
};

/** 线性振幅增益（0..1）→ 档位（0..1）。反向换算，用于把原生侧读到的增益折回滑杆。 */
export const outputGainToLevel = (gain: number): number => {
    const clamped = Math.min(1, Math.max(0, gain));
    if (clamped <= 0) return 0;
    if (clamped >= 1) return 1;
    return 1 + (20 * Math.log10(clamped)) / VOLUME_CURVE_DB;
};
