// src/services/userVolume.ts
//
// 用户音量的**统一写入口**（照 APlayer 的模型）。
//
// APlayer（remix.myplayer）在同一台车机上音量正常，而它对音量**什么都没做**：用户音量就是
// 系统媒体音量（STREAM_MUSIC）——滑杆直接读写它，播放器自己的音量（ExoPlayer.volume）只用于
// 淡入淡出与 duck。folia 现在照同一个模型来：
//
// - 系统音量说话时（车机滚轮/音量键/系统 UI 都作用在 STREAM_MUSIC 上）：写系统媒体音量，
//   网页增益恒 1 —— 谁在动都作用在功放上；
// - 系统音量真改不动（AudioManager.isVolumeFixed=true）或用户手动选软件增益时：写应用内档位。
//
// 所有音量控件（设置面板、控制栏、播放页、音乐墙工具、命令面板、方向盘音量键）都从这里写，
// 免得出现"某个滑杆在系统音量模式下拖了没反应"——那正是两套音量系统并存时最容易漏的一角。

import { isNativeAndroidShell, setSystemVolume } from './foliaExtensionBridge';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { useNativeVolumeMirrorStore } from '../stores/useNativeVolumeMirrorStore';
import { systemVolumeGoverns } from '../utils/nativeVolumeMode';

/**
 * 系统音量是否在管这件事。
 *
 * 读的是镜像 store 的实时值，不是渲染时的快照：滚轮刚动过、探测刚翻转时，写入目标必须
 * 跟着一起变，否则会出现"滑杆写系统音量、增益也在写"这种双重调节。
 */
export const systemVolumeOwnsOutput = (): boolean => {
    if (!isNativeAndroidShell()) return false;
    const mirror = useNativeVolumeMirrorStore.getState();
    return systemVolumeGoverns(mirror.fixedVolume, mirror.systemVolume);
};

/** 系统音量写入的最小间隔：拖动时别把 AudioService 写爆。 */
const MIN_SYSTEM_WRITE_GAP_MS = 60;
let lastSystemWriteAt = 0;

/**
 * 写用户音量到真正生效的那一层。
 *
 * `force` 跳过节流：提交时用（拖动过程的预览已经写过一串近似值，提交要落到最终值）。
 */
export const writeUserVolume = (level: number, options: { force?: boolean } = {}): void => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
    const settings = useAudioSettingsStore.getState();
    if (systemVolumeOwnsOutput()) {
        const now = Date.now();
        if (options.force || now - lastSystemWriteAt >= MIN_SYSTEM_WRITE_GAP_MS) {
            lastSystemWriteAt = now;
            void setSystemVolume(clamped);
        }
        // 界面数字也跟着走：滑杆、播放页、音乐墙工具、命令面板读的都是 store 里的这个值，
        // 系统音量模式下它就是系统音量的镜像（原生侧的 volume 事件也会同步它）。
        settings.handleSetVolume(clamped);
        return;
    }
    settings.handleSetVolume(clamped);
};
