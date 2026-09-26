import { describe, expect, it } from 'vitest';
import { paceAlertFor } from '../lib/pace-alert.js';

const HOUR = 3_600_000;
const now = new Date(Date.now());
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR).toISOString();
const bar = (percent: number, resetsInHours: number) => ({
  percent,
  resetsAt: new Date(now.getTime() + resetsInHours * HOUR).toISOString(),
  severity: 'normal',
  isActive: true,
});
// 10%/hour over 5 points -> high confidence, ~5h from full at 50%.
const steep = [4, 3, 2, 1, 0].map((h, i) => ({ capturedAt: at(h), percent: 10 + i * 10 }));

describe('paceAlertFor', () => {
  it('alerts when the projection lands before the reset', () => {
    const alert = paceAlertFor('Session (5h)', bar(50, 8), steep, now);
    expect(alert?.title).toBe('Claude usage: Session (5h) on pace to run out');
    expect(alert?.message).toMatch(/before it resets/);
  });

  it('stays quiet when the reset comes first', () => {
    expect(paceAlertFor('Session (5h)', bar(50, 1), steep, now)).toBeNull();
  });

  it('stays quiet when the projection only barely beats the reset', () => {
    expect(paceAlertFor('Session (5h)', bar(50, 5.2), steep, now)).toBeNull();
  });

  it('stays quiet for a barely-used bar, however steep the fit', () => {
    const tiny = [4, 3, 2, 1, 0].map((h, i) => ({ capturedAt: at(h), percent: 1 + i }));
    expect(paceAlertFor('Weekly', bar(5, 100), tiny, now)).toBeNull();
  });

  it('stays quiet at low confidence and for a bar already at its limit', () => {
    expect(paceAlertFor('Session (5h)', bar(50, 8), steep.slice(-2), now)).toBeNull();
    expect(paceAlertFor('Session (5h)', bar(100, 8), steep, now)).toBeNull();
    expect(paceAlertFor('Session (5h)', null, steep, now)).toBeNull();
  });

  it('keys the same window identically despite sub-hour reset jitter', () => {
    const a = paceAlertFor('Session (5h)', bar(50, 8), steep, now);
    const jittered = { ...bar(50, 8), resetsAt: new Date(new Date(bar(50, 8).resetsAt).getTime() + 90_000).toISOString() };
    expect(paceAlertFor('Session (5h)', jittered, steep, now)?.windowKey).toBe(a?.windowKey);
  });
});
