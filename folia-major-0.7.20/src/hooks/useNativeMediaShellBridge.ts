// src/hooks/useNativeMediaShellBridge.ts
// 安卓壳层 MediaSession / AudioFocus 配套前端桥：
//   ① 上报播放状态（切歌/播放/暂停/seek 即时 + 播放中 ~1s 节流）→ window.foliaBridge.reportMediaState
//      → 壳层 content.js 转发 ns 'media' method 'state' → 驱动 MediaSessionCompat/前台服务/AudioFocus。
//   ② seek 下行（method 'seek'，payload=毫秒位置）→ 复用既有 seekRef（与 W3C 'seekto' 同一函数）。
//   ③ AudioFocus duck/unduck（method 'focus'，payload 'duck'/'unduck'）→ 瞬时把 audio.volume 降到 0.2 /
//      恢复 1.0。不进 store、不持久化；原生模式 store.volume 恒 1，故直接写 element volume 即为最终增益。
// 非原生环境：window.foliaBridge 不存在 → report 静默 no-op；系统事件只有壳层会推，无副作用。

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../types';
import type { SongResult } from '../types';
import { getSongAlbumLabel, getSongArtistLabel } from '../services/onlineMusic/songMetadata';
import {
    onNativeSystemEvent,
    reportFoliaMediaState,
} from '../services/foliaExtensionBridge';

type NativeMediaShellBridgeOptions = {
    audioRef: RefObject<HTMLAudioElement | null>;
    /** 当前显示曲目（与 useMediaSessionBridge 的 displaySong 同源）。 */
    currentSong: SongResult | null;
    playerState: PlayerState;
    /** 既有 seek 入口（秒）；W3C 'seekto' 与原生 method 'seek' 共用，防两套 seek 漂移。 */
    seekRef: RefObject<((timeSec: number) => void) | null>;
    unknownArtistLabel: string;
    /**
     * duck/unduck 的增益出口。音频走 WebAudio graph 后 element.volume 不一定再生效，
     * 所以优先写 gainNode（App.syncOutputGain）；不传才退回写 element.volume。
     */
    setDuckLevel?: (ducked: boolean) => void;
    /**
     * 方向盘/车机音量键。固定音量车机上 STREAM_MUSIC 是死的，音量键事件只能由应用自己接住
     * 改软件音量；壳层把 VOLUME_UP/DOWN 与 MediaSession 的 remote volume 都推成 'volumeKey'。
     */
    onVolumeKey?: (delta: number) => void;
    /** 车机音量面板给出的绝对档位（0..1）；固定音量机型上它就是唯一能到达应用的一路。 */
    onVolumeSet?: (level: number) => void;
    /**
     * 当前应用内音量档位（0..1，静音时为 0）。上报给壳层同步 MediaSession 的 remote volume：
     * 车机滚轮/音量条按"当前档位 ± 一档"工作，不同步的话转一下就从旧档位跳走。
     */
    volume?: number;
};

const DUCK_VOLUME = 0.2;
const NORMAL_VOLUME = 1.0;
const REPORT_INTERVAL_MS = 1000;

export const useNativeMediaShellBridge = ({
    audioRef,
    currentSong,
    playerState,
    seekRef,
    unknownArtistLabel,
    setDuckLevel,
    onVolumeKey,
    onVolumeSet,
    volume = 1,
}: NativeMediaShellBridgeOptions) => {
    // duck 状态：瞬时增益乘数，不写 store。切歌后新 element 由 syncOutputGain 写 1（原生 store 恒 1），
    // duck 态丢失可接受（导航语音 duck 窗口很短；unduck 恢复时直接写 1 与默认一致）。
    const duckRef = useRef(false);

    // 取当前显示 element（与 MediaSession bridge 一致：优先 blend 的 tail element）。
    const report = () => {
        const audio = audioRef.current;
        // 档位一起上报：壳层用它同步 remote volume 的 currentVolume（车机音量条/滚轮的基准）。
        const level = Math.min(1, Math.max(0, volume));
        if (!currentSong) {
            reportFoliaMediaState({
                title: null, artist: null, album: null,
                durationMs: null, positionMs: null, playing: false, contentUri: null,
                volume: level,
            });
            return;
        }
        const durationSec = audio && Number.isFinite(audio.duration) ? audio.duration : undefined;
        const positionSec = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : undefined;
        // 本地曲目条目可能带 contentUri（SAF），在线曲目无此字段。
        const contentUri = (currentSong as SongResult & { contentUri?: string | null }).contentUri ?? null;
        reportFoliaMediaState({
            title: currentSong.name ?? null,
            artist: getSongArtistLabel(currentSong) || unknownArtistLabel,
            album: getSongAlbumLabel(currentSong) || null,
            durationMs: durationSec !== undefined ? Math.round(durationSec * 1000) : null,
            positionMs: positionSec !== undefined ? Math.round(positionSec * 1000) : null,
            playing: playerState === PlayerState.PLAYING,
            contentUri,
            volume: level,
        });
    };

    // 切歌/播放/暂停/音量变化即时上报。
    useEffect(() => {
        report();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentSong, playerState, volume]);

    // 播放中 ~1s 节流上报进度（壳层 setPlaybackState 需要 position 滚动）。
    useEffect(() => {
        if (playerState !== PlayerState.PLAYING) return;
        const timer = window.setInterval(report, REPORT_INTERVAL_MS);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playerState, currentSong, volume]);

    // 原生下行事件：seek（毫秒）+ focus duck/unduck。
    useEffect(() => onNativeSystemEvent((method, payload) => {
        if (method === 'seek') {
            const ms = typeof payload === 'number' ? payload : Number(payload);
            if (Number.isFinite(ms) && seekRef.current) {
                seekRef.current(ms / 1000);
                report();
            }
            return;
        }
        if (method === 'volumeKey') {
            const raw = String(payload);
            if (raw.startsWith('set:')) {
                const level = Number(raw.slice(4)) / 100;
                if (Number.isFinite(level)) onVolumeSet?.(Math.min(1, Math.max(0, level)));
                return;
            }
            const delta = raw === 'up' ? 0.05 : raw === 'down' ? -0.05 : Number(raw);
            if (Number.isFinite(delta) && delta !== 0) onVolumeKey?.(delta);
            return;
        }
        if (method === 'focus') {
            const audio = audioRef.current;
            if (payload === 'duck') {
                duckRef.current = true;
                if (setDuckLevel) setDuckLevel(true);
                else if (audio) audio.volume = DUCK_VOLUME;
            } else if (payload === 'unduck') {
                duckRef.current = false;
                if (setDuckLevel) setDuckLevel(false);
                else if (audio) audio.volume = NORMAL_VOLUME;
            }
        }
    }), [audioRef, onVolumeKey, onVolumeSet, seekRef, setDuckLevel]);
};
