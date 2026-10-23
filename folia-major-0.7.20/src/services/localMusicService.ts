import { LocalSong, LyricData, LocalLibrarySnapshot, LocalLibrarySnapshotFile, LocalLibrarySnapshotNode, type SongResult } from '../types';
import { detectNativeLibrary, buildSnapshotVirtualHandle, findNativeFileHandle, readNativeAudioMeta, readNativeFileStats, readNativeFileContentUri, readNativeRelativePath, readNativeSidecarPath, readNativeTranslationSidecarPath, getNativeCoverUrl, getNativeMediaUrl, getNativeSnapshot, type NativeAudioMeta, type NativeSnapshot } from './nativeLibrary/nativeLibrarySource';
import { saveLocalSong, saveLocalSongs, deleteLocalSong as dbDeleteLocalSong, deleteLocalSongs as dbDeleteLocalSongs, saveDirHandles, getDirHandles, deleteDirHandle, getLocalSongs, getLocalLibrarySnapshot, saveLocalLibrarySnapshot, deleteLocalLibrarySnapshot } from './db';
import { getLocalPlaylists, saveLocalPlaylists } from './localPlaylistService';
import { parseEmbeddedMetadataAsync, type EmbeddedMetadataResult } from '../utils/localMetadataWorkerClient';
import { autoMatchBestLyric } from '../utils/lyrics/autoMatchBestLyric';
import { normalizeLyricMatchText } from '../utils/lyrics/matchScore';
import { createSafeObjectUrl } from '../utils/blobGuards';
import { repairFlacMetadata } from '../utils/flacMetadataRepair';
import { resolveExplicitFileTimedLyricFormat, type ExplicitFileTimedLyricFormat } from '../utils/lyrics/formatDetection';
import { applyMatchedMetadata } from './localLibraryCatalogService';
import { buildLyricSearchQuery } from '../utils/lyrics/searchQuery';
import { buildLocalSongLyricMatchContext, shouldRefreshLocalSongLyricsFromMetadata } from '../utils/lyrics/localSongMatchContext';
import { buildImportedMetadataSnapshot } from '../utils/localSongMetadata';
import { getLocalLibraryCatalogSnapshot } from './localLibraryEntityRepository';
import { resolveLocalSongMetadata } from './playbackAdapters';
import { removeCachedCover } from './coverCache';
import { getOnlineMusicProvider } from './onlineMusic/providerRegistry';
import { getProviderSongMetadata } from './onlineMusic/songMetadata';
import { normalizeLyricMatchMetadataCandidate } from './onlineMetadataSearchService';
import {
    prepareLocalCoverBlob,
    stageLocalCoverAsset,
    type PreparedLocalCoverBlob,
} from './localCoverAssetService';
import { hasLocalCoverBinary } from './localCoverBinaryStore';
import { hasLocalSongCover } from '../utils/localSongCover';
import { createFoliaIgnoreMatcher, isIgnoredByFoliaMatchers, type FoliaIgnoreMatcher } from '../utils/foliaIgnore';
import { getLocalLibraryAvailability } from './localLibraryAvailability';
import { useLyricSettingsStore } from '../stores/useLyricSettingsStore';
import { getLocalLyricFilePriority, isSameLocalLyricFormatOrder, normalizeLocalLyricFormatOrder, type LocalLyricFileFormat } from '../utils/lyrics/localLyricFormatOrder';
import { readLyricFile } from '../utils/lyrics/lyricFileDecoding';
import { isLocalFolderIgnored, normalizeLocalFolderPath, runLocalFolderMutation, setLocalFolderIgnored } from './localLibraryFolderIgnore';


type EmbeddedMetadata = EmbeddedMetadataResult;

export const EMBEDDED_METADATA_VERSION = 7;

interface ImportPreparationMetrics {
    getFileMs: number;
    lyricReadMs: number;
    coverReadMs: number;
    parseMetadataMs: number;
    durationFallbackMs: number;
    usedDurationFallback: boolean;
}

interface FileEntryForImport {
    handle: FileSystemFileHandle;
    /** 原生源且目录树已带 meta 时为 undefined（故意不 getFile() 整字节回传） */
    file?: File;
    folderName: string;
    relativePath: string;
    // A sidecar lyric file of this track was added or modified on disk since the last scan.
    sidecarLyricFilesChanged?: boolean;
    /** 原生 MediaMetadataRetriever 目录树直接携带的音频元数据；存在即走快速导入分支 */
    nativeAudioMeta?: NativeAudioMeta;
    /** 原生句柄直接暴露的非字节文件信息（size/lastModified/mimeType） */
    nativeStats?: { size: number; lastModified: number; mimeType: string };
}

interface LocalLyricFileCandidate {
    /** web/Electron 路径：导入时已 getFile() 拿到字节；原生路径为 undefined。 */
    file?: File;
    /** 原生侧car歌词相对路径：导入不读字节，播放时按需 readNativeFile → decodeLyricFileBytes。 */
    nativePath?: string;
    format?: ExplicitFileTimedLyricFormat;
}

/** 文件夹封面候选：File 字节路径或原生 contentUri 路径二选一。 */
interface LocalCoverCandidate {
    file?: File;
    nativeContentUri?: string;
}

interface SnapshotTraversalResult {
    tree: LocalLibrarySnapshotNode;
    relevantFileCount: number;
    filesByPath: Map<string, SnapshotTraversalFile>;
}

interface SnapshotTraversalFile {
    handle: FileSystemFileHandle;
    /** 原生源且目录树已带 meta 的音频文件、以及原生源 lyric/cover 文件，均为 undefined（不预读字节） */
    file?: File;
    nativeAudioMeta?: NativeAudioMeta;
    nativeStats?: { size: number; lastModified: number; mimeType: string };
    /** 原生图片条目携带的 SAF content uri（cover 候选用） */
    nativeContentUri?: string;
}

interface ImportDiffPlan {
    changedEntries: FileEntryForImport[];
    reusedSongs: LocalSong[];
    removedSongs: LocalSong[];
    totalAudioFiles: number;
    relevantFileCount: number;
    lrcMap: Map<string, LocalLyricFileCandidate>;
    tlrcMap: Map<string, LocalLyricFileCandidate>;
    coverMap: Map<string, LocalCoverCandidate>;
    snapshot: LocalLibrarySnapshot;
}

// In-memory storage for hot-path access. Persistent recovery uses directory handles from IndexedDB.
const fileHandleMap = new Map<string, FileSystemFileHandle>();
const localCoverAssetRequestMap = new Map<string, Promise<LocalSong>>();
// 解析过、确认没有内嵌封面的文件：歌曲 id → 当时文件的「大小:修改时间」。没封面时没有可落库的东西，
// 不记下来的话每次播放都要在出声前把文件重新解析一遍。文件被替换后大小或修改时间变了，就会重新解析。
const songsWithoutEmbeddedCover = new Map<string, string>();
const BROWSER_AUDIO_EXTENSIONS = /\.(mp3|flac|m4a|wav|ogg|opus|aac)$/i;
const ELECTRON_FALLBACK_AUDIO_EXTENSIONS = /\.(alac|ape|wv|tta|wma|aif|aiff|caf)$/i;
const KNOWN_AUDIO_EXTENSIONS = /\.(mp3|flac|m4a|wav|ogg|opus|aac|alac|ape|wv|tta|wma|aif|aiff|caf)$/i;
const LYRIC_EXTENSIONS = /\.(lrc|vtt|ttml|qrc|yrc|krc|fia)$/i;
const TRANSLATION_LYRIC_EXTENSIONS = /\.t\.(lrc|vtt)$/i;
const IMPORT_CONCURRENCY = 6;
// 目录树遍历的兄弟目录并发：每次目录列出是一次原生桥往返（postMessage→content script→native），
// 串行递归是导入耗时大头；并发 6 把往返重叠。原生侧 MMR/缓存由安卓子代理并行优化。
const DIRECTORY_TRAVERSAL_CONCURRENCY = 6;
export const LOCAL_MUSIC_UPDATED_EVENT = 'folia-local-music-updated';
export const LOCAL_MUSIC_SCAN_PROGRESS_EVENT = 'folia-local-music-scan-progress';
const HYDRATION_BATCH_SIZE = 25;
const HYDRATION_REFRESH_EVERY = 100;
const SNAPSHOT_HASH_SEED = 2166136261;
const REIMPORT_HANDLE_MISSING_ERROR = 'Missing persisted directory handle for reimport';
const PREFERRED_FOLDER_COVER_FILES = ['cover.png', 'cover.jpg', 'cover.jpeg'];

interface LocalMusicScanProgressDetail {
    active: boolean;
    folderName: string;
    totalSongs: number;
    completedSongs: number;
}

function formatImportDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms.toFixed(1)}ms`;
    }

    return `${(ms / 1000).toFixed(2)}s`;
}

function notifyLocalMusicUpdated() {
    window.dispatchEvent(new CustomEvent(LOCAL_MUSIC_UPDATED_EVENT));
}

async function removeDeletedSongIdsFromPlaylists(songIds: string[]): Promise<void> {
    if (songIds.length === 0) {
        return;
    }

    const removingIds = new Set(songIds);
    const playlists = await getLocalPlaylists();
    let changed = false;
    const nextPlaylists = playlists.map(playlist => {
        const nextSongIds = playlist.songIds.filter(songId => !removingIds.has(songId));
        if (nextSongIds.length === playlist.songIds.length) {
            return playlist;
        }

        changed = true;
        return {
            ...playlist,
            songIds: nextSongIds,
        };
    });

    if (changed) {
        await saveLocalPlaylists(nextPlaylists);
    }
}

function notifyLocalMusicScanProgress(detail: LocalMusicScanProgressDetail) {
    window.dispatchEvent(new CustomEvent(LOCAL_MUSIC_SCAN_PROGRESS_EVENT, { detail }));
}

async function getImportDirectoryHandle(expectedRootName?: string): Promise<FileSystemDirectoryHandle | null> {
    // 原生壳：曲库永远来自 MediaStore 快照，没有"选目录"这一步。
    // 重扫/首次导入都从同一份快照重建内存树，句柄无需持久化（重启后也不可能还原）。
    if (detectNativeLibrary()) {
        const snapshot = await getNativeSnapshot(Boolean(expectedRootName));
        return snapshot ? buildSnapshotVirtualHandle(snapshot) : null;
    }

    if (expectedRootName) {
        const dirHandles = await getDirHandles();
        const persistedHandle = dirHandles[expectedRootName];

        if (!persistedHandle) {
            throw new Error(REIMPORT_HANDLE_MISSING_ERROR);
        }

        const permissionAwareHandle = persistedHandle as FileSystemDirectoryHandle & {
            queryPermission: (descriptor: { mode: 'read' | 'readwrite'; }) => Promise<PermissionState>;
            requestPermission: (descriptor: { mode: 'read' | 'readwrite'; }) => Promise<PermissionState>;
        };

        let permission = await permissionAwareHandle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') {
            permission = await permissionAwareHandle.requestPermission({ mode: 'read' });
        }

        if (permission !== 'granted') {
            return null;
        }

        return persistedHandle;
    }

    const availability = getLocalLibraryAvailability();
    if (!availability.supported) throw new Error(`Local library unavailable: ${availability.reason}`);

    // @ts-ignore - showDirectoryPicker is not in all TypeScript definitions
    return await window.showDirectoryPicker();
}

async function findImportedRootForHandle(dirHandle: FileSystemDirectoryHandle): Promise<string | null> {
    const dirHandles = await getDirHandles();
    const selectedHandle = dirHandle as FileSystemDirectoryHandle & {
        isSameEntry?: (other: FileSystemHandle) => Promise<boolean>;
    };

    if (!selectedHandle.isSameEntry) {
        return null;
    }

    for (const [rootFolderName, persistedHandle] of Object.entries(dirHandles)) {
        try {
            if (await selectedHandle.isSameEntry(persistedHandle)) {
                return rootFolderName;
            }
        } catch (error) {
            console.warn(`[LocalMusic][Import] Failed to compare imported directory with "${rootFolderName}":`, error);
        }
    }

    return null;
}

// Generate UUID for local songs
function generateId(): string {
    return `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Extract basic metadata from filename.
