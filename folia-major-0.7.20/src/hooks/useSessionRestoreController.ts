import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getFromCache, getLocalSongs } from '../services/db';
import { getLocalLibraryCatalogSnapshot } from '../services/localLibraryEntityRepository';
import { buildLocalQueue } from '../services/playbackAdapters';
import { prefetchNearbySongs } from '../services/prefetchService';
import type { ThemeCacheSongKey } from '../services/themeCache';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { restorePlaybackSourceForSong } from '../components/app/playback/restorePlaybackSource';
import { getPlaybackSongKey, isStagePlaybackSong, normalizePlaybackSongSource } from '../utils/appPlaybackGuards';
import type { LyricData, SongResult, StatusMessage } from '../types';
import type { AudioQualityPreference, MediaId } from '../types/onlineMusic';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { setCurrentSong, setPlayQueue } from '../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { omni } from '../services/onlineMusic/omni';

// src/hooks/useSessionRestoreController.ts

type SetState<T> = Dispatch<SetStateAction<T>>;

type UseSessionRestoreControllerParams = {
    userId?: MediaId;
    blobUrlRef: MutableRefObject<string | null>;
    currentOnlineAudioUrlFetchedAtRef: MutableRefObject<number | null>;
    setLyrics: (nextLyrics: LyricData | null) => void;
    restoreCachedThemeForSong: (songId: ThemeCacheSongKey | SongResult, options?: {
        allowLastUsedFallback?: boolean;
        preserveCurrentOnMiss?: boolean;
    }) => Promise<'legacy' | 'dual' | 'fallback-dual' | 'restored' | 'none'>;
    persistLastPlaybackCache: (song: SongResult | null, queue: SongResult[]) => Promise<void>;
    clearPersistedStagePlaybackCache: () => Promise<void>;
    loadLocalSongs: () => Promise<void>;
    loadLocalPlaylists: () => Promise<void>;
    canRestoreSession?: boolean;
    /**
     * The autoplay intent the audio bridge spends when a source lands. Restore normally leaves it
     * alone so the session comes back paused; the lab switch below is the only thing that arms it.
     */
    shouldAutoPlayRef: MutableRefObject<boolean>;
    /** The playing song's key that recovery and failure handling gate on; restore commits to a song like playSong does. */
    currentSongRef: MutableRefObject<string | number | null>;
    /** Bumped with each commit of the current song (see usePlaybackRuntimeRefs). */
    playbackGenerationRef: MutableRefObject<number>;
    /** 恢复上次进度（秒）；写入后由 onLoadedMetadata seek（差 >1s 才跳，紧恢复不跳）。 */
    pendingResumeTimeRef: MutableRefObject<number | null>;
    /**
     * 上次退出时正在放歌、且开关打开时调用：直接进播放页。
     * 与"播放时是否跳转"的设置无关——用户要求这一种启动场景必须落在播放界面。
     */
    onResumeToPlayer?: () => void;
};

