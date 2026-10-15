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
 * 分屏 / 旋转 / 窗口尺寸变化时，Activity 不会重建（见 AndroidManifest 的 configChanges），
 * 而是 WebView 直接 resize。这里监听视口变化，按当前宽高比动态更新 orientation 并重新
 * apply，保证全屏与分屏两种形态下紧凑布局（所有可交互元素收进视口）持续生效。
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
        });
    };

    window.addEventListener('resize', applyForViewport);
    window.addEventListener('orientationchange', applyForViewport);
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