// Expected format: "Artist - Title.mp3", "Artist-Title.mp3", or "Title.mp3".
export function extractMetadataFromFilename(fileName: string): { title?: string; artist?: string; } {
    // 去掉扩展名
    let nameWithoutExt = fileName.replace(KNOWN_AUDIO_EXTENSIONS, '');

    // 去掉开头的cue切分产生的序号 "01. ", "01 - ", or "1-01 " 
    nameWithoutExt = nameWithoutExt.replace(/^\d{1,3}(?:[-.]\d{1,3})?(?:\s*[-.]\s*|\s+)/, '');

    // 分割艺术家和标题 - 尝试 " - " (带空格)
    let parts = nameWithoutExt.split(' - ');
    if (parts.length === 2) {
        return {
            artist: parts[0].trim(),
            title: parts[1].trim()
        };
    }

    // 尝试 "-" (不带空格) - 但要确保不是单词中间的连字符
    // 我们检查最后一个"-"是否可能是分隔符
    const lastDashIndex = nameWithoutExt.lastIndexOf('-');
    if (lastDashIndex > 0 && lastDashIndex < nameWithoutExt.length - 1) {
        const potentialTitle = nameWithoutExt.substring(0, lastDashIndex).trim();
        const potentialArtist = nameWithoutExt.substring(lastDashIndex + 1).trim();

        // 如果分割后的两部分都有内容，使用这个分割
        if (potentialTitle && potentialArtist) {
            return {
                artist: potentialArtist,
                title: potentialTitle
            };
        }
    }

    return {
        title: nameWithoutExt.trim()
    };
}

// Get audio duration from file
async function getAudioDuration(file: File): Promise<number> {
    const playbackInput = await repairFlacMetadata(file, true);
    return new Promise((resolve) => {
        const audio = new Audio();
        const url = createSafeObjectUrl(playbackInput);
        if (!url) {
            resolve(0);
            return;
        }

        audio.addEventListener('loadedmetadata', () => {
            const duration = audio.duration * 1000; // Convert to milliseconds
            URL.revokeObjectURL(url);
            resolve(duration);
        });

        audio.addEventListener('error', () => {
            URL.revokeObjectURL(url);
            resolve(0); // Default duration on error
        });

        audio.src = url;
    });
}

function canImportElectronFallbackAudio(): boolean {
    return typeof window !== 'undefined' && typeof window.electron?.requestTranscodeFallback === 'function';
}

function isAudioFile(file: File): boolean {
    return BROWSER_AUDIO_EXTENSIONS.test(file.name)
        || (canImportElectronFallbackAudio() && ELECTRON_FALLBACK_AUDIO_EXTENSIONS.test(file.name));
}

function isAudioFileName(fileName: string): boolean {
    return BROWSER_AUDIO_EXTENSIONS.test(fileName)
        || (canImportElectronFallbackAudio() && ELECTRON_FALLBACK_AUDIO_EXTENSIONS.test(fileName));
}

function getFolderCoverPriority(fileName: string): number {
    return PREFERRED_FOLDER_COVER_FILES.indexOf(fileName.toLowerCase());
}

function getParentRelativePath(relativePath: string): string {
    const lastSlashIndex = relativePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? '' : relativePath.slice(0, lastSlashIndex);
}

function getAudioBasePath(relativePath: string): string {
    return relativePath.replace(KNOWN_AUDIO_EXTENSIONS, '');
}

function getSidecarLyricBasePath(relativePath: string, kind: 'lyric' | 'translationLyric'): string {
    const withoutLyricSuffix = kind === 'translationLyric'
        ? relativePath.replace(/\.t\.(lrc|vtt)$/i, '')
        : relativePath.replace(/\.(lrc|vtt|ttml|qrc|yrc|krc|fia)$/i, '');

    // Support both "track.lrc" and "track.mp3.lrc" style sidecar lyrics.
    return getAudioBasePath(withoutLyricSuffix);
}

// Sidecar lyric base paths whose winning file differs between two format orders. Only these
// tracks need their lyrics re-read after the user reorders formats.
function collectLyricBasePathsAffectedByFormatOrder(
    files: LocalLibrarySnapshotFile[],
    previousOrder: readonly LocalLyricFileFormat[],
    nextOrder: readonly LocalLyricFileFormat[],
): Set<string> {
    const pickWinners = (order: readonly LocalLyricFileFormat[]) => {
        const winners = new Map<string, { relativePath: string; priority: number; }>();
        files.forEach((file) => {
            if (file.kind !== 'lyric' && file.kind !== 'translationLyric') {
                return;
            }
            const key = `${file.kind}:${getSidecarLyricBasePath(file.relativePath, file.kind)}`;
            const priority = getLocalLyricFilePriority(file.name, order);
            const existing = winners.get(key);
            if (!existing || priority < existing.priority) {
                winners.set(key, { relativePath: file.relativePath, priority });
            }
        });
        return winners;
    };

    const previousWinners = pickWinners(previousOrder);
    const affected = new Set<string>();
    pickWinners(nextOrder).forEach((winner, key) => {
        if (previousWinners.get(key)?.relativePath !== winner.relativePath) {
            affected.add(key.slice(key.indexOf(':') + 1));
        }
    });
    return affected;
}

function getSnapshotFileKind(fileName: string): LocalLibrarySnapshotFile['kind'] {
    const lowerName = fileName.toLowerCase();
    if (TRANSLATION_LYRIC_EXTENSIONS.test(lowerName)) {
        return 'translationLyric';
    }
    if (LYRIC_EXTENSIONS.test(lowerName)) {
        return 'lyric';
    }
    if (getFolderCoverPriority(lowerName) !== -1) {
        return 'cover';
    }
    if (isAudioFileName(fileName)) {
        return 'audio';
    }
    return 'other';
}

function buildFileSignature(relativePath: string, size: number, lastModified: number): string {
    return `${relativePath}::${size}::${lastModified}`;
}

