import { describe, expect, it } from 'vitest';
import { describeUsageAnomaly } from '../lib/anomaly.js';

const hour = (h: number) => new Date(2026, 7, 26, h, 0, 0).toISOString();
const now = new Date(2026, 7, 26, 10, 0, 0);
const resetsAt = new Date(2026, 7, 26, 20, 0, 0).toISOString(); // comfortably past the near-reset margin

function bar(percent: number) {
  return { percent, resetsAt, severity: 'normal', isActive: true };
}

// Two established baseline runs at +5/h, then a current run far above it.
const ANOMALOUS_HISTORY = [
  { capturedAt: hour(0), percent: 10 },
  { capturedAt: hour(1), percent: 15 },
  { capturedAt: hour(2), percent: 5 },
  { capturedAt: hour(3), percent: 10 },
  { capturedAt: hour(4), percent: 2 },
  { capturedAt: hour(5), percent: 13 },
  { capturedAt: hour(6), percent: 24 },
];

const FLAT_HISTORY = [
  { capturedAt: hour(0), percent: 10 },
  { capturedAt: hour(1), percent: 10 },
];

describe('describeUsageAnomaly', () => {
  it('returns null when nothing is anomalous', () => {
    const result = describeUsageAnomaly(
      [{ title: 'Session', bar: bar(10), history: FLAT_HISTORY }],
      now,
    );
    expect(result).toBeNull();
  });

  it('returns null when a bar has no history at all to judge', () => {
    expect(describeUsageAnomaly([{ title: 'Session', bar: bar(10), history: [] }], now)).toBeNull();
  });

  it('describes behavior, never a cause — no "you are using Claude more"', () => {
    const result = describeUsageAnomaly([{ title: 'Session', bar: bar(24), history: ANOMALOUS_HISTORY }], now);
    expect(result).toContain('rising faster than its recent pattern');
    expect(result).not.toMatch(/you are using/i);
    expect(result).not.toMatch(/caused/i);
  });

  it('picks the single most-anomalous bar across both', () => {
    const result = describeUsageAnomaly(
      [
        { title: 'Session', bar: bar(10), history: FLAT_HISTORY },
        { title: 'Weekly', bar: bar(24), history: ANOMALOUS_HISTORY },
      ],
      now,
    );
    expect(result).toContain('Weekly');
  });

  it('skips a null bar without throwing', () => {
    expect(describeUsageAnomaly([{ title: 'Session', bar: null, history: ANOMALOUS_HISTORY }], now)).toBeNull();
  });
});
