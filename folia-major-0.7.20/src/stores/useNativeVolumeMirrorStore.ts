// src/stores/useNativeVolumeMirrorStore.ts
// 原生安卓壳：系统媒体音量（STREAM_MUSIC）镜像状态 + 音量能力。
//
// 普通机型：音量由 Android 在输出端控制（MediaSession.setPlaybackToLocal(STREAM_MUSIC)），
// 壳层用 ContentObserver 监听音量变化并推送 ns='system' method='volume'；前端把它写进这里，
// 音量条就跟着车机旋钮走。
//
// 注意：**不要**把这个值再写进 gainNode。系统已经按 STREAM_MUSIC 缩放了一次，
// 网页再乘一次等于音量被平方（车机 50% 只剩 25%），听感就是"偏小/不跟随"。
//
// 固定音量机型（比亚迪 DiLink 等）：AudioManager.isVolumeFixed() 为 true，系统音量接口是空转的，
// 硬件增益由 CarAudioService 全权接管、APP 改不了。此时 fixedVolume=true，音量条改为写
// 应用内增益（gainNode），这是唯一能压低响度的途径。

import { create } from 'zustand';

interface NativeVolumeMirrorState {
    /** 最近一次回读的系统媒体音量（0..1）；null=尚未读到。 */
    systemVolume: number | null;
    setSystemVolumeMirror: (value: number) => void;
    /** 系统音量是否固定（null=尚未探测）。固定时音量条走应用内软件增益。 */
    fixedVolume: boolean | null;
    setFixedVolume: (fixed: boolean) => void;
}

export const useNativeVolumeMirrorStore = create<NativeVolumeMirrorState>((set) => ({
    systemVolume: null,
    setSystemVolumeMirror: (value) => set({ systemVolume: value }),
    fixedVolume: null,
    setFixedVolume: (fixed) => set({ fixedVolume: fixed }),
}));
