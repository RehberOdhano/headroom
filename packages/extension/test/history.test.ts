import { describe, expect, it } from 'vitest';
import type { LimitSnapshotRecord } from '../lib/db.js';
import { barHistory, withinWindow } from '../lib/history.js';

const bar = (percent: number) => ({ percent, resetsAt: '2026-08-30T00:00:00Z', severity: 'normal', isActive: true });

const snapshots: LimitSnapshotRecord[] = [
  { id: 1, capturedAt: '2026-08-29T10:00:00Z', source: 'usage', session: bar(10), weekly: bar(20) },
  { id: 2, capturedAt: '2026-08-29T11:00:00Z', source: 'usage', session: null, weekly: bar(25) },
  { id: 3, capturedAt: '2026-08-29T12:00:00Z', source: 'usage', session: bar(30), weekly: bar(30) },
];

describe('barHistory', () => {
  it('extracts a time series for a present bar', () => {
    expect(barHistory(snapshots, 'weekly')).toEqual([
      { capturedAt: '2026-08-29T10:00:00Z', percent: 20 },
      { capturedAt: '2026-08-29T11:00:00Z', percent: 25 },
      { capturedAt: '2026-08-29T12:00:00Z', percent: 30 },
    ]);
  });

  it('skips snapshots where the bar is null', () => {
    expect(barHistory(snapshots, 'session')).toEqual([
      { capturedAt: '2026-08-29T10:00:00Z', percent: 10 },
      { capturedAt: '2026-08-29T12:00:00Z', percent: 30 },
    ]);
  });
});

describe('withinWindow', () => {
  it('keeps only snapshots at or after the given time', () => {
    const result = withinWindow(snapshots, new Date('2026-08-29T11:00:00Z'));
    expect(result.map((s) => s.id)).toEqual([2, 3]);
  });
});