function hashString(input: string): string {
    let hash = SNAPSHOT_HASH_SEED;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashSnapshotNode(
    relativePath: string,
    files: LocalLibrarySnapshotFile[],
    children: LocalLibrarySnapshotNode[]
): string {
    const normalizedFiles = files
        .map(file => `${file.kind}:${file.relativePath}:${file.size}:${file.lastModified}`)
        .sort()
        .join('|');
    const normalizedChildren = children
        .map(child => `${child.relativePath}:${child.hash}`)
        .sort()
        .join('|');

    return hashString(`${relativePath}__${normalizedFiles}__${normalizedChildren}`);
}

function getDurationFromParsedMetadata(durationSeconds?: number): number {
    if (typeof durationSeconds !== 'number' || !isFinite(durationSeconds) || durationSeconds <= 0) {
        return 0;
    }

    return Math.round(durationSeconds * 1000);
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    };

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

async function extractEmbeddedMetadata(file: File, includeCover = false): Promise<EmbeddedMetadata> {
    const parsed = await parseEmbeddedMetadataAsync(file, includeCover);
    if (!parsed) {
        throw new Error('Metadata worker returned null');
    }
    return parsed;
}

async function buildSnapshotTree(
    handle: FileSystemDirectoryHandle,
    currentPath: string,
    rootFolderName: string,
    inheritedIgnoreMatchers: readonly FoliaIgnoreMatcher[],
    filesByPath = new Map<string, SnapshotTraversalFile>(),
    ignoredFolderPaths: ReadonlySet<string> = new Set(),
): Promise<SnapshotTraversalResult> {
    const files: LocalLibrarySnapshotFile[] = [];
    const children: LocalLibrarySnapshotNode[] = [];
    let relevantFileCount = 0;

    const directoryRelativePath = currentPath === rootFolderName
        ? ''
        : currentPath.slice(rootFolderName.length + 1);
    const childEntries: Array<FileSystemHandle> = [];

    try {
        // @ts-ignore
        for await (const entry of handle.values()) {
            childEntries.push(entry);
        }
    } catch (error) {
        console.warn(`[LocalMusic][Import] Skip unreadable directory "${currentPath}":`, error);

        return {
            tree: {
                name: handle.name,
                relativePath: currentPath,
                hash: hashSnapshotNode(currentPath, [], []),
                files: [],
                children: []
            },
            relevantFileCount: 0,
            filesByPath,
        };
    }

    childEntries.sort((a, b) => a.name.localeCompare(b.name));
    const ignoreHandle = childEntries.find(entry => entry.kind === 'file' && entry.name === '.foliaignore');
    const localIgnoreMatcher = await loadFoliaIgnoreMatcher(
        ignoreHandle as FileSystemFileHandle | undefined,
        directoryRelativePath,
        handle.name,
    );
    const ignoreMatchers = localIgnoreMatcher.ruleCount > 0
        ? [...inheritedIgnoreMatchers, localIgnoreMatcher]
        : inheritedIgnoreMatchers;

    // 先同步分流：被忽略目录、普通文件、待递归目录。目录递归原来是逐目录串行 await——
    // 每个目录一次 listNativeDirectory 桥往返（postMessage→content script→native），
    // 300+ 首歌的相册树几十次串行往返就是导入耗时大头；这里对兄弟目录做有界并发。
    const ignoredChildNodes: LocalLibrarySnapshotNode[] = [];
    const pendingFileEntries: FileSystemHandle[] = [];
    const pendingDirEntries: FileSystemHandle[] = [];
    for (const entry of childEntries) {
        if (entry.name === '.foliaignore') {
            continue;
        }

        const entryPath = `${currentPath}/${entry.name}`;
        if (entry.kind === 'directory' && ignoredFolderPaths.has(entryPath)) {
            ignoredChildNodes.push({ name: entry.name, relativePath: entryPath, ignored: true, hash: '', files: [], children: [] });
            continue;
        }
        const importRelativePath = entryPath.startsWith(`${rootFolderName}/`)
            ? entryPath.slice(rootFolderName.length + 1)
            : entryPath;
        if (isIgnoredByFoliaMatchers(ignoreMatchers, importRelativePath, entry.kind === 'directory')) {
            continue;
        }

        if (entry.kind === 'directory') {
            pendingDirEntries.push(entry);
            continue;
        }

        if (getSnapshotFileKind(entry.name) === 'other') {
            continue;
        }
        pendingFileEntries.push(entry);
    }

    for (const entry of pendingFileEntries) {
        const kind = getSnapshotFileKind(entry.name);
        const fileHandle = entry as FileSystemFileHandle;
        const relativePath = `${currentPath}/${entry.name}`;

        try {
            // 原生桥快路径：目录树条目已带音频 meta（原生 MediaMetadataRetriever 提取）时，
            // 不调 getFile()——那会把整音频字节 base64 经桥回传再在 JS 里解析，几百首歌极慢。
            // 直接用条目自带的 size/lastModified 建快照与签名；音频元数据后续随导入直接用。
            const nativeMeta = readNativeAudioMeta(fileHandle);
            if (kind === 'audio' && nativeMeta) {
                const stats = readNativeFileStats(fileHandle);
                const size = stats?.size ?? 0;
                const lastModified = stats?.lastModified ?? 0;
                files.push({
                    name: entry.name,
                    relativePath,
                    kind,
                    size,
                    lastModified,
                    signature: buildFileSignature(relativePath, size, lastModified)
                });
                filesByPath.set(relativePath, { handle: fileHandle, nativeAudioMeta: nativeMeta, nativeStats: stats });
                relevantFileCount += 1;
                continue;
            }

            // 原生源 lyric/cover 快路径：封面字节与歌词字节同样不进 JS。
            // cover 条目带 contentUri（SAF）→ 播放时直接 /cover?uri=... 同源出图；
            // lyric 条目只记相对路径 → 播放时按需 readNativeFile → decodeLyricFileBytes（KRC 解密复用）。
            const nativeStats = readNativeFileStats(fileHandle);
            if (nativeStats && kind !== 'audio') {
                files.push({
                    name: entry.name,
                    relativePath,
                    kind,
                    size: nativeStats.size,
                    lastModified: nativeStats.lastModified,
                    signature: buildFileSignature(relativePath, nativeStats.size, nativeStats.lastModified)
                });
                filesByPath.set(relativePath, {
                    handle: fileHandle,
                    nativeStats,
                    nativeContentUri: readNativeFileContentUri(fileHandle),
                });
                relevantFileCount += 1;
                continue;
            }

            const file = await fileHandle.getFile();
            const signature = buildFileSignature(relativePath, file.size, file.lastModified);

            files.push({
                name: file.name,
                relativePath,
                kind,
                size: file.size,
                lastModified: file.lastModified,
                signature
            });
            filesByPath.set(relativePath, { handle: fileHandle, file });
            relevantFileCount += 1;
        } catch (error) {
            console.warn(`[LocalMusic][Import] Skip unreadable file "${currentPath}/${entry.name}":`, error);
        }
    }

    // 主线程分块让出：每 100 个文件后让出一帧，避免 path 模式整库内存遍历卡顿 UI。
    if (pendingFileEntries.length > 100) {
        await new Promise(r => setTimeout(r, 0));
    }

    // 兄弟目录有界并发递归：每目录一次 listNativeDirectory 桥往返，并发 6 把串行等待重叠掉。
    const childResults = await mapWithConcurrency(
        pendingDirEntries,
        DIRECTORY_TRAVERSAL_CONCURRENCY,
        async (entry) => {
            const childPath = `${currentPath}/${entry.name}`;
            try {
                return await buildSnapshotTree(
                    entry as FileSystemDirectoryHandle,
                    childPath,
                    rootFolderName,
                    ignoreMatchers,
                    filesByPath,
                    ignoredFolderPaths,
                );
            } catch (error) {
                console.warn(`[LocalMusic][Import] Skip failed child directory "${childPath}":`, error);
                return null;
            }
        },
    );
    for (const childResult of childResults) {
        if (!childResult) {
            continue;
        }
        children.push(childResult.tree);
        relevantFileCount += childResult.relevantFileCount;
    }
    children.push(...ignoredChildNodes);

    const tree: LocalLibrarySnapshotNode = {
        name: handle.name,
        relativePath: currentPath,
        hash: hashSnapshotNode(currentPath, files, children),
        files,
        children
    };

    return { tree, relevantFileCount, filesByPath };
}

async function loadFoliaIgnoreMatcher(
    ignoreHandle: FileSystemFileHandle | undefined,
    baseDirectory: string,
    directoryName: string,
): Promise<FoliaIgnoreMatcher> {
    if (!ignoreHandle) {
        return createFoliaIgnoreMatcher('', baseDirectory);
    }

    try {
        const ignoreFile = await ignoreHandle.getFile();
        const matcher = createFoliaIgnoreMatcher(await ignoreFile.text(), baseDirectory);
        console.log(`[LocalMusic][Import] Loaded ${matcher.ruleCount} .foliaignore rules from "${directoryName}".`);
        return matcher;
    } catch (error) {
        console.warn(`[LocalMusic][Import] Failed to read .foliaignore from "${directoryName}":`, error);
        return createFoliaIgnoreMatcher('', baseDirectory);
    }
}

function flattenSnapshotFiles(node: LocalLibrarySnapshotNode, target = new Map<string, LocalLibrarySnapshotFile>()) {
    node.files.forEach(file => {
        target.set(file.relativePath, file);
    });
    node.children.forEach(child => flattenSnapshotFiles(child, target));
    return target;
}

async function collectImportDiffPlan(
    rootFolderName: string,
    dirHandle: FileSystemDirectoryHandle,
    existingSongs: LocalSong[],
    previousSnapshot: LocalLibrarySnapshot | null,
    lyricFormatOrder: LocalLyricFileFormat[]
): Promise<ImportDiffPlan> {
    const ignoredFolderPaths = previousSnapshot?.ignoredFolderPaths || [];
    const traversalResult = await buildSnapshotTree(dirHandle, rootFolderName, rootFolderName, [], new Map(), new Set(ignoredFolderPaths));
    const snapshot: LocalLibrarySnapshot = {
        rootFolderName,
        scannedAt: Date.now(),
        ignoredFolderPaths,
        lyricFormatOrder,
        tree: traversalResult.tree
    };

    const currentFiles = flattenSnapshotFiles(snapshot.tree);
    const previousFiles = previousSnapshot ? flattenSnapshotFiles(previousSnapshot.tree) : new Map<string, LocalLibrarySnapshotFile>();
    const existingSongsByPath = new Map(existingSongs.map(song => [song.filePath, song]));
    const currentAudioPaths = new Set<string>();
    const changedAudioPaths = new Set<string>();
    const changedLyricBasePaths = new Set<string>();
    // Subset of changedLyricBasePaths whose files changed on disk, as opposed to only being
    // re-ranked by a format order change. Only these may replace lyrics the user uploaded.
    const lyricFileChangedBasePaths = new Set<string>();
    const changedCoverFolders = new Set<string>();
    // Built in the same pass over the current files, so mapping a changed sidecar or folder cover
    // back to its tracks is a lookup instead of a scan of the whole library per path.
    const audioPathsByBasePath = new Map<string, string[]>();
    const audioPathsByFolder = new Map<string, string[]>();
    const appendToGroup = (groups: Map<string, string[]>, key: string, value: string) => {
        const group = groups.get(key);
        if (group) {
            group.push(value);
        } else {
            groups.set(key, [value]);
        }
    };
    const lyricCandidates = new Map<string, { file?: File; nativePath?: string; priority: number; format?: ExplicitFileTimedLyricFormat; }>();
    const translationLyricCandidates = new Map<string, { file?: File; nativePath?: string; priority: number; }>();
    const coverCandidates = new Map<string, { file?: File; nativeContentUri?: string; priority: number; }>();

    currentFiles.forEach((file) => {
        const previousFile = previousFiles.get(file.relativePath);
        const hasChanged = !previousFile || previousFile.signature !== file.signature || previousFile.kind !== file.kind;

        if (file.kind === 'audio') {
            currentAudioPaths.add(file.relativePath);
            appendToGroup(audioPathsByBasePath, getAudioBasePath(file.relativePath), file.relativePath);
            appendToGroup(audioPathsByFolder, getParentRelativePath(file.relativePath), file.relativePath);
            if (hasChanged || !existingSongsByPath.has(file.relativePath)) {
                changedAudioPaths.add(file.relativePath);
            }
            return;
        }

        if (hasChanged && (file.kind === 'lyric' || file.kind === 'translationLyric')) {
            const basePath = getSidecarLyricBasePath(file.relativePath, file.kind);
            changedLyricBasePaths.add(basePath);
            lyricFileChangedBasePaths.add(basePath);
        }

        if (file.kind === 'cover' && hasChanged) {
            changedCoverFolders.add(getParentRelativePath(file.relativePath));
        }
    });

    // Snapshots written before the order became configurable were scanned with the default order.
    const previousLyricFormatOrder = normalizeLocalLyricFormatOrder(previousSnapshot?.lyricFormatOrder);
    if (previousSnapshot && !isSameLocalLyricFormatOrder(previousLyricFormatOrder, lyricFormatOrder)) {
        collectLyricBasePathsAffectedByFormatOrder(Array.from(currentFiles.values()), previousLyricFormatOrder, lyricFormatOrder)
            .forEach(basePath => changedLyricBasePaths.add(basePath));
    }

    const previousAudioPaths = Array.from(previousFiles.values())
        .filter(file => file.kind === 'audio')
        .map(file => file.relativePath);

    previousAudioPaths.forEach((relativePath) => {
        if (!currentAudioPaths.has(relativePath)) {
            const removedSong = existingSongsByPath.get(relativePath);
            if (removedSong) {
                existingSongsByPath.delete(relativePath);
            }
        }
    });

    // "Track.mp3" and "Track.flac" share one sidecar, so every track with that base path is rebuilt.
    changedLyricBasePaths.forEach(basePath => {
        audioPathsByBasePath.get(basePath)?.forEach(audioPath => changedAudioPaths.add(audioPath));
    });

    previousFiles.forEach((file) => {
        if (file.kind === 'cover' && !currentFiles.has(file.relativePath)) {
            changedCoverFolders.add(getParentRelativePath(file.relativePath));
        }
    });

    changedCoverFolders.forEach(folderPath => {
        audioPathsByFolder.get(folderPath)?.forEach(audioPath => changedAudioPaths.add(audioPath));
    });

    const changedEntries: FileEntryForImport[] = [];
    const reusedSongs: LocalSong[] = [];
    const removedSongs = existingSongs.filter(song => !currentAudioPaths.has(song.filePath));
    const allRelevantFiles = Array.from(currentFiles.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    for (const snapshotFile of allRelevantFiles) {
        const traversedFile = traversalResult.filesByPath.get(snapshotFile.relativePath);
        if (!traversedFile) {
            console.warn(`[LocalMusic][Import] Missing traversed file handle for "${snapshotFile.relativePath}".`);
            continue;
        }

        // 歌词/翻译歌词/文件夹封面：web/Electron 路径已 getFile() 拿到真实 File；
        // 原生路径故意不读字节（file 为空），只记相对路径/contentUri，播放时按需取。
        // 两者都拿不到才算遍历异常，跳过。
        const isLyricOrCoverKind = snapshotFile.kind === 'lyric'
            || snapshotFile.kind === 'translationLyric'
            || snapshotFile.kind === 'cover';
        if (isLyricOrCoverKind && !traversedFile.file && !traversedFile.nativeStats) {
            console.warn(`[LocalMusic][Import] No readable File for lyric/cover "${snapshotFile.relativePath}".`);
            continue;
        }
        const sidecarFile = traversedFile.file;
        // 原生路径：候选只记相对路径（=snapshotFile.relativePath），字节留给播放时读。
        const nativeSidecarPath = sidecarFile ? undefined : snapshotFile.relativePath;

        const pathSegments = snapshotFile.relativePath.split('/');
        const fileName = pathSegments[pathSegments.length - 1];
        const folderName = pathSegments.slice(0, -1).join('/');

        if (snapshotFile.kind === 'lyric' || snapshotFile.kind === 'translationLyric') {
            const baseName = getSidecarLyricBasePath(snapshotFile.relativePath, snapshotFile.kind);
            const priority = getLocalLyricFilePriority(snapshotFile.name, lyricFormatOrder);
            const format = resolveExplicitFileTimedLyricFormat(snapshotFile.name);

            if (snapshotFile.kind === 'translationLyric') {
                const existingTranslationLyric = translationLyricCandidates.get(baseName);
                if (!existingTranslationLyric || priority < existingTranslationLyric.priority) {
                    translationLyricCandidates.set(baseName, { file: sidecarFile, nativePath: nativeSidecarPath, priority });
                }
            } else {
                const existingLyric = lyricCandidates.get(baseName);
                if (!existingLyric || priority < existingLyric.priority) {
                    lyricCandidates.set(baseName, { file: sidecarFile, nativePath: nativeSidecarPath, priority, format });
                }
            }
            continue;
        }

        if (snapshotFile.kind === 'cover') {
            const folderKey = getParentRelativePath(snapshotFile.relativePath);
            const priority = getFolderCoverPriority(snapshotFile.name);
            const existingCover = coverCandidates.get(folderKey);

            if (!existingCover || priority < existingCover.priority) {
                coverCandidates.set(folderKey, {
                    file: sidecarFile,
                    // 原生封面：带 SAF contentUri 时不读字节，/cover?uri=... 同源出图。
                    nativeContentUri: traversedFile.nativeContentUri,
                    priority,
                });
            }
            continue;
        }

        if (snapshotFile.kind !== 'audio') {
            continue;
        }

        const existingSong = existingSongsByPath.get(snapshotFile.relativePath);

        if (
            changedAudioPaths.has(snapshotFile.relativePath)
            || !existingSong
            || existingSong.embeddedMetadataVersion !== EMBEDDED_METADATA_VERSION
            || existingSong.localCoverNeedsAssetMigration
        ) {
            changedEntries.push({
                handle: traversedFile.handle,
                file: traversedFile.file,
                folderName,
                relativePath: snapshotFile.relativePath,
                sidecarLyricFilesChanged: lyricFileChangedBasePaths.has(getAudioBasePath(snapshotFile.relativePath)),
                nativeAudioMeta: traversedFile.nativeAudioMeta,
                nativeStats: traversedFile.nativeStats,
            });
            continue;
        }

        fileHandleMap.set(existingSong.id, traversedFile.handle);
        existingSong.fileHandle = traversedFile.handle;
        existingSong.fileSize = snapshotFile.size;
        existingSong.fileLastModified = snapshotFile.lastModified;
        existingSong.fileSignature = snapshotFile.signature;
        reusedSongs.push(existingSong);
    }

    return {
        changedEntries,
        reusedSongs,
        removedSongs,
        totalAudioFiles: currentAudioPaths.size,
        relevantFileCount: traversalResult.relevantFileCount,
        lrcMap: new Map(Array.from(lyricCandidates.entries()).map(([baseName, value]) => [baseName, { file: value.file, nativePath: value.nativePath, format: value.format }])),
        tlrcMap: new Map(Array.from(translationLyricCandidates.entries()).map(([baseName, value]) => [baseName, { file: value.file, nativePath: value.nativePath }])),
        coverMap: new Map(Array.from(coverCandidates.entries()).map(([folderKey, value]) => [folderKey, { file: value.file, nativeContentUri: value.nativeContentUri }])),
        snapshot
    };
}

async function buildImportedSong(
    entry: FileEntryForImport,
    lrcMap: Map<string, LocalLyricFileCandidate>,
    tlrcMap: Map<string, LocalLyricFileCandidate>,
    coverMap: Map<string, LocalCoverCandidate>,
    coverBlobCache: Map<string, Promise<PreparedLocalCoverBlob | undefined>>,
    includeEmbeddedMetadata = true,
    existingSong?: LocalSong
): Promise<{ song: LocalSong | null; metrics: ImportPreparationMetrics; }> {
    const fileHandle = entry.handle;
    const file = entry.file;
    const nativeMeta = entry.nativeAudioMeta;
    // 原生源且目录树已带 meta：故意不 getFile() 整字节回传，元数据直接用原生 MediaMetadataRetriever 结果。
    const isNativeMetaAudio = Boolean(nativeMeta);
    const fileName = file?.name ?? entry.relativePath.split('/').pop() ?? '';
    const getFileMs = 0;

    if (!isNativeMetaAudio && file && !isAudioFile(file)) {
        return {
            song: null,
            metrics: {
                getFileMs,
                lyricReadMs: 0,
                coverReadMs: 0,
                parseMetadataMs: 0,
                durationFallbackMs: 0,
                usedDurationFallback: false
            }
        };
    }

    const metadata = extractMetadataFromFilename(fileName);
    const baseName = getAudioBasePath(entry.relativePath);

    let localLyricsContent: string | undefined;
    let localLyricsFormat: ExplicitFileTimedLyricFormat | undefined;
    let localTranslationLyricsContent: string | undefined;
    const lyricReadStartedAt = performance.now();
    // Uploaded lyrics survive rescans (including a format order change) until a sidecar lyric of
    // this track changes on disk: whichever explicit action is newer wins.
    const keepUploadedLyrics = existingSong?.localLyricsOrigin === 'upload' && !entry.sidecarLyricFilesChanged;
    const keepUploadedTranslation = existingSong?.localTranslationLyricsOrigin === 'upload' && !entry.sidecarLyricFilesChanged;

    // 原生侧car懒加载路径：导入期不读字节，播放首次显示歌词时按需 readNativeFile → decodeLyricFileBytes。
    let pendingNativeSidecarLyricPath: string | undefined;
    let pendingNativeTranslationSidecarPath: string | undefined;

    // media 模式：快照音频项自带 sidecarPath（contentUri）——直接作为歌词懒加载路径，
    // 不依赖树内 sidecar 文件条目（media 快照里没有）。
    if (!pendingNativeSidecarLyricPath) {
        pendingNativeSidecarLyricPath = readNativeSidecarPath(fileHandle);
    }
    if (!pendingNativeTranslationSidecarPath) {
        pendingNativeTranslationSidecarPath = readNativeTranslationSidecarPath(fileHandle);
    }

    if (keepUploadedLyrics) {
        localLyricsContent = existingSong?.localLyricsContent;
        localLyricsFormat = existingSong?.localLyricsFormat;
    } else if (lrcMap.has(baseName)) {
        const lyricCandidate = lrcMap.get(baseName)!;
        if (lyricCandidate.nativePath && !lyricCandidate.file) {
            pendingNativeSidecarLyricPath = lyricCandidate.nativePath;
            localLyricsFormat = lyricCandidate.format;
        } else if (lyricCandidate.file) {
            try {
                localLyricsContent = await readLyricFile(lyricCandidate.file);
                localLyricsFormat = lyricCandidate.format;
            } catch (e) {
                console.error(`[LocalMusic] Failed to read local lyric for ${fileName}`, e);
            }
        }
    }

    if (keepUploadedTranslation) {
        localTranslationLyricsContent = existingSong?.localTranslationLyricsContent;
    } else if (tlrcMap.has(baseName)) {
        const translationCandidate = tlrcMap.get(baseName)!;
        if (translationCandidate.nativePath && !translationCandidate.file) {
            pendingNativeTranslationSidecarPath = translationCandidate.nativePath;
        } else if (translationCandidate.file) {
            try {
                localTranslationLyricsContent = await readLyricFile(translationCandidate.file);
            } catch (e) {
                console.error(`[LocalMusic] Failed to read local translation lyric for ${fileName}`, e);
            }
        }
    }
    const lyricReadMs = performance.now() - lyricReadStartedAt;

    let folderCover: PreparedLocalCoverBlob | undefined;
    let nativeCoverUrl: string | undefined;
    const coverReadStartedAt = performance.now();
    if (coverMap.has(entry.folderName)) {
        const coverEntry = coverMap.get(entry.folderName)!;
        if (coverEntry.nativeContentUri && !coverEntry.file) {
            // 原生封面：不读字节、不 staging；播放 UI 直接用 LocalHttpServer /cover?uri=... 出图。
            nativeCoverUrl = getNativeCoverUrl(coverEntry.nativeContentUri);
        } else if (coverEntry.file) {
            if (!coverBlobCache.has(entry.folderName)) {
                coverBlobCache.set(entry.folderName, (async () => {
                    try {
                        return (await prepareLocalCoverBlob(coverEntry.file!)) || undefined;
                    } catch (error) {
                        console.warn(`[LocalMusic] Failed to read folder cover for ${entry.folderName}:`, error);
                        return undefined;
                    }
                })());
            }
            folderCover = await coverBlobCache.get(entry.folderName)!;
        }
    } else {
        // media 模式：快照里没有封面文件条目，封面 uri 挂在每个音频条目上（同目录 cover.jpg）。
        const fileCoverUri = readNativeFileContentUri(fileHandle);
        if (fileCoverUri) nativeCoverUrl = getNativeCoverUrl(fileCoverUri, 512);
    }
    const coverReadMs = performance.now() - coverReadStartedAt;

    let embeddedMetadata: EmbeddedMetadata = {};
    let parseMetadataMs = 0;
    if (isNativeMetaAudio) {
        // 原生 MediaMetadataRetriever 已给齐 title/artist/album/duration(ms)/bitrate(bps)：
        // 不再 getFile() 回传整音频字节、也不再起 metadata worker 解析；v1 不提取内嵌封面。
        const meta = nativeMeta!;
        embeddedMetadata = {
            title: meta.title ?? undefined,
            artist: meta.artist ?? undefined,
            album: meta.album ?? undefined,
            duration: typeof meta.duration === 'number' ? meta.duration : undefined,
            bitrate: typeof meta.bitrate === 'number' ? meta.bitrate : undefined,
        };
    } else if (includeEmbeddedMetadata) {
        const parseMetadataStartedAt = performance.now();

        try {
            embeddedMetadata = await extractEmbeddedMetadata(file!, false);
        } catch (e) {
            console.warn(`[LocalMusic] Failed to parse metadata for ${fileName}:`, e);
        }
        parseMetadataMs = performance.now() - parseMetadataStartedAt;
    }

    let durationFallbackMs = 0;
    let usedDurationFallback = false;
    let duration = embeddedMetadata.duration || 0;
    if (!isNativeMetaAudio && includeEmbeddedMetadata && !duration) {
        usedDurationFallback = true;
        const durationFallbackStartedAt = performance.now();
        duration = await getAudioDuration(file!);
        durationFallbackMs = performance.now() - durationFallbackStartedAt;
    }

    const songId = existingSong?.id || generateId();
    const fileSize = file?.size ?? entry.nativeStats?.size ?? 0;
    const fileLastModified = file?.lastModified ?? entry.nativeStats?.lastModified ?? 0;
    const mimeType = file?.type ?? entry.nativeStats?.mimeType ?? '';
    const importedMetadata = buildImportedMetadataSnapshot({
        fileName,
        embeddedTitle: embeddedMetadata.title,
        fallbackTitle: metadata.title,
        embeddedArtist: embeddedMetadata.artist,
        embeddedArtists: embeddedMetadata.artists,
        fallbackArtist: metadata.artist,
        embeddedAlbum: embeddedMetadata.album,
    });
    const titleOrigin = existingSong?.titleOrigin || 'import';
    const localSong: LocalSong = {
        ...existingSong,
        id: songId,
        fileName,
        filePath: entry.relativePath,
        duration,
        fileSize,
        fileLastModified,
        fileSignature: buildFileSignature(entry.relativePath, fileSize, fileLastModified),
        mimeType,
        bitrate: embeddedMetadata.bitrate || 0,
        addedAt: existingSong?.addedAt || Date.now(),
        title: titleOrigin === 'import' ? importedMetadata.title : existingSong?.title || importedMetadata.title,
        titleOrigin,
        importedMetadata,
        onlineMetadata: existingSong?.onlineMetadata,
        trackNumber: embeddedMetadata.trackNumber,
        discNumber: embeddedMetadata.discNumber,
        localCoverAssetId: folderCover?.assetId,
        localCoverSource: folderCover ? 'folder' : (nativeCoverUrl ? 'folder' : undefined),
        localCoverNeedsAssetMigration: folderCover && !folderCover.assetId ? true : undefined,
        hasManualLyricSelection: existingSong?.hasManualLyricSelection ?? false,
        folderName: entry.folderName,
        // 原生侧car懒加载：内容未读也算「有本地歌词」，播放时按需填回 localLyricsContent。
        hasLocalLyrics: Boolean(localLyricsContent || pendingNativeSidecarLyricPath),
        localLyricsContent,
        localLyricsFormat: localLyricsContent || pendingNativeSidecarLyricPath ? localLyricsFormat : undefined,
        localLyricsOrigin: (localLyricsContent || pendingNativeSidecarLyricPath) ? (keepUploadedLyrics ? 'upload' : 'sidecar') : undefined,
        localSidecarLyricPath: pendingNativeSidecarLyricPath,
        hasLocalTranslationLyrics: Boolean(localTranslationLyricsContent || pendingNativeTranslationSidecarPath),
        localTranslationLyricsContent,
        localTranslationLyricsOrigin: (localTranslationLyricsContent || pendingNativeTranslationSidecarPath) ? (keepUploadedTranslation ? 'upload' : 'sidecar') : undefined,
        localTranslationSidecarLyricPath: pendingNativeTranslationSidecarPath,
        nativeCoverUrl,
        hasEmbeddedLyrics: !!embeddedMetadata.lyrics,
        embeddedLyricsContent: embeddedMetadata.lyrics,
        hasEmbeddedTranslationLyrics: !!embeddedMetadata.translationLyrics,
        embeddedTranslationLyricsContent: embeddedMetadata.translationLyrics,
        replayGain: embeddedMetadata.replayGain,
        replayGainTrackGain: embeddedMetadata.replayGainTrackGain,
        replayGainTrackPeak: embeddedMetadata.replayGainTrackPeak,
        replayGainAlbumGain: embeddedMetadata.replayGainAlbumGain,
        replayGainAlbumPeak: embeddedMetadata.replayGainAlbumPeak,
        matchedLyrics: existingSong?.matchedLyrics,
        matchedIsPureMusic: existingSong?.matchedIsPureMusic,
        markedPureMusic: existingSong?.markedPureMusic,
        matchedLyricsSongId: existingSong?.matchedLyricsSongId,
        matchedLyricsSource: existingSong?.matchedLyricsSource,
        matchedLyricsProviderPlatform: existingSong?.matchedLyricsProviderPlatform,
        noAutoMatch: existingSong?.noAutoMatch,
        lyricsSource: existingSong?.lyricsSource,
        useOnlineCover: existingSong?.useOnlineCover,
    };

    fileHandleMap.set(songId, fileHandle);
    localSong.fileHandle = fileHandle;

    return {
        song: localSong,
        metrics: {
            getFileMs,
            lyricReadMs,
            coverReadMs,
            parseMetadataMs,
            durationFallbackMs,
            usedDurationFallback
        }
    };
}

async function hydrateSongMetadata(song: LocalSong): Promise<LocalSong> {
    const fileHandle = fileHandleMap.get(song.id) || song.fileHandle;
    if (!fileHandle) {
        return song;
    }

    // 原生桥快路径：目录树已带 meta 的歌曲，后台 hydrate 不再 getFile() 整字节回传 + worker 解析。
    // v1 不提取内嵌封面（封面降级点：原生 meta 路径下歌曲封面只能走文件夹封面/在线封面，不读内嵌图）。
    const nativeMeta = readNativeAudioMeta(fileHandle);
    if (nativeMeta) {
        const stats = readNativeFileStats(fileHandle);
        if (stats) {
            song.fileSize = stats.size;
            song.fileLastModified = stats.lastModified;
            if (stats.mimeType) song.mimeType = stats.mimeType;
        }
        if (typeof nativeMeta.duration === 'number' && nativeMeta.duration > 0) {
            song.duration = nativeMeta.duration;
        }
        if (typeof nativeMeta.bitrate === 'number' && nativeMeta.bitrate > 0) {
            song.bitrate = nativeMeta.bitrate;
        }
        const filenameMetadata = extractMetadataFromFilename(song.fileName);
        song.importedMetadata = buildImportedMetadataSnapshot({
            fileName: song.fileName,
            embeddedTitle: nativeMeta.title ?? undefined,
            fallbackTitle: filenameMetadata.title,
            embeddedArtist: nativeMeta.artist ?? undefined,
            embeddedArtists: undefined,
            fallbackArtist: filenameMetadata.artist,
            embeddedAlbum: nativeMeta.album ?? undefined,
        });
        if (song.titleOrigin === 'import') song.title = song.importedMetadata.title;
        song.embeddedMetadataVersion = EMBEDDED_METADATA_VERSION;
        return song;
    }

    try {
        const file = await fileHandle.getFile();
        const includeCover = song.localCoverSource !== 'folder';
        let embeddedMetadata: EmbeddedMetadata;
        let coverHydrationFailed = false;

        try {
            embeddedMetadata = await extractEmbeddedMetadata(file, includeCover);
        } catch (coverError) {
            if (!includeCover) throw coverError;
            coverHydrationFailed = true;
            console.warn(`[LocalMusic][Import] Cover-aware metadata parsing failed for ${song.fileName}; retrying without covers.`, coverError);
            embeddedMetadata = await extractEmbeddedMetadata(file, false);
        }

        song.duration = embeddedMetadata.duration || song.duration || 0;
        song.fileSize = file.size;
        // Kept in step with fileSize: buildLocalSourceRevision reads both, so refreshing only one
        // makes every cached playback representation look stale and re-transcode on each play.
        song.fileLastModified = file.lastModified;
        song.mimeType = file.type;
        song.bitrate = embeddedMetadata.bitrate || song.bitrate || 0;
        const filenameMetadata = extractMetadataFromFilename(file.name);
        song.importedMetadata = buildImportedMetadataSnapshot({
            fileName: file.name,
            embeddedTitle: embeddedMetadata.title,
            fallbackTitle: filenameMetadata.title,
            embeddedArtist: embeddedMetadata.artist,
            embeddedArtists: embeddedMetadata.artists,
            fallbackArtist: filenameMetadata.artist,
            embeddedAlbum: embeddedMetadata.album,
        });
        if (song.titleOrigin === 'import') song.title = song.importedMetadata.title;
        song.trackNumber = embeddedMetadata.trackNumber;
        song.discNumber = embeddedMetadata.discNumber;
        song.embeddedMetadataVersion = EMBEDDED_METADATA_VERSION;
        song.hasEmbeddedLyrics = !!embeddedMetadata.lyrics;
        song.embeddedLyricsContent = embeddedMetadata.lyrics;
        song.hasEmbeddedTranslationLyrics = !!embeddedMetadata.translationLyrics;
        song.embeddedTranslationLyricsContent = embeddedMetadata.translationLyrics;
        song.replayGain = embeddedMetadata.replayGain;
        song.replayGainTrackGain = embeddedMetadata.replayGainTrackGain;
        song.replayGainTrackPeak = embeddedMetadata.replayGainTrackPeak;
        song.replayGainAlbumGain = embeddedMetadata.replayGainAlbumGain;
        song.replayGainAlbumPeak = embeddedMetadata.replayGainAlbumPeak;
        if (includeCover) {
            stageLocalCoverAsset(embeddedMetadata.coverAssetId, embeddedMetadata.cover);
            song.localCoverAssetId = embeddedMetadata.coverAssetId;
            song.localCoverSource = embeddedMetadata.cover ? 'embedded' : undefined;
            song.localCoverNeedsAssetMigration = coverHydrationFailed ? true : undefined;
        }
    } catch (error) {
        console.warn(`[LocalMusic][Import] Failed to hydrate metadata for ${song.fileName}:`, error);
    }

    return song;
}

const removedRootGenerations = new Map<string, number>();

async function hydrateImportedSongsInBackground(rootFolderName: string, songs: LocalSong[]) {
    const rootGeneration = removedRootGenerations.get(rootFolderName);
    const hydrationStartedAt = performance.now();
    const pendingBatch: LocalSong[] = [];
    let savedCount = 0;
    let nextIndex = 0;
    let flushInFlight: Promise<void> | null = null;

    notifyLocalMusicScanProgress({
        active: true,
        folderName: rootFolderName,
        totalSongs: songs.length,
        completedSongs: 0
    });

    const flushBatch = async (forceNotify = false) => {
        while (flushInFlight) {
            await flushInFlight;
        }
        if (pendingBatch.length === 0) {
            return;
        }

        const batch = pendingBatch.splice(0, pendingBatch.length);
        const currentFlush = (async () => {
            await runLocalFolderMutation(async () => {
                if (removedRootGenerations.get(rootFolderName) !== rootGeneration) return;
                const ignoredPaths = (await getLocalLibrarySnapshot(rootFolderName))?.ignoredFolderPaths || [];
                const visibleBatch = batch.filter(song => !isLocalFolderIgnored(song.folderName || song.filePath, ignoredPaths));
                if (visibleBatch.length > 0) await saveLocalSongs(visibleBatch);
            });
            savedCount += batch.length;
            if (forceNotify || savedCount % HYDRATION_REFRESH_EVERY === 0 || savedCount === songs.length) {
                notifyLocalMusicUpdated();
            }
            notifyLocalMusicScanProgress({
                active: true,
                folderName: rootFolderName,
                totalSongs: songs.length,
                completedSongs: savedCount
            });
            console.log(`[LocalMusic][Import] Background metadata hydration saved ${savedCount}/${songs.length} songs for "${rootFolderName}".`);
        })();
        flushInFlight = currentFlush;
        try {
            await currentFlush;
        } finally {
            if (flushInFlight === currentFlush) {
                flushInFlight = null;
            }
        }
    };

    const worker = async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= songs.length) {
                return;
            }

            const hydratedSong = await hydrateSongMetadata(songs[currentIndex]);

            pendingBatch.push(hydratedSong);

            if (pendingBatch.length >= HYDRATION_BATCH_SIZE) {
                await flushBatch();
            }
        }
    };

    try {
        const workerCount = Math.min(IMPORT_CONCURRENCY, songs.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        while (pendingBatch.length > 0) {
            await flushBatch(true);
        }
        if (flushInFlight) {
            await flushInFlight;
        }
        console.log(`[LocalMusic][Import] Background metadata hydration for "${rootFolderName}" finished in ${formatImportDuration(performance.now() - hydrationStartedAt)}.`);
    } finally {
        notifyLocalMusicScanProgress({
            active: false,
            folderName: rootFolderName,
            totalSongs: songs.length,
            completedSongs: savedCount
        });
    }
}


