import { describe, expect, it } from 'vitest';
import { resolveStartupExperienceStep } from '../../../src/hooks/useStartupExperienceGate';

// test/unit/hooks/startupExperienceGate.test.ts

const readyState = {
    isCurrentRelease: true,
    hasSeenReleaseNotes: false,
    isReleaseNotesOpen: false,
    hasChosenPlaybackEntryView: false,
    needsLibrarySuitePrompt: false,
    isPlaybackEntryViewPromptOpen: false,
};

describe('startup experience gate', () => {
    // foliaAPP：车机没有首启引导的场景，整个序列被短路成永不弹出（任何状态下都返回 null）。
    // 保留解析器与测试是为了让上游 folia 的引导逻辑合并回来时能一眼看到这里被改过。
    it('stays completely quiet on the foliaAPP build', () => {
        expect(resolveStartupExperienceStep(readyState)).toBeNull();
    });

    it('stays quiet no matter which step would be owed', () => {
        expect(resolveStartupExperienceStep({
            ...readyState,
            hasSeenReleaseNotes: true,
            hasChosenPlaybackEntryView: true,
            needsLibrarySuitePrompt: true,
        })).toBeNull();

        expect(resolveStartupExperienceStep({
            ...readyState,
            isReleaseNotesOpen: true,
        })).toBeNull();

        expect(resolveStartupExperienceStep({
            ...readyState,
            isPlaybackEntryViewPromptOpen: true,
        })).toBeNull();
    });

    it('stays quiet on builds without release notes', () => {
        expect(resolveStartupExperienceStep({ ...readyState, isCurrentRelease: false })).toBeNull();
    });
});
