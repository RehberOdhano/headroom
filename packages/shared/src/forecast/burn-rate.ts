/** One historical data point: a limit bar's percent at the time it was captured. */
export interface TimedPercent {
  capturedAt: string;
  percent: number;
}

export interface BurnRateForecast {
  /** Least-squares slope of the current run, in percentage points per hour. Can be negative. */
  ratePercentPerHour: number;
  /** ISO timestamp the bar would hit 100% at this pace, or null if not on pace to (rate <= 0,
   *  or the projection already lies in the past relative to `now`). */
  projectedFullAt: string | null;
  /** 'low' below 3 points; 'medium' below 5 or under an hour of span; 'high' otherwise. Cheap
   *  proxy for "how much do we trust this line" — not a real statistical confidence interval. */
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Splits chronologically-sorted points into independent runs, starting a new run wherever
 * percent decreases relative to the previous point (a reset happened). Shared by
 * `forecastBurnRate` (which only ever wants the last run) and `detectBurnRateAnomaly` (which
 * wants every completed run as a historical baseline) — this is the one place that decides
 * where a reset boundary falls; don't duplicate the splitting rule elsewhere.
 */
export function segmentRuns(sorted: TimedPercent[]): TimedPercent[][] {
  if (sorted.length === 0) return [];
  const runs: TimedPercent[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.percent < sorted[i - 1]!.percent) runs.push([]);
    runs[runs.length - 1]!.push(sorted[i]!);
  }
  return runs;
}

export interface LinearFit {
  /** Percentage points per hour. */
  rate: number;
  /** Percent at `run[0]`'s own timestamp (hoursSinceStart = 0). */
  intercept: number;
}

/** Ordinary least-squares fit of percent against hours-since-the-run-started. Callers decide
 *  what counts as "enough points" — this will compute a (degenerate) fit for a single point too
 *  (rate 0, intercept = that point's percent), so check `run.length >= 2` first if a real slope
 *  is required. */
export function fitLinearRate(run: TimedPercent[]): LinearFit {
  const runStartMs = new Date(run[0]!.capturedAt).getTime();
  const hoursSinceStart = run.map((point) => (new Date(point.capturedAt).getTime() - runStartMs) / 3_600_000);
  const percentValues = run.map((point) => point.percent);
  const pointCount = hoursSinceStart.length;

  const sumHours = hoursSinceStart.reduce((total, hours) => total + hours, 0);
  const sumPercent = percentValues.reduce((total, percent) => total + percent, 0);
  const sumHoursPercent = hoursSinceStart.reduce((total, hours, i) => total + hours * percentValues[i]!, 0);
  const sumHoursSquared = hoursSinceStart.reduce((total, hours) => total + hours * hours, 0);
  const denominator = pointCount * sumHoursSquared - sumHours * sumHours;
  const rate = denominator === 0 ? 0 : (pointCount * sumHoursPercent - sumHours * sumPercent) / denominator;
  const intercept = (sumPercent - rate * sumHours) / pointCount;
  return { rate, intercept };
}

/**
 * Linear projection of a limit bar's next 100%, fit only to its *current run* — the points
 * since the last reset. A limit window resets periodically (percent drops back down), and
 * fitting a line across that drop would extrapolate nonsense, so only the last of `segmentRuns`'
 * segments is used.
 *
 * Returns null if the current run has fewer than two points (can't fit a line to one).
 */
export function forecastBurnRate(history: TimedPercent[], now: Date = new Date()): BurnRateForecast | null {
  const sorted = [...history].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );

  const runs = segmentRuns(sorted);
  const run = runs.at(-1) ?? [];
  if (run.length < 2) return null;

  const { rate, intercept } = fitLinearRate(run);
  const runStartMs = new Date(run[0]!.capturedAt).getTime();
  const pointCount = run.length;

  let projectedFullAt: string | null = null;
  if (rate > 0) {
    const hoursToFull = (100 - intercept) / rate;
    const projectedMs = runStartMs + hoursToFull * 3_600_000;
    const projectedDate = new Date(projectedMs);
    // A rate can be a genuine but tiny positive number (barely-moving usage), which pushes
    // hoursToFull — and so projectedMs — far outside Date's representable range (~year
    // 275760). new Date() doesn't throw for that, it silently becomes an Invalid Date, and
    // toISOString() on one does throw — checking getTime() first turns that into "no
    // meaningful projection" (null) instead of crashing the dashboard.
    projectedFullAt =
      !Number.isNaN(projectedDate.getTime()) && projectedMs > now.getTime() ? projectedDate.toISOString() : null;
  }

  const spanHours = (new Date(run.at(-1)!.capturedAt).getTime() - runStartMs) / 3_600_000;
  const confidence: BurnRateForecast['confidence'] =
    pointCount >= 5 && spanHours >= 1 ? 'high' : pointCount >= 3 ? 'medium' : 'low';

  return { ratePercentPerHour: rate, projectedFullAt, confidence };
}
