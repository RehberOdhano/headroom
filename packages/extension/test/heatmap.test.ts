import { describe, expect, it } from 'vitest';
import { buildCostHeatmap, busiestHeatmapCell, heatmapCell, maxHeatmapCost } from '../lib/heatmap.js';

// Constructed with the local-time `Date` constructor and read back with local getters, so this
// round-trips correctly regardless of which timezone the test runner itself is in (no UTC
// conversion happens on either side) — see lib/format.ts's own `toLocaleString` tests for the
// same "don't assert an exact locale/timezone string" precedent.
const localIso = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month, day, hour, minute).toISOString();

// 2026-08-29 is a Saturday (day 6); 2026-08-31 is the following Monday (day 1).
const SATURDAY = (hour: number, minute = 0) => localIso(2026, 7, 29, hour, minute);
const MONDAY = (hour: number, minute = 0) => localIso(2026, 7, 31, hour, minute);

describe('buildCostHeatmap', () => {
  it('buckets sessions by local day-of-week and hour', () => {
    const cells = buildCostHeatmap([
      { lastActivity: SATURDAY(14, 10), totalCost: 1.5 },
      { lastActivity: MONDAY(9, 0), totalCost: 2 },
    ]);

    expect(cells).toHaveLength(2);
    expect(heatmapCell(cells, 6, 14)).toEqual({ dayOfWeek: 6, hour: 14, cost: 1.5, sessionCount: 1 });
    expect(heatmapCell(cells, 1, 9)).toEqual({ dayOfWeek: 1, hour: 9, cost: 2, sessionCount: 1 });
  });

  it('sums cost and counts sessions landing in the same day/hour bucket', () => {
    const cells = buildCostHeatmap([
      { lastActivity: SATURDAY(14, 5), totalCost: 1 },
      { lastActivity: SATURDAY(14, 45), totalCost: 3 },
    ]);

    expect(cells).toEqual([{ dayOfWeek: 6, hour: 14, cost: 4, sessionCount: 2 }]);
  });

  it('returns no cells for no sessions', () => {
    expect(buildCostHeatmap([])).toEqual([]);
  });
});

describe('heatmapCell', () => {
  it('returns null for a bucket with no sessions', () => {
    const cells = buildCostHeatmap([{ lastActivity: SATURDAY(14), totalCost: 1 }]);
    expect(heatmapCell(cells, 6, 15)).toBeNull();
  });
});

describe('maxHeatmapCost', () => {
  it('returns the highest single-bucket cost', () => {
    const cells = buildCostHeatmap([
      { lastActivity: SATURDAY(14), totalCost: 1 },
      { lastActivity: MONDAY(9), totalCost: 5 },
    ]);
    expect(maxHeatmapCost(cells)).toBe(5);
  });

  it('returns 0 for an empty heatmap', () => {
    expect(maxHeatmapCost([])).toBe(0);
  });
});

describe('busiestHeatmapCell', () => {
  it('returns the priciest bucket', () => {
    const cells = buildCostHeatmap([
      { lastActivity: SATURDAY(14), totalCost: 1 },
      { lastActivity: MONDAY(9), totalCost: 5 },
    ]);
    expect(busiestHeatmapCell(cells)).toEqual({ dayOfWeek: 1, hour: 9, cost: 5, sessionCount: 1 });
  });

  it('returns null when there is nothing yet', () => {
    expect(busiestHeatmapCell([])).toBeNull();
  });
});
