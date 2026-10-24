import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { PlayerState } from '../types';
import type { ReplayGainInfo, ReplayGainMode, SongResult, StatusMessage } from '../types';
import type { LocalSong } from '../types';
import { resolveNavidromePlaybackCarrier } from '../utils/appPlaybackGuards';
import { calculateReplayGain } from '../utils/replayGain';
import { applyAudioEqualizerSettings } from '../services/audioEqualizerGraph';
import { type AudioEffectChain } from '../services/audioEffects/effectChain';
import { buildPlaybackGraph } from '../services/playbackGraph';
import { cachePlayedTrackAssets } from '../services/playedTrackCache';
import { registerPlaybackFadeGraph, playbackFade } from '../services/playbackFade';
import { rampGain, type AutomixDeckChain } from '../services/automix/crossfadeGraph';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { isPlaybackFailureStatus } from '../services/playbackRecovery/playbackFailurePolicy';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { setPlayerState } from '../stores/usePlaybackStore';
import { useTranslation } from 'react-i18next';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { useAppViewStore } from '../stores/useAppViewStore';
import { getSystemVolume, isNativeAndroidShell, onNativeSystemEvent } from '../services/foliaExtensionBridge';
import { useNativeVolumeMirrorStore } from '../stores/useNativeVolumeMirrorStore';
import {
    getVolumeModeOverride,
    resolveNativeVolumeMode,
    subscribeVolumeModeOverride,
    systemVolumeGoverns,
} from '../utils/nativeVolumeMode';

// src/hooks/usePlaybackAudioBridge.ts

/** 固定音量车机的应用内音量（写进 gainNode），刻意与 player_volume 分开存。 */
const SOFT_VOLUME_KEY = 'player_soft_volume';
const DEFAULT_SOFT_VOLUME = 0.7;
/** 软音量下限：0 留给显式静音，避免任何脏值把输出钉死成"完全没声音"。 */
const MIN_SOFT_VOLUME = 0.02;

type UsePlaybackAudioBridgeParams = {

    audioRef: RefObject<HTMLAudioElement | null>;
    localSongs: LocalSong[];
    isLyricsLoading: boolean;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    audioContextRef: MutableRefObject<AudioContext | null>;
    analyserRef: MutableRefObject<AnalyserNode | null>;
    gainNodeRef: MutableRefObject<GainNode | null>;
    /** Wires both automix decks into the shared mix point. Returns false if a deck is missing. */
    connectDecks: (context: AudioContext, output: AudioNode) => boolean;
    /** The deck the app is currently listening through, for per-track loudness compensation. */
    getActiveChain: () => AutomixDeckChain | null;
    /** Set when a pause interrupted an armed transition; suppresses exactly one autoplay. */
    suppressAutoplayRef: MutableRefObject<boolean>;
    /** True while automix has the next track loaded but its blend is not due to start yet. */
    isAutoplayHeld: boolean;
    syncOutputGain: (targetVolume: number, smoothing?: number) => void;
    getTargetPlaybackVolume: () => number;
    getCoverUrl: () => string | null;
    updateCacheSize: () => void;
};

