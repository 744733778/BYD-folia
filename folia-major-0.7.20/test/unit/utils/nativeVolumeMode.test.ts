import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// 音量归属判据是车机实测教训的沉淀：null（未知）绝不能被当成 adjustable——
// 那会把网页增益钉死成 1，表现为"永远最大声、滑竿和音量键全死"。
const nativeShell = { current: false };
const volumeMode = { current: null as 'fixed' | 'adjustable' | null };

vi.mock('@/services/foliaExtensionBridge', () => ({
    isNativeAndroidShell: () => nativeShell.current,
    getVolumeMode: async () => volumeMode.current,
}));

import {
    getVolumeModeOverride,
    resolveNativeVolumeMode,
    setVolumeModeOverride,
    subscribeVolumeModeOverride,
    systemVolumeGoverns,
} from '@/utils/nativeVolumeMode';

describe('systemVolumeGoverns', () => {
    beforeEach(() => {
        nativeShell.current = false;
        volumeMode.current = null;
        setVolumeModeOverride('auto');
    });

    it('非原生壳（桌面/浏览器）：系统永远不接管', () => {
        expect(systemVolumeGoverns(null, null)).toBe(false);
        expect(systemVolumeGoverns(false, 0.5)).toBe(false);
    });

    it('原生壳 + adjustable + 档位低于满档：系统接管', () => {
        nativeShell.current = true;
        expect(systemVolumeGoverns(false, 0.5)).toBe(true);
    });

    it('原生壳 + fixed：网页软件增益接管', () => {
        nativeShell.current = true;
        expect(systemVolumeGoverns(true, 0.5)).toBe(false);
    });

    it('原生壳 + 未知（null）：网页层继续管——绝不钉死成 1', () => {
        nativeShell.current = true;
        expect(systemVolumeGoverns(null, 0.5)).toBe(false);
        expect(systemVolumeGoverns(null, null)).toBe(false);
    });

    it('原生壳 + adjustable 但档位未知或已满：不交给系统', () => {
        nativeShell.current = true;
        expect(systemVolumeGoverns(false, null)).toBe(false);
        expect(systemVolumeGoverns(false, 1)).toBe(false);
    });

    it('覆盖项优先于探测', () => {
        nativeShell.current = true;
        setVolumeModeOverride('fixed');
        expect(systemVolumeGoverns(false, 0.5)).toBe(false);
        setVolumeModeOverride('system');
        expect(systemVolumeGoverns(true, 0.5)).toBe(true);
        setVolumeModeOverride('auto');
    });

    it('覆盖项变更会通知订阅者', () => {
        const listener = vi.fn();
        const off = subscribeVolumeModeOverride(listener);
        setVolumeModeOverride('fixed');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getVolumeModeOverride()).toBe('fixed');
        off();
        setVolumeModeOverride('auto');
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('resolveNativeVolumeMode', () => {
    beforeEach(() => {
        nativeShell.current = true;
        setVolumeModeOverride('auto');
    });

    afterEach(() => {
        setVolumeModeOverride('auto');
    });

    it('探测 fixed → true', async () => {
        volumeMode.current = 'fixed';
        await expect(resolveNativeVolumeMode()).resolves.toBe(true);
    });

    it('探测 adjustable → false', async () => {
        volumeMode.current = 'adjustable';
        await expect(resolveNativeVolumeMode()).resolves.toBe(false);
    });

    it('探测持续 null（旧版持久扩展没有该方法）→ null，绝不折算成 adjustable', async () => {
        volumeMode.current = null;
        await expect(resolveNativeVolumeMode(2, 1)).resolves.toBeNull();
    });

    it('覆盖 fixed/system 时不必等探测', async () => {
        volumeMode.current = 'adjustable';
        setVolumeModeOverride('fixed');
        await expect(resolveNativeVolumeMode()).resolves.toBe(true);
        setVolumeModeOverride('system');
        await expect(resolveNativeVolumeMode()).resolves.toBe(false);
    });
});
