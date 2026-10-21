// src/services/nativeLibrary/nativeLibrarySource.ts
// 安卓 GeckoView 壳的原生桥（页面世界对象由内置 WebExtension 的 content script 注入）。
//
// 曲库契约：壳层内置的 MediaStore 索引是唯一来源。原生 `listSnapshot` 直接返回平铺文件清单
// （音频 + 每个目录的封面 uri + 同名歌词 sidecar），前端把它建成内存目录树，喂给 Folia 既有的
// 本地曲库遍历/解析流程——不需要目录授权、不需要 showDirectoryPicker，也不需要逐目录往返。
//
// 三个数据通道，各管一件事：
//   - 元数据：随快照一起来（MediaStore 的 title/artist/album/duration），零 MMR 提取
//   - 音频字节：走 LocalHttpServer 的 /local?uri=…（支持 Range），<audio> 直接流式播放
//   - 封面字节：走 /cover?uri=…&size=N，同源出图，字节不进 JS
// 只有歌词这类小文件才用 readFile 过桥（base64）。
//
// 原生桥不依赖 showDirectoryPicker（安卓上该 API 会直接 AbortError 且不弹 UI），
// 因此也绕开了 localLibraryAvailability 对 secure context 的检查。

export interface NativeDirectoryEntry {
    name: string;
    /** 文件标识：media 模式为 MediaStore content uri；也是 readFile / /local 的键 */
    relativePath: string;
    kind: 'file' | 'directory';
    size?: number;
    /** 文件最后修改时间（epoch 毫秒 / media 模式为秒，只用于变化判定） */
    lastModified?: number;
    mimeType?: string;
    /**
     * 原生 MediaStore 提取的音频元数据。
     * 契约：仅音频条目带该键（提取失败也带、值全为 null）；非音频条目无此键。
     * 因此「键存在」本身即代表这是原生源音频条目，导入时可跳过 getFile() 整字节回传。
     */
    meta?: NativeAudioMeta;
    /** 图片条目的 content uri（media 模式的目录封面） */
    contentUri?: string;
    /** media 模式：条目自带歌词 sidecar 的路径（绝对路径或 content uri） */
    sidecarPath?: string;
    /** media 模式：翻译歌词 sidecar（同名 .t.lrc / .t.vtt）的路径 */
    translationSidecarPath?: string;
    children?: NativeDirectoryEntry[];
}

/** 原生 MediaMetadataRetriever / MediaStore 提取的音频元数据；任一字段可能为 null。 */
export interface NativeAudioMeta {
    title: string | null;
    artist: string | null;
    album: string | null;
    /** 时长，毫秒 */
    duration: number | null;
    /** 比特率，bps */
    bitrate: number | null;
}

export interface NativeDirectoryTree {
    /** 根目录名（用于 LocalSong.folderName 前缀） */
    name: string;
    /** 原生根标识（isSameEntry 判重用） */
    rootPath: string;
    children: NativeDirectoryEntry[];
}

/**
 * 原生壳注入到 window.nativeLibrary 的原始回调式桥。
 * 方法不返回数据，结果经 window.__nativeLibraryOnResult(requestId, ok, payload) 回传。
 */
export interface NativeLibraryBridge {
    readonly isAvailable: boolean;
    /** 音频/歌词字节（base64）；大文件请走 /local 流式端点 */
    readFile(requestId: number, relativePath: string): void;
    /** 曲库全量快照（壳层 MediaStore 查询）：结果 payload 为 NativeSnapshot JSON */
    listSnapshot(requestId: number): void;
    /** 强制重查（绕过壳层快照缓存）；老壳层没有此方法时回退到 listSnapshot */
    refreshSnapshot?(requestId: number): void;
    /** 提前引导媒体权限；结果 payload 为空 ack */
    ensureStorageAccess(requestId: number): void;
}

/** 壳层曲库快照。revision 相同即曲库未变。 */
export interface NativeSnapshotFile {
    /** 文件标识（media 模式为 content uri） */
    path: string;
    relativePath?: string;
    /** 目录分组键（"Music/专辑"）；缺省时从 path 推导 */
    folder?: string;
    name?: string;
    size?: number;
    lastModified?: number;
    mimeType?: string;
    /** 音频条目自带元数据（与 saf 分支同形状）；非音频项无。 */
    meta?: NativeAudioMeta;
    /** 歌词 sidecar 路径；无则不加载歌词。 */
    sidecarPath?: string;
    /** 翻译歌词 sidecar 路径（同名 .t.lrc / .t.vtt）；无则不加载翻译。 */
    translationSidecarPath?: string;
    /** 目录封面 uri（/cover?uri=... 出图）。 */
    coverUri?: string;
}

