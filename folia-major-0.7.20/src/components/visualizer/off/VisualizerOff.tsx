import React, { useEffect, useState } from 'react';
import { useMotionValueEvent } from 'framer-motion';
import { resolveThemeFontStack, resolveThemeFontWeight, resolveThemeTranslationFontStack } from '../../../utils/fontStacks';
import type { VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';

// src/components/visualizer/off/VisualizerOff.tsx
// 「关闭」文字模式：纯 DOM 歌词渲染 + KRC 逐字变色高亮。
// 不跑 canvas / 粒子 / 发光 / three.js——初次启动降负载的默认文字层。

const VisualizerOff: React.FC<VisualizerSharedProps> = ({
    currentTime,
    currentLineIndex,
    lines,
    theme,
    subtitleTheme,
    lyricsFontScale = 1,
    subtitleFontScale = 1,
    hideTranslationSubtitle = false,
    isDaylight = false,
    showText = true,
    audioPower,
    audioBands,
    ...sharedProps
}) => {
    const [effectiveIndex, setEffectiveIndex] = useState(() => Math.max(0, currentLineIndex));
    // 当前行内已唱到的 word 下标（-1 = 还没开始唱本行）。
    const [spokenWordIndex, setSpokenWordIndex] = useState(-1);

    useEffect(() => {
        if (currentLineIndex !== -1) {
            setEffectiveIndex(currentLineIndex);
            setSpokenWordIndex(-1);
        } else if (effectiveIndex >= lines.length) {
            setEffectiveIndex(0);
        }
    }, [currentLineIndex, effectiveIndex, lines.length]);

    useMotionValueEvent(currentTime, 'change', (timeSec) => {
        const line = lines[effectiveIndex];
        if (!line) return;
        let spoken = -1;
        for (let i = 0; i < line.words.length; i += 1) {
            if (timeSec >= line.words[i].startTime) spoken = i;
            else break;
        }
        setSpokenWordIndex(prev => (prev === spoken ? prev : spoken));
    });

    const resolvedSubtitleTheme = subtitleTheme ?? theme;

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={{
                ...sharedProps,
                isDaylight,
            }}
            renderBackground={false}
            className="visualizer-off"
        >
            {showText && (
                <div className="absolute inset-0 z-0 flex flex-col items-center justify-center pointer-events-none px-12 pb-16 gap-8">
                    {[-1, 0, 1].map((offset) => {
                        const lineIndex = effectiveIndex + offset;
                        const line = lines[lineIndex];
                        if (!line) {
                            return <div key={`empty-${offset}`} className="h-20" />;
                        }

                        const isCurrent = offset === 0;
                        return (
                            <div key={lineIndex} className="flex flex-col items-center w-full max-w-4xl">
                                {line.fullText && (
                                    <div
                                        className={`text-center tracking-[0.02em] ${isCurrent ? 'text-[2.5rem] opacity-100 leading-tight' : 'text-3xl opacity-30'}`}
                                        style={{
                                            fontFamily: resolveThemeFontStack(theme),
                                            scale: lyricsFontScale,
                                            fontWeight: resolveThemeFontWeight(theme, isCurrent ? 700 : 600),
                                        }}
                                    >
                                        {isCurrent && line.words.length > 0
                                            ? line.words.map((word, wordIndex) => (
                                                <span
                                                    key={wordIndex}
                                                    style={{ color: wordIndex <= spokenWordIndex ? theme.primaryColor : theme.secondaryColor }}
                                                >
                                                    {word.text}
                                                </span>
                                            ))
                                            : <span style={{ color: theme.primaryColor }}>{line.fullText}</span>}
                                    </div>
                                )}
                                {line.translation && !hideTranslationSubtitle && (
                                    <div
                                        className={`text-center tracking-wide ${isCurrent ? 'text-2xl opacity-80 mt-3' : 'text-xl opacity-30 mt-2'}`}
                                        style={{
                                            color: resolvedSubtitleTheme.secondaryColor,
                                            fontFamily: resolveThemeTranslationFontStack(resolvedSubtitleTheme),
                                            scale: lyricsFontScale * subtitleFontScale,
                                            fontWeight: resolveThemeFontWeight(resolvedSubtitleTheme, isCurrent ? 500 : 400),
                                        }}
                                    >
                                        {line.translation}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </VisualizerShell>
    );
};

export default VisualizerOff;
