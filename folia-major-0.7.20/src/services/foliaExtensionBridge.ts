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

/**
 * 壳层 MediaSession / 前台服务 / AudioFocus 上报载荷。
 * 壳层 content.js 把它转发为 ns 'media' method 'state' 的原生消息。
 */
export interface NativeMediaState {
    title: string | null;
    artist: string | null;
    album: string | null;
    /** 毫秒 */
    durationMs: number | null;
    /** 毫秒 */
    positionMs: number | null;
    playing: boolean;
    /** 本地曲目 SAF contentUri（封面/封面通知用）；在线曲目为 null */
    contentUri?: string | null;
    /**
     * 应用内音量档位（0..1）。壳层拿它同步 MediaSession 的 remote volume 当前值，
     * 车机音量条/滚轮才不会以为我们还停在上一次的档位上（不同步时滚轮一转就跳一大格）。
     */
    volume?: number | null;
}

declare global {
    interface Window {
        foliaBridge?: {
            httpRequest(requestId: number, requestJson: string): void;
            isAvailable(): boolean;
            /** 读取系统媒体音量（STREAM_MUSIC）0..1；结果 payload 为浮点字符串。 */
            getSystemVolume(requestId: number): void;
            /** 系统音量是否可调：payload 为 'fixed'（DiLink 等固定音量机型）或 'adjustable'。 */
            getVolumeMode(requestId: number): void;
            /** 设置系统媒体音量；level 为 0..1 浮点（String）；结果 payload 为设置后实际档位。 */
            setSystemVolume(requestId: number, level: string): void;
            /**
             * 拉取原生推送队列里 seq 之后的事件（JSON：{seq, events:[{s,m,p}]}）。
             * 推送链路是四跳转发，车机上可能整条不通；这条「页面请求 → 原生回包」
             * 与 httpRequest 同路，是兜底通道。
             */
            pollEvents?(requestId: number, since: string): void;
            /** 上报播放状态（切歌/播放/暂停/seek 即时上报 + 播放中 ~1s 节流），壳层驱动 MediaSession/前台服务。 */
            reportMediaState(state: NativeMediaState): void;
        };
        __foliaBridgeOnResult?: (requestId: number, ok: boolean, payload: string) => void;
        /**
         * 原生推送事件分发单例（媒体键等）：
         * content script 转发 postMessage({__foliaBridge:'event', ns, method, payload, seq}) → 页面桥转调。
         * 第四个参数 seq 是原生侧自增序号，推送与拉取两条通道共用它去重。
         */
        __foliaOnEvent?: (ns: string, method: string, payload: unknown, seq?: number) => void;
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

/**
 * 原生系统媒体音量桥是否可用（STREAM_MUSIC，0..1 浮点）。
 * 原生壳里音量由系统在输出端控制：APP 只读它做 UI 回显、写它改档位，
 * 绝不把它再乘进网页增益（否则音量被平方）。
 */
export const isFoliaVolumeBridgeAvailable = (): boolean =>
    typeof window !== 'undefined' &&
    !!window.foliaBridge &&
    typeof window.foliaBridge.getSystemVolume === 'function' &&
    typeof window.foliaBridge.setSystemVolume === 'function';

/**
 * 是否运行在安卓 GeckoView 壳里（UA 含 Android）。
 * 音量完全交给系统媒体音量：此环境下 APP 内音量条/静音开关没有意义，UI 需隐藏。
 * 注意：页面世界桥（geckoNativeBridge）在所有环境都注入 window.foliaBridge/nativeLibrary，
 * 不能用它做环境判定，UA 是唯一可靠区分（Electron/Windows 浏览器不含 Android）。
 */
export const isNativeAndroidShell = (): boolean =>
    typeof navigator !== 'undefined' &&
    /Android/i.test(navigator.userAgent);

// ---- 回调式桥 → Promise 封装 ----

const REQUEST_TIMEOUT_MS = 45000;
// 系统音量读写是本地操作，毫秒级返回；单独短超时，避免轮询挂起过长。
const VOLUME_REQUEST_TIMEOUT_MS = 3000;

interface PendingEntry {
    resolve: (value: FoliaBridgeResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface VolumePendingEntry {
    resolve: (ok: boolean, payload: string) => void;
    timer: ReturnType<typeof setTimeout>;
}

let nextRequestId = 1;
const pending = new Map<number, PendingEntry>();

// 音量调用用独立 requestId 段（自 1e6 起），与 HTTP 调用互不冲突。
let nextVolumeRequestId = 1_000_000;
const volumePending = new Map<number, VolumePendingEntry>();

const registerResultHandler = (): void => {
    if (typeof window === 'undefined') return;
    if (window.__foliaBridgeOnResult) return;
    window.__foliaBridgeOnResult = (requestId, ok, payload) => {
        // 音量桥调用走独立 pending：payload 是裸浮点字符串，不是 JSON。
        const volumeEntry = volumePending.get(requestId);
        if (volumeEntry) {
            volumePending.delete(requestId);
            clearTimeout(volumeEntry.timer);
            volumeEntry.resolve(ok, payload);
            return;
        }
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

/** 发起一次系统音量桥调用；永不 reject，失败统一以 { ok:false } 返回，方便上层空处理。 */
const invokeVolumeBridge = (invoke: (requestId: number) => void): Promise<{ ok: boolean; payload: string }> =>
    new Promise((resolve) => {
        const requestId = nextVolumeRequestId++;
        const timer = setTimeout(() => {
            volumePending.delete(requestId);
            resolve({ ok: false, payload: 'timeout' });
        }, VOLUME_REQUEST_TIMEOUT_MS);
        volumePending.set(requestId, {
            resolve: (ok, payload) => resolve({ ok, payload }),
            timer,
        });
        try {
            invoke(requestId);
        } catch (error) {
            volumePending.delete(requestId);
            clearTimeout(timer);
            resolve({ ok: false, payload: error instanceof Error ? error.message : String(error) });
        }
    });

/** "0..1 浮点字符串" → number；非法/越界归一为 0..1，失败返回 null。 */
const parseVolumeLevel = (payload: string): number | null => {
    const n = Number.parseFloat(payload);
    if (!Number.isFinite(n)) return null;
    return Math.min(1, Math.max(0, n));
};

// ---- 原生推送事件：媒体键（ns='system', method='mediaKey'）----

export type NativeMediaKey = 'next' | 'prev' | 'play' | 'pause' | 'playpause';
type NativeMediaKeyHandler = (key: NativeMediaKey) => void;
const nativeMediaKeyHandlers = new Set<NativeMediaKeyHandler>();

/** ns='system' 的通用事件处理器（method='seek' / method='focus' 等）。 */
export type NativeSystemEventHandler = (method: string, payload: unknown) => void;
const nativeSystemEventHandlers = new Set<NativeSystemEventHandler>();

/**
 * 最近一条已处理事件的原生序号。
 *
 * 原生事件有两条通道：port 即时推送、页面 400ms 轮询拉取。两条都带同一个自增 seq，
 * 谁先到都能处理，后到的按 seq 丢掉。这样轮询不会把推送已经处理过的上一曲再放一遍。
 */
let lastEventSeq = 0;

/** 事件处理（推送与拉取共用）。 */
const dispatchNativeEvent = (ns: string, method: string, payload: unknown, seq?: number): void => {
    if (ns !== 'system') return;
    if (typeof seq === 'number' && Number.isFinite(seq)) {
        if (seq <= lastEventSeq) return;
        lastEventSeq = seq;
    }
    // 车机排查口：原生的系统事件全从这里进来，留一行在会话日志里（设置 → 开发者选项）。
    // 按了方向盘却读不到这行，说明事件根本没到应用 —— 那是车厂把它派给了别人，
    // 不是我们分发错了。这行和壳层的 keyDiag 合起来才能把两种失败分开。
    // 'volume' 也记：假可调车机上滚轮"没反应"时，这行能区分"事件到了但功放不听"
    // （映射生效、软件增益在动）和"事件根本没来"（车厂没派发）两种完全不同的病因。
    if (method === 'mediaKey' || method === 'volumeKey' || method === 'focus'
        || method === 'keyDiag' || method === 'diag' || method === 'volume') {
        console.log(
            '[CarKeys] native →',
            method,
            typeof payload === 'string' ? payload : JSON.stringify(payload),
        );
    }
    // 通用通道：seek（毫秒位置）/ focus（duck/unduck）等系统级事件。
    nativeSystemEventHandlers.forEach(handler => {
        try {
            handler(method, payload);
        } catch (e) {
            console.warn('[FoliaBridge] native system event handler failed:', method, e);
        }
    });
    if (method !== 'mediaKey') return;
    if (payload === 'next' || payload === 'prev' || payload === 'play' || payload === 'pause' || payload === 'playpause') {
        nativeMediaKeyHandlers.forEach(handler => handler(payload));
    }
};

const registerNativeEventHandler = (): void => {
    startNativeEventPolling();
    if (typeof window === 'undefined' || window.__foliaOnEvent) return;
    window.__foliaOnEvent = (ns, method, payload, seq) => dispatchNativeEvent(ns, method, payload, seq);
};

// ---- 拉取通道：页面主动取，不依赖 port → background → content 的四跳推送 ----

let eventPollTimer: ReturnType<typeof setInterval> | null = null;
let eventPollInFlight = false;

const startNativeEventPolling = (): void => {
    if (eventPollTimer || typeof window === 'undefined') return;
    if (typeof window.foliaBridge?.pollEvents !== 'function') {
        // 扩展 shim 是 document_start 注入的，与 bundle 执行有竞争；还没到位就稍后再试，
        // 不能一次判死（否则整版都没有事件，跟推送断掉的表现一模一样）。
        setTimeout(startNativeEventPolling, 500);
        return;
    }
    const tick = async (): Promise<void> => {
        if (eventPollInFlight) return;
        eventPollInFlight = true;
        try {
            const { ok, payload } = await invokeVolumeBridge(id =>
                window.foliaBridge!.pollEvents!(id, String(lastEventSeq)),
            );
            if (!ok || !payload) return;
            const parsed = JSON.parse(payload) as {
                seq?: number;
                events?: Array<{ s?: number; m?: string; p?: string }>;
            };
            for (const e of parsed.events ?? []) {
                if (!e || typeof e.m !== 'string') continue;
                dispatchNativeEvent('system', e.m, e.p ?? '', typeof e.s === 'number' ? e.s : undefined);
            }
            // 服务端可能有比已处理更新的序号（例如首拉时的历史事件被时间窗过滤掉的），
            // 对齐到最新，避免下一轮重复扫同一段。
            if (typeof parsed.seq === 'number' && parsed.seq > lastEventSeq) {
                lastEventSeq = parsed.seq;
            }
        } catch {
            // 解析失败/端口未就绪：下一轮再试，不打断播放。
        } finally {
            eventPollInFlight = false;
        }
    };
    eventPollTimer = setInterval(() => {
        void tick();
    }, 400);
    void tick();
};

/** 订阅原生媒体键推送（车载方向盘/耳机线控）。返回取消订阅函数。非原生环境不注册、不报错。 */
export const onNativeMediaKey = (handler: NativeMediaKeyHandler): (() => void) => {
    registerNativeEventHandler();
    nativeMediaKeyHandlers.add(handler);
    return () => {
        nativeMediaKeyHandlers.delete(handler);
    };
};

/** 订阅 ns='system' 的通用原生事件（method='seek' / method='focus' 等）。返回取消订阅函数。 */
export const onNativeSystemEvent = (handler: NativeSystemEventHandler): (() => void) => {
    registerNativeEventHandler();
    nativeSystemEventHandlers.add(handler);
    return () => {
        nativeSystemEventHandlers.delete(handler);
    };
};

/**
 * 上报播放状态到壳层 MediaSession/前台服务。桥不存在或调用抛错均静默 no-op。
 */
export const reportFoliaMediaState = (state: NativeMediaState): void => {
    try {
        window.foliaBridge?.reportMediaState?.(state);
    } catch {
        // 壳层尚未实现或抛错：静默，不影响播放。
    }
};

/**
 * 读取系统当前媒体音量档位（0..1）。桥不可用/超时/返回非法 → null。
 */
export const getSystemVolume = async (): Promise<number | null> => {
    if (!isFoliaVolumeBridgeAvailable()) return null;
    registerResultHandler();
    const bridge = window.foliaBridge!;
    const { ok, payload } = await invokeVolumeBridge(id => bridge.getSystemVolume(id));
    if (!ok) return null;
    return parseVolumeLevel(payload);
};

/**
 * 读取系统音量能力：'fixed' = AudioManager 是空转的（DiLink 等固定音量车机，
 * 硬件增益由 CarAudioService 接管），此时 APP 必须用软件增益控制响度。
 * 桥不可用/超时 → null（按可调处理，保持老行为）。
 */
export const getVolumeMode = async (): Promise<'fixed' | 'adjustable' | null> => {
    if (typeof window === 'undefined' || typeof window.foliaBridge?.getVolumeMode !== 'function') {
        return null;
    }
    registerResultHandler();
    const bridge = window.foliaBridge!;
    const { ok, payload } = await invokeVolumeBridge(id => bridge.getVolumeMode(id));
    if (!ok) return null;
    const mode = String(payload).trim();
    return mode === 'fixed' ? 'fixed' : mode === 'adjustable' ? 'adjustable' : null;
};

/**
 * 设置系统媒体音量档位（clamp 到 0..1）。
 * 返回原生回读的实际档位（0..1）；桥不可用/失败 → null。
 */
export const setSystemVolume = async (level: number): Promise<number | null> => {
    if (!isFoliaVolumeBridgeAvailable()) return null;
    registerResultHandler();
    const bridge = window.foliaBridge!;
    const clamped = Math.min(1, Math.max(0, level));
    const { ok, payload } = await invokeVolumeBridge(id => bridge.setSystemVolume(id, String(clamped)));
    if (!ok) return null;
    return parseVolumeLevel(payload);
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

// 模块加载即开轮询：不等任何人订阅。启动诊断（首帧后 2.5s 起）本来就没有订阅者，
// 只有轮询在跑，那两行才会出现在会话日志里。
if (typeof window !== 'undefined' && isNativeAndroidShell()) {
    startNativeEventPolling();
}