// Import folder using File System Access API (if supported)
export async function importFolder(expectedRootName?: string, preloadedSnapshot?: NativeSnapshot | null): Promise<LocalSong[]> {
    // Request access in the user gesture before waiting for other library writes.
    try {
        // snapshot（壳层 MediaStore 索引）直导：buildSnapshotVirtualHandle 内存树，零桥往返。
        // 每次启动都走一遍 importFolderContents（纯内存遍历，几百首毫秒级），由既有 pipeline
        // 对未变歌曲复用——不要"revision 命中就直接复用 IndexedDB"：句柄是进程内的，重启后
        // 不复用会得到一堆播不了的条目。
        let snapshot = preloadedSnapshot ?? await getNativeSnapshot(Boolean(expectedRootName));
        // 空快照 = 媒体库还没权限/系统扫描还没跑完。此时**不要**建空库把已有曲目覆盖掉，
        // 直接返回空让调用方保持现状（下次媒体库变更广播会再触发一次）。
        if (snapshot && snapshot.files.length === 0) {
            console.warn('[LocalMusic][Snapshot] 空快照，跳过导入（保留现有曲库）');
            return [];
        }
        if (snapshot) {
            const mode = snapshot.mode || 'saf';
            const revKey = `native_library_revision__${mode}`;
            const storedMode = ((): string | null => {
                try { return localStorage.getItem('native_library_mode'); } catch { return null; }
            })();
            if (storedMode && storedMode !== mode) {
                // 模式切换：路径标识空间不同（相对 vs 绝对），签名去重键会双份——整清旧模式条目。
                const old = await getLocalSongs();
                if (old.length) {
                    await dbDeleteLocalSongs(old.map(s => s.id));
                    console.log(`[LocalMusic][Snapshot] 索引模式 ${storedMode}→${mode}，已清旧条目 ${old.length}。`);
                }
            } else if (!storedMode) {
                // 升级后首次快照导入（bridge-11/12 旧根残留，如 folderName="本地音乐"）：一次性整清，
                // 防止"本地音乐"包装根与所选文件夹根并存。v1 标记只清一次。
                const migrated = ((): boolean => {
                    try { return localStorage.getItem('native_library_migrated_v1') === '1'; } catch { return true; }
                })();
                if (!migrated) {
                    const old = await getLocalSongs();
                    if (old.length) {
                        await dbDeleteLocalSongs(old.map(s => s.id));
                        console.log(`[LocalMusic][Snapshot] 升级首导：已清旧根残留 ${old.length} 首。`);
                    }
                }
                try { localStorage.setItem('native_library_migrated_v1', '1'); } catch { /* ignore */ }
            }
            const dirHandle = buildSnapshotVirtualHandle(snapshot);
            // 关键：给一个**稳定的根名**。importFolderContents 在没拿到 expectedRootName 时，
            // 会用 isSameEntry 去比对已持久化的句柄来判断"这是不是同一个根"——而虚拟句柄进
            // IndexedDB 后方法全丢，比对永远失败，于是每次启动都被当成新导入，根名被改成
            // "本地音乐 (2)"、"(3)"……全库按新 folderName 重导一遍。
            // 这正是"重启后要重新扫描、越扫越多"的根因：现在直接用快照下发的根名。
            const stableRootName = expectedRootName
                || (detectNativeLibrary() ? (snapshot.root || '本地音乐') : undefined);
            // 一次性清理历史遗留：上面那个 bug 会让过去的版本留下 "本地音乐 (2)"、"(3)" 这样的
            // 影子根，它们和主根是同一批文件。只在主根存在时清掉，并且只清一次。
            if (stableRootName && detectNativeLibrary()) {
                await cleanupShadowRootsOnce(stableRootName);
            }
            const songs = await runLocalFolderMutation(() => importFolderContents(dirHandle, stableRootName));
            try {
                localStorage.setItem(revKey, snapshot.revision);
                localStorage.setItem('native_library_mode', mode);
            } catch { /* ignore */ }
            return songs;
        }

        const dirHandle = await getImportDirectoryHandle(expectedRootName);
        if (!dirHandle) return [];
        return await runLocalFolderMutation(() => importFolderContents(dirHandle, expectedRootName));
    } catch (error) {
        if ((error as Error).name === 'AbortError') return [];
        throw error;
    }
}

