import React from 'react';
import { defineVisualizer } from '../definition';

const VisualizerOff = React.lazy(() => import('./VisualizerOff'));

// src/components/visualizer/off/entry.tsx
// 「关闭」文字模式：默认文字层，纯 DOM + 逐字变色，零粒子/零 canvas/零 three.js。
export default defineVisualizer({
    mode: 'off',
    order: 140,
    labelKey: 'ui.visualizerOff',
    labelFallback: 'Off',
    previewSeed: 'off',
    previewStartOffset: 0,
    tuningKind: 'none',
    render: props => <VisualizerOff {...props} />,
});
