// src/services/foliaExtensionBridge.ts
// 安卓原生桥接（extension 桥）：原生 WebView 壳注入 `window.foliaBridge`（回调式，因
// addJavascriptInterface 无法向 JS 返回 Promise），前端在这里把回调封装成 Promise。
//
// 与 nativeLibrary 桥并列：nativeLibrary 桥管本地曲库目录与文件字节；foliaBridge 管
// 网易云 / QQ / 酷狗等在线源的 HTTP 请求转发。打包后 `VITE_*_API_BASE=extension`，
// 前端识别到该值后，所有在线 API 调用不再走 fetch，而是序列化请求对象交给原生侧，
// 由原生侧发起真实 HTTP 请求并把响应体 JSON 回传。
//
// 原生侧契约：
//   - 调用：window.foliaBridge.httpRequest(requestId, requestJsonString)
//   - 回传：window.__foliaBridgeOnResult(requestId, ok, payload)
//     ok=true  -> payload 为真实 API 响应体 JSON 字符串（业务错误体也带 __foliaBridgeError 字段）
//     ok=false -> payload 为错误消息文本
//   - 超时 45s

export type FoliaBridgeProvider = 'netease' | 'qq' | 'kugou' | 'bodian' | 'qq_raw';

export interface FoliaBridgeRequest {
    provider: FoliaBridgeProvider;
    operation: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path?: string;
    query?: Record<string, string>;
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
}

export interface FoliaBridgeResponse {
    /** 业务错误标记：存在时同级 message 表达错误原因 */
    __foliaBridgeError?: string;
    message?: string;
    [key: string]: unknown;
}

/** 构建期注入的特殊值：表示在线 API 走原生 extension 桥。 */
export const FOLIA_EXTENSION_API_BASE = 'extension';

declare global {
    interface Window {
        foliaBridge?: {
            httpRequest(requestId: number, requestJson: string): void;
            isAvailable(): boolean;
        };
        __foliaBridgeOnResult?: (requestId: number, ok: boolean, payload: string) => void;
    }
}

/**
 * 判断配置的 API base 是否为「extension 桥」模式。
 * 接受 'extension'、'folia-extension' 以及 'folia-extension://netease' 这类带 provider 后缀的值。
 */
export const isFoliaExtensionBridgeConfigured = (value?: string | null): boolean => {
    if (typeof value !== 'string' || !value) return false;
    const normalized = value.trim().replace(/\/$/, '').toLowerCase();
    if (normalized === 'extension') return true;
    if (normalized === 'folia-extension') return true;
    if (normalized.startsWith('folia-extension://')) return true;
    return false;
};

/** 原生桥对象是否真的注入到 window 上（运行时探测）。 */
export const isFoliaExtensionBridgeAvailable = (): boolean =>
    typeof window !== 'undefined' &&
    !!window.foliaBridge &&
    typeof window.foliaBridge.httpRequest === 'function';

// ---- 回调式桥 → Promise 封装 ----

const REQUEST_TIMEOUT_MS = 45000;

interface PendingEntry {
    resolve: (value: FoliaBridgeResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

let nextRequestId = 1;
const pending = new Map<number, PendingEntry>();

const registerResultHandler = (): void => {
    if (typeof window === 'undefined') return;
    if (window.__foliaBridgeOnResult) return;
    window.__foliaBridgeOnResult = (requestId, ok, payload) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        clearTimeout(entry.timer);
        if (ok) {
            try {
                const parsed = JSON.parse(payload) as FoliaBridgeResponse;
                entry.resolve(parsed);
            } catch (error) {
                entry.reject(
                    new Error(
                        `FoliaExtension bridge returned non-JSON payload: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                );
            }
        } else {
            entry.reject(new Error(payload || 'FoliaExtension bridge call failed'));
        }
    };
};

/**
 * 发起一次经原生桥转发的在线 API 请求。
 * 桥不可用抛 `Error('FOLIA_EXTENSION_BRIDGE_UNAVAILABLE')`。
 */
export const requestFoliaExtension = <T = FoliaBridgeResponse>(
    request: FoliaBridgeRequest,
): Promise<T> => {
    if (!isFoliaExtensionBridgeAvailable()) {
        return Promise.reject(new Error('FOLIA_EXTENSION_BRIDGE_UNAVAILABLE'));
    }
    registerResultHandler();
    const bridge = window.foliaBridge!;

    return new Promise<T>((resolve, reject) => {
        const requestId = nextRequestId++;
        const timer = setTimeout(() => {
            const entry = pending.get(requestId);
            if (!entry) return;
            pending.delete(requestId);
            reject(new Error(`FoliaExtension bridge request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(requestId, {
            resolve: value => resolve(value as unknown as T),
            reject,
            timer,
        });

        try {
            bridge.httpRequest(requestId, JSON.stringify(request));
        } catch (error) {
            pending.delete(requestId);
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
};
