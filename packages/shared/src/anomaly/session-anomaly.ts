import type { DaemonSession } from '../daemon/schemas.js';

/** Exported (not just an internal helper) so a UI flagging an anomalous session can also show
 *  *how* anomalous — e.g. "6x the typical $1.20 session" — using the exact same "typical" this
 *  module's own threshold is built from, rather than a second, possibly-divergent calculation. */
export function medianSessionCost(sessions: DaemonSession[]): number {
  if (sessions.length === 0) return 0;
  const sorted = [...sessions.map((s) => s.totalCost)].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Flags sessions whose cost is way outside the norm for the given set — usually a sign an agent
 * got stuck looping rather than that unusually valuable work happened. Deliberately a plain
 * heuristic (5x the median, with a floor so a cheap window doesn't flag everything): there's no
 * "correct" multiplier, this just needs to catch genuine outliers without false-positiving on
 * ordinary variance between sessions.
 */
export function findAnomalousSessions(sessions: DaemonSession[], options: { minFloor?: number } = {}): DaemonSession[] {
  const minFloor = options.minFloor ?? 2;
  if (sessions.length === 0) return [];

  const threshold = Math.max(medianSessionCost(sessions) * 5, minFloor);
  return sessions.filter((s) => s.totalCost > threshold);
}
