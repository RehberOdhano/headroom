import { describe, expect, it } from 'vitest';
import { forecastBurnRate } from './burn-rate.js';

const hour = (h: number) => new Date(2026, 7, 26, h, 0, 0).toISOString();

describe('forecastBurnRate', () => {
  it('returns null with fewer than two points', () => {
    expect(forecastBurnRate([])).toBeNull();
    expect(forecastBurnRate([{ capturedAt: hour(0), percent: 10 }])).toBeNull();
  });

  it('projects a future 100% crossing for a steadily rising run', () => {
    const history = [
      { capturedAt: hour(0), percent: 10 },
      { capturedAt: hour(1), percent: 20 },
      { capturedAt: hour(2), percent: 30 },
      { capturedAt: hour(3), percent: 40 },
      { capturedAt: hour(4), percent: 50 },
    ];
    const now = new Date(2026, 7, 26, 4, 0, 0);
    const result = forecastBurnRate(history, now);

    expect(result).not.toBeNull();
    expect(result!.ratePercentPerHour).toBeCloseTo(10, 5);
    // Started at 10 and rises 10/hr from t0=hour(0) -> hits 100 at hour(9).
    expect(result!.projectedFullAt).toBe(new Date(2026, 7, 26, 9, 0, 0).toISOString());
    expect(result!.confidence).toBe('high');
  });

  it('only fits the current run, ignoring points before the most recent reset', () => {
    const history = [
      { capturedAt: hour(0), percent: 90 },
      { capturedAt: hour(1), percent: 95 },
      // reset: percent drops
      { capturedAt: hour(2), percent: 5 },
      { capturedAt: hour(3), percent: 15 },
    ];
    const now = new Date(2026, 7, 26, 3, 0, 0);
    const result = forecastBurnRate(history, now);

    expect(result).not.toBeNull();
    // Only the post-reset run (hour 2 -> hour 3, +10/hr) should be fit.
    expect(result!.ratePercentPerHour).toBeCloseTo(10, 5);
  });

  it('returns a null projection (not a null result) for a flat or falling run', () => {
    const flat = [
      { capturedAt: hour(0), percent: 50 },
      { capturedAt: hour(1), percent: 50 },
    ];
    const result = forecastBurnRate(flat, new Date(2026, 7, 26, 1, 0, 0));
    expect(result).not.toBeNull();
    expect(result!.ratePercentPerHour).toBeCloseTo(0, 5);
    expect(result!.projectedFullAt).toBeNull();
  });

  it('drops confidence to low with only two points', () => {
    const history = [
      { capturedAt: hour(0), percent: 10 },
      { capturedAt: hour(1), percent: 20 },
    ];
    const result = forecastBurnRate(history, new Date(2026, 7, 26, 1, 0, 0));
    expect(result!.confidence).toBe('low');
  });

  it('does not project a crossing already in the past relative to now', () => {
    // Rising fast enough that the naive projection lands before `now` itself (e.g. this run
    // started a long time ago and `now` is far past where the line already crossed 100).
    const history = [
      { capturedAt: hour(0), percent: 10 },
      { capturedAt: hour(1), percent: 200 },
    ];
    const result = forecastBurnRate(history, new Date(2026, 7, 26, 5, 0, 0));
    expect(result!.projectedFullAt).toBeNull();
  });

  it('does not throw when a barely-positive rate projects a crossing outside the representable Date range', () => {
    // A real regression bug: with a tiny but genuinely positive rate (near-flat usage over a
    // long span), hoursToFull can be astronomical, pushing the projected timestamp past
    // Date's ~year-275760 ceiling. new Date() of that doesn't throw — it silently becomes an
    // Invalid Date — but calling .toISOString() on one does, which crashed the dashboard.
    const base = new Date(2026, 7, 26, 0, 0, 0).getTime();
    const farFuture = base + 1e8 * 60 * 60 * 1000; // ~11,415 years later — still a valid Date
    const history = [
      { capturedAt: new Date(base).toISOString(), percent: 10 },
      { capturedAt: new Date(farFuture).toISOString(), percent: 10.01 },
    ];

    expect(() => forecastBurnRate(history, new Date(base))).not.toThrow();
    expect(forecastBurnRate(history, new Date(base))!.projectedFullAt).toBeNull();
  });
});