/**
 * 一次性清理"影子根"：旧版本因句柄比对失败，会把同一批文件重复导入成
 * "本地音乐 (2)" / "(3)" 等根（folderName 前缀不同，内容完全一样）。
 *
 * 只在主根已经有歌时执行，且只执行一次；删的是重复条目，不是磁盘文件。
 */
async function cleanupShadowRootsOnce(canonicalRoot: string): Promise<void> {
    const FLAG = 'native_shadow_root_cleanup_v1';
    try { if (localStorage.getItem(FLAG) === '1') return; } catch { return; }

    const all = await getLocalSongs();
    const hasCanonical = all.some(song =>
        song.folderName === canonicalRoot || (song.folderName?.startsWith(`${canonicalRoot}/`) ?? false));
    if (!hasCanonical) return;

    const escaped = canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shadow = new RegExp(`^${escaped} \\(\\d+\\)(/|$)`);
    const ids = all
        .filter(song => song.folderName && shadow.test(song.folderName))
        .map(song => song.id);

    if (ids.length > 0) {
        console.log(`[LocalMusic][Snapshot] 清理历史影子根条目 ${ids.length} 首（同内容的重复导入）`);
        await deleteSongsByIds(ids);
    }
    try { localStorage.setItem(FLAG, '1'); } catch { /* ignore */ }
}

