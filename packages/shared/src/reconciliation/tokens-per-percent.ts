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
