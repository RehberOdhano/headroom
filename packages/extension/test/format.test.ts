import { describe, expect, it } from 'vitest';
import type { BurnRateForecast } from '@headroom/shared';
import {
  barColor,
  describeForecast,
  describeSource,
  formatCcusageDate,
  formatPercent,
  formatResetLabel,
} from '../lib/format.js';

describe('formatResetLabel', () => {
  const now = new Date('2026-08-29T12:00:00Z');

  it('formats hours and minutes under a day out', () => {
    expect(formatResetLabel('2026-08-29T15:14:00Z', now)).toBe('in 3h 14m');
  });

  it('formats whole hours with no minutes', () => {
    expect(formatResetLabel('2026-08-29T15:00:00Z', now)).toBe('in 3h');
  });

  it('formats minutes only when under an hour', () => {
    expect(formatResetLabel('2026-08-29T12:12:00Z', now)).toBe('in 12m');
  });

  it('reports resetting now once the reset time has passed', () => {
    expect(formatResetLabel('2026-08-29T11:00:00Z', now)).toBe('resetting now');
  });

  it('still uses the relative form right up to (but not past) the 24h boundary', () => {
    expect(formatResetLabel('2026-08-30T11:59:00Z', now)).toBe('in 23h 59m');
  });

  it('switches to an absolute weekday + time once a day or more out — a "167h 50m"-style ' + 'countdown stops being readable, which is exactly the weekly bar\'s usual case', () => {
    // 2026-08-29 is a Saturday; a week out lands on the following Saturday.
    const label = formatResetLabel('2026-09-05T20:00:00Z', now);
    expect(label).not.toMatch(/^in /);
    expect(label).not.toBe('resetting now');
    expect(label).toContain(':'); // a time is present, in whatever the runtime locale's format is
  });

  it('formats the 24h boundary itself as absolute, not "in 24h"', () => {
    const label = formatResetLabel('2026-08-30T12:00:00Z', now);
    expect(label).not.toMatch(/^in /);
  });
});

describe('barColor', () => {
  it('maps known severities', () => {
    expect(barColor('normal')).toBe('#3b82f6');
    expect(barColor('warning')).toBe('#f59e0b');
    expect(barColor('critical')).toBe('#ef4444');
  });

  it('falls back to a neutral color for an unrecognized severity', () => {
    expect(barColor('something_new')).toBe('#6b7280');
  });
});

describe('describeForecast', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  const highConfidence: BurnRateForecast = {
    ratePercentPerHour: 10,
    projectedFullAt: '2026-08-29T18:00:00Z',
    confidence: 'high',
  };

  it('returns null when there is no forecast', () => {
    expect(describeForecast(null, null, now)).toBeNull();
  });

  it('returns null when the bar is not on pace to hit 100%', () => {
    const flat: BurnRateForecast = { ratePercentPerHour: 0, projectedFullAt: null, confidence: 'high' };
    expect(describeForecast(flat, null, now)).toBeNull();
  });

  it('flags at-risk when the projection lands before the reset', () => {
    const result = describeForecast(highConfidence, '2026-08-29T20:00:00Z', now);
    expect(result?.atRisk).toBe(true);
    expect(result?.message).toContain('reaches limit');
  });

  it('does not flag at-risk when the reset comes first', () => {
    const result = describeForecast(highConfidence, '2026-08-29T14:00:00Z', now);
    expect(result?.atRisk).toBe(false);
    expect(result?.message).toContain('resets first');
  });

  it('treats no known reset time as always at-risk', () => {
    const result = describeForecast(highConfidence, null, now);
    expect(result?.atRisk).toBe(true);
  });

  it('notes low confidence in the message', () => {
    const low: BurnRateForecast = { ...highConfidence, confidence: 'low' };
    const result = describeForecast(low, null, now);
    expect(result?.message).toContain('low confidence');
  });
});

describe('formatPercent', () => {
  it('drops floating-point noise back to a clean integer', () => {
    expect(formatPercent(61.000001)).toBe('61');
    expect(formatPercent(28.999999999999996)).toBe('29');
  });

  it('keeps a genuinely meaningful fraction to 1 decimal place', () => {
    expect(formatPercent(75.19090170593013)).toBe('75.2');
    expect(formatPercent(61.4)).toBe('61.4');
  });

  it('handles whole numbers with no decimal', () => {
    expect(formatPercent(50)).toBe('50');
  });
});

describe('describeSource', () => {
  it('labels each snapshot source distinctly', () => {
    expect(describeSource('usage')).toBe('periodic check');
    expect(describeSource('message_limit')).toBe('claude.ai chat');
    expect(describeSource('rate_limit_event')).toBe('Claude Code web');
  });
});

describe('formatCcusageDate', () => {
  it('formats as YYYYMMDD', () => {
    expect(formatCcusageDate(new Date(2026, 0, 5))).toBe('20260105');
    expect(formatCcusageDate(new Date(2026, 11, 31))).toBe('20261231');
  });
});