async function importFolderContents(dirHandle: FileSystemDirectoryHandle, expectedRootName?: string): Promise<LocalSong[]> {    try {
        const importStartedAt = performance.now();

        let rootFolderName = expectedRootName || dirHandle.name;
        let isRescanningExistingRoot = Boolean(expectedRootName);

        // If the picked directory is already imported, rescan the existing root instead of duplicating it.
        if (!expectedRootName) {
            const existingRootName = await findImportedRootForHandle(dirHandle);
            if (existingRootName) {
                rootFolderName = existingRootName;
                isRescanningExistingRoot = true;
                console.log(`[LocalMusic][Import] Directory "${dirHandle.name}" already imported as "${rootFolderName}", rescanning existing root.`);
            }
        }

        // If it's a new import (no expectedRootName), ensure the root folder name is unique
        if (!expectedRootName && !isRescanningExistingRoot) {
            const allSongs = await getLocalSongs();

            // Collect existing root folder names (the part before the first '/')
            const existingRootFolders = new Set(
                allSongs
                    .map(s => s.folderName)
                    .filter(Boolean)
                    .map(name => name!.split('/')[0])
            );

            let originalRootName = rootFolderName;
            let counter = 1;
            while (existingRootFolders.has(rootFolderName)) {
                counter++;
                rootFolderName = `${originalRootName} (${counter})`;
            }
        }

        const traversalStartedAt = performance.now();
        const allSongs = await getLocalSongs();
        const existingRootSongs = allSongs.filter(song =>
            song.folderName === rootFolderName || (song.folderName && song.folderName.startsWith(`${rootFolderName}/`))
        );
        const previousSnapshot = await getLocalLibrarySnapshot(rootFolderName);
        const diffPlan = await collectImportDiffPlan(
            rootFolderName,
            dirHandle,
            existingRootSongs,
            previousSnapshot,
            useLyricSettingsStore.getState().localLyricFormatOrder
        );
        console.log(`[LocalMusic][Import] Traversed ${diffPlan.relevantFileCount} relevant files in ${formatImportDuration(performance.now() - traversalStartedAt)}.`);

        // Save directory handle for persistence after a successful scan plan is built
        try {
            const { getDirHandles, saveDirHandles } = await import('./db');
            const dirHandles = await getDirHandles();
            dirHandles[rootFolderName] = dirHandle;
            await saveDirHandles(dirHandles);
            console.log(`[LocalMusic] Saved directory handle for ${rootFolderName}`);
        } catch (e) {
            console.error('[LocalMusic] Failed to save directory handle:', e);
        }

        const lyricIndexStartedAt = performance.now();
        console.log(`[LocalMusic][Import] Indexed ${diffPlan.lrcMap.size} lyric files, ${diffPlan.tlrcMap.size} translated lyric files, and ${diffPlan.coverMap.size} folder cover files in ${formatImportDuration(performance.now() - lyricIndexStartedAt)}.`);
        console.log(`[LocalMusic][Import] Snapshot diff for "${rootFolderName}": ${diffPlan.changedEntries.length} changed/new audio files, ${diffPlan.reusedSongs.length} unchanged audio files, ${diffPlan.removedSongs.length} removed audio files.`);

        // Second pass: Process audio files with limited concurrency
        const metadataStartedAt = performance.now();
        const existingSongsByPath = new Map(existingRootSongs.map(song => [song.filePath, song]));
        const coverBlobCache = new Map<string, Promise<PreparedLocalCoverBlob | undefined>>();
        const processedSongs = await mapWithConcurrency(diffPlan.changedEntries, IMPORT_CONCURRENCY, async (entry) => {
            try {
                return await buildImportedSong(
                    entry,
                    diffPlan.lrcMap,
                    diffPlan.tlrcMap,
                    diffPlan.coverMap,
                    coverBlobCache,
                    false,
                    existingSongsByPath.get(entry.relativePath)
                );
            } catch (error) {
                console.error(`Failed to import file ${entry.relativePath}:`, error);
                return {
                    song: null,
                    metrics: {
                        getFileMs: 0,
                        lyricReadMs: 0,
                        coverReadMs: 0,
                        parseMetadataMs: 0,
                        durationFallbackMs: 0,
                        usedDurationFallback: false
                    }
                };
            }
        });

        const songsToPersist = processedSongs
            .map(result => result.song)
            .filter((song): song is LocalSong => song !== null);
        const aggregateMetrics = processedSongs.reduce((acc, result) => {
            acc.getFileMs += result.metrics.getFileMs;
            acc.lyricReadMs += result.metrics.lyricReadMs;
            acc.coverReadMs += result.metrics.coverReadMs;
            acc.parseMetadataMs += result.metrics.parseMetadataMs;
            acc.durationFallbackMs += result.metrics.durationFallbackMs;
            acc.durationFallbackCount += result.metrics.usedDurationFallback ? 1 : 0;
            return acc;
        }, {
            getFileMs: 0,
            lyricReadMs: 0,
            coverReadMs: 0,
            parseMetadataMs: 0,
            durationFallbackMs: 0,
            durationFallbackCount: 0
        });
        console.log(`[LocalMusic][Import] Prepared ${songsToPersist.length} changed audio files with concurrency=${IMPORT_CONCURRENCY} in ${formatImportDuration(performance.now() - metadataStartedAt)}.`);
        console.log(
            `[LocalMusic][Import] Preparation breakdown: getFile=${formatImportDuration(aggregateMetrics.getFileMs)}, ` +
            `lyrics=${formatImportDuration(aggregateMetrics.lyricReadMs)}, ` +
            `folderCover=${formatImportDuration(aggregateMetrics.coverReadMs)}, ` +
            `parseBlob=${formatImportDuration(aggregateMetrics.parseMetadataMs)}, ` +
            `durationFallback=${formatImportDuration(aggregateMetrics.durationFallbackMs)} ` +
            `(${aggregateMetrics.durationFallbackCount} files).`
        );

        if (diffPlan.removedSongs.length > 0) {
            for (const song of diffPlan.removedSongs) {
                fileHandleMap.delete(song.id);
                await dbDeleteLocalSong(song.id);
            }
        }

        const importedSongs = [...diffPlan.reusedSongs];
        try {
            const persistStartedAt = performance.now();
            await saveLocalSongs(songsToPersist);
            await saveLocalLibrarySnapshot(diffPlan.snapshot);
            console.log(`[LocalMusic][Import] Persisted ${songsToPersist.length} changed songs in ${formatImportDuration(performance.now() - persistStartedAt)}.`);
            importedSongs.push(...songsToPersist);
        } catch (saveError) {
            console.error('Failed to save imported songs:', saveError);
            songsToPersist.forEach(song => fileHandleMap.delete(song.id));
            throw saveError;
        }

        console.log(`[LocalMusic][Import] Finished importing "${rootFolderName}" with ${importedSongs.length}/${diffPlan.totalAudioFiles} available songs in ${formatImportDuration(performance.now() - importStartedAt)}.`);
        notifyLocalMusicUpdated();
        void hydrateImportedSongsInBackground(rootFolderName, songsToPersist).catch(error => {
            console.error(`[LocalMusic][Import] Background metadata hydration failed for "${rootFolderName}":`, error);
        });

        return importedSongs;
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            // User cancelled the picker
            return [];
        }
        throw error;
    }
}

// Helper function to normalize title for comparison
function normalizeTitle(title: string): string {
    return normalizeLyricMatchText(title).replace(/\s+/g, '');
}

// Helper function to check if two titles match
function isTitleMatch(localTitle: string, searchTitle: string): boolean {
    const normalizedLocal = normalizeTitle(localTitle);
    const normalizedSearch = normalizeTitle(searchTitle);

    // Check for exact match first
    if (normalizedLocal === normalizedSearch) {
        return true;
    }

    // Check if either title contains the other (for fuzzy matching)
    // This helps when local file is "Title-Artist" but search result is just "Title"
    if (normalizedLocal.includes(normalizedSearch) || normalizedSearch.includes(normalizedLocal)) {
        // Additional check: the shorter one should be at least 50% of the longer one
        // to avoid matching "a" with "abc"
        const minLength = Math.min(normalizedLocal.length, normalizedSearch.length);
        const maxLength = Math.max(normalizedLocal.length, normalizedSearch.length);
        if (minLength / maxLength >= 0.5) {
            return true;
        }
    }

    return false;
}

