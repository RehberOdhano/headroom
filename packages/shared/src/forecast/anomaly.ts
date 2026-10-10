import { fitLinearRate, segmentRuns, type TimedPercent } from './burn-rate.js';

/** Below this many completed runs, there's no real baseline to compare against — "this account
 *  has barely any history" and "this account is behaving normally" are indistinguishable. */
const MIN_COMPLETED_RUNS = 2;
/** The baseline matures past "preliminary" once this many completed runs are available. */
const ESTABLISHED_RUN_COUNT = 4;
/** Only the most recent N completed runs feed the baseline — an account's pattern from months
 *  ago shouldn't outweigh its last few windows. */
const BASELINE_RUN_WINDOW = 4;
/** The current run needs at least this many points for its own fit to be trusted — same floor
 *  `forecastBurnRate`'s 'medium' confidence tier uses. */
const MIN_CURRENT_RUN_POINTS = 3;
/** Below this much movement in the current run, a rate is extrapolating from near-nothing — a
 *  bar that moved from 2% to 4% is not a meaningful "2x" anomaly no matter the ratio. */
const MIN_CURRENT_RUN_MOVEMENT_PERCENT = 10;
/** A current rate at least this many times the baseline counts as anomalous. */
const ANOMALY_RATIO_THRESHOLD = 2;
/** Don't bother flagging anything this close to a reset — not actionable, and the fit over such
 *  a short remaining window is noisy anyway. Same margin `pace-alert.ts` already uses. */
const NEAR_RESET_SUPPRESSION_MS = 30 * 60_000;

export interface BurnRateAnomaly {
  /** Whether the current run's rate clears `ANOMALY_RATIO_THRESHOLD` against the baseline. */
  isAnomalous: boolean;
  currentRatePercentPerHour: number;
  baselineRatePercentPerHour: number;
  /** `currentRatePercentPerHour / baselineRatePercentPerHour`. `Infinity` when the baseline is
   *  (near-)zero — a genuinely unprecedented rate for an account with no prior nonzero history,
   *  not a division bug. Callers should treat a non-finite ratio as "much faster," not try to
   *  print it as a percentage. */
  ratioToBaseline: number;
  /** 'preliminary' below `ESTABLISHED_RUN_COUNT` completed runs — still real, but young. */
  baselineMaturity: 'preliminary' | 'established';
  completedRunCount: number;
  /** The current run's first point's own timestamp — the natural "WHEN did this start"
   *  boundary for a Usage Inspector correlation window, reusing the same run `forecastBurnRate`
   *  already fits rather than inventing a second notion of "when did this begin." */
  runStartedAt: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Compares the current run's fitted burn rate against a median baseline built from the account's
 * own recent completed runs — "usage is rising faster than your recent pattern," never a claim
 * about *why* (an Anthropic-side accounting or limit change can move the observed rate just as
 * much as the account's own behavior can; this function has no way to distinguish them and
 * doesn't try to).
 *
 * Returns `null` whenever there isn't enough data to say anything meaningful either way:
 * fewer than `MIN_COMPLETED_RUNS` completed runs, too few points or too little movement in the
 * current run, or the reset is too close to bother. A non-null result with `isAnomalous: false`
 * means there *was* enough data, and it looked normal — a different, equally real answer from
 * "we can't tell."
 */
export function detectBurnRateAnomaly(
  history: TimedPercent[],
  now: Date = new Date(),
  resetsAt?: string | null,
): BurnRateAnomaly | null {
  if (resetsAt) {
    const msUntilReset = new Date(resetsAt).getTime() - now.getTime();
    if (msUntilReset <= NEAR_RESET_SUPPRESSION_MS) return null;
  }

  const sorted = [...history].sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const runs = segmentRuns(sorted);
  const currentRun = runs.at(-1) ?? [];
  const completedRuns = runs.slice(0, -1).filter((run) => run.length >= 2);

  if (completedRuns.length < MIN_COMPLETED_RUNS) return null;
  if (currentRun.length < MIN_CURRENT_RUN_POINTS) return null;

  const currentMovement = Math.max(...currentRun.map((p) => p.percent)) - Math.min(...currentRun.map((p) => p.percent));
  if (currentMovement < MIN_CURRENT_RUN_MOVEMENT_PERCENT) return null;

  const baselineRuns = completedRuns.slice(-BASELINE_RUN_WINDOW);
  const baselineRate = median(baselineRuns.map((run) => fitLinearRate(run).rate));
  const currentRate = fitLinearRate(currentRun).rate;

  const ratioToBaseline = baselineRate <= 0 ? (currentRate > 0 ? Infinity : 0) : currentRate / baselineRate;

  return {
    isAnomalous: ratioToBaseline >= ANOMALY_RATIO_THRESHOLD,
    currentRatePercentPerHour: currentRate,
    baselineRatePercentPerHour: baselineRate,
    ratioToBaseline,
    baselineMaturity: completedRuns.length >= ESTABLISHED_RUN_COUNT ? 'established' : 'preliminary',
    completedRunCount: completedRuns.length,
    runStartedAt: currentRun[0]!.capturedAt,
  };
}
