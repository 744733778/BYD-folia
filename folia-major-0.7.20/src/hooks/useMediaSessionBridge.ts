import { useEffect } from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../types';
import type { SongResult } from '../types';
import { onNativeMediaKey } from '../services/foliaExtensionBridge';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';
import {
    getSupportedMediaSessionArtworkUrl,
    isMediaSessionSourceReady,
    publishMediaSessionTrack,
} from '../utils/mediaSessionSync';

// Bridges Folia playback state to the browser Media Session API.
type UseMediaSessionBridgeOptions = {
    audioRef: RefObject<HTMLAudioElement | null>;
    /**
     * The deck the displayed track is playing on, or null when the picture is live.
     *
     * Metadata, clock and source have to describe the same deck. `currentSong` is already the
     * DISPLAYED track - the outgoing one for the length of a blend - while `audioRef` names the
     * active deck, which by then is the arriving track. Publishing the two together put the outgoing
     * track's title on the incoming track's duration and position, so the system panel showed one
     * song's name over another song's progress. `audioSrc` is passed to match this element.
     */
    getDisplayAudioElement?: () => HTMLAudioElement | null;
    audioSrc: string | null;
    currentSong: SongResult | null;
    cachedCoverUrl: string | null;
    playerState: PlayerState;
    isNowPlayingStageActive: boolean;
    unknownArtistLabel: string;
    mediaSessionPlayRef: RefObject<() => Promise<void>>;
    mediaSessionPauseRef: RefObject<() => void>;
    mediaSessionPrevRef: RefObject<() => void>;
    mediaSessionNextRef: RefObject<() => Promise<void> | void>;
    /** seek 入口（秒）；原生壳层 method 'seek' 复用同一函数，防两套 seek 漂移。 */
    mediaSessionSeekRef: RefObject<((timeSec: number) => void) | null>;
    isNowPlayingControlDisabledRef: RefObject<boolean>;
};