// Match lyrics for a local song using search API, respecting the configured local/online priority.
// 某些网易云搜索接口（旧版 /api/search/get/web）只回 album.picId、不回 album.picUrl，
// 匹配到的歌曲因此没有封面（歌词走另一接口所以照常秒到）。缺封面时补拉一次歌曲详情
// （/song/detail 回 album.picUrl）把封面补上；只在确实缺封面时触发，正常路径零额外请求。
const resolveMatchedCoverFallback = async (
    source: string,
    songId: number | string | undefined,
    coverUrl: string | undefined,
): Promise<string | undefined> => {
    if (coverUrl || source !== 'netease') return coverUrl;
    const numericId = Number(songId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return coverUrl;
    try {
        const detail = await getOnlineMusicProvider('netease')?.playback?.getSongDetail?.(numericId);
        const detailCover = detail ? getProviderSongMetadata(detail, 'netease').coverUrl : undefined;
        if (detailCover) {
            console.log(`[LocalMusic] Cover resolved from song detail for netease/${numericId}`);
            return detailCover.replace('http:', 'https:');
        }
        console.log(`[LocalMusic] Song detail for netease/${numericId} carries no cover either`);
    } catch (error) {
        console.warn('[LocalMusic] Failed to resolve cover from song detail:', error);
    }
    return coverUrl;
};

export async function matchLyrics(song: LocalSong): Promise<LyricData | null> {
    // 用户标记的纯音乐不再自动匹配；与在线判定的纯音乐一样，连带的封面自动匹配也跳过。
    // 下面每次写回都带 skipIfMarkedPureMusic：匹配途中才标上的，写回时在事务里按库里的最新记录放弃。
    if (song.markedPureMusic || (song.matchedIsPureMusic && !shouldRefreshLocalSongLyricsFromMetadata(song))) {
        return null;
    }
    try {
        const catalog = await getLocalLibraryCatalogSnapshot();
        const resolvedMetadata = resolveLocalSongMetadata(song.id, catalog);
        const matchContext = buildLocalSongLyricMatchContext(song, {
            artistNames: resolvedMetadata.artists.map(artist => artist.name),
            albumName: resolvedMetadata.album?.name,
        });
        const searchQuery = buildLyricSearchQuery(matchContext.title, matchContext.artist, matchContext.album);
        const hasLocalOrEmbeddedLyrics = Boolean(
            (song.hasLocalLyrics && song.localLyricsContent)
            || (song.hasEmbeddedLyrics && song.embeddedLyricsContent)
        );
  const settingsLyricSettings = useLyricSettingsStore.getState();
        const onlineFirst = settingsLyricSettings.localLyricsPriority === 'online';

        console.log(`[LocalMusic] Searching lyrics for: "${searchQuery}"`);

        // A selected GridView metadata identity is authoritative and must not be replaced by lyric fallback metadata.
        if (!hasLocalOrEmbeddedLyrics || onlineFirst) {
            const shouldUseBestLyric = settingsLyricSettings.autoUseBestLyric;
            if (shouldUseBestLyric || matchContext.metadataCandidate) {
                const bestMatch = await autoMatchBestLyric(
                    matchContext.title,
                    matchContext.artist,
                    matchContext.durationMs,
                    {
                        album: matchContext.album,
                        preferredSource: shouldUseBestLyric ? settingsLyricSettings.preferredAlternativeLyricSource : undefined,
                        metadataCandidate: matchContext.metadataCandidate,
                        exactMatchOnly: Boolean(matchContext.metadataCandidate && !shouldUseBestLyric),
                    },
                );

                if (bestMatch && 'isPureMusic' in bestMatch) {
                    song.matchedIsPureMusic = true;
                    song.matchedLyrics = undefined;
                    song.matchedLyricsSongId = bestMatch.id ?? matchContext.metadataCandidate?.songId;
                    song.matchedLyricsSource = bestMatch.source ?? matchContext.metadataCandidate?.source;
                    await applyMatchedMetadata(song.id, {}, { lyricsOnly: true, songPatch: song, skipIfMarkedPureMusic: true });
                    return null;
                }

                if (bestMatch && 'lyrics' in bestMatch) {
                    song.matchedLyricsSongId = bestMatch.id;
                    song.matchedLyricsSource = bestMatch.source;
                    song.matchedLyricsProviderPlatform = bestMatch.matchedLyricsProviderPlatform;
                    song.matchedLyrics = bestMatch.lyrics;
                    song.matchedIsPureMusic = false;

                    if (matchContext.metadataCandidate) {
                        await applyMatchedMetadata(song.id, {}, { lyricsOnly: true, songPatch: song, skipIfMarkedPureMusic: true });
                        return bestMatch.lyrics;
                    }

                    const matchedMetadata = normalizeLyricMatchMetadataCandidate(
                        bestMatch.source,
                        bestMatch.song,
                        {
                            title: matchContext.title,
                            artist: matchContext.artist,
                            album: matchContext.album,
                            durationMs: matchContext.durationMs,
                        },
                    );
                    const coverUrl = await resolveMatchedCoverFallback(
                        matchedMetadata.source,
                        matchedMetadata.songId,
                        matchedMetadata.coverUrl,
                    );
                    await applyMatchedMetadata(song.id, {
                        source: matchedMetadata.source,
                        songId: matchedMetadata.songId,
                        title: matchedMetadata.title,
                        artists: matchedMetadata.artists,
                        album: matchedMetadata.album,
                        coverUrl,
                    }, {
                        songPatch: {
                            ...song,
                            useOnlineCover: Boolean(coverUrl && !hasLocalSongCover(song)),
                        },
                        protectOrigins: ['manual', 'manual-match', 'split'],
                        skipIfMarkedPureMusic: true,
                    });
                    return bestMatch.lyrics;
                }
            }
        } else if (matchContext.metadataCandidate) {
            return null;
        }

        // Search on Netease
        const searchPage = await getOnlineMusicProvider('netease')?.search?.searchSongs(searchQuery, 50, 0);

        if (!searchPage?.items?.length) {
            console.warn(`[LocalMusic] No search results for: "${searchQuery}"`);
            return null;
        }

        // Try to find a song with matching title
        const localTitle = matchContext.title;
        const matchedSong = searchPage.items.find(candidate => isTitleMatch(localTitle, candidate.name));

        // If no exact title match found, return null to trigger manual selection
        if (!matchedSong) {
            console.log(`[LocalMusic] No exact title match found for: "${localTitle}". Manual selection required.`);
            return null;
        }

        const matchedMetadata = getProviderSongMetadata(matchedSong, 'netease');
        console.log(`[LocalMusic] Found exact title match: ${matchedSong.name} by ${matchedMetadata.artists.map(artist => artist.name).join(', ')}`);

        // Preserve local and embedded lyrics when the configured priority keeps them first.
        if (!onlineFirst && ((song.hasLocalLyrics && song.localLyricsContent) || (song.hasEmbeddedLyrics && song.embeddedLyricsContent))) {
            console.log(`[LocalMusic] Local/embedded lyrics exist, skipping online lyrics fetch. Only fetching cover/metadata.`);

            // Only update metadata and cover, preserve local lyrics
            const coverUrl = await resolveMatchedCoverFallback('netease', matchedSong.id, matchedMetadata.coverUrl);
            await applyMatchedMetadata(song.id, {
                source: 'netease',
                songId: matchedSong.id,
                title: matchedSong.name,
                artists: matchedMetadata.artists,
                album: matchedMetadata.album,
                coverUrl: coverUrl?.replace('http:', 'https:'),
            }, {
                songPatch: { ...song, useOnlineCover: Boolean(coverUrl && !hasLocalSongCover(song)) },
                protectOrigins: ['manual', 'manual-match', 'split'],
                skipIfMarkedPureMusic: true,
            });

            // Return null to indicate no NEW lyrics were fetched (local lyrics are used)
            return null;
        }

        // Fetch lyrics (only when NO local lyrics)
        const processed = await getOnlineMusicProvider('netease')?.lyrics?.getLyrics(matchedSong);
        if (!processed) return null;

        song.matchedLyricsSongId = matchedSong.id;
        song.matchedLyricsSource = 'netease';
        song.matchedLyrics = processed.lyrics || undefined;
        song.matchedIsPureMusic = processed.isPureMusic;

        if (matchContext.metadataCandidate) {
            await applyMatchedMetadata(song.id, {}, { lyricsOnly: true, songPatch: song, skipIfMarkedPureMusic: true });
            return processed.lyrics;
        }

        const coverUrl = await resolveMatchedCoverFallback('netease', matchedSong.id, matchedMetadata.coverUrl);
        await applyMatchedMetadata(song.id, {
            source: 'netease',
            songId: matchedSong.id,
            title: matchedSong.name,
            artists: matchedMetadata.artists,
            album: matchedMetadata.album,
            coverUrl: coverUrl?.replace('http:', 'https:'),
        }, {
            songPatch: { ...song, useOnlineCover: Boolean(coverUrl && !hasLocalSongCover(song)) },
            protectOrigins: ['manual', 'manual-match', 'split'],
            skipIfMarkedPureMusic: true,
        });
        return processed.lyrics;
    } catch (error) {
        console.error('[LocalMusic] Failed to match lyrics:', error);
        return null;
    }
}

// Delete local song
export async function deleteLocalSong(id: string): Promise<void> {
    // Remove fileHandle from memory
    fileHandleMap.delete(id);
    await Promise.all([
        dbDeleteLocalSong(id),
        removeCachedCover(`cover_local_${id}`),
    ]);
}

function getRootFolderName(song: LocalSong): string | null {
    const pathLike = song.filePath || song.folderName;
    if (!pathLike) return null;

    const [rootFolderName] = pathLike.split('/');
    return rootFolderName || null;
}

async function resolveFileHandleFromDirHandle(
    dirHandle: FileSystemDirectoryHandle,
    relativePathFromRoot: string
): Promise<FileSystemFileHandle> {
    const pathSegments = relativePathFromRoot.split('/').filter(Boolean);
    if (pathSegments.length === 0) {
        throw new Error('Cannot resolve a file handle from an empty path.');
    }

    const fileName = pathSegments[pathSegments.length - 1];
    const directorySegments = pathSegments.slice(0, -1);

    let currentDir = dirHandle;
    for (const segment of directorySegments) {
        currentDir = await currentDir.getDirectoryHandle(segment);
    }

    return await currentDir.getFileHandle(fileName);
}

async function recoverFileHandleFromPersistedDirectory(song: LocalSong): Promise<FileSystemFileHandle | null> {
    const rootFolderName = getRootFolderName(song);
    if (!rootFolderName || !song.filePath) {
        return null;
    }

    // 原生壳：虚拟句柄进 IndexedDB 只剩字段、方法丢光（结构化克隆），不能拿来当 FileSystemHandle 用。
    // 直接按曲库内相对路径去新快照里取一个，比重走持久化句柄那条路更短也更可靠。
    if (detectNativeLibrary()) {
        try {
            const snapshot = await getNativeSnapshot();
            if (!snapshot) return null;
            const relativePathFromRoot = song.filePath.startsWith(`${rootFolderName}/`)
                ? song.filePath.slice(rootFolderName.length + 1)
                : song.filePath;
            const handle = findNativeFileHandle(snapshot, relativePathFromRoot);
            if (handle) {
                fileHandleMap.set(song.id, handle);
                song.fileHandle = handle;
            }
            return handle;
        } catch (error) {
            console.warn(`[LocalMusic] Native handle recovery failed for ${song.filePath}:`, error);
            return null;
        }
    }

    const dirHandles = await getDirHandles();
    const rootDirHandle = dirHandles[rootFolderName];
    if (!rootDirHandle) {
        return null;
    }

    const permissionAwareHandle = rootDirHandle as FileSystemDirectoryHandle & {
        queryPermission: (descriptor: { mode: 'read' | 'readwrite'; }) => Promise<PermissionState>;
    };
    const permission = await permissionAwareHandle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
        return null;
    }

    const relativePathFromRoot = song.filePath.startsWith(`${rootFolderName}/`)
        ? song.filePath.slice(rootFolderName.length + 1)
        : song.filePath;

    try {
        const recoveredHandle = await resolveFileHandleFromDirHandle(rootDirHandle, relativePathFromRoot);
        fileHandleMap.set(song.id, recoveredHandle);
        song.fileHandle = recoveredHandle;
        await saveLocalSong(song);
        return recoveredHandle;
    } catch (error) {
        console.warn(`[LocalMusic] Failed to recover file handle for ${song.filePath}:`, error);
        return null;
    }
}

async function getAccessibleFileHandle(song: LocalSong): Promise<FileSystemFileHandle | null> {
    let fileHandle = fileHandleMap.get(song.id);

    if (!fileHandle && song.fileHandle) {
        fileHandle = song.fileHandle;
        fileHandleMap.set(song.id, fileHandle);
    }

    if (fileHandle) {
        return fileHandle;
    }

    return await recoverFileHandleFromPersistedDirectory(song);
}

