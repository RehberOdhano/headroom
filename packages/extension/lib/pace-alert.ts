import { forecastBurnRate, type LimitBar, type TimedPercent } from '@headroom/shared';
import { MIN_FORECAST_MARGIN_MS, MIN_FORECAST_PERCENT, formatResetLabel } from './format.js';

export interface PaceAlert {
  title: string;
  message: string;
  /** Dedup key suffix: one alert per limit window, however many snapshots arrive during it. */
  windowKey: string;
}

/**
 * A heads-up *before* a limit is hit, from the burn-rate forecast — unlike a fixed-percentage
 * threshold alert, which only fires once you're already at 80%. Only fires for a projection the
 * UI would also trust (`MIN_FORECAST_PERCENT` used, medium/high confidence) that lands before
 * the window's own reset; anything else isn't worth interrupting someone for.
 *
 * `windowKey` rounds `resetsAt` to the hour because the same window's reset time is reported
 * with slightly different precision by different capture sources (`/usage` vs SSE), and an
 * exact-string key would let that jitter re-fire the same alert.
 */
export function paceAlertFor(
  label: string,
  bar: LimitBar | null,
  history: TimedPercent[],
  now: Date = new Date(),
): PaceAlert | null {
  if (!bar || bar.percent < MIN_FORECAST_PERCENT || bar.percent >= 100) return null;
  const forecast = forecastBurnRate(history, now);
  if (!forecast?.projectedFullAt || forecast.confidence === 'low') return null;
  const projected = new Date(forecast.projectedFullAt);
  if (projected.getTime() > new Date(bar.resetsAt).getTime() - MIN_FORECAST_MARGIN_MS) return null;

  const when = projected.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return {
    title: `Claude usage: ${label} on pace to run out`,
    message: `At this pace you'll hit the limit ~${when}, before it resets ${formatResetLabel(bar.resetsAt, now)}. Pacing back or switching to a lighter model would stretch it.`,
    windowKey: String(Math.round(new Date(bar.resetsAt).getTime() / 3_600_000)),
  };
}
