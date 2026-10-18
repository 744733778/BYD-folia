import { useSyncExternalStore } from 'react';

// src/hooks/useDeviceViewport.ts
// 设备视口快照的唯一出处，为安卓横屏移植提供「设备分辨率判断」的单一入口。
//
// 桌面布局按 ≥1280×720 的视口设计；安卓横屏的 CSS 视口往往只有 ~800×360，
// 宽度凑合但高度严重不足。这里的判断让布局分支能从一处读取当前 CSS 视口尺寸、
// 物理分辨率与横竖屏方向，不必各自手搓 matchMedia / resize。
//
// 横屏按「视口宽 > 高」判定，而非 `(orientation: landscape)`：前者直接反映
// 布局可用空间，且与 WebView 里 orientation 偶发滞后无关。
//
// 与 useViewportSettle 同款模块级 store：单一 window 监听，所有消费方共享快照；
// 仅在尺寸或 dpr 真正变化时才通知，避免无谓重渲染。

interface DeviceViewport {
    /** CSS 视口宽（逻辑像素） */
    width: number;
    /** CSS 视口高（逻辑像素） */
    height: number;
    /** devicePixelRatio，CSS 像素到物理像素的换算比 */
    dpr: number;
    /** 物理分辨率宽 = width * dpr */
    pixelWidth: number;
    /** 物理分辨率高 = height * dpr */
    pixelHeight: number;
    /** 视口宽 > 高（横屏） */
    isLandscape: boolean;
}

const read = (): DeviceViewport => {
    if (typeof window === 'undefined') {
        // SSR / 测试回退：桌面 1080p 视口。
        return {
            width: 1280, height: 720, dpr: 1,
            pixelWidth: 1280, pixelHeight: 720,
            isLandscape: true,
        };
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    return {
        width, height, dpr,
        pixelWidth: Math.round(width * dpr),
        pixelHeight: Math.round(height * dpr),
        isLandscape: width > height,
    };
};

let snapshot = read();
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

const refresh = () => {
    const next = read();
    if (next.width !== snapshot.width || next.height !== snapshot.height || next.dpr !== snapshot.dpr) {
        snapshot = next;
        publish();
    }
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1 && typeof window !== 'undefined') {
        window.addEventListener('resize', refresh);
        window.addEventListener('orientationchange', refresh);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size || typeof window === 'undefined') return;
        window.removeEventListener('resize', refresh);
        window.removeEventListener('orientationchange', refresh);
    };
};

/** 当前设备视口快照：CSS 尺寸、物理分辨率与横竖屏方向。 */
export const useDeviceViewport = (): DeviceViewport =>
    useSyncExternalStore(subscribe, () => snapshot, read);

export default useDeviceViewport;
