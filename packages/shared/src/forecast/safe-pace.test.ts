import { describe, expect, it } from 'vitest';
import { computeSafePace } from './safe-pace.js';
import type { BurnRateForecast } from './burn-rate.js';

const hour = (h: number) => new Date(2026, 7, 26, h, 0, 0);
const resetAt = (h: number) => hour(h).toISOString();

const forecast = (ratePercentPerHour: number, confidence: BurnRateForecast['confidence'] = 'high'): BurnRateForecast => ({
  ratePercentPerHour,
  projectedFullAt: null,
  confidence,
});

describe('computeSafePace', () => {
  it('computes exact arithmetic with no forecast', () => {
    // 37% remaining over 64 hours -> 0.578125%/h.
    const result = computeSafePace(63, resetAt(64), null, hour(0));
    expect(result).not.toBeNull();
    expect(result!.safeHourlyRate).toBeCloseTo(37 / 64, 6);
    expect(result!.recentPaceAboveSafePercent).toBeNull();
  });

  it('returns null for a missing/invalid reset time', () => {
    expect(computeSafePace(50, 'not-a-date', null, hour(0))).toBeNull();
  });

  it('returns null once the reset time has already passed', () => {
    expect(computeSafePace(50, resetAt(-1), null, hour(0))).toBeNull();
  });

  it('handles near-100% usage — a small but non-zero safe rate', () => {
    const result = computeSafePace(99, resetAt(10), null, hour(0));
    expect(result).not.toBeNull();
    expect(result!.safeHourlyRate).toBeCloseTo(1 / 10, 6);
  });

  it('handles 0% usage — the full range is still available', () => {
    const result = computeSafePace(0, resetAt(10), null, hour(0));
    expect(result).not.toBeNull();
    expect(result!.safeHourlyRate).toBeCloseTo(10, 6);
  });

  it('returns null once a bar is at/over 100% — nothing left to pace against', () => {
    expect(computeSafePace(100, resetAt(10), forecast(5), hour(0))).toBeNull();
    expect(computeSafePace(140, resetAt(10), forecast(5), hour(0))).toBeNull();
  });

  it('clamps a negative percent defensively to a full-range safe rate', () => {
    const result = computeSafePace(-10, resetAt(10), null, hour(0));
    expect(result!.safeHourlyRate).toBeCloseTo(10, 6);
  });

  it('omits the comparison for a low-confidence forecast', () => {
    const result = computeSafePace(63, resetAt(64), forecast(1, 'low'), hour(0));
    expect(result!.recentPaceAboveSafePercent).toBeNull();
  });

  it('omits the comparison when there is no forecast at all', () => {
    const result = computeSafePace(63, resetAt(64), null, hour(0));
    expect(result!.recentPaceAboveSafePercent).toBeNull();
  });

  it('computes the comparison for a medium/high-confidence forecast above the safe rate', () => {
    // safeHourlyRate = 37/64 ≈ 0.578125. A fitted rate of 0.8 is (0.8-0.578125)/0.578125*100 ≈ 38.4% above.
    const result = computeSafePace(63, resetAt(64), forecast(0.8, 'medium'), hour(0));
    expect(result!.recentPaceAboveSafePercent).toBeCloseTo(38.378, 2);
  });

  it('omits the comparison when the fitted rate is at or below the safe rate (already on track)', () => {
    const atSafe = computeSafePace(63, resetAt(64), forecast(37 / 64, 'high'), hour(0));
    expect(atSafe!.recentPaceAboveSafePercent).toBeNull();

    const below = computeSafePace(63, resetAt(64), forecast(0.1, 'high'), hour(0));
    expect(below!.recentPaceAboveSafePercent).toBeNull();
  });

  it('omits the comparison for a non-positive fitted rate', () => {
    const result = computeSafePace(63, resetAt(64), forecast(0, 'high'), hour(0));
    expect(result!.recentPaceAboveSafePercent).toBeNull();
  });
});
