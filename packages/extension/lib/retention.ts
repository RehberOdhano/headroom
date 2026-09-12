import type { DaemonSession } from '@headroom/shared';

export const SESSION_RETENTION_DAYS = 30;
export const RETENTION_WARNING_DAYS = 5;

export interface RetentionWarning {
  session: DaemonSession;
  daysLeft: number;
}

/** Sessions within `RETENTION_WARNING_DAYS` of Claude Code's `SESSION_RETENTION_DAYS`-day log
 *  cleanup, soonest first. Extracted out of the `RetentionWarnings` dashboard component so the
 *  background worker's toolbar-badge check can reuse the exact same definition of "worth
 *  flagging" rather than drifting from it. */
export function findRetentionWarnings(sessions: DaemonSession[], now: number = Date.now()): RetentionWarning[] {
  return sessions
    .map((session) => ({
      session,
      daysLeft: SESSION_RETENTION_DAYS - (now - new Date(session.lastActivity).getTime()) / (24 * 60 * 60 * 1000),
    }))
    .filter((w) => w.daysLeft > 0 && w.daysLeft <= RETENTION_WARNING_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}