async function cleanupDirHandleIfUnused(rootFolderName: string): Promise<void> {
    if ((await getLocalLibrarySnapshot(rootFolderName))?.ignoredFolderPaths?.length) return;
    const allSongs = await getLocalSongs();
    const stillUsed = allSongs.some(song => {
        const songRoot = getRootFolderName(song);
        return songRoot === rootFolderName;
    });

    if (!stillUsed) {
        await deleteDirHandle(rootFolderName);
        await deleteLocalLibrarySnapshot(rootFolderName);
        console.log(`[LocalMusic] Removed persisted directory handle for ${rootFolderName}`);
    }
}

// Get audio blob from local song using fileHandle
// Returns blob URL if fileHandle exists, null otherwise
export async function getAudioFromLocalSong(song: LocalSong): Promise<string | null> {
    const fileHandle = await getAccessibleFileHandle(song);

    if (fileHandle) {
        // 原生壳快路径：直接给同源 /local 流式 URL。支持 Range，<audio> 边下边播、拖动进度条；
        // 不再把整首歌 base64 过桥再打补丁建 Blob（一首无损在车机上要几秒，且同时占三份内存）。
        const nativeKey = readNativeRelativePath(fileHandle);
        if (nativeKey) return getNativeMediaUrl(nativeKey);

        try {
            const file = await fileHandle.getFile();
            return await getAudioFromFile(file);
        } catch (error) {
            console.error('[LocalMusic] Failed to get file from handle:', error);
            // File may have been moved or the stored handle may have become stale.
            fileHandleMap.delete(song.id);
        }
    }

    const recoveredHandle = await recoverFileHandleFromPersistedDirectory(song);
    if (recoveredHandle) {
        try {
            const file = await recoveredHandle.getFile();
            return await getAudioFromFile(file);
        } catch (error) {
            console.error('[LocalMusic] Failed to get file from recovered directory handle:', error);
            fileHandleMap.delete(song.id);
        }
    }

    // No accessible handle available - permission may need to be restored or the file moved.
    console.warn(`[LocalMusic] No accessible handle for song ${song.id}. Permission restore or re-import is required.`);
    return null;
}

/** Resolves the current File for playback recovery without changing the song or minting a URL. */
export async function getFileFromLocalSong(song: LocalSong): Promise<File | null> {
    const fileHandle = await getAccessibleFileHandle(song);
    if (fileHandle) {
        try {
            return await fileHandle.getFile();
        } catch (error) {
            console.warn(`[LocalMusic] Failed to read local recovery input for ${song.id}:`, error);
            fileHandleMap.delete(song.id);
        }
    }

    const recoveredHandle = await recoverFileHandleFromPersistedDirectory(song);
    if (!recoveredHandle) return null;
    try {
        return await recoveredHandle.getFile();
    } catch (error) {
        console.warn(`[LocalMusic] Failed to read recovered local input for ${song.id}:`, error);
        fileHandleMap.delete(song.id);
        return null;
    }
}

/**
 * The local file's raw bytes, for callers that need the audio itself rather than a URL to it.
 *
 * Automix separation is the caller: it must not mint a blob URL only to read it once and then have to
 * revoke it, and a local file never enters the online media cache, so its bytes are reachable only
 * from its own handle. Mirrors getAudioFromLocalSong's resolution (accessible handle, else a recover)
 * but returns the ArrayBuffer. Null when no handle can be reached - permission not restored, or moved.
 */
export async function getLocalSongArrayBuffer(song: LocalSong): Promise<ArrayBuffer | null> {
    const fileHandle = await getAccessibleFileHandle(song);
    if (!fileHandle) {
        console.warn(`[LocalMusic] No accessible handle for song ${song.id} (automix bytes)`);
        return null;
    }
    try {
        return await (await fileHandle.getFile()).arrayBuffer();
    } catch (error) {
        console.error('[LocalMusic] Failed to read local bytes:', error);
        fileHandleMap.delete(song.id);
        return null;
    }
}

// Extracts and persists one song's embedded cover after an explicit playback-time request.
async function extractAndPersistSongCover(
    song: LocalSong,
    fileHandle: FileSystemFileHandle,
): Promise<LocalSong> {
    const file = await fileHandle.getFile();
    const fileRevision = `${file.size}:${file.lastModified}`;
    if (songsWithoutEmbeddedCover.get(song.id) === fileRevision) return song;
    const metadata = await extractEmbeddedMetadata(file, true);
    if (!metadata.cover || !metadata.coverAssetId) {
        songsWithoutEmbeddedCover.set(song.id, fileRevision);
        return song;
    }
    songsWithoutEmbeddedCover.delete(song.id);
    stageLocalCoverAsset(metadata.coverAssetId, metadata.cover);

    const updatedSong: LocalSong = {
        ...song,
        localCoverAssetId: metadata.coverAssetId,
        localCoverSource: 'embedded',
        fileHandle,
    };
    Object.assign(song, updatedSong);
    await saveLocalSong(updatedSong);
    return updatedSong;
}

export async function ensureLocalSongCoverAsset(song: LocalSong): Promise<LocalSong> {
    if (song.localCoverAssetId && await hasLocalCoverBinary(song.localCoverAssetId)) return song;
    if (song.localCoverSource === 'folder') return song;

    if (!localCoverAssetRequestMap.has(song.id)) {
        localCoverAssetRequestMap.set(song.id, (async () => {
            const fileHandle = await getAccessibleFileHandle(song);
            if (!fileHandle) {
                return song;
            }

            try {
                return await extractAndPersistSongCover(song, fileHandle);
            } catch (error) {
                console.warn(`[LocalMusic] Failed to ensure embedded cover for ${song.fileName}:`, error);
                fileHandleMap.delete(song.id);

                try {
                    const recoveredHandle = await recoverFileHandleFromPersistedDirectory(song);
                    if (!recoveredHandle) {
                        return song;
                    }

                    return await extractAndPersistSongCover(song, recoveredHandle);
                } catch (recoveryError) {
                    console.warn(`[LocalMusic] Failed to recover embedded cover for ${song.fileName}:`, recoveryError);
                    return song;
                }
            } finally {
                localCoverAssetRequestMap.delete(song.id);
            }
        })());
    }

    return await localCoverAssetRequestMap.get(song.id)!;
}

// Get audio blob from File object (for file input imports)
export async function getAudioFromFile(file: File): Promise<string> {
    const url = createSafeObjectUrl(await repairFlacMetadata(file, true));
    if (!url) throw new TypeError('Local audio source must be a File or Blob');
    return url;
}

// Delete songs by their specific IDs
export async function deleteSongsByIds(songIds: string[]): Promise<void> {
    const uniqueSongIds = Array.from(new Set(songIds));
    if (uniqueSongIds.length === 0) return;
    const allSongs = await getLocalSongs();
    const deletedIdSet = new Set(uniqueSongIds);
    const affectedRoots = new Set(
        allSongs
            .filter(song => deletedIdSet.has(song.id))
            .map(getRootFolderName)
            .filter((root): root is string => Boolean(root)),
    );
    uniqueSongIds.forEach(id => {
        fileHandleMap.delete(id);
        localCoverAssetRequestMap.delete(id);
        songsWithoutEmbeddedCover.delete(id);
    });
    await Promise.all([
        dbDeleteLocalSongs(uniqueSongIds),
        ...uniqueSongIds.map(id => removeCachedCover(`cover_local_${id}`)),
    ]);
    await removeDeletedSongIdsFromPlaylists(uniqueSongIds);
    await Promise.all(Array.from(affectedRoots).map(cleanupDirHandleIfUnused));
    notifyLocalMusicUpdated();
    console.log(`[LocalMusic] Deleted ${uniqueSongIds.length} songs by ID`);
}

// Removes an imported root from the app, including empty roots, without deleting disk files.
export function removeImportedRoot(rootFolderName: string): Promise<void> {
    return runLocalFolderMutation(() => removeImportedRootContents(rootFolderName));
}

async function removeImportedRootContents(rootFolderName: string): Promise<void> {
    const normalizedRoot = normalizeLocalFolderPath(rootFolderName).split('/')[0];
    if (!normalizedRoot) return;
    removedRootGenerations.set(normalizedRoot, (removedRootGenerations.get(normalizedRoot) || 0) + 1);

    const allSongs = await getLocalSongs();
    const songIds = allSongs
        .filter(song => getRootFolderName(song) === normalizedRoot)
        .map(song => song.id);

    if (songIds.length > 0) {
        await deleteSongsByIds(songIds);
    }
    await Promise.all([
        deleteDirHandle(normalizedRoot),
        deleteLocalLibrarySnapshot(normalizedRoot),
    ]);
    notifyLocalMusicUpdated();
}

// Resync folder: refresh an imported folder in place using the persisted root handle
export async function resyncFolder(folderName: string): Promise<LocalSong[] | null> {
    // Only root imports have persisted directory handles. Derived child folders
    // should resync through their imported root folder handle.
    const rootFolderName = folderName.split('/')[0] || folderName;
    const importedSongs = await importFolder(rootFolderName);

    // If user cancelled (empty array), return null to indicate cancellation
    if (importedSongs.length === 0) {
        return null;
    }

    return importedSongs;
}

function getLocalSongRootFolderName(song: LocalSong): string | null {
    const sourcePath = song.folderName || song.filePath;
    const rootFolderName = sourcePath.split('/')[0]?.trim();
    return rootFolderName || null;
}

// Resyncs all imported local roots once, even when the song list contains nested folders.
export async function resyncAllFolders(): Promise<LocalSong[] | null> {
    // 原生曲库（MediaStore）本来就是整库快照：一次 importFolder 即全量。
    // 按 rootFolderName 循环只会把同一份快照重复导 N 遍（N = 顶层目录数）。
    if (detectNativeLibrary()) {
        return await importFolder();
    }

    const allSongs = await getLocalSongs();
    const handles = await getDirHandles();
    const rootFolderNames = Array.from(new Set(
        [...Object.keys(handles), ...allSongs
            .map(getLocalSongRootFolderName)
            .filter((rootFolderName): rootFolderName is string => Boolean(rootFolderName))]
    ));

    if (rootFolderNames.length === 0) {
        return null;
    }

    const importedSongs: LocalSong[] = [];
    for (const rootFolderName of rootFolderNames) {
        const rootSongs = await importFolder(rootFolderName);
        importedSongs.push(...rootSongs);
    }

    return importedSongs;
}

// Clear the app's ignore flag and rescan immediately; disk ignore rules still apply.
export async function clearFolderIgnore(folderName: string): Promise<void> {
    const rootFolderName = normalizeLocalFolderPath(folderName).split('/')[0];
    const dirHandle = await getImportDirectoryHandle(rootFolderName);
    if (!dirHandle) return;
    return runLocalFolderMutation(async () => {
        await setLocalFolderIgnored(folderName, false);
        await importFolderContents(dirHandle, rootFolderName);
    });
}

// Delete all songs from a specific folder (and its nested children)
export function deleteFolderSongs(folderName: string): Promise<void> {
    return runLocalFolderMutation(() => deleteFolderContents(folderName));
}

async function deleteFolderContents(folderName: string): Promise<void> {
    folderName = normalizeLocalFolderPath(folderName);
    if (!folderName.includes('/')) return removeImportedRootContents(folderName);
    await setLocalFolderIgnored(folderName, true);
    // Get all local songs
    const allSongs = await getLocalSongs();

    // Filter songs that belong to this folder OR are nested under it
    const songsToDelete = allSongs.filter(song =>
        song.folderName === folderName || (song.folderName && song.folderName.startsWith(`${folderName}/`))
    );

    const songIdsToDelete = songsToDelete.map(song => song.id);
    songIdsToDelete.forEach(id => {
        fileHandleMap.delete(id);
        localCoverAssetRequestMap.delete(id);
        songsWithoutEmbeddedCover.delete(id);
    });
    await Promise.all([
        dbDeleteLocalSongs(songIdsToDelete),
        ...songIdsToDelete.map(id => removeCachedCover(`cover_local_${id}`)),
    ]);
    await removeDeletedSongIdsFromPlaylists(songIdsToDelete);

    notifyLocalMusicUpdated();
    console.log(`[LocalMusic] Deleted ${songsToDelete.length} songs from folder tree: ${folderName}`);
}
