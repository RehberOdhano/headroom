import type { Settings } from './protocol.js';

/**
 * Whether `now` falls inside the user's configured quiet-hours window. `start`/`end` are hours
 * 0-23; `start > end` means the window wraps past midnight (e.g. 22 -> 8). `start === end` would
 * be a zero-length or full-day window depending on how you read it — treated as "disabled" by
 * `quietHoursEnabled` itself, not handled specially here.
 */
export function isWithinQuietHours(now: Date, settings: Pick<Settings, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>): boolean {
  if (!settings.quietHoursEnabled) return false;

  const hour = now.getHours();
  const { quietHoursStart: start, quietHoursEnd: end } = settings;

  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
