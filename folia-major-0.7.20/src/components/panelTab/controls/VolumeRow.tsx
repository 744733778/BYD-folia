import React, { useEffect, useRef, useState } from 'react';
import { Blend, SlidersHorizontal, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import { useAutomixSettingsStore } from '../../../stores/useAutomixSettingsStore';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { isNativeAndroidShell, setSystemVolume } from '../../../services/foliaExtensionBridge';
import { useNativeVolumeMirrorStore } from '../../../stores/useNativeVolumeMirrorStore';

// src/components/panelTab/controls/VolumeRow.tsx
// 单行音量：静音、滑杆、百分比、均衡器入口挤在同一行，省掉原来单独占一行的标题。

interface VolumeRowProps {
    volume: number;
    isMuted: boolean;
    onVolumePreview: (val: number) => void;
    onVolumeChange: (val: number) => void;
    onToggleMute: () => void;
    theme: Theme;
    isDaylight: boolean;
}

const VolumeRow: React.FC<VolumeRowProps> = ({
    volume,
    isMuted,
    onVolumePreview,
    onVolumeChange,
    onToggleMute,
    theme,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const audioEqualizerSettings = useAudioSettingsStore(state => state.audioEqualizerSettings);
    const openAudioEqualizer = useAudioSettingsStore(state => state.openAudioEqualizer);
    const automixEnabled = useAutomixSettingsStore(state => state.automixEnabled);
    const toggleAutomix = useAutomixSettingsStore(state => state.handleToggleAutomix);
    const [sliderVolume, setSliderVolume] = useState(isMuted ? 0 : volume);
    const isDraggingRef = useRef(false);
    const pendingVolumeRef = useRef(sliderVolume);
    const lastNativeSetRef = useRef(0);
    const wellBg = isDaylight ? 'bg-black/5' : 'bg-black/20';
    // 安卓 GeckoView 壳：
    //  - 普通机型：音量就是系统媒体音量，滑杆读镜像值显示，拖动直接写 STREAM_MUSIC（节流 80ms），
    //    **不写网页增益**——系统已经缩放过一次，再乘一次会让音量明显偏小。
    //  - 固定音量机型（DiLink 等）：系统音量是空转的，滑杆改为写应用内软件增益（gainNode），
    //    这是唯一能压低响度的途径；静音键也恢复可用。
    const nativeShell = isNativeAndroidShell();
    const fixedVolume = useNativeVolumeMirrorStore(state => state.fixedVolume);
    // 探测没过（含还没探测完的 null）一律按"应用内音量"处理：DiLink 上 isVolumeFixed 可能报
    // false 但 STREAM_MUSIC 写了不生效，滑杆必须走软件音量才有反应。
    const softVolume = nativeShell && fixedVolume !== false;
    const hideMuteButton = nativeShell && !softVolume;
    const systemVolume = useNativeVolumeMirrorStore(state => state.systemVolume);

    // 固定音量：显示应用内音量；普通原生壳：跟随镜像回读的系统音量（拖动中不覆盖）。
    const effectiveVolume = softVolume
        ? volume
        : nativeShell
            ? (systemVolume !== null ? systemVolume : volume)
            : volume;

    useEffect(() => {
        if (!isDraggingRef.current) {
            const nextVolume = isMuted ? 0 : effectiveVolume;
            setSliderVolume(nextVolume);
            pendingVolumeRef.current = nextVolume;
        }
    }, [effectiveVolume, isMuted]);

    const pushNativeVolume = (value: number) => {
        const now = Date.now();
        if (now - lastNativeSetRef.current < 80) return;
        lastNativeSetRef.current = now;
        void setSystemVolume(value);
    };

    const handleSliderInput = (nextVolume: number) => {
        isDraggingRef.current = true;
        pendingVolumeRef.current = nextVolume;
        setSliderVolume(nextVolume);
        if (softVolume) onVolumePreview(nextVolume);
        else if (nativeShell) pushNativeVolume(nextVolume);
        else onVolumePreview(nextVolume);
    };

    const commitVolumeChange = () => {
        if (!isDraggingRef.current) {
            return;
        }
        isDraggingRef.current = false;
        if (softVolume) {
            onVolumeChange(pendingVolumeRef.current);
            return;
        }
        if (nativeShell) {
            void setSystemVolume(pendingVolumeRef.current);
            return;
        }
        onVolumeChange(pendingVolumeRef.current);
    };

    return (
        <div className={`flex items-center gap-2.5 ${wellBg} px-2.5 py-2 rounded-xl`}>
            {!hideMuteButton && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleMute();
                    }}
                    className="shrink-0 opacity-40 transition-opacity hover:opacity-100"
                    title={t('ui.volume')}
                    aria-label={t('ui.volume')}
                >
                    {isMuted || sliderVolume === 0 ? <VolumeX size={16} /> : sliderVolume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
                </button>
            )}

            <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={sliderVolume}
                onInput={(e) => handleSliderInput(parseFloat(e.currentTarget.value))}
                onChange={(e) => handleSliderInput(parseFloat(e.currentTarget.value))}
                onMouseUp={commitVolumeChange}
                onTouchEnd={commitVolumeChange}
                onKeyUp={commitVolumeChange}
                onBlur={commitVolumeChange}
                className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-(--text-primary)"
                style={{ accentColor: theme.primaryColor }}
                aria-label={t('ui.volume')}
            />

            <span className="w-8 shrink-0 text-right text-[10px] font-bold opacity-60 tabular-nums">
                {Math.round(sliderVolume * 100)}%
            </span>

            <button
                type="button"

                onClick={openAudioEqualizer}
                className={`shrink-0 rounded-md transition-opacity hover:opacity-100 ${audioEqualizerSettings.enabled ? 'opacity-100' : 'opacity-40'}`}
                style={audioEqualizerSettings.enabled ? { color: theme.accentColor } : undefined}
                title={t('ui.openEqualizer')}
                aria-label={t('ui.openEqualizer')}
            >
                <SlidersHorizontal size={14} />
            </button>

            <button
                type="button"
                onClick={() => toggleAutomix(!automixEnabled)}
                className={`shrink-0 rounded-md transition-opacity hover:opacity-100 ${automixEnabled ? 'opacity-100' : 'opacity-40'}`}
                style={automixEnabled ? { color: theme.accentColor } : undefined}
                title={t('ui.automix')}
                aria-label={t('ui.automix')}
                aria-pressed={automixEnabled}
            >
                <Blend size={14} />
            </button>
        </div>
    );
};

export default VolumeRow;