export interface NativeSnapshot {
    revision: string;
    /** 壳层索引模式：media=MediaStore（曲库唯一来源）；path/saf 为历史模式 */
    mode?: 'media' | 'path' | 'saf';
    root?: string;
    scanRoot?: string;
    files: NativeSnapshotFile[];
}

declare global {
    interface Window {
        nativeLibrary?: NativeLibraryBridge;
        __nativeLibraryOnResult?: (requestId: number, ok: boolean, payload: string) => void;
    }
}

/** 原生桥是否可用。可用时本地曲库不再依赖 showDirectoryPicker。 */
export const detectNativeLibrary = (): boolean =>
    typeof window !== 'undefined' &&
    !!window.nativeLibrary &&
    typeof window.nativeLibrary.listSnapshot === 'function';

// ---- 回调式桥 → Promise 封装 ----

let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: string) => void; reject: (err: Error) => void }>();

const registerResultHandler = (): void => {
    if (window.__nativeLibraryOnResult) return;
    window.__nativeLibraryOnResult = (requestId, ok, payload) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        if (ok) entry.resolve(payload);
        else entry.reject(new Error(payload || 'NativeLibrary call failed'));
    };
};

const callNative = (invoke: (requestId: number) => void): Promise<string> => {
    const bridge = window.nativeLibrary;
    if (!bridge) return Promise.reject(new Error('[NativeLibrary] window.nativeLibrary 不可用'));
    registerResultHandler();
    return new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        pending.set(requestId, { resolve, reject });
        try {
            invoke(requestId);
        } catch (error) {
            pending.delete(requestId);
            reject(error as Error);
        }
    });
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
};

/** 按原生文件标识读字节（歌词等小文件）。音频请用 getNativeMediaUrl 走流式。 */
export const readNativeFile = async (relativePath: string): Promise<ArrayBuffer> => {
    const base64 = await callNative((id) => window.nativeLibrary!.readFile(id, relativePath));
    return base64ToArrayBuffer(base64);
};

/**
 * 全量曲库快照。桥无 listSnapshot（老壳层）→ 返回 null。
 * 失败返回 null 并打 warn，不阻塞导入。
 */
export const getNativeSnapshot = async (force = false): Promise<NativeSnapshot | null> => {
    if (typeof window === 'undefined' || !window.nativeLibrary
        || typeof window.nativeLibrary.listSnapshot !== 'function') {
        return null;
    }
    try {
        const useRefresh = force && typeof window.nativeLibrary.refreshSnapshot === 'function';
        const payload = await callNative((id) => (useRefresh
            ? window.nativeLibrary!.refreshSnapshot!(id)
            : window.nativeLibrary!.listSnapshot(id)));
        if (!payload || payload === 'null') return null;
        return JSON.parse(payload) as NativeSnapshot;
    } catch (error) {
        console.warn('[NativeLibrary] getNativeSnapshot 失败:', error);
        return null;
    }
};

/** 提前引导媒体权限。返回 granted/denied/unknown。 */
export const ensureNativeStorageAccess = async (): Promise<'granted' | 'denied' | 'unknown'> => {
    if (typeof window === 'undefined' || !window.nativeLibrary
        || typeof window.nativeLibrary.ensureStorageAccess !== 'function') {
        return 'unknown';
    }
    try {
        await callNative((id) => window.nativeLibrary!.ensureStorageAccess(id));
        return 'granted';
    } catch (error) {
        console.warn('[NativeLibrary] ensureStorageAccess 失败:', error);
        return 'denied';
    }
};

// ---- 虚拟 FileSystemDirectoryHandle（全部来自快照，零桥往返） ----

class VirtualFileHandle {
    kind = 'file' as const;
    name: string;
    private node: NativeDirectoryEntry;
    // 品牌标记：供上层鸭子类型判断这是一个原生桥虚拟文件句柄（无需 import 本类即可识别）。
    readonly __foliaNativeFile = true;
    // 直接来自快照条目的非字节元数据：导入遍历时不必 getFile() 取整音频即可拿到。
    readonly size: number;
    readonly lastModified: number;
    readonly mimeType: string;
    /** 文件标识（readFile / /local 的键）。 */
    readonly nativeRelativePath: string;
    /** 目录封面 uri；无则 undefined。 */
    readonly nativeContentUri?: string;
    /** 歌词 sidecar 路径（播放时按需 readNativeFile）。 */
    readonly nativeSidecarPath?: string;
    /** 翻译歌词 sidecar 路径。 */
    readonly nativeTranslationSidecarPath?: string;

