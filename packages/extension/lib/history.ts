import type { LimitSnapshotRecord } from './db.js';

export type BarKey = 'session' | 'weekly';

export interface TimedPercent {
  capturedAt: string;
  percent: number;
}

/** Pulls a {capturedAt, percent}[] time series for one bar out of stored snapshots, dropping
 *  any snapshot where that bar was absent (kept `null` by normalizeUsageResponse). */
export function barHistory(snapshots: LimitSnapshotRecord[], key: BarKey): TimedPercent[] {
  const series: TimedPercent[] = [];
  for (const snapshot of snapshots) {
    const bar = snapshot[key];
    if (bar) series.push({ capturedAt: snapshot.capturedAt, percent: bar.percent });
  }
  return series;
}

/** Snapshots captured at or after `since`. */
export function withinWindow(snapshots: LimitSnapshotRecord[], since: Date): LimitSnapshotRecord[] {
  const sinceMs = since.getTime();
  return snapshots.filter((s) => new Date(s.capturedAt).getTime() >= sinceMs);
}
