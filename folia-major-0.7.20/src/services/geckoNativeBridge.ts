// src/services/geckoNativeBridge.ts
// 页面世界 Gecko 桥（纯前端、零原生 API）。
//
// 在 WebExtension / GeckoView 页面世界里没有 addJavascriptInterface，原生不会直接往
// window 上注入 window.foliaBridge / window.nativeLibrary。本模块在页面世界安装这两个
// 回调式桥对象（与安卓 WebView 壳注入的对象形状一致），把每次调用序列化为 postMessage
// 上行，交给 WebExtension content script 中继：
//
//   页面桥 (window.foliaBridge / window.nativeLibrary)
//     → window.postMessage({ __foliaGecko: true, kind: 'call', request: { channel, requestId, method, arg } })
//     → WebExtension content script 中继
//     → connectNative('foliaNative')
//     → 原生
//
// 原生结果由 content script 以
//   window.postMessage({ __foliaGecko: true, kind: 'result', channel, requestId, ok, payload })
// 发回，本模块按 channel 分发给前端业务模块自行安装的
//   window.__foliaBridgeOnResult(requestId, ok, payload)
//   window.__nativeLibraryOnResult(requestId, ok, payload)
//
// 只用到 window.postMessage 与 window.addEventListener('message')，不触碰任何原生 API。

import type { NativeLibraryBridge } from './nativeLibrary/nativeLibrarySource';

type GeckoChannel = 'foliaBridge' | 'nativeLibrary';

interface GeckoCallRequest {
    channel: GeckoChannel;
    requestId: number;
    method: string;
    /** 字符串参数：readFile 的 relativePath、httpRequest 的 requestJson；无参方法不传该键 */
    arg?: string;
}

/** 上行：把一次桥调用交给页面世界 → content script → connectNative('foliaNative')。 */
const relay = (channel: GeckoChannel, method: string, requestId: number, arg?: string): void => {
    const request: GeckoCallRequest = { channel, requestId, method };
    if (arg !== undefined) request.arg = arg;
    window.postMessage({ __foliaGecko: true, kind: 'call', request }, '*');
};

/** 下行：接收 content script 中继回来的原生结果，分发给业务模块自装的回调。 */
const installGeckoResultListener = (): void => {
    window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.__foliaGecko !== true || data.kind !== 'result') return;
        if (typeof data.requestId !== 'number') return;

        const requestId: number = data.requestId;
        const ok: boolean = data.ok === true;
        const payload: string = typeof data.payload === 'string' ? data.payload : '';

        if (data.channel === 'nativeLibrary') {
            if (typeof window.__nativeLibraryOnResult === 'function') {
                window.__nativeLibraryOnResult(requestId, ok, payload);
            } else {
                console.warn('[GeckoBridge] nativeLibrary result 无人接收:', requestId);
            }
            return;
        }
        if (data.channel === 'foliaBridge') {
            if (typeof window.__foliaBridgeOnResult === 'function') {
                window.__foliaBridgeOnResult(requestId, ok, payload);
            } else {
                console.warn('[GeckoBridge] foliaBridge result 无人接收:', requestId);
            }
        }
    });
};

const installGeckoBridges = (): void => {
    if (typeof window === 'undefined') return;

    // 若原生壳已注入真实桥（addJavascriptInterface），不覆盖；否则安装页面世界中继桥。
    if (!window.nativeLibrary) {
        window.nativeLibrary = {
            isAvailable: true,
            pickDirectory: (requestId: number): void =>
                relay('nativeLibrary', 'pickDirectory', requestId),
            readFile: (requestId: number, relativePath: string): void =>
                relay('nativeLibrary', 'readFile', requestId, relativePath),
        } as NativeLibraryBridge;
    }

    if (!window.foliaBridge) {
        window.foliaBridge = {
            isAvailable: (): boolean => true,
            httpRequest: (requestId: number, requestJson: string): void =>
                relay('foliaBridge', 'httpRequest', requestId, requestJson),
        };
    }

    installGeckoResultListener();
};

// 模块顶层直接执行：必须先于业务桥调用方（bootstrap 及其下游）求值安装。
installGeckoBridges();
