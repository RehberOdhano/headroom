/** Case-insensitive substring match across any number of fields — an empty query matches
 *  everything. Shared by every type-to-filter box in the dashboard (CLI Attribution's
 *  By-project/By-session tables) rather than one ad-hoc copy per table. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}
