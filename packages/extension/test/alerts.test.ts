import { describe, expect, it } from 'vitest';
import { thresholdCrossed } from '../lib/alerts.js';

const resetsAt = '2026-08-30T00:00:00Z';

describe('thresholdCrossed', () => {
  it('returns null below the lowest threshold', () => {
    expect(thresholdCrossed({ percent: 50, resetsAt }, null)).toBeNull();
  });

  it('fires the lowest threshold on first crossing', () => {
    expect(thresholdCrossed({ percent: 82, resetsAt }, null)).toBe(80);
  });

  it('fires the highest threshold crossed, not each one individually', () => {
    expect(thresholdCrossed({ percent: 97, resetsAt }, null)).toBe(95);
  });

  it('does not re-fire the same threshold in the same window', () => {
    expect(thresholdCrossed({ percent: 85, resetsAt }, { resetsAt, threshold: 80 })).toBeNull();
  });

  it('fires a higher threshold newly crossed in the same window', () => {
    expect(thresholdCrossed({ percent: 96, resetsAt }, { resetsAt, threshold: 80 })).toBe(95);
  });

  it('does not re-fire a lower threshold after a small downward correction in the same window', () => {
    // e.g. extra usage credits added mid-window nudge percent down slightly — not a real reset.
    expect(thresholdCrossed({ percent: 90, resetsAt }, { resetsAt, threshold: 95 })).toBeNull();
  });

  it('allows thresholds to fire again once the window has actually reset', () => {
    const newResetsAt = '2026-09-06T00:00:00Z';
    expect(thresholdCrossed({ percent: 82, resetsAt: newResetsAt }, { resetsAt, threshold: 95 })).toBe(80);
  });
});
