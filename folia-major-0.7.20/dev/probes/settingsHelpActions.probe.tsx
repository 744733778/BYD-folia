import React from 'react';
import SettingsHelpActions from '../../src/components/modal/SettingsHelpActions';
import PonderHost from '../../src/components/ponder/PonderHost';
import { openPonderNavigation } from '../../src/services/ponder/pagePonderTarget';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';

// dev/probes/settingsHelpActions.probe.tsx
// foliaAPP：版本更新按钮已替换为「导入文件夹」，探针相应更新。

const ProbeBody: React.FC = () => (
    <div
        data-ponder-page-scope="help-page"
        className="min-h-screen bg-zinc-950 p-10 text-white"
        style={{ '--text-primary': '#fafafa', '--text-secondary': '#a1a1aa' } as React.CSSProperties}
    >
        <SettingsHelpActions
            onImportFolder={() => console.log('import folder clicked')}
            onOpenPonder={openPonderNavigation}
        />
        <PonderHost theme={DEFAULT_THEME} isDaylight={false} />
    </div>
);

const probe: ProbeDefinition = {
    id: 'settingsHelpActions',
    title: 'Help · 导入文件夹与页面思索入口',
    description: '验证导入文件夹入口与 Help 页面级 Ponder。',
    Component: ProbeBody,
};

export default probe;
