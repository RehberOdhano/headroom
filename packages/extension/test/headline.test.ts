import { describe, expect, it } from 'vitest';
import { summarizeHeadroom } from '../lib/headline.js';

const HOUR = 3_600_000;
const now = new Date(Date.now());
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR).toISOString();
const bar = (percent: number, resetsInHours = 4) => ({
  percent,
  resetsAt: new Date(now.getTime() + resetsInHours * HOUR).toISOString(),
  severity: 'normal',
  isActive: true,
});
// 10%/hour for 5 points -> ~high confidence, projects 100% about 5h out from 50%.
const steep = [4, 3, 2, 1, 0].map((h, i) => ({ capturedAt: at(h), percent: 10 + i * 10 }));
const flat = [4, 3, 2, 1, 0].map((h) => ({ capturedAt: at(h), percent: 20 }));

describe('summarizeHeadroom', () => {
  it('returns null with no bars', () => {
    expect(summarizeHeadroom([{ title: 'Session', bar: null, history: [] }], now)).toBeNull();
  });

  it('alerts when a bar is already at its limit', () => {
    const result = summarizeHeadroom([{ title: 'Weekly', bar: bar(100), history: [] }], now);
    expect(result?.tone).toBe('alert');
    expect(result?.text).toMatch(/Weekly limit reached/);
  });

  it('warns when the projection beats the reset', () => {
    // Projects full ~5h out (50% at 10%/h) but the reset is 8h away.
    const result = summarizeHeadroom([{ title: 'Session', bar: bar(50, 8), history: steep }], now);
    expect(result?.tone).toBe('warn');
    expect(result?.text).toMatch(/session runs out/);
  });

  it('suggests waiting when the reset is close', () => {
    // 10% -> 90% at 20%/h projects full in ~30m, and the reset is 1h15m away.
    const late = [4, 3, 2, 1, 0].map((h, i) => ({ capturedAt: at(h), percent: 10 + i * 20 }));
    const result = summarizeHeadroom([{ title: 'Session', bar: bar(90, 1.25), history: late }], now);
    expect(result?.tone).toBe('warn');
    expect(result?.text).toMatch(/A short break gets you a fresh window in 1h 15m/);
    // A distant reset gets no such hint.
    expect(summarizeHeadroom([{ title: 'Session', bar: bar(50, 8), history: steep }], now)?.text).not.toMatch(/short break/);
  });

  it('does not warn when the reset comes first', () => {
    const result = summarizeHeadroom([{ title: 'Session', bar: bar(50, 1), history: steep }], now);
    expect(result?.tone).toBe('ok');
  });

  it('does not warn when the projection only barely beats the reset', () => {
    // Full in ~5h, reset 5.2h away: 12 minutes of margin, under the 30-minute floor.
    expect(summarizeHeadroom([{ title: 'Session', bar: bar(50, 5.2), history: steep }], now)?.tone).toBe('ok');
  });

  it('does not headline a low-confidence projection', () => {
    const twoPoints = steep.slice(-2);
    const result = summarizeHeadroom([{ title: 'Session', bar: bar(50, 8), history: twoPoints }], now);
    expect(result?.tone).toBe('ok');
  });

  it('ignores a projection from a barely-used bar', () => {
    // 1%/hour from 1% is a valid linear fit, but 5% used is too little to warn on.
    const tiny = [4, 3, 2, 1, 0].map((h, i) => ({ capturedAt: at(h), percent: 1 + i }));
    const result = summarizeHeadroom([{ title: 'Weekly', bar: bar(5, 1), history: tiny }], now);
    expect(result?.tone).toBe('ok');
  });

  it('is all-clear for a flat run and names the tightest bar', () => {
    const result = summarizeHeadroom(
      [
        { title: 'Session', bar: bar(20), history: flat },
        { title: 'Weekly', bar: bar(60), history: flat },
      ],
      now,
    );
    expect(result).toEqual({ tone: 'ok', text: "You're clear until reset — weekly at 60%." });
  });
});
