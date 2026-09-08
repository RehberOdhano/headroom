import { describe, expect, it, vi } from 'vitest';
import {
  buildStatusLine,
  fetchTodayUsage,
  formatDate,
  formatResetIn,
  formatSessionWindow,
  formatTokens,
  formatWeeklyWindow,
} from '../bin/statusline.mjs';

describe('formatTokens', () => {
  it('formats under 1000 as-is', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('formats thousands with one decimal', () => {
    expect(formatTokens(12_345)).toBe('12.3K');
  });

  it('formats millions with one decimal', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatDate', () => {
  it('formats as YYYYMMDD', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('20260105');
  });
});

describe('formatResetIn', () => {
  const now = new Date(2026, 0, 5, 12, 0, 0);

  it('formats hours and minutes', () => {
    const resetsAt = now.getTime() / 1000 + 2 * 3600 + 15 * 60;
    expect(formatResetIn(resetsAt, now)).toBe('2h 15m');
  });

  it('formats minutes only under an hour', () => {
    const resetsAt = now.getTime() / 1000 + 20 * 60;
    expect(formatResetIn(resetsAt, now)).toBe('20m');
  });

  it('returns null once the reset time has passed', () => {
    const resetsAt = now.getTime() / 1000 - 60;
    expect(formatResetIn(resetsAt, now)).toBeNull();
  });
});

describe('formatSessionWindow', () => {
  const now = new Date(2026, 0, 5, 12, 0, 0);

  it('returns null when rate_limits is absent (not a Pro/Max account, or before the first API response)', () => {
    expect(formatSessionWindow(undefined, now)).toBeNull();
    expect(formatSessionWindow({}, now)).toBeNull();
  });

  it('formats percentage with a reset countdown', () => {
    const rateLimits = { five_hour: { used_percentage: 23.5, resets_at: now.getTime() / 1000 + 3600 } };
    expect(formatSessionWindow(rateLimits, now)).toBe('Session: 24% (resets in 1h 0m)');
  });

  it('omits the countdown once resets_at has passed', () => {
    const rateLimits = { five_hour: { used_percentage: 10, resets_at: now.getTime() / 1000 - 1 } };
    expect(formatSessionWindow(rateLimits, now)).toBe('Session: 10%');
  });

  it('ignores seven_day/spend_limit — only five_hour is the session window', () => {
    const rateLimits = { seven_day: { used_percentage: 90, resets_at: 0 } };
    expect(formatSessionWindow(rateLimits, now)).toBeNull();
  });
});

describe('formatWeeklyWindow', () => {
  const now = new Date(2026, 0, 5, 12, 0, 0);

  it('returns null when rate_limits is absent', () => {
    expect(formatWeeklyWindow(undefined, now)).toBeNull();
    expect(formatWeeklyWindow({}, now)).toBeNull();
  });

  it('formats percentage with a reset countdown', () => {
    const rateLimits = { seven_day: { used_percentage: 61.4, resets_at: now.getTime() / 1000 + 3600 } };
    expect(formatWeeklyWindow(rateLimits, now)).toBe('Weekly: 61% (resets in 1h 0m)');
  });

  it('ignores five_hour/spend_limit — only seven_day is the weekly window', () => {
    const rateLimits = { five_hour: { used_percentage: 90, resets_at: 0 } };
    expect(formatWeeklyWindow(rateLimits, now)).toBeNull();
  });
});

describe('buildStatusLine', () => {
  it('shows a fallback when there is nothing to report', () => {
    expect(buildStatusLine({}, null)).toBe('Claude usage: daemon not running');
  });

  it("shows today's token total, no dollar amounts", () => {
    const line = buildStatusLine({}, { totalCost: 4.5, totalTokens: 12_345 });
    expect(line).toBe('Today: 12.3K Tokens');
  });

  it('prepends the session window when rate_limits is present', () => {
    const input = { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 0 } } };
    const line = buildStatusLine(input, { totalCost: 4.5, totalTokens: 500 });
    expect(line).toBe('Session: 24% | Today: 500 Tokens');
  });

  it('shows the session window alone when the daemon is unreachable', () => {
    const input = { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 0 } } };
    expect(buildStatusLine(input, null)).toBe('Session: 24%');
  });

  it('shows both windows together, session before weekly', () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 0 },
        seven_day: { used_percentage: 61.4, resets_at: 0 },
      },
    };
    const line = buildStatusLine(input, { totalCost: 4.5, totalTokens: 500 });
    expect(line).toBe('Session: 24% | Weekly: 61% | Today: 500 Tokens');
  });

  it('ignores unrelated stdin content — model/context% are the wrapper script’s job, not this segment’s', () => {
    const line = buildStatusLine(
      { model: { display_name: 'Sonnet 5' }, cost: { total_cost_usd: 1 } },
      { totalCost: 4.5, totalTokens: 500 },
    );
    expect(line).toBe('Today: 500 Tokens');
  });
});

describe('fetchTodayUsage', () => {
  it('returns null rather than throwing when the daemon is unreachable', async () => {
    // Whether or not a real token file exists at the default path on the machine running this
    // test, the result must be null, never a throw — a statusline must never error out a
    // terminal prompt. (No token file -> "no token" branch; token exists -> this rejected
    // fetchImpl is hit instead.)
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchTodayUsage(fetchImpl);
    expect(result).toBeNull();
  });
});
