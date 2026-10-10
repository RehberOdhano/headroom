import { detectBurnRateAnomaly, type LimitBar, type TimedPercent } from '@headroom/shared';

export interface BarAnomalyInput {
  title: string;
  bar: LimitBar | null;
  history: TimedPercent[];
}

/**
 * One-line "is something unusual?" note — the single most-anomalous bar, if any, phrased to
 * describe behavior, never a cause. An Anthropic-side accounting or limit change can move the
 * observed rate just as much as the account's own usage can; this never says "you are using
 * Claude more," only that the rate itself is unusual relative to the account's own recent
 * pattern. Kept separate from `summarizeHeadroom`'s forecast headline — anomaly and "about to
 * run out" are independent signals, not one combined sentence.
 */
export function describeUsageAnomaly(bars: BarAnomalyInput[], now: Date = new Date()): string | null {
  let best: { title: string; ratio: number; preliminary: boolean } | null = null;
  for (const { title, bar, history } of bars) {
    if (!bar) continue;
    const anomaly = detectBurnRateAnomaly(history, now, bar.resetsAt);
    if (!anomaly?.isAnomalous) continue;
    if (!best || anomaly.ratioToBaseline > best.ratio) {
      best = { title, ratio: anomaly.ratioToBaseline, preliminary: anomaly.baselineMaturity === 'preliminary' };
    }
  }
  if (!best) return null;
  const note = best.preliminary ? ' (early pattern — based on limited history)' : '';
  return `${best.title} usage is rising faster than its recent pattern.${note}`;
}
