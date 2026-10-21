// src/utils/flatUi.ts
// 2D（平面）界面开关：安卓壳的 flat 变体在启动 URL 上带 `flat=1`。
// 开启后音乐墙从蜂窝 3D 布局换成等大等距的平面网格（无缩放衰减、无飞入/翻转），
// 播放页（动态歌词与背景）不受影响。桌面/3D 版不带这个参数，行为完全不变。

const readFlatFlag = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return new URLSearchParams(window.location.search).get('flat') === '1';
    } catch {
        return false;
    }
};

/** 模块级常量：一次启动内不会变，也不需要响应式。 */
export const FLAT_UI = readFlatFlag();

export const isFlatUi = (): boolean => FLAT_UI;
