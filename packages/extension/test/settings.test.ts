import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../lib/settings.js';

describe('settings', () => {
  beforeEach(async () => {
    await db.meta.clear();
  });

  it('returns defaults when nothing has been stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a partial update on top of the current settings', async () => {
    await updateSettings({ badgeEnabled: false });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, badgeEnabled: false });

    await updateSettings({ daemonToken: 'abc123' });
    expect(await getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      badgeEnabled: false,
      daemonToken: 'abc123',
    });
  });

  it('falls back to defaults if the stored value is corrupt', async () => {
    await db.meta.put({ key: 'settings', value: 'not json' });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('does not lose an update when two calls race (read-modify-write, not just last-write-wins)', async () => {
    // Fired together, not awaited between — without the fix, whichever call's read landed
    // before the other's write would silently clobber it on write.
    await Promise.all([updateSettings({ daemonUrl: 'http://127.0.0.1:9999' }), updateSettings({ daemonToken: 'my-token' })]);

    const settings = await getSettings();
    expect(settings.daemonUrl).toBe('http://127.0.0.1:9999');
    expect(settings.daemonToken).toBe('my-token');
  });
});
