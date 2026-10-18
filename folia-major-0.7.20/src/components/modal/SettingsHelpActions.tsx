import React from 'react';
import { FolderOpen, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// src/components/modal/SettingsHelpActions.tsx
// foliaAPP：把原来无用的「版本更新」按钮替换为「导入文件夹」，点击直接触发本地目录导入。

type SettingsHelpActionsProps = {
    onImportFolder: () => void;
    onOpenPonder: () => void;
};

const SettingsHelpActions: React.FC<SettingsHelpActionsProps> = ({ onImportFolder, onOpenPonder }) => {
    const { t } = useTranslation();

    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
                type="button"
                data-testid="help-import-folder"
                onClick={onImportFolder}
                className="flex items-center gap-3 rounded-2xl bg-white/5 p-4 text-left transition-colors hover:bg-white/10"
                style={{ color: 'var(--text-primary)' }}
            >
                <FolderOpen size={19} className="shrink-0 opacity-75" aria-hidden="true" />
                <span>
                    <span className="block text-sm font-semibold">{t('localMusic.importFolder')}</span>
                    <span className="mt-0.5 block text-xs opacity-55">{t('localMusic.importFolderHint', '选择音乐文件夹（含同名 .krc 歌词）')}</span>
                </span>
            </button>
            <button
                type="button"
                data-testid="help-page-ponder"
                onClick={onOpenPonder}
                className="flex items-center gap-3 rounded-2xl bg-white/5 p-4 text-left transition-colors hover:bg-white/10"
                style={{ color: 'var(--text-primary)' }}
            >
                <Lightbulb size={19} className="shrink-0 opacity-75" aria-hidden="true" />
                <span>
                    <span className="block text-sm font-semibold">{t('help.ponder')}</span>
                    <span className="mt-0.5 block text-xs opacity-55">{t('help.ponderDescription')}</span>
                </span>
            </button>
        </div>
    );
};

export default SettingsHelpActions;
