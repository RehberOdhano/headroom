import { describe, expect, it } from 'vitest';
import { isWithinQuietHours } from '../lib/quiet-hours.js';

function at(hour: number): Date {
  const d = new Date('2026-01-01T00:00:00');
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe('isWithinQuietHours', () => {
  it('is always false when disabled, regardless of hour', () => {
    expect(isWithinQuietHours(at(23), { quietHoursEnabled: false, quietHoursStart: 22, quietHoursEnd: 8 })).toBe(false);
  });

  it('handles a same-day window (start < end)', () => {
    const settings = { quietHoursEnabled: true, quietHoursStart: 9, quietHoursEnd: 17 };
    expect(isWithinQuietHours(at(8), settings)).toBe(false);
    expect(isWithinQuietHours(at(9), settings)).toBe(true);
    expect(isWithinQuietHours(at(16), settings)).toBe(true);
    expect(isWithinQuietHours(at(17), settings)).toBe(false);
  });

  it('handles an overnight window (start > end)', () => {
    const settings = { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 8 };
    expect(isWithinQuietHours(at(23), settings)).toBe(true);
    expect(isWithinQuietHours(at(3), settings)).toBe(true);
    expect(isWithinQuietHours(at(8), settings)).toBe(false);
    expect(isWithinQuietHours(at(21), settings)).toBe(false);
  });

  it('treats a zero-length window (start === end) as never quiet', () => {
    expect(isWithinQuietHours(at(22), { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 22 })).toBe(false);
  });
});
