import type { ActiveLocalLyricsSource, LocalLyricsPriority, LocalSong, LyricData } from '../../types';
import { LyricParserFactory } from './LyricParserFactory';
import { decodeLyricFileBytes } from './lyricFileDecoding';
import { readNativeFile, detectNativeLibrary } from '../../services/nativeLibrary/nativeLibrarySource';

// src/utils/lyrics/localSongLyrics.ts
// Resolves the lyric payload and its actual source from one local-song snapshot.

// 原生侧car歌词懒加载缓存：relativePath → 加载任务。同一路径只过桥读一次，重复播放命中缓存。
const nativeSidecarLyricCache = new Map<string, Promise<string | null>>();

const loadNativeSidecarLyric = (relativePath: string): Promise<string | null> => {
    let task = nativeSidecarLyricCache.get(relativePath);
    if (!task) {
        task = (async () => {
            try {
                const bytes = await readNativeFile(relativePath);
                // KRC 逐字解密 / GBK 兜底全部复用既有 decodeLyricFileBytes，一行不改。
                return await decodeLyricFileBytes(new Uint8Array(bytes));
            } catch (error) {
                console.warn(`[LocalSongLyrics] 原生侧car歌词读取失败: ${relativePath}`, error);
                return null;
            }
        })();
        nativeSidecarLyricCache.set(relativePath, task);
    }
    return task;
};

/**
 * 原生源侧car歌词：导入期故意不读字节（封面/歌词字节过桥是导入慢点），
 * 播放首次需要时在这里按需 readNativeFile → decodeLyricFileBytes，填回 song 后走原解析路径。
 */
const ensureNativeSidecarLyricsLoaded = async (song: LocalSong): Promise<void> => {
    if (!detectNativeLibrary()) return;
    if (song.hasLocalLyrics && !song.localLyricsContent && song.localSidecarLyricPath) {
        const content = await loadNativeSidecarLyric(song.localSidecarLyricPath);
        if (content !== null) song.localLyricsContent = content;
    }
    if (song.hasLocalTranslationLyrics && !song.localTranslationLyricsContent && song.localTranslationSidecarLyricPath) {
        const content = await loadNativeSidecarLyric(song.localTranslationSidecarLyricPath);
        if (content !== null) song.localTranslationLyricsContent = content;
    }
};

export type ResolvedLocalSongLyrics = {
    lyrics: LyricData | null;
    source: ActiveLocalLyricsSource | null;
};

export const selectLocalSongLyricsSource = (
    song: LocalSong,
    priority: LocalLyricsPriority,
): ActiveLocalLyricsSource | null => {
    if (song.lyricsSource) {
        if (song.lyricsSource === 'online' && (song.matchedLyrics || song.matchedIsPureMusic)) return 'online';
        if (song.lyricsSource === 'local' && song.localLyricsContent) return 'local';
        if (song.lyricsSource === 'embedded' && song.embeddedLyricsContent) return 'embedded';
        return null;
    }

    // 用户标记的纯音乐：没有显式选本地 / 内嵌时一律按纯音乐（空歌词），「不使用在线数据」等把来源清回自动也不例外。
    if (song.markedPureMusic) return 'online';
    if (priority === 'online' && song.matchedLyrics) return 'online';
    if (song.hasLocalLyrics && song.localLyricsContent) return 'local';
    if (song.hasEmbeddedLyrics && song.embeddedLyricsContent) return 'embedded';
    if (song.matchedLyrics) return 'online';
    return null;
};

/** Parses the payload selected by the explicit source or current automatic priority. */
export const resolveLocalSongLyrics = async (
    song: LocalSong,
    priority: LocalLyricsPriority,
): Promise<ResolvedLocalSongLyrics> => {
    // 原生侧car懒加载：导入不读字节，播放首次解析前按需过桥读取并填回 song。
    await ensureNativeSidecarLyricsLoaded(song);
    const source = selectLocalSongLyricsSource(song, priority);
    if (source === 'online') {
        return { lyrics: song.matchedLyrics ?? null, source };
    }
    if (source === 'local') {
        const lyrics = await LyricParserFactory.parse({
            type: 'local',
            lrcContent: song.localLyricsContent!,
            tLrcContent: song.localTranslationLyricsContent,
            formatHint: song.localLyricsFormat,
        });
        return { lyrics, source };
    }
    if (source === 'embedded') {
        const lyrics = await LyricParserFactory.parse({
            type: 'embedded',
            textContent: song.embeddedLyricsContent!,
            translationContent: song.embeddedTranslationLyricsContent,
        });
        return { lyrics, source };
    }
    return { lyrics: null, source: null };
};
