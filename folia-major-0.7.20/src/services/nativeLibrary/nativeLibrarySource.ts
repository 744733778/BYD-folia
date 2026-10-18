// src/services/nativeLibrary/nativeLibrarySource.ts
// 安卓原生桥接：原生 WebView 壳注入 `window.nativeLibrary`（回调式，因 addJavascriptInterface
// 无法向 JS 返回 Promise），前端在这里把回调封装成 Promise，并提供「目录树 + 按路径读字节」，
// 据此构造一个虚拟 FileSystemDirectoryHandle 喂给 Folia 现有本地曲库遍历/解析。
//
// 为什么是虚拟 handle：Folia 的本地曲库（localMusicService）只依赖 dirHandle 的几个接口
// （name、values()、entry.getFile()、queryPermission/requestPermission、isSameEntry），
// 没有任何 Electron 专属文件能力。给它一个满足这些接口的对象，遍历、sidecar 匹配、KRC 解密、
// 音频元数据解析、封面、播放源全部复用，不必改动曲库内核。
//
// 原生桥不依赖 showDirectoryPicker（安卓上该 API 会直接 AbortError 且不弹 UI），
// 因此也绕开了 localLibraryAvailability 对 secure context 的检查。

export interface NativeDirectoryEntry {
    name: string;
    /** 相对根目录的路径，如 "sub/01.mp3"，用作 readFile 的键 */
    relativePath: string;
    kind: 'file' | 'directory';
    size?: number;
    /** 文件最后修改时间（epoch 毫秒） */
    lastModified?: number;
    mimeType?: string;
    children?: NativeDirectoryEntry[];
}

export interface NativeDirectoryTree {
    /** 根目录名（用于 LocalSong.folderName 前缀） */
    name: string;
    /** 原生绝对路径，作稳定标识（isSameEntry 判重用） */
    rootPath: string;
    children: NativeDirectoryEntry[];
}

/**
 * 原生壳注入到 window.nativeLibrary 的原始回调式桥。
 * 方法不返回数据，结果经 window.__nativeLibraryOnResult(requestId, ok, payload) 回传。
 * requestId 由前端生成并传入。
 */
export interface NativeLibraryBridge {
    readonly isAvailable: boolean;
    /** 弹目录选择器；结果 payload 为目录树 JSON，或用户取消时 ok=false */
    pickDirectory(requestId: number): void;
    /** 按根目录相对路径读文件字节；结果 payload 为 base64 */
    readFile(requestId: number, relativePath: string): void;
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
    typeof window.nativeLibrary.pickDirectory === 'function';

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

/** 用户选择目录；返回目录树，用户取消返回 null。失败也返回 null 并打印错误，避免上层静默。 */
export const pickNativeDirectory = async (): Promise<NativeDirectoryTree | null> => {
    try {
        const payload = await callNative((id) => window.nativeLibrary!.pickDirectory(id));
        if (!payload || payload === 'null') return null;
        return JSON.parse(payload) as NativeDirectoryTree;
    } catch (error) {
        console.error('[NativeLibrary] pickNativeDirectory 失败:', error);
        return null;
    }
};

/** 按根目录相对路径读文件字节。 */
export const readNativeFile = async (relativePath: string): Promise<ArrayBuffer> => {
    const base64 = await callNative((id) => window.nativeLibrary!.readFile(id, relativePath));
    return base64ToArrayBuffer(base64);
};

const nativeReadFile = readNativeFile;

// ---- 虚拟 FileSystemDirectoryHandle ----

interface VirtualNode {
    kind: 'file' | 'directory';
    name: string;
    relativePath: string;
    size?: number;
    lastModified?: number;
    mimeType?: string;
    children?: VirtualNode[];
}

const toVirtualNode = (entry: NativeDirectoryEntry): VirtualNode => ({
    ...entry,
    children: entry.children?.map(toVirtualNode),
});

// 方法定义在 prototype 上、实例只持纯数据字段（name/rootPath/node），
// 因此实例可被 IndexedDB 结构化克隆（桥接引用经 readNativeFile/window 走，不落在实例上）。
// 原生桥第一版不依赖持久化重扫，clone 能力仅作余量保留。

class VirtualFileHandle {
    kind = 'file' as const;
    name: string;
    private node: VirtualNode;

    constructor(node: VirtualNode) {
        this.name = node.name;
        this.node = node;
    }

    async getFile(): Promise<File> {
        const bytes = await nativeReadFile(this.node.relativePath);
        return new File([bytes], this.node.name, {
            type: this.node.mimeType || '',
            lastModified: this.node.lastModified || Date.now(),
        });
    }
}

class VirtualDirectoryHandle {
    kind = 'directory' as const;
    name: string;
    private rootPath: string;
    private children: VirtualNode[];

    constructor(name: string, rootPath: string, children: VirtualNode[]) {
        this.name = name;
        this.rootPath = rootPath;
        this.children = children;
    }

    async *values(): AsyncGenerator<VirtualFileHandle | VirtualDirectoryHandle> {
        for (const child of this.children) {
            yield child.kind === 'directory'
                ? new VirtualDirectoryHandle(child.name, this.rootPath, child.children || [])
                : new VirtualFileHandle(child);
        }
    }

    async queryPermission(): Promise<'granted'> { return 'granted'; }
    async requestPermission(): Promise<'granted'> { return 'granted'; }

    async isSameEntry(other: unknown): Promise<boolean> {
        return other instanceof VirtualDirectoryHandle && other.rootPath === this.rootPath;
    }
}

/** 用原生目录树构造一个满足 Folia 本地曲库接口的虚拟目录句柄。 */
export const buildVirtualDirectoryHandle = (tree: NativeDirectoryTree): FileSystemDirectoryHandle =>
    new VirtualDirectoryHandle(tree.name, tree.rootPath, (tree.children || []).map(toVirtualNode)) as unknown as FileSystemDirectoryHandle;
