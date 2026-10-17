export const ANDROID_PHONE_FIT_STORAGE_KEY = 'folia_android_phone_fit';
export const ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY = 'folia_android_phone_fit_orientation';

export type AndroidPhoneFitOrientation = 'portrait' | 'landscape';

export const readStoredAndroidPhoneFit = (): boolean => {
    if (typeof window === 'undefined') return true;
    try {
        const stored = localStorage.getItem(ANDROID_PHONE_FIT_STORAGE_KEY);
        // 首次启动（无存储值）默认开启紧凑布局：车机/横屏大屏下设置与选项卡
        // 默认就该收进视口，不能等用户手动去设置里开。
        if (stored === null) return true;
        return stored === 'true';
    } catch {
        return true;
    }
};

export const writeStoredAndroidPhoneFit = (enabled: boolean): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(ANDROID_PHONE_FIT_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // A storage failure must not make the switch unusable for the current session.
    }
};

export const readStoredAndroidPhoneFitOrientation = (): AndroidPhoneFitOrientation => {
    if (typeof window === 'undefined') return 'landscape';
    try {
        const stored = localStorage.getItem(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY);
        // 首次启动（无存储值）默认横屏：车机多为固定横屏大屏。
        if (stored === null) return 'landscape';
        return stored === 'landscape' ? 'landscape' : 'portrait';
    } catch {
        return 'landscape';
    }
};

export const writeStoredAndroidPhoneFitOrientation = (orientation: AndroidPhoneFitOrientation): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY, orientation);
    } catch {
        // A storage failure must not make the switch unusable for the current session.
    }
};

/**
 * Applies the Android-only compact layout at the document root.
 *
 * Keeping this as one attribute means every override lives in one stylesheet and upstream
 * components keep their own markup and breakpoints.
 */
export const applyAndroidPhoneFit = (
    enabled: boolean,
    orientation: AndroidPhoneFitOrientation = readStoredAndroidPhoneFitOrientation(),
): void => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-folia-phone-fit', enabled ? 'true' : 'false');
    root.setAttribute('data-folia-phone-orientation', orientation);
};

export const installAndroidPhoneFitPreference = (): void => {
    applyAndroidPhoneFit(readStoredAndroidPhoneFit(), readStoredAndroidPhoneFitOrientation());
    installPhoneFitViewportListener();
};

let phoneFitViewportListenerInstalled = false;

/**
 * 车机（比亚迪 DiLink 等）在全屏 + 沉浸式 + viewport-fit=cover 下，系统常把 App
 * 放进一个「兼容窗口 / 显示比例」：WebView 的布局视口（window.innerWidth/Height）
 * 大于实际视觉视口（visualViewport）。于是主内容按大布局视口排版跑出屏幕——
 * 背景色铺满、fixed 定位的浮动按钮正常、流式主内容（菜单 / 选项卡 / header）整个
 * 偏移出屏只剩一点边缘。这里把根元素钳到视觉视口尺寸，让 100% / 100vw 的内容
 * 收回到屏幕内，菜单与设置重新可见。mismatch 消失（退出兼容窗口）时恢复。
 *
 * visualViewport 在 Android WebView 与 Chromium 均可用；Electron / Web 无差异时不动。
 */
const alignRootToVisualViewport = (): void => {
    const visual = window.visualViewport;
    const root = document.documentElement;
    if (!visual || typeof visual.width !== 'number' || typeof visual.height !== 'number') {
        root.style.width = '';
        root.style.height = '';
        return;
    }
    const lw = window.innerWidth;
    const lh = window.innerHeight;
    const vw = visual.width;
    const vh = visual.height;
    const hMismatch = Math.abs(lw - vw) > 1;
    const vMismatch = Math.abs(lh - vh) > 1;
    if (hMismatch) {
        root.style.width = `${vw}px`;
    } else {
        root.style.width = '';
    }
    if (vMismatch) {
        root.style.height = `${vh}px`;
    } else {
        root.style.height = '';
    }
};

/**
 * 分屏 / 旋转 / 窗口尺寸变化时，Activity 不会重建（见 AndroidManifest 的 configChanges），
 * 而是 WebView 直接 resize。这里监听视口变化，按当前宽高比动态更新 orientation 并重新
 * apply，同时把根元素对齐到视觉视口，保证全屏与分屏两种形态下紧凑布局（所有可交互
 * 元素收进视口）持续生效。
 *
 * 用 requestAnimationFrame 合并连续 resize，避免分屏拖动时高频重复设置属性。
 */
const installPhoneFitViewportListener = (): void => {
    if (typeof window === 'undefined' || phoneFitViewportListenerInstalled) return;
    phoneFitViewportListenerInstalled = true;

    let framePending = false;
    const applyForViewport = (): void => {
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(() => {
            framePending = false;
            const enabled = readStoredAndroidPhoneFit();
            const orientation: AndroidPhoneFitOrientation =
                window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
            applyAndroidPhoneFit(enabled, orientation);
            syncAndroidPhoneFitNative(enabled, orientation);
            // 布局视口与视觉视口错位（车机兼容窗口）时，钳根元素到视觉视口。
            alignRootToVisualViewport();
        });
    };

    window.addEventListener('resize', applyForViewport);
    window.addEventListener('orientationchange', applyForViewport);

    const visual = window.visualViewport;
    if (visual) {
        // 视觉视口的缩放 / 滚动也会改变可视区域，单独再挂一次。
        visual.addEventListener('resize', applyForViewport);
        visual.addEventListener('scroll', applyForViewport);
    }

    // 启动时布局视口可能已经错位，主动对齐一次（等首帧布局稳定）。
    applyForViewport();
};

/**
 * Synchronizes the JS setting with the Android orientation lock. Web and plugin-less runtimes
 * simply keep using the CSS attribute above.
 */
export const syncAndroidPhoneFitNative = (
    enabled: boolean,
    orientation: AndroidPhoneFitOrientation,
): void => {
    if (typeof window === 'undefined') return;
    const plugin = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: {
                FoliaNative?: {
                    setPhoneFitLayout?: (options: {
                        enabled: boolean;
                        orientation: AndroidPhoneFitOrientation;
                    }) => Promise<unknown>;
                };
            };
        };
    }).Capacitor?.Plugins?.FoliaNative;
    if (typeof plugin?.setPhoneFitLayout !== 'function') return;
    void plugin.setPhoneFitLayout({ enabled, orientation }).catch(() => undefined);
};
