import { forecastBurnRate, type LimitBar, type TimedPercent } from '@headroom/shared';
import { MIN_FORECAST_MARGIN_MS, MIN_FORECAST_PERCENT, formatPercent, formatResetLabel } from './format.js';

export interface Headline {
  /** `alert` = a bar is already at its limit; `warn` = on pace to hit a limit before it resets;
   *  `ok` = neither. */
  tone: 'ok' | 'warn' | 'alert';
  text: string;
}

/** Within this long of a reset, waiting is a realistic option worth suggesting. */
const NEAR_RESET_MS = 90 * 60_000;

interface BarInput {
  title: string;
  bar: LimitBar | null;
  history: TimedPercent[];
}

function clock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * One-line answer to "can I keep working?" for the popup, so the forecast is the headline
 * instead of a footnote under each bar. Precedence: a bar already at its limit, then the
 * soonest at-risk projection (only at medium/high confidence — a low-confidence forecast is
 * too thin to headline, same rule `describeForecast` uses for its suggestion, and a bar under
 * `MIN_FORECAST_PERCENT` used is skipped outright), then all-clear.
 * Returns null when there's no bar at all to talk about.
 */
export function summarizeHeadroom(bars: BarInput[], now: Date = new Date()): Headline | null {
  const present = bars.filter((b): b is BarInput & { bar: LimitBar } => b.bar !== null);
  if (present.length === 0) return null;

  const full = present.find((b) => b.bar.percent >= 100);
  if (full) {
    return {
      tone: 'alert',
      text: `${full.title} limit reached — resets ${formatResetLabel(full.bar.resetsAt, now)}.`,
    };
  }

  let soonest: { title: string; projectedFullAt: string; resetsAt: string } | null = null;
  for (const { title, bar, history } of present) {
    if (bar.percent < MIN_FORECAST_PERCENT) continue;
    const forecast = forecastBurnRate(history, now);
    if (!forecast?.projectedFullAt || forecast.confidence === 'low') continue;
    // A projection that loses (or barely wins) the race to the reset isn't a risk.
    if (new Date(forecast.projectedFullAt).getTime() > new Date(bar.resetsAt).getTime() - MIN_FORECAST_MARGIN_MS) continue;
    if (!soonest || forecast.projectedFullAt < soonest.projectedFullAt) {
      soonest = { title, projectedFullAt: forecast.projectedFullAt, resetsAt: bar.resetsAt };
    }
  }
  if (soonest) {
    // Close to the reset, the useful advice is to wait it out, not to change how you work.
    const resetMs = new Date(soonest.resetsAt).getTime() - now.getTime();
    const wait =
      resetMs <= NEAR_RESET_MS ? ` A short break gets you a fresh window ${formatResetLabel(soonest.resetsAt, now)}.` : '';
    return {
      tone: 'warn',
      text: `At this pace, ${soonest.title.toLowerCase()} runs out ~${clock(soonest.projectedFullAt)} — before it resets.${wait}`,
    };
  }

  const tightest = present.reduce((a, b) => (b.bar.percent > a.bar.percent ? b : a));
  return {
    tone: 'ok',
    text: `You're clear until reset — ${tightest.title.toLowerCase()} at ${formatPercent(tightest.bar.percent)}%.`,
  };
}