// Restores the main playback session without pushing more boot logic into App.tsx.
export function useSessionRestoreController({
    userId,
    blobUrlRef,
    currentOnlineAudioUrlFetchedAtRef,
    setLyrics,
    restoreCachedThemeForSong,
    persistLastPlaybackCache,
    clearPersistedStagePlaybackCache,
    loadLocalSongs,
    loadLocalPlaylists,
    canRestoreSession = true,
    shouldAutoPlayRef,
    currentSongRef,
    playbackGenerationRef,
    pendingResumeTimeRef,
    onResumeToPlayer,
}: UseSessionRestoreControllerParams) {
    const audioQuality = useAudioSettingsStore(state => state.audioQuality);

    const hasInitializedRef = useRef(false);
    const hasLoadedLocalLibraryRef = useRef(false);

    useEffect(() => {
        if (hasLoadedLocalLibraryRef.current) {
            return;
        }

        hasLoadedLocalLibraryRef.current = true;
        void loadLocalSongs();
        void loadLocalPlaylists();
    }, [loadLocalPlaylists, loadLocalSongs]);

    useEffect(() => {
        if (!canRestoreSession) {
            return;
        }

        if (hasInitializedRef.current) {
            return;
        }
        hasInitializedRef.current = true;

        const restoreSession = async () => {
            try {
                let lastSong = await getFromCache<SongResult>('last_song');
                let lastQueue = await getFromCache<SongResult[]>('last_queue');

                if (lastSong) lastSong = normalizePlaybackSongSource(lastSong);
                if (lastQueue) lastQueue = lastQueue.map(normalizePlaybackSongSource);

                if (isStagePlaybackSong(lastSong) || lastQueue?.some(song => isStagePlaybackSong(song))) {
                    await clearPersistedStagePlaybackCache();
                    return;
                }

                if (!lastSong) {
                    return;
                }

                // Leave unsupported sessions cached for a build that registers their provider.
                if (lastSong.sourceRef?.kind === 'online' && !omni.canPlaySong(lastSong)) return;
                lastQueue = lastQueue?.filter(song => song.sourceRef?.kind !== 'online' || omni.canPlaySong(song)) ?? null;

                const containsLocalSnapshot = [lastSong, ...(lastQueue || [])].some(song => (
                    Boolean((song as any).isLocal)
                    || Boolean((song as any).localRef?.songId)
                    || Boolean((song as any).localData?.id)
                ));
                if (containsLocalSnapshot) {
                    const [localSongs, catalog] = await Promise.all([
                        getLocalSongs(),
                        getLocalLibraryCatalogSnapshot(),
                    ]);
                    const songsById = new Map(localSongs.map(song => [song.id, song]));
                    const rebuild = (cached: SongResult): SongResult | null => {
                        const songId = (cached as any).localRef?.songId || (cached as any).localData?.id;
                        if (!songId) return cached;
                        const localSong = songsById.get(songId);
                        if (!localSong) return null;
                        return buildLocalQueue([localSong], undefined, catalog)[0] || null;
                    };
                    lastSong = rebuild(lastSong);
                    lastQueue = (lastQueue || []).map(rebuild).filter((song): song is SongResult => Boolean(song));
                    if (!lastSong) return;
                    const lastSongKey = getPlaybackSongKey(lastSong);
                    if (!lastQueue.some(song => getPlaybackSongKey(song) === lastSongKey)) {
                        lastQueue.unshift(lastSong);
                    }
                    await persistLastPlaybackCache(lastSong, lastQueue);
                }

                console.log('[Session] Restoring last song:', lastSong.name);
                if (lastSong.sourceRef?.kind === 'online' && lastSong.sourceRef.providerId) {
                    const currentActiveProviderId = useOnlineProviderAccountStore.getState().activeProviderId;
                    if (currentActiveProviderId !== lastSong.sourceRef.providerId) {
                        console.log(`[Session] Aligning active provider to restored song provider: ${lastSong.sourceRef.providerId}`);
                        useOnlineProviderAccountStore.getState().setActiveProviderId(lastSong.sourceRef.providerId);
                    }
                }
                setCurrentSong(lastSong);
                // Left unset, every "is this still the current song" check reads the restored song
                // as already replaced, and its source refresh or failure message is dropped as stale.
                currentSongRef.current = getPlaybackSongKey(lastSong);
                playbackGenerationRef.current += 1;
                setPlayQueue(lastQueue && lastQueue.length > 0 ? lastQueue : [lastSong]);

                // 进度恢复：读 5s 防抖落库的 last_position（毫秒 + 退出时是否在放）。
                // 差 >1s 才 arm seek，紧恢复（杀进程即恢复，误差 <1s）不跳歌——与 Auxio 的恢复策略一致。
                let lastPositionRecord: { ms: number; playing?: boolean } | null = null;
                try {
                    lastPositionRecord = await getFromCache<{ ms: number; playing?: boolean }>('last_position');
                    if (lastPositionRecord && Number.isFinite(lastPositionRecord.ms) && lastPositionRecord.ms > 1000) {
                        pendingResumeTimeRef.current = lastPositionRecord.ms / 1000;
                    }
                } catch {
                    // 进度恢复失败不阻塞会话恢复。
                }

                // Read at restore time rather than subscribed: this effect runs once, and the
                // switch only ever has to answer for this one launch.
                const settings = useAudioSettingsStore.getState();
                // 启动续播：开关开着（默认开）就直接继续播放——不再看上次退出时是否在放，
                // 暂停退出下次打开也接着放（用户要求"第二次打开直接继续播放"）。
                // Lab 里的 autoPlayOnLaunch 是无条件自动播，与开关取并集。
                const resumePlaying = settings.resumePlayingOnLaunch !== false;
                if (settings.autoPlayOnLaunch || resumePlaying) {
                    // Arm before the source lands. The bridge's autoplay effect fires on the commit
                    // that gives the deck its src, and it spends this flag there; setting it after
                    // would miss that run and leave the deck buffered in silence.
                    shouldAutoPlayRef.current = true;
                }

                try {
                    const outcome = await restorePlaybackSourceForSong(lastSong, {
                        audioQuality,
                        userId,
                        blobUrlRef,
                        currentOnlineAudioUrlFetchedAtRef,
                        setLyrics,
                        restoreCachedThemeForSong,
                        persistLastPlaybackCache,
                        queue: lastQueue || [lastSong],
                    });
                    // A failed restore landed no source either, so the intent is withdrawn as below.
                    // A stale one is left alone: the listener has already picked another song, and
                    // the intent now belongs to that one.
                    if (outcome === 'failed') {
                        shouldAutoPlayRef.current = false;
                    } else if (resumePlaying && currentSongRef.current === getPlaybackSongKey(lastSong)) {
                        // 续播成立：直接落在播放页，不用用户再从首页点进去。
                        onResumeToPlayer?.();
                    }
                } catch (error) {
                    // No source ever landed, so the intent was never spent. Left standing it would
                    // fire on whatever the listener plays next, which they did not ask for.
                    // A throw that lands after the listener switched songs is stale like the outcome
                    // above: the intent belongs to their song by then and stays.
                    if (currentSongRef.current === getPlaybackSongKey(lastSong)) {
                        shouldAutoPlayRef.current = false;
                    }
                    console.warn('Failed to restore audio/lyrics for last session', error);
                }

                // Restoring a session sets up the current song and stops, so until the listener
                // changes track nothing around it has been fetched: the next song's URL and lyrics
                // are cold, and neither track has been measured for automix. That makes the first
                // song change of every session the slowest one and the only one that blends blind.
                // Every other entry into playback prefetches; this one was simply never wired to.
                void prefetchNearbySongs(lastSong, lastQueue || [lastSong], audioQuality, userId);
            } catch (error) {
                console.error('Session restore failed', error);
            }
        };

        void restoreSession();
    }, [canRestoreSession]);
}
