import { describe, expect, it } from 'vitest';
import { sparklinePointsAttr, toSparklinePoints } from '../lib/chart.js';

describe('toSparklinePoints', () => {
  it('returns an empty array for empty input', () => {
    expect(toSparklinePoints([])).toEqual([]);
  });

  it('maps a single point to the left edge, half height', () => {
    const points = toSparklinePoints([{ capturedAt: '2026-08-29T10:00:00Z', percent: 50 }]);
    expect(points).toEqual([{ x: 0, y: 50 }]);
  });

  it('spreads points across x by relative time and inverts y (higher percent -> lower y)', () => {
    const points = toSparklinePoints([
      { capturedAt: '2026-08-29T10:00:00Z', percent: 0 },
      { capturedAt: '2026-08-29T11:00:00Z', percent: 100 },
      { capturedAt: '2026-08-29T12:00:00Z', percent: 50 },
    ]);
    expect(points).toEqual([
      { x: 0, y: 100 },
      { x: 50, y: 0 },
      { x: 100, y: 50 },
    ]);
  });

  it('clamps out-of-range percents into 0-100', () => {
    const points = toSparklinePoints([
      { capturedAt: '2026-08-29T10:00:00Z', percent: -10 },
      { capturedAt: '2026-08-29T11:00:00Z', percent: 150 },
    ]);
    expect(points).toEqual([
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ]);
  });
});

describe('sparklinePointsAttr', () => {
  it('formats points as an SVG polyline points attribute', () => {
    expect(sparklinePointsAttr([{ x: 0, y: 100 }, { x: 50.5, y: 0 }])).toBe('0.00,100.00 50.50,0.00');
  });
});
