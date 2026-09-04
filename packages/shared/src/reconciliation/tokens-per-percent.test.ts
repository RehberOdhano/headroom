import { describe, expect, it } from 'vitest';
import { estimateTokensPerPercent } from './tokens-per-percent.js';

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
