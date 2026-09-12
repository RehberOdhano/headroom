import { describe, expect, it } from 'vitest';
import { estimateTokensPerPercent, estimateWeeklyCliSplit } from './tokens-per-percent.js';

const day = (d: number) => `2026-08-${String(d).padStart(2, '0')}`;
const at = (d: number, h = 12) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

describe('estimateTokensPerPercent', () => {
  it('returns null with fewer than two percent points', () => {
    expect(estimateTokensPerPercent([], [{ date: day(1), totalTokens: 1000 }])).toBeNull();
    expect(
      estimateTokensPerPercent([{ capturedAt: at(1), percent: 10 }], [{ date: day(1), totalTokens: 1000 }]),
    ).toBeNull();
  });

  it('returns null with no CLI usage data', () => {
    const history = [
      { capturedAt: at(1), percent: 10 },
      { capturedAt: at(2), percent: 20 },
    ];
    expect(estimateTokensPerPercent(history, [])).toBeNull();
  });

  it('divides total CLI tokens by total positive percent delta', () => {
    const history = [
      { capturedAt: at(1), percent: 10 },
      { capturedAt: at(2), percent: 30 }, // +20
    ];
    const usage = [
      { date: day(1), totalTokens: 100_000 },
      { date: day(2), totalTokens: 100_000 }, // total 200,000
    ];
    const result = estimateTokensPerPercent(history, usage);
    expect(result).not.toBeNull();
    expect(result!.totalPercentDelta).toBe(20);
    expect(result!.totalCliTokens).toBe(200_000);
    expect(result!.tokensPerPercent).toBe(10_000);
  });

  it('skips a reset (percent decrease) rather than counting it as negative usage', () => {
    const history = [
      { capturedAt: at(1), percent: 90 },
      { capturedAt: at(2), percent: 5 }, // reset, skipped
      { capturedAt: at(3), percent: 15 }, // +10
    ];
    const usage = [{ date: day(1), totalTokens: 50_000 }];
    const result = estimateTokensPerPercent(history, usage);
    expect(result!.totalPercentDelta).toBe(10);
  });

  it('returns null when there is no net positive movement (all resets/flat)', () => {
    const history = [
      { capturedAt: at(1), percent: 50 },
      { capturedAt: at(2), percent: 50 },
    ];
    expect(estimateTokensPerPercent(history, [{ date: day(1), totalTokens: 1000 }])).toBeNull();
  });

  it('reports low confidence with sparse data, high with plenty', () => {
    const sparse = estimateTokensPerPercent(
      [{ capturedAt: at(1), percent: 10 }, { capturedAt: at(2), percent: 20 }],
      [{ date: day(1), totalTokens: 1000 }],
    );
    expect(sparse!.confidence).toBe('low');

    const richHistory = Array.from({ length: 10 }, (_, i) => ({ capturedAt: at(1, i), percent: i * 5 }));
    const richUsage = Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), totalTokens: 1000 }));
    const rich = estimateTokensPerPercent(richHistory, richUsage);
    expect(rich!.confidence).toBe('high');
  });
});

describe('estimateWeeklyCliSplit', () => {
  // 2026-08-03 and 2026-08-10 are both Mondays.
  it('buckets percent deltas and CLI tokens into calendar weeks', () => {
    const history = [
      { capturedAt: at(3), percent: 10 },
      { capturedAt: at(5), percent: 30 }, // +20, week of 08-03
      { capturedAt: at(10), percent: 40 }, // +10, week of 08-10
      { capturedAt: at(12), percent: 70 }, // +30, week of 08-10
    ];
    const usage = [
      { date: day(3), totalTokens: 100_000 },
      { date: day(5), totalTokens: 100_000 }, // week of 08-03 total: 200,000
      { date: day(11), totalTokens: 300_000 }, // week of 08-10 total: 300,000
    ];

    const result = estimateWeeklyCliSplit(history, usage, 10_000);
    expect(result).toEqual([
      { weekStart: '2026-08-03', totalPercentDelta: 20, cliPercent: 20 },
      { weekStart: '2026-08-10', totalPercentDelta: 40, cliPercent: 30 },
    ]);
  });

  it('clamps an estimate that would otherwise exceed the real total for that week', () => {
    const history = [
      { capturedAt: at(17), percent: 50 },
      { capturedAt: at(19), percent: 55 }, // +5, week of 08-17
    ];
    const usage = [{ date: day(18), totalTokens: 1_000_000 }];

    const result = estimateWeeklyCliSplit(history, usage, 10_000);
    expect(result).toEqual([{ weekStart: '2026-08-17', totalPercentDelta: 5, cliPercent: 5 }]);
  });

  it('returns an empty array with fewer than two percent points or a non-positive ratio', () => {
    expect(estimateWeeklyCliSplit([], [{ date: day(1), totalTokens: 1000 }], 100)).toEqual([]);
    expect(
      estimateWeeklyCliSplit(
        [
          { capturedAt: at(3), percent: 10 },
          { capturedAt: at(5), percent: 30 },
        ],
        [{ date: day(3), totalTokens: 1000 }],
        0,
      ),
    ).toEqual([]);
  });
});
