/** What's-new copy shown once after an update. Add an entry per release worth announcing;
 *  versions without one show nothing. */
export const RELEASE_NOTES: Record<string, string[]> = {
  '0.2.2': [
    'CLI Attribution now breaks usage down by individual session, not just by project and model.',
    'The By-project and By-session tables are filterable by typing, for accounts with a long list.',
    'Session exports can optionally include a short summary of each tool call and its result.',
    'The popup now tells apart "haven’t visited claude.ai yet" from "detected, just waiting on the first snapshot" instead of repeating the same instruction either way.',
  ],
  '0.2.1': [
    'The empty popup now links straight to claude.ai’s Settings → Usage instead of just describing it.',
  ],
  '0.2.0': [
    'The popup now flags, in one line, when you are on pace to run out before a limit resets (and stays quiet otherwise).',
    'The dashboard shows CLI tabs only once the daemon is connected, with a copy-paste install command until then.',
    'New: an optional warning when you are on pace to run out before a limit resets (Settings).',
    'When a reset is close, the popup suggests waiting it out instead of just warning.',
    'Forecast warnings now stay hidden until a bar has enough usage to make them meaningful.',
  ],
};

export function notesForVersion(version: string): string[] {
  return RELEASE_NOTES[version] ?? [];
}

/** Whether to announce: only when a previous version was recorded and differs — a fresh install
 *  (nothing recorded) gets onboarding instead, not a changelog. */
export function shouldShowReleaseNotes(lastSeen: string | undefined, current: string): boolean {
  return lastSeen !== undefined && lastSeen !== current && notesForVersion(current).length > 0;
}
