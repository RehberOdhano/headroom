import { describe, expect, it } from 'vitest';
import { findRetentionWarnings, RETENTION_WARNING_DAYS, SESSION_RETENTION_DAYS } from '../lib/retention.js';
import { daemonSession as session } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('findRetentionWarnings', () => {
  const now = new Date('2026-08-30T00:00:00Z').getTime();

  it('flags a session within the warning window before cleanup', () => {
    // last activity 27 days ago -> 3 days left, inside the 5-day warning window.
    const lastActivity = new Date(now - 27 * DAY_MS).toISOString();
    const warnings = findRetentionWarnings([session({ sessionId: 'a', lastActivity })], now);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.daysLeft).toBeCloseTo(SESSION_RETENTION_DAYS - 27, 5);
  });

  it('does not flag a session with plenty of time left', () => {
    const lastActivity = new Date(now - 5 * DAY_MS).toISOString();
    expect(findRetentionWarnings([session({ lastActivity })], now)).toEqual([]);
  });

  it('does not flag a session that has already aged out (0 or negative days left)', () => {
    const lastActivity = new Date(now - (SESSION_RETENTION_DAYS + 1) * DAY_MS).toISOString();
    expect(findRetentionWarnings([session({ lastActivity })], now)).toEqual([]);
  });

  it('sorts soonest-to-expire first', () => {
    const soon = new Date(now - (SESSION_RETENTION_DAYS - 1) * DAY_MS).toISOString();
    const later = new Date(now - (SESSION_RETENTION_DAYS - RETENTION_WARNING_DAYS) * DAY_MS).toISOString();
    const warnings = findRetentionWarnings([session({ sessionId: 'later', lastActivity: later }), session({ sessionId: 'soon', lastActivity: soon })], now);
    expect(warnings.map((w) => w.session.sessionId)).toEqual(['soon', 'later']);
  });
});
