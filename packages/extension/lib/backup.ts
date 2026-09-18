import type { ConfigFingerprintRecord, LimitSnapshotRecord } from './db.js';
import type { Settings } from './protocol.js';

/** Bumped whenever `BackupFile`'s shape changes in a way `parseBackup` can't just shrug off with
 *  a default — see root CLAUDE.md's `.default(...)` rule for why the daemon does the analogous
 *  thing for its own long-lived response schemas. There's no long-running process here, but the
 *  same failure mode applies: a backup file downloaded months ago must still fail loudly rather
 *  than silently importing garbage against a shape that's since changed. */
export const BACKUP_VERSION = 1;

/**
 * Everything worth not losing when browser storage is cleared, an install is uninstalled, or a
 * profile moves machines. Deliberately narrower than the full `HeadroomDb`:
 * - `rawRecords` (raw claude.ai captures) is excluded — it's capture-mode debug data with its
 *   own separate "Export fixtures" flow (`entrypoints/options/App.tsx`), not user-facing history.
 * - `daemonToken` is stripped from `settings` — it's a local pairing secret scoped to *this*
 *   daemon install, not portable history; carrying an old token into a restore would silently
 *   clobber a token this machine already paired with. Restoring settings intentionally never
 *   touches whatever token is already configured (see `mergeRestoredSettings`).
 * - Everything else in `meta` (orgId, prepaidCredits, dedup flags like `alertState:*`) is either
 *   re-derived automatically on the next poll or pure internal bookkeeping — not history a user
 *   would recognize as "their data".
 */
export interface BackupFile {
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  limitSnapshots: Omit<LimitSnapshotRecord, 'id'>[];
  configFingerprints: ConfigFingerprintRecord[];
  settings: Omit<Settings, 'daemonToken'>;
}

export function buildBackup(input: {
  limitSnapshots: LimitSnapshotRecord[];
  configFingerprints: ConfigFingerprintRecord[];
  settings: Settings;
}): BackupFile {
  const { daemonToken: _daemonToken, ...settingsWithoutToken } = input.settings;
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    limitSnapshots: input.limitSnapshots.map(({ id: _id, ...rest }) => rest),
    configFingerprints: input.configFingerprints,
    settings: settingsWithoutToken,
  };
}

export type ParsedBackup = { ok: true; data: BackupFile } | { ok: false; error: string };

/** Structural checks only, no schema library — this is our own internal format, not an
 *  undocumented claude.ai endpoint, so a few `Array.isArray`/`typeof` checks are enough to
 *  reject a corrupt or foreign file without dragging in a dependency for it. */
export function parseBackup(json: string): ParsedBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'That file is not a headroom backup.' };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.version !== BACKUP_VERSION) {
    return {
      ok: false,
      error: 'version' in obj ? `Unsupported backup version (${String(obj.version)}).` : 'That file is not a headroom backup.',
    };
  }
  if (!Array.isArray(obj.limitSnapshots) || !Array.isArray(obj.configFingerprints) || typeof obj.settings !== 'object' || obj.settings === null) {
    return { ok: false, error: 'That file is not a headroom backup.' };
  }

  return { ok: true, data: obj as unknown as BackupFile };
}

/** Snapshots from the backup that aren't already stored, so restoring twice (or restoring a
 *  backup that overlaps with data captured since) doesn't duplicate history. `capturedAt` +
 *  `source` is the natural key: two different sources capturing at the exact same instant is
 *  the only case that would collide, and would just mean skipping one true duplicate-looking
 *  entry rather than corrupting anything. */
export function snapshotsToRestore(
  existing: LimitSnapshotRecord[],
  incoming: BackupFile['limitSnapshots'],
): Omit<LimitSnapshotRecord, 'id'>[] {
  const seen = new Set(existing.map((s) => `${s.capturedAt}|${s.source}`));
  return incoming.filter((s) => !seen.has(`${s.capturedAt}|${s.source}`));
}

/** Config fingerprints from the backup worth writing — only when there's no existing fingerprint
 *  for that project, or the backup's is strictly newer. Never let an older backup regress a
 *  fresher fingerprint already captured on this machine (same "don't let older data overwrite
 *  newer" lesson as the claude.ai/code rate-limit-event dedup bug in `code-events.ts`). */
export function fingerprintsToRestore(
  existing: ConfigFingerprintRecord[],
  incoming: ConfigFingerprintRecord[],
): ConfigFingerprintRecord[] {
  const existingByDir = new Map(existing.map((f) => [f.projectDir, f]));
  return incoming.filter((f) => {
    const current = existingByDir.get(f.projectDir);
    return !current || new Date(f.checkedAt).getTime() > new Date(current.checkedAt).getTime();
  });
}
