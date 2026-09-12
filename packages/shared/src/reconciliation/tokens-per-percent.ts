export interface DailyCliUsage {
  date: string;
  totalTokens: number;
}

export interface WeeklyPercentPoint {
  capturedAt: string;
  percent: number;
}

export interface ReconciliationEstimate {
  tokensPerPercent: number;
  totalCliTokens: number;
  totalPercentDelta: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Estimates tokens-per-percent of the weekly limit by correlating CLI token counts with limit
 * deltas over time. Sums every *increase* in the weekly bar's percent across the window (a
 * decrease means the window reset, not usage, so it's skipped) against total CLI tokens spent
 * in the same window, and divides.
 *
 * This treats all weekly-bar movement in the window as CLI-caused. Any claude.ai chat usage in
 * the same window gets folded in too, which overestimates tokens-per-percent whenever the
 * account also chats on claude.ai during the tracked period — there's no way to separate the
 * two from this data alone. Confidence is only about sample size, not this contamination —
 * treat every result here as a rough estimate, not a fact.
 */
export function estimateTokensPerPercent(
  weeklyPercentHistory: WeeklyPercentPoint[],
  dailyCliUsage: DailyCliUsage[],
): ReconciliationEstimate | null {
  if (weeklyPercentHistory.length < 2 || dailyCliUsage.length === 0) return null;

  const sorted = [...weeklyPercentHistory].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );

  let totalPercentDelta = 0;
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]!.percent - sorted[i - 1]!.percent;
    if (delta > 0) totalPercentDelta += delta;
  }

  const totalCliTokens = dailyCliUsage.reduce((sum, day) => sum + day.totalTokens, 0);

  if (totalPercentDelta <= 0 || totalCliTokens <= 0) return null;

  const tokensPerPercent = totalCliTokens / totalPercentDelta;
  const confidence: ReconciliationEstimate['confidence'] =
    dailyCliUsage.length >= 7 && sorted.length >= 10 ? 'high' : dailyCliUsage.length >= 3 ? 'medium' : 'low';

  return { tokensPerPercent, totalCliTokens, totalPercentDelta, confidence };
}

export interface WeeklyCliSplit {
  /** ISO date (start of week, Monday) this bucket covers. */
  weekStart: string;
  /** Total weekly-bar percent consumed in this week (sum of positive deltas only). */
  totalPercentDelta: number;
  /** Estimated CLI-attributable share of that percent, using the caller's already-computed
   *  global `tokensPerPercent` ratio — never refit per week, since a single week's sample is too
   *  small to refit reliably. Clamped to `totalPercentDelta`: the estimate is noisy enough that
   *  it can otherwise exceed the real total for that week, which would make "chat's share" look
   *  negative. */
  cliPercent: number;
}

function startOfWeek(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 (Sun) - 6 (Sat)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Buckets weekly-bar history and CLI daily usage into calendar weeks and estimates each week's
 * CLI-attributable share of that week's weekly-bar movement, using a single caller-supplied
 * `tokensPerPercent` ratio (from `estimateTokensPerPercent` over the same or a wider window) —
 * see that function's own doc comment for why this is a rough estimate, not a fact: any
 * claude.ai chat usage in the same window is indistinguishable from CLI usage in this data and
 * gets folded into the "remainder" (chat + noise), not cleanly separated out.
 */
export function estimateWeeklyCliSplit(
  weeklyPercentHistory: WeeklyPercentPoint[],
  dailyCliUsage: DailyCliUsage[],
  tokensPerPercent: number,
): WeeklyCliSplit[] {
  if (weeklyPercentHistory.length < 2 || tokensPerPercent <= 0) return [];

  const sorted = [...weeklyPercentHistory].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );

  const percentDeltaByWeek = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]!.percent - sorted[i - 1]!.percent;
    if (delta <= 0) continue;
    const week = startOfWeek(sorted[i]!.capturedAt);
    percentDeltaByWeek.set(week, (percentDeltaByWeek.get(week) ?? 0) + delta);
  }

  const tokensByWeek = new Map<string, number>();
  for (const day of dailyCliUsage) {
    const week = startOfWeek(day.date);
    tokensByWeek.set(week, (tokensByWeek.get(week) ?? 0) + day.totalTokens);
  }

  const weeks = [...new Set([...percentDeltaByWeek.keys(), ...tokensByWeek.keys()])].sort();

  return weeks.map((weekStart) => {
    const totalPercentDelta = percentDeltaByWeek.get(weekStart) ?? 0;
    const estimatedCliPercent = (tokensByWeek.get(weekStart) ?? 0) / tokensPerPercent;
    return { weekStart, totalPercentDelta, cliPercent: Math.min(estimatedCliPercent, totalPercentDelta) };
  });
}
