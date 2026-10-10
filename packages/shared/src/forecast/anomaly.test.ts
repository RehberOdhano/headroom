import { describe, expect, it } from 'vitest';
import { detectBurnRateAnomaly } from './anomaly.js';
import type { TimedPercent } from './burn-rate.js';

const hour = (h: number) => new Date(2026, 7, 26, h, 0, 0).toISOString();
const point = (h: number, percent: number): TimedPercent => ({ capturedAt: hour(h), percent });
const now = new Date(2026, 7, 26, 10, 30, 0);

/** Four completed 2-point runs (rates 5, 5, 5, 50 %/h) followed by a 3-point current run at
 *  11%/h — the shared fixture for most tests below. Median baseline (5) resists the 50 outlier;
 *  a mean would not (mean = 16.25, which would NOT classify the current rate as anomalous). */
const FOUR_RUN_HISTORY: TimedPercent[] = [
  point(0, 10),
  point(1, 15), // run 1: +5/h
  point(2, 5),
  point(3, 10), // run 2: +5/h
  point(4, 3),
  point(5, 8), // run 3: +5/h
  point(6, 1),
  point(7, 51), // run 4: +50/h (outlier)
  point(8, 2),
  point(9, 13),
  point(10, 24), // current run: +11/h, movement 22
];

describe('detectBurnRateAnomaly', () => {
  it('returns null with no history at all', () => {
    expect(detectBurnRateAnomaly([], now)).toBeNull();
  });

  it('returns null with only one completed run — no real baseline yet', () => {
    const history: TimedPercent[] = [point(0, 10), point(1, 20), point(2, 5), point(3, 15), point(4, 25)];
    expect(detectBurnRateAnomaly(history, now)).toBeNull();
  });

  it('returns null when the current run has too few points', () => {
    const history: TimedPercent[] = [point(0, 10), point(1, 20), point(2, 5), point(3, 15), point(4, 5), point(5, 25)];
    // Two completed runs (10->20, 5->15), current run only [5, 25] — just 2 points.
    expect(detectBurnRateAnomaly(history, now)).toBeNull();
  });

  it('returns null when the current run has moved too little, regardless of ratio', () => {
    const history: TimedPercent[] = [
      point(0, 10),
      point(1, 20), // completed run 1
      point(2, 5),
      point(3, 15), // completed run 2
      point(4, 1),
      point(5, 1.3),
      point(6, 1.6), // current run: 3 points, but only 0.6 points of movement
    ];
    expect(detectBurnRateAnomaly(history, now)).toBeNull();
  });

  it('flags a current rate well above an established median baseline — resisting an outlier run', () => {
    const result = detectBurnRateAnomaly(FOUR_RUN_HISTORY, now);
    expect(result).not.toBeNull();
    expect(result!.completedRunCount).toBe(4);
    expect(result!.baselineMaturity).toBe('established');
    expect(result!.baselineRatePercentPerHour).toBeCloseTo(5, 5); // median of [5,5,5,50], not the mean (16.25)
    expect(result!.currentRatePercentPerHour).toBeCloseTo(11, 5);
    expect(result!.ratioToBaseline).toBeCloseTo(2.2, 5);
    expect(result!.isAnomalous).toBe(true);
    expect(result!.runStartedAt).toBe(hour(8)); // the current run's own first point
  });

  it('reports a preliminary baseline below the established run count', () => {
    const history: TimedPercent[] = [
      point(0, 10),
      point(1, 15), // run 1: +5/h
      point(2, 5),
      point(3, 10), // run 2: +5/h
      point(4, 2),
      point(5, 11),
      point(6, 20), // current run: +9/h, movement 18
    ];
    const result = detectBurnRateAnomaly(history, now)!;
    expect(result.completedRunCount).toBe(2);
    expect(result.baselineMaturity).toBe('preliminary');
  });

  it('does not flag a current rate in line with the baseline', () => {
    const history: TimedPercent[] = [
      point(0, 10),
      point(1, 15),
      point(2, 20), // run 1: +5/h
      point(3, 5),
      point(4, 10),
      point(5, 15), // run 2: +5/h
      point(6, 8),
      point(7, 13),
      point(8, 18), // run 3: +5/h
      point(9, 2),
      point(10, 7),
      point(11, 12), // current run: +5/h, movement 10 — right at the baseline rate
    ];
    const result = detectBurnRateAnomaly(history, new Date(2026, 7, 26, 11, 30, 0))!;
    expect(result.completedRunCount).toBe(3);
    expect(result.isAnomalous).toBe(false);
  });

  it('treats a (near-)zero baseline specially: any real current movement reads as infinitely above it, not a division artifact', () => {
    const history: TimedPercent[] = [
      point(0, 10),
      point(1, 10),
      point(2, 10), // run 1: flat, rate 0
      point(3, 5),
      point(4, 5),
      point(5, 5), // run 2: flat, rate 0
      point(6, 2),
      point(7, 17),
      point(8, 32), // current run: +15/h, movement 30
    ];
    const result = detectBurnRateAnomaly(history, now)!;
    expect(result.baselineRatePercentPerHour).toBe(0);
    expect(result.ratioToBaseline).toBe(Infinity);
    expect(result.isAnomalous).toBe(true);
  });

  it('is suppressed within the near-reset margin, even though the same data would otherwise flag', () => {
    const lastPointAt = new Date(2026, 7, 26, 10, 0, 0);
    const resetsAt = new Date(lastPointAt.getTime() + 15 * 60_000).toISOString(); // 15 min out
    expect(detectBurnRateAnomaly(FOUR_RUN_HISTORY, now, resetsAt)).toBeNull();
  });

  it('is not suppressed once the reset is comfortably past the near-reset margin', () => {
    const resetsAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString(); // 2h out
    expect(detectBurnRateAnomaly(FOUR_RUN_HISTORY, now, resetsAt)).not.toBeNull();
  });

  it('segments correctly across multiple resets — reset boundaries', () => {
    // Three resets packed closely: 20->5, 15->3, 25->1 — four runs total, none merged across a drop.
    const history: TimedPercent[] = [
      point(0, 10),
      point(1, 20),
      point(2, 5),
      point(3, 15),
      point(4, 3),
      point(5, 25),
      point(6, 1),
      point(7, 12),
      point(8, 23),
    ];
    const result = detectBurnRateAnomaly(history, now)!;
    expect(result.completedRunCount).toBe(3); // every run but the last
  });
});