export const useMediaSessionBridge = ({
    audioRef,
    getDisplayAudioElement,
    audioSrc,
    currentSong,
    cachedCoverUrl,
    playerState,
    isNowPlayingStageActive,
    unknownArtistLabel,
    mediaSessionPlayRef,
    mediaSessionPauseRef,
    mediaSessionPrevRef,
    mediaSessionNextRef,
    mediaSessionSeekRef,
    isNowPlayingControlDisabledRef,
}: UseMediaSessionBridgeOptions) => {
    useEffect(() => {
        if (!('mediaSession' in navigator)) {
            return;
        }

        const mediaSession = navigator.mediaSession;
        const setActionHandlerSafely = (
            action: MediaSessionAction,
            handler: MediaSessionActionHandler | null
        ) => {
            try {
                mediaSession.setActionHandler(action, handler);
            } catch (e) {
                console.warn(`[MediaSession] Failed to bind ${action} handler`, e);
            }
        };

        setActionHandlerSafely('play', async () => {
            if (isNowPlayingControlDisabledRef.current || !audioRef.current) {
                return;
            }

            try {
                await mediaSessionPlayRef.current();
            } catch (e) {
                console.error('MediaSession play failed', e);
            }
        });
        setActionHandlerSafely('pause', () => {
            if (isNowPlayingControlDisabledRef.current || !audioRef.current) {
                return;
            }

            mediaSessionPauseRef.current();
        });
        setActionHandlerSafely('previoustrack', () => {
            if (isNowPlayingControlDisabledRef.current) {
                return;
            }
            mediaSessionPrevRef.current();
        });
        setActionHandlerSafely('nexttrack', () => {
            if (isNowPlayingControlDisabledRef.current) {
                return;
            }
            void mediaSessionNextRef.current();
        });
        // 车机/蓝牙线控进度条拖动 → seek。GeckoView 是否把 W3C MediaSession seekto 桥到系统
        // MediaSessionCompat.onSeekTo 未实测；不可达时壳层走 method 'seek' 原生下行（同一 seekRef）。
        setActionHandlerSafely('seekto', (details) => {
            if (isNowPlayingControlDisabledRef.current) {
                return;
            }
            const target = details.seekTime;
            if (typeof target === 'number' && Number.isFinite(target) && mediaSessionSeekRef.current) {
                mediaSessionSeekRef.current(target);
            }
        });

        return () => {
            setActionHandlerSafely('play', null);
            setActionHandlerSafely('pause', null);
            setActionHandlerSafely('previoustrack', null);
            setActionHandlerSafely('nexttrack', null);
            setActionHandlerSafely('seekto', null);
        };
    }, [audioRef, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, mediaSessionSeekRef]);

    useEffect(() => {
        if (!('mediaSession' in navigator)) {
            return;
        }

        if (!currentSong) {
            try {
                navigator.mediaSession.setPositionState();
                navigator.mediaSession.metadata = null;
            } catch (e) {
                console.warn('[MediaSession] Failed to clear metadata', e);
            }
            return;
        }

        // The displayed track's own deck, so the position published below belongs to the title
        // published beside it. Falls back to the active deck whenever no blend is holding a picture.
        const audio = getDisplayAudioElement?.() ?? audioRef.current;
        if (!audio || !audioSrc) {
            return;
        }

        let disposed = false;
        const sourceArtworkUrl = cachedCoverUrl || getSongCoverUrl(currentSong) || '';
        let artworkUrl = getSupportedMediaSessionArtworkUrl(sourceArtworkUrl, document.baseURI);
        let disposableArtworkUrl: string | null = null;
        const publish = () => {
            if (disposed || !isMediaSessionSourceReady(audio, audioSrc, document.baseURI)) {
                return;
            }

            try {
                publishMediaSessionTrack(navigator.mediaSession, audio, {
                    title: currentSong.name,
                    artist: getSongArtistLabel(currentSong) || unknownArtistLabel,
                    album: getSongAlbumLabel(currentSong),
                    artworkUrl,
                });
            } catch (e) {
                console.warn('[MediaSession] Failed to update metadata', e);
            }
        };

        // MediaMetadata rejects Electron's custom protocol, so expose that image through a
        // short-lived blob URL while this track owns the platform media session.
        const prepareUnsupportedArtwork = async () => {
            if (!sourceArtworkUrl || artworkUrl) return;

            try {
                const response = await fetch(sourceArtworkUrl);
                if (!response.ok) throw new Error(`Artwork request failed: ${response.status}`);
                const artworkBlob = await response.blob();
                if (artworkBlob.size <= 0 || !artworkBlob.type.startsWith('image/')) {
                    throw new Error('Artwork response is not a valid image');
                }

                const objectUrl = URL.createObjectURL(artworkBlob);
                if (disposed) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }
                disposableArtworkUrl = objectUrl;
                artworkUrl = objectUrl;
                publish();
            } catch (e) {
                if (!disposed) console.warn('[MediaSession] Failed to prepare artwork', e);
            }
        };

        audio.addEventListener('loadedmetadata', publish);
        audio.addEventListener('durationchange', publish);
        // Re-publish after playback starts in case Chromium delivered a late clear from the old source.
        audio.addEventListener('playing', publish);
        publish();
        void prepareUnsupportedArtwork();

        return () => {
            disposed = true;
            audio.removeEventListener('loadedmetadata', publish);
            audio.removeEventListener('durationchange', publish);
            audio.removeEventListener('playing', publish);
            if (disposableArtworkUrl) URL.revokeObjectURL(disposableArtworkUrl);
        };
    }, [audioRef, audioSrc, cachedCoverUrl, currentSong, getDisplayAudioElement, unknownArtistLabel]);

    useEffect(() => {
        if (!('mediaSession' in navigator)) {
            return;
        }

        try {
            navigator.mediaSession.playbackState = isNowPlayingStageActive
                ? 'none'
                : currentSong
                    ? (playerState === PlayerState.PLAYING ? 'playing' : 'paused')
                    : 'none';
        } catch (e) {
            console.warn('[MediaSession] Failed to update playback state', e);
        }

        // setPositionState 滚动进度（W3C 面板/蓝牙 AVRCP 进度条）；GeckoView 是否桥到系统待车机验证。
        const pushPosition = () => {
            const audio = getDisplayAudioElement?.() ?? audioRef.current;
            if (!audio || !Number.isFinite(audio.duration) || !Number.isFinite(audio.currentTime)) {
                return;
            }
            try {
                navigator.mediaSession.setPositionState({
                    duration: audio.duration,
                    position: Math.min(audio.currentTime, audio.duration),
                    playbackRate: audio.playbackRate || 1,
                });
            } catch {
                // 忽略：老浏览器/GeckoView 不支持时静默。
            }
        };
        if (playerState === PlayerState.PLAYING && !isNowPlayingStageActive && currentSong) {
            pushPosition();
            const timer = window.setInterval(pushPosition, 1000);
            return () => window.clearInterval(timer);
        }
        return undefined;
    }, [audioRef, currentSong, getDisplayAudioElement, isNowPlayingStageActive, playerState]);

    // 原生壳物理媒体键（方向盘/车机面板/蓝牙线控）。壳层把 KeyEvent / MediaSession 回调统一
    // 压成 ns='system' method='mediaKey' 推上来，这里分发到与 W3C MediaSession 完全相同的 ref —
    // 两套入口一个实现，不会出现"通知栏能暂停、方向盘不能"或"playpause 被当成上一曲"。
    // 注意这里不看 isNowPlayingControlDisabled：车机方向盘是唯一的物理传输控制，用户停在
    // 全屏歌词舞台时也必须能切歌/暂停——曾经在这里早退，舞台上按上下曲整组失灵
    // （事件日志全都到了，歌就是不动，见 2026-10-19 排查）。
    useEffect(() => onNativeMediaKey((key) => {
        switch (key) {
            case 'next':
                void mediaSessionNextRef.current();
                break;
            case 'prev':
                mediaSessionPrevRef.current();
                break;
            case 'play':
                void mediaSessionPlayRef.current().catch(() => undefined);
                break;
            case 'pause':
                mediaSessionPauseRef.current();
                break;
            case 'playpause':
                if (playerState === PlayerState.PLAYING) mediaSessionPauseRef.current();
                else void mediaSessionPlayRef.current().catch(() => undefined);
                break;
            default:
                break;
        }
    }), [isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, playerState]);
};
