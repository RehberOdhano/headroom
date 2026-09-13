import { KNOWN_TECH_TAGS } from '@headroom/shared';

/** Case-insensitive substring match against a catalog, excluding whatever is already selected —
 *  used by the New Project form's "Stack" pill picker to suggest as the user types. `catalog`
 *  defaults to the curated list but the picker itself passes `KNOWN_TECH_TAGS` plus whatever
 *  custom tags this browser has already saved (`lib/custom-stack-tags.ts`), so a tag someone
 *  added on an earlier run shows up as a real suggestion, not just a one-off value. Empty query
 *  means no suggestions (nothing to narrow down yet), not "show everything". */
export function filterTechTagSuggestions(query: string, selected: string[], catalog: string[] = KNOWN_TECH_TAGS, limit = 8): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const selectedLower = new Set(selected.map((tag) => tag.toLowerCase()));
  return catalog.filter((tag) => tag.toLowerCase().includes(trimmed) && !selectedLower.has(tag.toLowerCase())).slice(0, limit);
}

/** Adds a tag (trimmed, case-insensitively deduped against what's already selected) — accepts
 *  anything, not just a `KNOWN_TECH_TAGS` entry, the same way `stack: 'other'` accepts a typed
 *  stack name not in its own fixed list. */
export function addTechTag(selected: string[], tag: string): string[] {
  const trimmed = tag.trim();
  if (!trimmed || selected.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return selected;
  return [...selected, trimmed];
}

/** Unions a set of detected tags into the current selection without ever dropping one the user
 *  already picked — a multi-select has no "untouched, safe to overwrite" state the way a single
 *  text field does, so detection can only ever add, never replace. */
export function mergeDetectedTechTags(selected: string[], detected: string[]): string[] {
  const selectedLower = new Set(selected.map((tag) => tag.toLowerCase()));
  const additions = detected.filter((tag) => !selectedLower.has(tag.toLowerCase()));
  return additions.length > 0 ? [...selected, ...additions] : selected;
}
