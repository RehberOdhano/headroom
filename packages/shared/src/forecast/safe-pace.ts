import type { BurnRateForecast } from './burn-rate.js';

/**
 * Sustainable average pace to last until a bar's own reset — pure arithmetic over the two
 * server-observed numbers every `LimitBar` already carries (`percent`, `resetsAt`), not a fitted
 * estimate. Unlike `forecastBurnRate`, this needs no history and no minimum sample size: given
 * just the current percent and reset time, `safeHourlyRate` is exact. Only the *comparison* to
 * the account's recently observed rate is a derived figure, and only shown when there's an
 * actual fitted rate worth trusting.
 */
export interface SafePace {
  /** %/hour that would exactly exhaust the remaining percent right at reset. */
  safeHourlyRate: number;
  /**
   * How far the recently observed rate (`forecastBurnRate`'s `ratePercentPerHour`) sits above
   * `safeHourlyRate`, as a percentage of `safeHourlyRate` — e.g. 30 means "30% above." `null`
   * whenever there's nothing worth comparing: no forecast, a low-confidence one, a non-positive
   * fitted rate, a zero safe rate (already at/over 100%), or a fitted rate at or below the safe
   * one (nothing to warn about — that case is already "on track").
   */
  recentPaceAboveSafePercent: number | null;
}

/**
 * Returns `null` when there's no meaningful safe pace to report: a missing/invalid `resetsAt`;
 * one that's already passed (nothing left to pace against); or a bar already at/over 100% —
 * "stay under 0%/hour" isn't an actionable pacing suggestion, just a restatement of "you're at
 * the limit," which the bar and the existing forecast message already say. `percent` is clamped
 * to [0, 100] defensively — a bar's own percent shouldn't fall outside that range, but this is
 * cheap insurance against a noisy/malformed value rather than propagating a nonsensical result.
 */
export function computeSafePace(
  percent: number,
  resetsAt: string,
  forecast: BurnRateForecast | null,
  now: Date = new Date(),
): SafePace | null {
  const resetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(resetMs)) return null;

  const hoursUntilReset = (resetMs - now.getTime()) / 3_600_000;
  if (hoursUntilReset <= 0) return null;

  const clampedPercent = Math.min(100, Math.max(0, percent));
  const safeHourlyRate = (100 - clampedPercent) / hoursUntilReset;
  if (safeHourlyRate <= 0) return null;

  let recentPaceAboveSafePercent: number | null = null;
  if (forecast && forecast.ratePercentPerHour > 0 && (forecast.confidence === 'medium' || forecast.confidence === 'high')) {
    const aboveSafe = ((forecast.ratePercentPerHour - safeHourlyRate) / safeHourlyRate) * 100;
    if (aboveSafe > 0) recentPaceAboveSafePercent = aboveSafe;
  }

  return { safeHourlyRate, recentPaceAboveSafePercent };
}
