/** What's-new copy shown once after an update. Add an entry per release worth announcing;
 *  versions without one show nothing. */
export const RELEASE_NOTES: Record<string, string[]> = {
  '0.3.1': [
    'Refreshed the popup and Settings pages to match the dashboard’s look, including dark mode.',
    'Redesigned the subagent list in Activity → By session as an expandable card, with a scroll limit for sessions with many subagents.',
    'Fixed: Activity could go blank if just one section (like the daily total) failed to load — the rest of the tab now keeps working.',
    'Fixed: "Sessions nearing cleanup" could go silent if the check itself failed — it now tells you when that happens.',
  ],
  '0.3.0': [
    'Added: a sustainable "safe pace" next to each bar — how slow usage needs to average to last until reset.',
    'Added: anomaly detection — flags when a bar is rising well faster than its own recent pattern.',
    'Added: "What changed?" — how this week’s project/model mix compares to the same point last week, once a swing is big enough to matter.',
    'Added: Usage Inspector — when an anomaly fires, see which local sessions were active during that window (or that none were).',
    'Added: read-only subagent activity visibility — expand a session to see which subagents ran and their own token totals.',
    'Added: numbers are now labeled by where they come from (reported by Claude, read from local logs, or a rough estimate) via a tooltip.',
    'Added: Settings → Diagnostics — a privacy-safe summary of extension/daemon status you can copy for troubleshooting — never your token, account id, or any conversation content.',
    'Fixed: a bar whose reset time had just passed could read "resets resetting now" — now reads "resets now".',
    'Changed: the dashboard is now Overview / Activity / Sessions, reorganized around usage intelligence rather than implementation history.',
    'Changed: headroom is now focused specifically on Claude usage intelligence — Guardrails and New Project are no longer part of the shipped product.',
  ],
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