    constructor(node: NativeDirectoryEntry) {
        this.name = node.name;
        this.node = node;
        this.size = typeof node.size === 'number' ? node.size : 0;
        this.lastModified = typeof node.lastModified === 'number' ? node.lastModified : 0;
        this.mimeType = node.mimeType || '';
        this.nativeRelativePath = node.relativePath;
        this.nativeContentUri = node.contentUri;
        this.nativeSidecarPath = node.sidecarPath;
        this.nativeTranslationSidecarPath = node.translationSidecarPath;
    }

    /** 原生提取的音频元数据；非音频条目或原生未带时为 undefined。 */
    get nativeAudioMeta(): NativeAudioMeta | undefined {
        return this.node.meta;
    }

    /**
     * 只有在调用方坚持要 File 时才读整字节（歌词/自动混音等）。
     * 播放路径不会走这里——见 getNativeMediaUrl。
     */
    async getFile(): Promise<File> {
        const bytes = await readNativeFile(this.node.relativePath);
        return new File([bytes], this.node.name, {
            type: this.node.mimeType || '',
            lastModified: this.node.lastModified || Date.now(),
        });
    }
}

/**
 * 读取某句柄是否为原生桥文件句柄，并返回其快照里携带的音频元数据。
 * 返回 undefined 表示这不是原生句柄、或原生未给该条目带 meta 键。
 */
export const readNativeAudioMeta = (handle: unknown): NativeAudioMeta | undefined => {
    if (!handle || (handle as { __foliaNativeFile?: boolean }).__foliaNativeFile !== true) return undefined;
    return (handle as VirtualFileHandle).nativeAudioMeta;
};

/** 读取原生句柄直接暴露的非字节文件信息；非原生句柄返回 undefined。 */
export const readNativeFileStats = (handle: unknown): { size: number; lastModified: number; mimeType: string } | undefined => {
    if (!handle || (handle as { __foliaNativeFile?: boolean }).__foliaNativeFile !== true) return undefined;
    const h = handle as VirtualFileHandle;
    return { size: h.size, lastModified: h.lastModified, mimeType: h.mimeType };
};

/** 读取原生句柄的文件标识；非原生句柄返回 undefined。 */
export const readNativeRelativePath = (handle: unknown): string | undefined => {
    if (!handle || (handle as { __foliaNativeFile?: boolean }).__foliaNativeFile !== true) return undefined;
    return (handle as VirtualFileHandle).nativeRelativePath;
};

/** 读取原生图片条目携带的封面 uri；非原生句柄或条目未带时返回 undefined。 */
export const readNativeFileContentUri = (handle: unknown): string | undefined => {
    if (!handle || (handle as { __foliaNativeFile?: boolean }).__foliaNativeFile !== true) return undefined;
    return (handle as VirtualFileHandle).nativeContentUri;
};

/** 读取原生音频条目自带的歌词 sidecar 路径；无则 undefined。 */
export const readNativeSidecarPath = (handle: unknown): string | undefined => {
    if (!handle || (handle as { __foliaNativeFile?: boolean }).__foliaNativeFile !== true) return undefined;
    return (handle as VirtualFileHandle).nativeSidecarPath;
};

/** 读取原生音频条目自带的翻译歌词 sidecar 路径；无则 undefined。 */
export const readNativeTranslationSidecarPath = (handle: unknown): string | undefined => {
    if (!handle || (handle as { __foliaNativeFile?: boolean }).__foliaNativeFile !== true) return undefined;
    return (handle as VirtualFileHandle).nativeTranslationSidecarPath;
};

/**
 * 原生封面 URL：LocalHttpServer 同源 GET /cover?uri=<url编码uri>[&size=N] 流式出图。
 * 页面本来就从 http://127.0.0.1:<port>/ 加载，origin 即服务器；字节不进 JS。
 */
export const getNativeCoverUrl = (contentUri: string, size?: number): string => {
    const base = `${window.location.origin}/cover?uri=${encodeURIComponent(contentUri)}`;
    return size ? `${base}&size=${size}` : base;
};

/**
 * 原生音频 URL：LocalHttpServer 的 /local 端点，支持 Range，<audio> 直接流式播放。
 *
 * 这是性能关键路径：旧实现把整首音频 base64 过 WebExtension 桥，再在 JS 里解成 ArrayBuffer、
 * 打补丁、建 Blob URL——一首 30MB 的无损在车机上要几百毫秒到数秒，还会同时存在
 * base64 字符串 + 解码后字节 + Blob 三份内存。
 */
export const getNativeMediaUrl = (sourceKey: string): string =>
    `${window.location.origin}/local?uri=${encodeURIComponent(sourceKey)}`;

/**
 * 从快照里按"曲库内相对路径"找单个文件句柄（形如 "Music/专辑/01.flac"）。
 *
 * 用途：进程重启后 fileHandleMap 是空的，而导入时存进 IndexedDB 的虚拟句柄会丢方法
 * （结构化克隆只留字段）。与其在恢复路径上重新遍历整棵树，不如直接查一次快照。
 */