// Bridges audio element setup, autoplay, replay gain, and media caching.
export function usePlaybackAudioBridge({
    audioRef,
    localSongs,
    isLyricsLoading,
    shouldAutoPlayRef,
    audioContextRef,
    analyserRef,
    gainNodeRef,
    connectDecks,
    getActiveChain,
    suppressAutoplayRef,
    isAutoplayHeld,
    syncOutputGain,
    getTargetPlaybackVolume,
    getCoverUrl,
    updateCacheSize,
}: UsePlaybackAudioBridgeParams) {
    // Read here rather than passed in: all store fields or i18n.
    const { t } = useTranslation();
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const replayGainMode = usePlaybackStore(state => state.replayGainMode);
    const enableMediaCache = useAudioSettingsStore(state => state.enableMediaCache);
    const isPanelOpen = useAppViewStore(state => state.isPanelOpen);
    const panelTab = useAppViewStore(state => state.panelTab);

    const previousAudioSrcRef = useRef<string | null>(null);
    const replayGainLogSignatureRef = useRef<string | null>(null);
    const equalizerNodesRef = useRef<BiquadFilterNode[]>([]);
    const effectChainRef = useRef<AudioEffectChain | null>(null);
    const audioEqualizerSettings = useAudioSettingsStore(state => state.audioEqualizerSettings);

    // 音量完全交给系统媒体音量：网页侧不再做任何音量干预（无轮询、无系统读/写、无增益钉死）。
    // 这个包装只是让本 hook 的调用点保持形状；原生模式下 web 增益维持 App.syncOutputGain 原始行为。
    const applyOutputLevel = useCallback((targetVolume: number, smoothing = 0.015) => {
        syncOutputGain(targetVolume, smoothing);
    }, [syncOutputGain]);

    /**
     * 音量自检（车机排查口）：增益写下去之后，唯一能证明"响度真的跟着变了"的证据是
     * AnalyserNode 的实测峰值——它串在音量节点与淡化节点之后，读到的是什么，
     * 送进功放的就是什么。每次应用内音量变化后约 600ms 采一次样：
     * - 峰值随档位走 ⇒ 输出层真的在缩放（音量链路是通的）；
     * - 档位在动而峰值不动 ⇒ 音频不走这条图（元素直通 / 图没接上），病因立刻分明；
     * - 峰值恒 0 而 elVol 在动 ⇒ 元素没接进图，element.volume 才是生效的那一层。
     */
    const lastSelfCheckPeakRef = useRef<number | null>(null);
    const selfCheckTimerRef = useRef<number | null>(null);
    const sampleAnalyserPeak = (analyser: AnalyserNode): number => {
        const buffer = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i += 1) {
            const deviation = Math.abs(buffer[i] - 128);
            if (deviation > peak) peak = deviation;
        }
        return peak / 128;
    };
    const scheduleVolumeSelfCheck = useCallback(() => {
        if (selfCheckTimerRef.current !== null) window.clearTimeout(selfCheckTimerRef.current);
        selfCheckTimerRef.current = window.setTimeout(() => {
            selfCheckTimerRef.current = null;
            const analyser = analyserRef.current;
            const context = audioContextRef.current;
            const element = audioRef.current;
            if (!analyser || !context || !element || element.paused || element.ended) return;
            const peak = sampleAnalyserPeak(analyser);
            const previous = lastSelfCheckPeakRef.current;
            lastSelfCheckPeakRef.current = peak;
            const gainValue = gainNodeRef.current ? gainNodeRef.current.gain.value : null;
            console.log(
                `[Volume] self-check: peak=${peak.toFixed(3)}`
                + ` prev=${previous === null ? 'n/a' : previous.toFixed(3)}`
                + ` ctx=${context.state}`
                + ` gainNode=${gainValue === null ? 'none' : gainValue.toFixed(3)}`
                + ` elVol=${element.volume.toFixed(3)}`
                + ` storeVol=${useAudioSettingsStore.getState().volume.toFixed(3)}`
            );
        }, 600);
    }, [analyserRef, audioContextRef, audioRef, gainNodeRef]);
    // 自检定时器随 hook 卸载取消，避免回调指向已拆卸的播放器。
    useEffect(() => () => {
        if (selfCheckTimerRef.current !== null) window.clearTimeout(selfCheckTimerRef.current);
    }, []);

    // AudioContext 没在跑 ⇒ 一点声音都出不来（声音只从它到 destination），此时写 gainNode
    // 完全无效。车机冷启动自动续播没有用户手势，内核可能把上下文建在 suspended 上，
    // 表现就是"进度条在走、完全没声音、怎么调音量都没反应"。所有播放起点都先拉一次。
    const ensureAudioContextRunning = useCallback(() => {
        const ctx = audioContextRef.current;
        if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
        // 排查口：车机上"没声音/音量不动"时，这行能区分上下文是被钉在 suspended 还是根本没建。
        console.log(`[AudioContext] resume attempt (state=${ctx.state})`);
        void ctx.resume()
            .then(() => {
                // 上下文刚恢复：把当前目标音量重新落一遍，别让旧值留在节点上。
                console.log(`[AudioContext] resumed (state=${ctx.state})`);
                syncOutputGain(getTargetPlaybackVolume(), 0);
            })
            .catch(() => {
                // 仍被策略拦住：等下面的一次性手势监听兜底。
            });
    }, [audioContextRef, getTargetPlaybackVolume, syncOutputGain]);

    // 首个用户手势兜底：上下文确实被钉在 suspended 时，第一次触屏/按键立刻恢复。
    // 桌面浏览器不注册，避免给正常环境增加监听。
    useEffect(() => {
        if (!isNativeAndroidShell()) return;
        const resume = () => ensureAudioContextRunning();
        window.addEventListener('pointerdown', resume, true);
        window.addEventListener('keydown', resume, true);
        window.addEventListener('touchstart', resume, true);
        return () => {
            window.removeEventListener('pointerdown', resume, true);
            window.removeEventListener('keydown', resume, true);
            window.removeEventListener('touchstart', resume, true);
        };
    }, [ensureAudioContextRunning]);

    // 原生壳：先探测系统音量是否真的可用。
    //  - 普通机型：系统媒体音量是唯一音量源，这里只把数值镜像给音量条显示，**绝不写 gainNode**
    //    （旧实现每 600ms 把系统音量写进 gainNode，等于被平方，听起来"音量不跟随/偏小"）。
    //  - 固定音量机型（DiLink）：AudioManager 空转，系统音量永远满档。此时必须改用应用内软件增益，
    //    否则就是"总是最大声、怎么调都无效"。
    //  - 未知（null）：车机上旧版持久 WebExtension 没有 getVolumeMode、或冷启动端口未就绪。
    //    **绝不把 null 写成 adjustable**——那会让 systemGoverns 成立、网页增益钉死成 1，
    //    正是"永远最大声、滑竿和音量键全死"的根因（0.1.21 车机实测）。保持 null：
    //    网页层继续管，滑竿立即可用，并给一个不至于满功率的初值。
    const volumeModeOverride = useSyncExternalStore(
        subscribeVolumeModeOverride,
        getVolumeModeOverride,
    );
    useEffect(() => {
        if (!isNativeAndroidShell()) return;
        let cancelled = false;
        let off: (() => void) | null = null;
        let timer = 0;

        const applyMirror = (v: number | null) => {
            if (cancelled || v === null || !Number.isFinite(v)) return;
            useNativeVolumeMirrorStore.getState().setSystemVolumeMirror(Math.min(1, Math.max(0, v)));
        };

        const startSystemMirror = () => {
            // 事件驱动：壳层 ContentObserver 一有变化就推 → UI 跟手、零轮询。
            // fixed 模式同样订阅：滚轮事件要换算成应用内档位（见下方 wheel 映射）。
            off = onNativeSystemEvent((method, payload) => {
                if (method !== 'volume') return;
                const v = typeof payload === 'number' ? payload : Number.parseFloat(String(payload));
                applyMirror(Number.isFinite(v) ? v : null);
            });
            void getSystemVolume().then(applyMirror);
            // 兜底：极少数 ROM 不派发 Settings 变更，低频拉一次即可（30s，成本可忽略）。
            timer = window.setInterval(() => { void getSystemVolume().then(applyMirror); }, 30000);
        };

        // 固定音量/未知模式：把持久化的应用内音量装回 store（原生壳 readStoredVolume 恒 1），
        // 再立刻写进 gainNode —— 车机一启动就是合适的响度，而不是满功率。
        //
        // 独立键 player_soft_volume：绝不复用 player_volume。旧版本在车机上可能把
        // player_volume 写成 0（那次是拖到静音试的），拿它当软音量初值就是"一启动全静音，
        // 而且怎么调都没声"。这里 0 也视为无效值，退回默认 0.7。
        const applySoftVolumeDefault = () => {
            const parsed = Number.parseFloat(localStorage.getItem(SOFT_VOLUME_KEY) ?? '');
            const level = Number.isFinite(parsed) && parsed > 0
                ? Math.min(1, Math.max(MIN_SOFT_VOLUME, parsed))
                : DEFAULT_SOFT_VOLUME;
            useAudioSettingsStore.getState().handleSetVolume(level);
            applyOutputLevel(level, 0);
            // 冷启动没有用户手势，AudioContext 可能还没跑起来：先把上下文拉起来再确认增益。
            ensureAudioContextRunning();
        };

        void resolveNativeVolumeMode().then(fixed => {
            if (cancelled) return;
            if (fixed === null) {
                // 未知：不写镜像、不交给系统。startSystemMirror 只用于滚轮映射与显示。
                console.log('[Volume] mode unresolved after retries; web layer keeps control');
                startSystemMirror();
                applySoftVolumeDefault();
                return;
            }
            useNativeVolumeMirrorStore.getState().setFixedVolume(fixed);
            startSystemMirror();
            if (fixed) {
                console.log('[Volume] mode=fixed; software gain active');
                applySoftVolumeDefault();
            } else {
                console.log('[Volume] mode=adjustable; system volume governs');
            }
        });

        return () => {
            cancelled = true;
            off?.();
            if (timer) window.clearInterval(timer);
        };
    }, [applyOutputLevel, ensureAudioContextRunning, volumeModeOverride]);

    // 应用内音量 → 输出层。原生壳只要不是"系统音量确认可用"（fixedVolume === false），
    // 这一层就是唯一音量闸：DiLink 这类车机 isVolumeFixed 可能报 false，但 STREAM_MUSIC 写进去
    // 根本没人执行，所以只要探测没过就必须由网页这层承担，宁可小声也不能满功率。
    const fixedVolume = useNativeVolumeMirrorStore(state => state.fixedVolume);
    const systemVolume = useNativeVolumeMirrorStore(state => state.systemVolume);
    const appVolume = useAudioSettingsStore(state => state.volume);
    const appMuted = useAudioSettingsStore(state => state.isMuted);
    // 与 App.syncOutputGain 里的判据保持完全一致（共用 utils/nativeVolumeMode）：
    // 探测说"可调"还不够，系统音量必须真的低于满档，才承认系统那层在缩放。DiLink 的探测会
    // 假通过，判据不一致的话这里会提前 return，滑杆和启动初值都落不到增益上（改了等于没改）。
    const systemGovernsNow = systemVolumeGoverns(fixedVolume, systemVolume);
    useEffect(() => {
        if (!isNativeAndroidShell()) return;
        // 系统接管时也要把网页增益归位到 1：否则从软件增益切到系统音量（用户拨覆盖开关，
        // 或探测结果翻转）时，旧的软增益还挂在音频图上，系统音量再乘一次就是"音量被平方"，
        // 听起来像切了模式后突然变小。syncOutputGain 在 governs 时写的正是 1。
        const level = systemGovernsNow
            ? getTargetPlaybackVolume()
            : (appMuted ? 0 : Math.max(MIN_SOFT_VOLUME, appVolume));
        applyOutputLevel(level, 0.02);
        // 音量落下去之后实测一次输出峰值：这是"档位动了、响度没动"的唯一实锤判据。
        scheduleVolumeSelfCheck();
        if (systemGovernsNow) return;
        // 只记用户真正调过的音量；0 不记，免得下次启动读到 0 又变成静音。
        if (!appMuted && appVolume > 0) {
            try {
                localStorage.setItem(SOFT_VOLUME_KEY, String(appVolume));
            } catch {
                // 存储不可用（隐私模式）时忽略：下次启动退回默认值。
            }
        }
        ensureAudioContextRunning();
    }, [systemGovernsNow, systemVolume, fixedVolume, appVolume, appMuted, applyOutputLevel, ensureAudioContextRunning, getTargetPlaybackVolume, scheduleVolumeSelfCheck]);

    // 网页层管音量时（fixed / 未知 / 覆盖为 fixed），把系统音量变化换算成应用内档位：
    // 假可调车机（DiLink）上 STREAM_MUSIC 只被 AudioService 缓存、功放不动，但滚轮/音量键
    // 产生的事件是真的。换算过来，方向盘滚轮就能调软件增益——否则 fixed 车上实体按键全死。
    // 系统真可调时（systemGoverns）不映射：那会导致系统与网页双重调节（音量被平方）。
    const lastMappedSystemVolumeRef = useRef<number | null>(null);
    const wheelMappingLoggedRef = useRef(false);
    useEffect(() => {
        if (!isNativeAndroidShell() || systemGovernsNow) {
            if (isNativeAndroidShell() && wheelMappingLoggedRef.current) {
                // 车机排查口：这行出现 = 滚轮事件被判定为"系统在管"而不换算。
                // 滚轮动了却只有 [CarKeys] 事件、没有下面 wheel 行，就是这个原因。
                console.log('[Volume] wheel mapping inactive (system governs)');
                wheelMappingLoggedRef.current = false;
            }
            lastMappedSystemVolumeRef.current = null;
            return;
        }
        if (!wheelMappingLoggedRef.current) {
            console.log('[Volume] wheel mapping active (web governs; wheel turns adjust in-app volume)');
            wheelMappingLoggedRef.current = true;
        }
        return onNativeSystemEvent((method, payload) => {
            if (method !== 'volume') return;
            const v = typeof payload === 'number' ? payload : Number.parseFloat(String(payload));
            if (!Number.isFinite(v)) return;
            const previous = lastMappedSystemVolumeRef.current;
            lastMappedSystemVolumeRef.current = v;
            // 首个事件只建立基线：启动时读到的当前档位不是用户操作，不能折算成跳变。
            if (previous === null) return;
            const delta = v - previous;
            if (Math.abs(delta) < 1e-4) return;
            const store = useAudioSettingsStore.getState();
            const next = Math.min(1, Math.max(MIN_SOFT_VOLUME, store.volume + delta));
            store.handleSetVolume(next);
            console.log(`[Volume] wheel Δ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} → app=${next.toFixed(3)}`);
        });
    }, [systemGovernsNow]);

    // 输出自检（原生壳）：element 明明在播，但音频图出口一点能量都没有 ⇒ 静音发生在
    // WebAudio 这一层（上下文被挂起、某个 gain 停在 0、淡化节点没回来）。固定音量车机没有
    // 第二道音量闸，一旦这样就是"完全没声音、怎么调都没用"，所以这里自愈两档：
    //   ① 归位上下文与淡化节点，并把主增益抬到可听见；
    //   ② 仍然死寂 → 主增益拉到满档（等同退回旧的"系统音量"行为），宁可大声也不能没声。
    // 只有图存在（analyser 存在）时才跑；没有图说明音频不经 WebAudio，那种情况一定有声音。
    const silentTicksRef = useRef(0);
    const playerState = usePlaybackStore(state => state.playerState);
    useEffect(() => {
        if (!isNativeAndroidShell()) return;
        if (playerState !== PlayerState.PLAYING) {
            silentTicksRef.current = 0;
            return;
        }
        const timer = window.setInterval(() => {
            const el = audioRef.current;
            const analyser = analyserRef.current;
            if (!el || el.paused || el.ended || !analyser) {
                silentTicksRef.current = 0;
                return;
            }
            const buffer = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(buffer);
            let peak = 0;
            for (let i = 0; i < buffer.length; i += 1) {
                const deviation = Math.abs(buffer[i] - 128);
                if (deviation > peak) peak = deviation;
            }
            if (peak > 0) {
                silentTicksRef.current = 0;
                return;
            }
            silentTicksRef.current += 1;
            // 上下文没在跑：所有增益都写在空气上，先拉起来（要用户手势才可能成功，
            // 所以每个 tick 都试一次——用户一碰屏幕，下一次就会恢复）。
            const ctx = audioContextRef.current;
            if (!ctx || ctx.state !== 'running') {
                ensureAudioContextRunning();
                return;
            }
            if (silentTicksRef.current === 1) {
                // 排查口：元素在放、峰值却为 0。带上上下文与元素层状态——元素没接进图时
                // 这里恒触发（element.volume 仍在管响度，自检峰值恒 0，属误报）；接进图却
                // 读不到能量，才是图真的死了。两种情况在日志里一眼可分。
                console.warn(
                    `[Volume] analyser reads silence while playing: ctx=${ctx.state}`
                    + ` elVol=${el.volume.toFixed(3)}`
                    + ` storeVol=${useAudioSettingsStore.getState().volume.toFixed(3)}`
                );
                // 只做"归位"：把淡化节点收回 1、把上下文拉起来、把用户的目标音量重新写一遍。
                // 这里曾经还有两档"兜底拉满"（element.volume=1、gain=1），在车机上正好是灾难：
                // analyser 读不到能量并不等于真的没声音——元素没接进 WebAudio 图时它永远是 0，
                // 而这两档会把音量硬钉在 100%，用户再拖滑杆也拉不回来。
                playbackFade.cancel();
                ensureAudioContextRunning();
                syncOutputGain(getTargetPlaybackVolume(), 0);
            }
        }, 2000);
        return () => window.clearInterval(timer);
    }, [analyserRef, applyOutputLevel, audioRef, ensureAudioContextRunning, getTargetPlaybackVolume, playerState, syncOutputGain]);

    // Recalculates source-specific gain after the audio graph or playback settings become ready.
    const applyReplayGain = useCallback(() => {
        if (!currentSong || !gainNodeRef.current || !audioContextRef.current) return;

        let replayGainInfo: ReplayGainInfo | undefined;
        const localSongId = (currentSong as SongResult & { localRef?: { songId: string } }).localRef?.songId;
        const localData = localSongId ? localSongs.find(song => song.id === localSongId) : undefined;
        if ((currentSong as SongResult & { isLocal?: boolean }).isLocal && localData) {
            replayGainInfo = {
                trackGain: typeof localData.replayGainTrackGain === 'number'
                    ? localData.replayGainTrackGain
                    : localData.replayGain,
                trackPeak: localData.replayGainTrackPeak,
                albumGain: localData.replayGainAlbumGain,
                albumPeak: localData.replayGainAlbumPeak,
            };
        }

        const navidromeSong = resolveNavidromePlaybackCarrier(currentSong);
        const navidromeReplayGain = navidromeSong?.navidromeData.replayGain;
        if (navidromeReplayGain) {
            replayGainInfo = navidromeReplayGain;
        }

        if (currentSong.sourceRef?.kind === 'online') {
            replayGainInfo = currentSong.replayGain;
        }

        const calculation = calculateReplayGain(replayGainInfo, replayGainMode);

        try {
            // Onto the deck rather than the shared output: loudness compensation is a per-track
            // value, so during a blend the two decks legitimately need different ones.
            const activeChain = getActiveChain();
            if (activeChain) {
                rampGain(audioContextRef.current, activeChain.replayGain, calculation.linearGain, 0.1);
            }

            const replayGainLogSignature = JSON.stringify({
                songId: currentSong.id,
                mode: replayGainMode,
                raw: calculation.gainDb,
                effective: calculation.effectiveGainDb,
                peak: calculation.peak ?? null,
            });

            if (replayGainLogSignatureRef.current !== replayGainLogSignature) {
                replayGainLogSignatureRef.current = replayGainLogSignature;
                console.log(`[AudioContext] ReplayGain mode=${replayGainMode} gain=${calculation.effectiveGainDb}dB (raw=${calculation.gainDb}dB, peak=${calculation.peak ?? 'n/a'}, linear=${calculation.linearGain.toFixed(2)})`);
            }
        } catch (error) {
            console.warn('[AudioContext] Failed to apply ReplayGain', error);
        }
    }, [audioContextRef, currentSong, gainNodeRef, getActiveChain, localSongs, replayGainMode]);

    const setupAudioAnalyzer = useCallback(() => {
        // The context is the sentinel, not the source node: a deck that failed to connect must
        // not let this run twice, because createMediaElementSource throws on a second call.
        if (!audioRef.current || audioContextRef.current) return;
        try {
            const AudioContextClass = window.AudioContext || (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioContextClass();
            audioContextRef.current = ctx;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.6;
            analyserRef.current = analyser;

            const { gainNode, fadeNode, effectChain, decksConnected } = buildPlaybackGraph({
                context: ctx,
                analyser,
                connectDecks,
                equalizerNodesRef,
                settings: audioEqualizerSettings,
            });
            gainNodeRef.current = gainNode;
            // Hands the transport its own fade node; until this runs (or if setup fails) pause and
            // resume see no graph and fall back to plain element pause/play.
            registerPlaybackFadeGraph({ context: ctx, gain: fadeNode });
            effectChainRef.current = effectChain;
            if (!decksConnected) {
                console.warn('[AudioContext] Deck setup incomplete, automix will stay idle');
            }
            // 排查口：图建成时上下文是什么状态、几只 deck 接上了、初始音量落在哪。
            // 车机上"滚轮调不了音量"时，这一行 + [Volume] write/self-check 三行合起来能定位
            // 是图没建、上下文挂着、还是写入层没接到。
            console.log(
                `[AudioContext] graph ready: ctx=${ctx.state}`
                + ` decks=${decksConnected ? 'A+B' : 'partial'}`
                + ` volume=${getTargetPlaybackVolume().toFixed(3)}`
            );
            applyReplayGain();
            applyOutputLevel(getTargetPlaybackVolume(), 0);
            // 新建的上下文可能停在 suspended（无手势冷启动），声音会彻底没有。
            ensureAudioContextRunning();
        } catch (error) {
            console.error(
                `Audio Context Setup Failed (ctx=${audioContextRef.current?.state ?? 'gone'}):`,
                error,
            );
        }
    }, [analyserRef, applyOutputLevel, applyReplayGain, audioContextRef, audioEqualizerSettings, audioRef, connectDecks, ensureAudioContextRunning, gainNodeRef, getTargetPlaybackVolume]);

    /**
     * Writes a fully-played track's audio and cover into the media cache.
     *
     * Takes the song and its source explicitly rather than reading `currentSong`/`audioSrc`, because
     * the automix settle path caches the track that just faded OUT - and by then the app's own state
     * already names the track that arrived. `coverUrl` is passed for the currently-displayed track
     * (which may carry a user override); left undefined - the automix path - the cover is taken from
     * the song's own metadata instead.
     *
     * The writes themselves live in `cachePlayedTrackAssets`, which is where the audio and cover
     * conditions are kept apart from each other; this only adds the setting gate and the readout
     * refresh, neither of which belongs in a service.
     */
    const cacheSongAssetsFor = useCallback(async (
        song: SongResult | null,
        src: string | null,
        coverUrl?: string | null,
    ) => {
        if (!enableMediaCache) return;

        const written = await cachePlayedTrackAssets(song, src, coverUrl);

        if ((written.audio || written.cover) && isPanelOpen && panelTab === 'account') {
            updateCacheSize();
        }
    }, [enableMediaCache, isPanelOpen, panelTab, updateCacheSize]);

    const cacheSongAssets = useCallback(
        () => cacheSongAssetsFor(currentSong, audioSrc, getCoverUrl()),
        [audioSrc, cacheSongAssetsFor, currentSong, getCoverUrl],
    );

    useEffect(() => {
        if (audioRef.current) {
            applyOutputLevel(getTargetPlaybackVolume(), 0.015);
        }
    }, [audioRef, applyOutputLevel, getTargetPlaybackVolume]);

    useEffect(() => {
        localStorage.setItem('local_replaygain_mode', replayGainMode);
    }, [replayGainMode]);

    useEffect(() => {
        applyReplayGain();
    }, [applyReplayGain]);

    useEffect(() => {
        const context = audioContextRef.current;
        if (!context || equalizerNodesRef.current.length === 0) {
            return;
        }
        applyAudioEqualizerSettings(context, equalizerNodesRef.current, audioEqualizerSettings);
        effectChainRef.current?.apply(audioEqualizerSettings.effects, audioEqualizerSettings.enabled);
    }, [audioContextRef, audioEqualizerSettings]);

    useEffect(() => () => {
        effectChainRef.current?.dispose();
        effectChainRef.current = null;
    }, []);

    useEffect(() => {
        const audioElement = audioRef.current;
        if (!audioElement) {
            previousAudioSrcRef.current = audioSrc;
            return;
        }

        if (audioSrc && previousAudioSrcRef.current && previousAudioSrcRef.current !== audioSrc) {
            audioElement.pause();
            audioElement.load();
        }

        previousAudioSrcRef.current = audioSrc;
    }, [audioRef, audioSrc]);

    useEffect(() => {
        if (audioSrc && audioRef.current) {
            // `audioRef` and `audioSrc` describe the same track almost always - but not while a
            // blend is being armed. Automix repoints the ref at the incoming deck the instant it
            // arms, and `audioSrc` keeps naming the OUTGOING track until playSong has resolved the
            // next URL, which takes an await or two. Playing in that window starts whatever the
            // incoming deck still had loaded from an earlier song AND spends the autoplay intent
            // on it, so when the real source lands there is nothing left to press play with: the
            // deck sits fully buffered at currentTime 0 in silence.
            //
            // The deck's own src attribute is written from `audioSrc`, so an exact match is the
            // whole test. Bail WITHOUT spending the intent - this effect runs again on the commit
            // that gives the deck its real source, and that run is the one meant to start it.
            if (audioRef.current.getAttribute('src') !== audioSrc) return;

            // The deck has already failed on this exact source and something else - the transcode
            // fallback - is off resolving it. play() on an element in error state cannot start
            // anything; it rejects with NotSupportedError. Pressing it here only spends the intent,
            // so when the recovered source lands there is nothing left to start the deck with.
            // Bail WITHOUT spending it, the same way the autoplay hold below does: replacing the
            // source runs this effect again, and that run is the one meant to start it.
            if (audioRef.current.error) return;

            if (shouldAutoPlayRef.current && !isLyricsLoading) {
                // The deck has its source and is buffering, but its blend is not due yet. Bail
                // WITHOUT spending the intent - this effect runs again when the hold lifts, and
                // that run is the one meant to start it.
                //
                // This is what keeps the load out of the blend. Pressing play here instead starts
                // the fade wherever loading happened to finish, which took the same second or two
                // off every transition and capped an eight second plan at three.
                if (isAutoplayHeld) {
                    // The outgoing deck is still sounding. playSong dropped the state to IDLE on
                    // its way past and nothing else puts it back until this deck starts, so left
                    // alone the transport reads "stopped" for the whole lead - and the play button
                    // it offers would start this deck early and take the blend with it.
                    setPlayerState(PlayerState.PLAYING);
                    return;
                }

                shouldAutoPlayRef.current = false;

                // Automix starts the next track seconds early, so a pause can land after the
                // advance is already in flight and too late to recall. Honour the pause instead:
                // without this the listener presses pause and the next song starts anyway.
                if (suppressAutoplayRef.current) {
                    suppressAutoplayRef.current = false;
                    setPlayerState(PlayerState.PAUSED);
                    return;
                }

                applyOutputLevel(getTargetPlaybackVolume(), 0);
                const playPromise = audioRef.current.play();
                if (playPromise !== undefined) {
                    playPromise
                        .then(() => {
                            setPlayerState(PlayerState.PLAYING);
                            setupAudioAnalyzer();
                            // 真的开始放了：把传输淡化节点归位（自动续播没走 transport 的
                            // prepareFadeIn/runFadeIn 配对时，它可能停在上一次淡出的 0 上，
                            // 那会让"怎么调音量都没声音"），并确认上下文在跑。
                            playbackFade.cancel();
                            ensureAudioContextRunning();
                            // Playback has really started. The transport hands a refreshed source (its TTL
                            // refresh, or the recovery after a rejected play()) to this effect to start, so a
                            // leftover retry / skip failure toast, which has no close control, is cleared here
                            // too. Countdowns and every other toast stay.
                            setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? null : prev));
                        })
                        .catch(error => {
                            if (audioRef.current && !audioRef.current.paused && !audioRef.current.ended) {
                                setPlayerState(PlayerState.PLAYING);
                                return;
                            }

                            // A load() landing between play() and its promise aborts the play.
                            // That happens whenever the source changes again while a track is
                            // still starting - skipping during an automix transition is the
                            // reliable way to see it - and the autoplay flag was spent before
                            // play() was ever called, so nothing would press play again and the
                            // app sits silent. Put the intent back for the next run.
                            if (error.name === 'AbortError') {
                                shouldAutoPlayRef.current = true;
                                return;
                            }

                            if (error.name === 'NotAllowedError') {
                                setStatusMsg({ type: 'info', text: t('status.clickToPlay') });
                                setPlayerState(PlayerState.PAUSED);

                                // 车机/原生壳的 AUTOPLAY 授权是异步落地的：首次 play() 常常先被
                                // 拒一次，权限随后才生效。先退避重试几次，让"启动即续播"自己开始；
                                // 真被策略拦死，再退回"首个用户手势补播"。
                                const failAudio = audioRef.current;
                                let tries = 0;
                                const retryWhenAllowed = () => {
                                    const el = audioRef.current;
                                    // 已经换歌/已在放/源出错：这个意图过期了，交给新流程。
                                    if (!el || el !== failAudio || !el.paused || el.ended || el.error) return;
                                    if (tries++ >= 3) {
                                        const retryOnGesture = () => {
                                            window.removeEventListener('pointerdown', retryOnGesture);
                                            window.removeEventListener('keydown', retryOnGesture);
                                            const a = audioRef.current;
                                            if (a && a.paused && !a.ended && !a.error) {
                                                a.play()
                                                    .then(() => {
                                                        setPlayerState(PlayerState.PLAYING);
                                                        setupAudioAnalyzer();
                                                        playbackFade.cancel();
                                                        ensureAudioContextRunning();
                                                    })
                                                    .catch(() => { /* 仍失败则保持暂停，走正常播放键 */ });
                                            }
                                        };
                                        window.addEventListener('pointerdown', retryOnGesture);
                                        window.addEventListener('keydown', retryOnGesture);
                                        return;
                                    }
                                    el.play()
                                        .then(() => {
                                            setPlayerState(PlayerState.PLAYING);
                                            setupAudioAnalyzer();
                                            playbackFade.cancel();
                                            ensureAudioContextRunning();
                                            setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? null : prev));
                                        })
                                        .catch(() => window.setTimeout(retryWhenAllowed, 250 * 2 ** tries));
                                };
                                window.setTimeout(retryWhenAllowed, 250);
                            }
                        });
                }
            }
        }
    }, [applyOutputLevel, audioRef, audioSrc, ensureAudioContextRunning, getTargetPlaybackVolume, isAutoplayHeld, isLyricsLoading, setPlayerState, setStatusMsg, setupAudioAnalyzer, shouldAutoPlayRef, suppressAutoplayRef, t]);

    // Tells this bridge that the active deck ALREADY holds `src` and is sounding it, so the next time
    // `audioSrc` settles on that value the reload effect above treats it as a no-op instead of calling
    // load(). Used when a transition is cancelled back onto the deck still playing the outgoing track:
    // that deck has the song loaded and playing, and reloading it would run the whole song-change
    // shape - a fresh load, a visible hitch - for a track that never actually left.
    const adoptActiveDeckSource = useCallback((src: string) => {
        previousAudioSrcRef.current = src;
    }, []);

    return {
        setupAudioAnalyzer,
        cacheSongAssets,
        cacheSongAssetsFor,
        adoptActiveDeckSource,
    };
}
