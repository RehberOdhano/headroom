import { db } from './db.js';
import { DEFAULT_ALERT_THRESHOLDS } from './alerts.js';
import type { Settings } from './protocol.js';

export const DEFAULT_SETTINGS: Settings = {
  badgeEnabled: true,
  daemonUrl: 'http://127.0.0.1:4317',
  daemonToken: '',
  snapshotRetentionDays: 90,
  alertThresholds: [...DEFAULT_ALERT_THRESHOLDS],
};

const SETTINGS_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await db.meta.get(SETTINGS_KEY);
  if (!stored) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(stored.value) as Partial<Settings>) };
  } catch {
    // Corrupt value — fall back to defaults rather than breaking every settings read.
    return DEFAULT_SETTINGS;
  }
}

/** Wrapped in a Dexie transaction so two updates fired close together (e.g. two settings
 *  fields changed in quick succession) can't race — without it, the second's `getSettings()`
 *  read could land before the first's `put()` write finished, silently reverting whichever
 *  field the first update had just changed. IndexedDB readwrite transactions on the same table
 *  serialize, so this closure runs atomically end to end. */
export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  return db.transaction('rw', db.meta, async () => {
    const next = { ...(await getSettings()), ...partial };
    await db.meta.put({ key: SETTINGS_KEY, value: JSON.stringify(next) });
    return next;
  });
}