export const findNativeFileHandle = (
    snapshot: NativeSnapshot,
    libraryRelativePath: string,
): FileSystemFileHandle | null => {
    const target = libraryRelativePath.replace(/^\/+/, '');
    for (const f of snapshot.files) {
        const folder = (f.folder ?? '').replace(/^\/+|\/+$/g, '');
        const name = f.name ?? (f.path || '').slice((f.path || '').lastIndexOf('/') + 1);
        const p = folder ? `${folder}/${name}` : name;
        if (p !== target && f.path !== target && f.relativePath !== target) continue;
        return new VirtualFileHandle({
            kind: 'file',
            name,
            relativePath: f.path || f.relativePath || target,
            size: f.size,
            lastModified: f.lastModified,
            mimeType: f.mimeType,
            meta: f.meta,
            sidecarPath: f.sidecarPath,
            translationSidecarPath: f.translationSidecarPath,
            contentUri: f.coverUri,
        }) as unknown as FileSystemFileHandle;
    }
    return null;
};

class SnapshotDirHandle {
    kind = 'directory' as const;
    name: string;
    private dirKey: string;
    private index: Map<string, { dirs: string[]; files: NativeDirectoryEntry[] }>;

    constructor(name: string, dirKey: string, index: SnapshotDirHandle['index']) {
        this.name = name;
        this.dirKey = dirKey;
        this.index = index;
    }

    async *values(): AsyncGenerator<VirtualFileHandle | SnapshotDirHandle> {
        const node = this.index.get(this.dirKey);
        if (!node) return;
        for (const childDir of node.dirs) {
            const seg = childDir.slice(childDir.lastIndexOf('/') + 1) || childDir;
            yield new SnapshotDirHandle(seg, childDir, this.index);
        }
        for (const f of node.files) {
            yield new VirtualFileHandle(f);
        }
    }

    async queryPermission(): Promise<'granted'> { return 'granted'; }
    async requestPermission(): Promise<'granted'> { return 'granted'; }

    async isSameEntry(other: unknown): Promise<boolean> {
        return other instanceof SnapshotDirHandle && other.dirKey === this.dirKey;
    }
}

const pathOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * 用快照的平铺文件清单直接构造虚拟目录句柄：values() 只在内存树里走，
 * 零 pickDirectory、零 listDirectory 桥调用。
 *
 * 目录分组优先用条目的 folder 字段（"Music/专辑"）；media 模式的 path 是 content://…
 * 直接当路径切会切出一串 "content:/" 伪目录，历史实现就是这么把 folderName 弄脏的。
 */
export const buildSnapshotVirtualHandle = (snapshot: NativeSnapshot): FileSystemDirectoryHandle => {
    const mode = snapshot.mode ?? 'media';
    const norm = (p: string): string => p.replace(/^\/+|\/+$/g, '');
    const index = new Map<string, { dirs: string[]; files: NativeDirectoryEntry[] }>();
    const ensure = (key: string) => {
        let node = index.get(key);
        if (!node) { node = { dirs: [], files: [] }; index.set(key, node); }
        return node;
    };
    for (const f of snapshot.files) {
        const rawPath: string = f.path || f.relativePath || '';
        if (!rawPath) continue;
        const dir = norm(f.folder ?? pathOf(rawPath));
        const name = f.name || rawPath.slice(rawPath.lastIndexOf('/') + 1) || rawPath;
        ensure(dir).files.push({
            kind: 'file',
            name,
            relativePath: rawPath,
            size: f.size,
            lastModified: f.lastModified,
            mimeType: f.mimeType,
            meta: f.meta,
            sidecarPath: f.sidecarPath,
            translationSidecarPath: f.translationSidecarPath,
            contentUri: f.coverUri,
        } as NativeDirectoryEntry);
    }
    // 派生目录边：对每个目录键，列出其子目录键。
    for (const key of Array.from(index.keys()).sort()) {
        if (!key) continue;
        const parent = pathOf(key);
        const node = ensure(parent);
        if (!node.dirs.includes(key)) node.dirs.push(key);
    }
    // media 模式根固定为壳层下发的 root（"本地音乐"）；path/saf 模式取扫描根最后一段。
    const snapshotRoot = snapshot.root || snapshot.scanRoot || '';
    const rootKey = mode === 'media' ? '' : norm(snapshotRoot);
    const rootName = mode === 'media'
        ? (snapshotRoot || '本地音乐')
        : (rootKey ? rootKey.slice(rootKey.lastIndexOf('/') + 1) || rootKey : '本地音乐');
    ensure(rootKey);
    return new SnapshotDirHandle(rootName, rootKey, index) as unknown as FileSystemDirectoryHandle;
};
