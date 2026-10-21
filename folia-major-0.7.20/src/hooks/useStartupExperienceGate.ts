import { useCallback, useEffect, useState } from 'react';
import { USER_GUIDE_AUTO_OPEN_VERSION } from '../components/modal/userGuideContent';
import { hasOnboardingLibrarySuiteChoice } from '../library/app/librarySuiteChoice';
import { requestPlaybackEntryViewPrompt, usePlaybackEntryViewStore } from '../stores/usePlaybackEntryViewStore';
import { useSettingsModalStore } from '../stores/useSettingsModalStore';

// src/hooks/useStartupExperienceGate.ts

const LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY = 'folia_last_seen_guide_version';

export type StartupExperienceStep = 'release-notes' | 'playback-entry-view' | null;

type StartupExperienceState = {
    isCurrentRelease: boolean;
    hasSeenReleaseNotes: boolean;
    isReleaseNotesOpen: boolean;
    hasChosenPlaybackEntryView: boolean;
    /**
     * The library-interface page is still owed (both suites exist and it has never been shown). Unlike everything
     * else here it is not gated by the release: everyone is asked once (2026-10-10), whatever version they are on.
     */
    needsLibrarySuitePrompt: boolean;
    isPlaybackEntryViewPromptOpen: boolean;
};

/** Chooses the next blocking surface while ensuring that two startup dialogs never overlap. */
export const resolveStartupExperienceStep = ({
    isCurrentRelease,
    hasSeenReleaseNotes,
    isReleaseNotesOpen,
    hasChosenPlaybackEntryView,
    needsLibrarySuitePrompt,
    isPlaybackEntryViewPromptOpen,
}: StartupExperienceState): StartupExperienceStep => {
    // foliaAPP：首启不弹任何引导（版本更新 / 资料库与播放视图选择）。直接返回 null 关闭全部。
    void isCurrentRelease; void hasSeenReleaseNotes;
    void isReleaseNotesOpen; void hasChosenPlaybackEntryView; void needsLibrarySuitePrompt;
    void isPlaybackEntryViewPromptOpen;
    return null;
};

const readLastSeenReleaseNotesVersion = (): string | null => (
    typeof window === 'undefined'
        ? null
        : localStorage.getItem(LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY)
);

/**
 * Runs the first-launch sequence: release notes, then the two-page choice prompt (library
 * interface, then playback destination). The prompt is gated by the playback choice alone,
 * so installs that answered the older single-page prompt are not asked again.
 */
export const useStartupExperienceGate = () => {
    const hasChosenPlaybackEntryView = usePlaybackEntryViewStore(state => state.hasChosenPlaybackEntryView);
    const hasSeenLibrarySuitePrompt = usePlaybackEntryViewStore(state => state.hasSeenLibrarySuitePrompt);
    const needsLibrarySuitePrompt = hasOnboardingLibrarySuiteChoice() && !hasSeenLibrarySuitePrompt;
    const isPlaybackEntryViewPromptOpen = usePlaybackEntryViewStore(state => state.isPlaybackEntryViewPromptOpen);
    const [lastSeenReleaseNotesVersion, setLastSeenReleaseNotesVersion] = useState(readLastSeenReleaseNotesVersion);
    const [isReleaseNotesOpen, setIsReleaseNotesOpen] = useState(false);
    const appVersion = typeof __APP_VERSION__ === 'undefined' ? null : __APP_VERSION__;

    const nextStep = resolveStartupExperienceStep({
        isCurrentRelease: Boolean(appVersion && USER_GUIDE_AUTO_OPEN_VERSION === appVersion),
        hasSeenReleaseNotes: Boolean(appVersion && lastSeenReleaseNotesVersion === appVersion),
        isReleaseNotesOpen,
        hasChosenPlaybackEntryView,
        needsLibrarySuitePrompt,
        isPlaybackEntryViewPromptOpen,
    });

    useEffect(() => {
        if (nextStep === 'release-notes') {
            setIsReleaseNotesOpen(true);
        } else if (nextStep === 'playback-entry-view') {
            requestPlaybackEntryViewPrompt({ withLibrarySuite: hasOnboardingLibrarySuiteChoice() });
        }
    }, [nextStep]);

    const closeReleaseNotes = useCallback(() => {
        if (appVersion) {
            localStorage.setItem(LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY, appVersion);
            setLastSeenReleaseNotesVersion(appVersion);
        }
        setIsReleaseNotesOpen(false);
    }, [appVersion]);

    return { isReleaseNotesOpen, closeReleaseNotes };
};
