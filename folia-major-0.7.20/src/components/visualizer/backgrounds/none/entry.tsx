import React from 'react';
import { defineVisualizerBackground } from '../definition';

// src/components/visualizer/backgrounds/none/entry.tsx
// 「关闭」背景模式：纯黑底，不跑任何着色器/three.js/动画——默认背景层，降负载。
export default defineVisualizerBackground({
    mode: 'none',
    order: 5,
    labelKey: 'options.visualizerBackgroundModeNone',
    labelFallback: 'Off',
    render: () => (
        <div className="absolute inset-0 z-0" style={{ backgroundColor: '#000000' }} />
    ),
});
