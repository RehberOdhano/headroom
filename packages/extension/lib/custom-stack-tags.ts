import { db } from './db.js';

const META_KEY = 'customStackTags';

/** A user-typed "Stack" tag not already in the curated `KNOWN_TECH_TAGS` catalog, saved locally
 *  (this browser's own IndexedDB, never sent anywhere) so it comes back as a real suggestion the
 *  next time — this is the actual mechanism behind "typing a tag that doesn't exist adds it, and
 *  that's how the list grows": growth is per-install, not a shared/synced catalog. */
export async function addCustomStackTag(tag: string): Promise<void> {
  const trimmed = tag.trim();
  if (!trimmed) return;
  const current = await getCustomStackTags();
  if (current.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
  await db.meta.put({ key: META_KEY, value: JSON.stringify([...current, trimmed]) });
}

export async function getCustomStackTags(): Promise<string[]> {
  const stored = await db.meta.get(META_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored.value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}
