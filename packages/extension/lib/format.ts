import type { BurnRateForecast, LimitSnapshot } from '@headroom/shared';

export interface ForecastMessage {
  message: string;
  /** True when the projection lands before the window's own reset — the only case worth
   *  calling out, since a projection that loses the race to the reset isn't actually a risk. */
  atRisk: boolean;
}

/** Turns a raw burn-rate forecast into UI copy, or null if there's nothing worth showing (no
 *  forecast, or the bar isn't currently on pace to hit 100% at all). */
export function describeForecast(
  forecast: BurnRateForecast | null,
  resetsAt: string | null,
  now: Date = new Date(),
): ForecastMessage | null {
  if (!forecast || !forecast.projectedFullAt) return null;

  const projected = new Date(forecast.projectedFullAt);
  const atRisk = !resetsAt || projected < new Date(resetsAt);
  const when = projected.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const confidenceNote = forecast.confidence === 'low' ? ' (low confidence)' : '';

  return {
    atRisk,
    message: atRisk
      ? `At current pace, reaches limit ~${when}${confidenceNote}`
      : `On pace for ~${when}, but resets first${confidenceNote}`,
  };
}

/**
 * "in 3h 14m", "in 12m", or "resetting now" for anything under a day out — a relative
 * countdown is genuinely the clearest way to read a short span. A day or more out (the weekly
 * bar's usual case), a countdown like "in 167h 50m" stops being readable at a glance, so this
 * switches to an absolute "Thu, 8:00 PM" instead (same `weekday, time` style
 * `describeForecast()` already uses for its own "reaches limit ~<when>" text, so the two read
 * consistently next to each other).
 */
export function formatResetLabel(resetsAt: string, now: Date = new Date()): string {
  const diffMs = new Date(resetsAt).getTime() - now.getTime();
  if (diffMs <= 0) return 'resetting now';

  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours < 24) {
    if (hours === 0) return `in ${minutes}m`;
    if (minutes === 0) return `in ${hours}h`;
    return `in ${hours}h ${minutes}m`;
  }

  return new Date(resetsAt).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// `severity` is an open string per packages/shared's schema (only "normal"/"warning" observed
// so far) — anything unrecognized falls back to the neutral color rather than erroring, so a
// new severity value degrades gracefully instead of breaking the popup.
const SEVERITY_COLORS: Record<string, string> = {
  normal: '#3b82f6',
  warning: '#f59e0b',
  critical: '#ef4444',
};
const DEFAULT_BAR_COLOR = '#6b7280';

export function barColor(severity: string): string {
  return SEVERITY_COLORS[severity] ?? DEFAULT_BAR_COLOR;
}

/** Percent can be fractional now (message_limit's exact utilization, extra credits) — round to
 *  at most 1 decimal place and drop a trailing ".0" so "61.000001" reads as "61", not noise,
 *  while a genuinely meaningful fraction like "61.4" still shows. */
export function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Human label for which capture produced a `LimitSnapshot`. All three describe the same
 * shared account-level limit, just observed from a different place — this is "how fresh/where
 * from" context, not a separate budget. `usage` is a periodic `/usage` poll; `message_limit`/
 * `rate_limit_event` are live, exact-fraction upgrades that fire while actively chatting on
 * claude.ai or coding in a `claude.ai/code` session, respectively.
 */
const SOURCE_LABELS: Record<LimitSnapshot['source'], string> = {
  usage: 'periodic check',
  message_limit: 'claude.ai chat',
  rate_limit_event: 'Claude Code web',
};

export function describeSource(source: LimitSnapshot['source']): string {
  return SOURCE_LABELS[source];
}

/** YYYYMMDD, the exact format ccusage's `--since`/`--until` flags take (confirmed via
 *  `ccusage claude daily --help`). */
export function formatCcusageDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
