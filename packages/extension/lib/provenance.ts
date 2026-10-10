/**
 * Minimal presentation-only model for "where did this number come from." No new data needs to
 * be stored anywhere — provenance is a static property of *which metric* is being shown, not a
 * per-value flag — so this is just the three label strings used consistently wherever each kind
 * of number renders (a `title` tooltip, typically), plus a plain "updated N ago" formatter.
 */
export type ProvenanceKind = 'server' | 'local' | 'derived';

export const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  server: 'Reported by Claude',
  local: 'Read from your local Claude Code session logs',
  derived: 'Calculated from the above — a rough estimate, not an exact figure',
};

/**
 * "just now" / "3m ago" / "2h ago". Deliberately has no "stale"/warning variant — a slightly-old
 * observation is normal, not broken, so the wording stays the same at any age rather than
 * escalating into a dramatic warning past some threshold.
 */
export function formatUpdatedAgo(capturedAt: string, now: Date = new Date()): string {
  const diffMinutes = Math.round((now.getTime() - new Date(capturedAt).getTime()) / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  return `${Math.round(diffMinutes / 60)}h ago`;
}
