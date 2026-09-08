/** Default percent thresholds worth a notification, ascending — used unless the user
 *  configures their own in settings. Only the highest one newly crossed in a single check
 *  fires — a poll that jumps straight from 60% to 97% shouldn't fire both 80 and 95 separately. */
export const DEFAULT_ALERT_THRESHOLDS = [80, 95] as const;

export interface AlertState {
  /** The bar's `resetsAt` at the time this alert was recorded — the anchor for "same window or
   *  not", since percent alone can't tell a real reset (a big drop) apart from a minor downward
   *  correction (extra usage credits added mid-window, a rounding wobble). */
  resetsAt: string;
  threshold: number;
}

/**
 * Highest alert threshold newly crossed by `bar`, or null if there's nothing new to notify
 * about. `lastAlert` is only honored when its `resetsAt` matches the bar's current one — a
 * different `resetsAt` means the window rolled over since the last alert, so thresholds are
 * free to fire again from the top. `thresholds` need not be sorted or non-empty — an empty
 * array (user turned alerts off) always returns null.
 */
export function thresholdCrossed(
  bar: { percent: number; resetsAt: string },
  lastAlert: AlertState | null,
  thresholds: readonly number[] = DEFAULT_ALERT_THRESHOLDS,
): number | null {
  const lastThreshold = lastAlert && lastAlert.resetsAt === bar.resetsAt ? lastAlert.threshold : 0;
  const crossed = [...thresholds]
    .sort((a, b) => b - a)
    .find((t) => bar.percent >= t && t > lastThreshold);
  return crossed ?? null;
}
