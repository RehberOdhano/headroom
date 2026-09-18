export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface HeatmapCell {
  /** 0 = Sunday .. 6 = Saturday, in the viewer's own local time — this is meant to show "when in
   *  my day/week do I run expensive sessions", so it deliberately isn't UTC. */
  dayOfWeek: number;
  /** 0-23, local time. */
  hour: number;
  cost: number;
  sessionCount: number;
}

/**
 * Buckets each session's *entire* cost into the local day-of-week/hour-of-day of its
 * `lastActivity` timestamp. ccusage's session reports (`DaemonSession`) have no sub-hour
 * breakdown — a session spanning several hours still only has one `lastActivity` — so this is a
 * proxy for "when do I tend to run costly sessions", not exact minute-by-minute attribution. Good
 * enough to spot a real pattern (e.g. "Monday mornings are always the expensive ones"), same
 * spirit as the CLI reconciliation math's own "rough estimate, not a fact" caveat.
 */
export function buildCostHeatmap(sessions: { lastActivity: string; totalCost: number }[]): HeatmapCell[] {
  const buckets = new Map<string, HeatmapCell>();
  for (const session of sessions) {
    const date = new Date(session.lastActivity);
    const dayOfWeek = date.getDay();
    const hour = date.getHours();
    const key = `${dayOfWeek}-${hour}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.cost += session.totalCost;
      existing.sessionCount += 1;
    } else {
      buckets.set(key, { dayOfWeek, hour, cost: session.totalCost, sessionCount: 1 });
    }
  }
  return [...buckets.values()];
}

export function heatmapCell(cells: HeatmapCell[], dayOfWeek: number, hour: number): HeatmapCell | null {
  return cells.find((c) => c.dayOfWeek === dayOfWeek && c.hour === hour) ?? null;
}

export function maxHeatmapCost(cells: HeatmapCell[]): number {
  return cells.reduce((max, c) => Math.max(max, c.cost), 0);
}

/** The single day+hour bucket that costs the most — the one-line callout above the grid. Ties
 *  keep whichever bucket was seen first, which is fine since it's just a headline, not a ranking. */
export function busiestHeatmapCell(cells: HeatmapCell[]): HeatmapCell | null {
  if (cells.length === 0) return null;
  return cells.reduce((top, c) => (c.cost > top.cost ? c : top));
}
