// src/utils/nativeVolumeMode.ts
//
// 原生安卓壳「音量归谁管」的唯一决策点。App.syncOutputGain / duck 层级与
// usePlaybackAudioBridge 都必须经过这里，两边判据不一致就会一个钉死、一个照调。
//
// 背景（车机实测教训，0.1.21）：
// - getVolumeMode() 返回 null 有两种常见原因：车机上 GeckoView 的 WebExtension 是
//   **持久化**的，旧版扩展根本没有 getVolumeMode 方法（manifest 1.0 时代）；以及冷启动
//   时原生端口尚未连上、3s 超时。旧代码把 null 当成 adjustable **主动写进**镜像，
//   于是 systemGoverns 成立 → 网页增益被钉死成 1 → 滑竿全死；而车机的 STREAM_MUSIC
//   只是被 AudioService 缓存、功放根本不听（假可调）→ 实体按键也死 → 恒定最大声。
// - 所以：null = 未知 = 网页层继续管（宁可小声也不要满功率），绝不写成 adjustable。

import { getVolumeMode, isNativeAndroidShell } from '../services/foliaExtensionBridge';

/** 用户覆盖项：auto=按探测，fixed=强制软件增益，system=强制交给系统。 */
export type VolumeModeOverride = 'auto' | 'fixed' | 'system';

const OVERRIDE_KEY = 'folia_volume_mode';

const readOverride = (): VolumeModeOverride => {
    if (typeof window === 'undefined') return 'auto';
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return raw === 'fixed' || raw === 'system' ? raw : 'auto';
};

let currentOverride: VolumeModeOverride = readOverride();
const overrideListeners = new Set<() => void>();

export const getVolumeModeOverride = (): VolumeModeOverride => currentOverride;

export const setVolumeModeOverride = (mode: VolumeModeOverride): void => {
    currentOverride = mode;
    try {
        if (mode === 'auto') window.localStorage.removeItem(OVERRIDE_KEY);
        else window.localStorage.setItem(OVERRIDE_KEY, mode);
    } catch {
        // 隐私模式等存储不可用：仅本进程生效，下次启动退回 auto。
    }
    overrideListeners.forEach(listener => listener());
};

export const subscribeVolumeModeOverride = (listener: () => void): (() => void) => {
    overrideListeners.add(listener);
    return () => {
        overrideListeners.delete(listener);
    };
};

/**
 * 系统媒体音量是否真的在缩放声音（而非 DiLink 那种"写得进、回读得出、功放不动"的假可调）。
 *
 * 判据必须是"原生壳 + 探测说可调 + 实测档位低于满档"三件同时成立：只看 probe 会在 DiLink 上
 * 假通过，把网页增益钉死成 1，表现为永远最大声。
 *
 * 覆盖项优先于一切探测：车机上没有 adb，探测误判时这是用户唯一的自救入口。
 */
export const systemVolumeGoverns = (
    fixedVolume: boolean | null,
    systemVolume: number | null,
): boolean => {
    if (!isNativeAndroidShell()) return false;
    const override = currentOverride;
    if (override === 'fixed') return false;
    if (override === 'system') return true;
    return fixedVolume === false
        && systemVolume !== null
        && systemVolume < 0.999;
};

/**
 * 解析原生音量模式。
 *
 * 返回 true=fixed（网页软件增益），false=adjustable（交给系统），null=未知（网页层继续管）。
 * null 的处理是本次修复的核心：调用方**不得**把它折算成 false 写进镜像。
 *
 * 重试而非一次定音：冷启动时扩展 shim / 原生端口可能没就绪，旧版持久扩展甚至没有
 * getVolumeMode 方法，一次失败不能把模式钉成 adjustable。
 */
export const resolveNativeVolumeMode = async (
    attempts = 5,
    gapMs = 600,
): Promise<boolean | null> => {
    const override = currentOverride;
    if (override === 'fixed') return true;
    if (override === 'system') return false;
    for (let i = 0; i < attempts; i += 1) {
        const mode = await getVolumeMode();
        if (mode === 'fixed') return true;
        if (mode === 'adjustable') return false;
        await new Promise<void>(resolve => { setTimeout(resolve, gapMs); });
    }
    return null;
};
