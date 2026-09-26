import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Settings } from '../../lib/protocol.js';
import { buildBackup, fingerprintsToRestore, parseBackup, snapshotsToRestore, type BackupFile } from '../../lib/backup.js';
import { db } from '../../lib/db.js';
import { downloadJson } from '../../lib/downloads.js';
import { extensionMessenger } from '../../lib/messaging.js';
import { styles } from './styles.ts';

type RestorePreview = { data: BackupFile; newSnapshots: number; newFingerprints: number };

/**
 * All local state (`limitSnapshots`, `configFingerprints`, settings minus the daemon token — see
 * `lib/backup.ts`'s doc comment for why) lives only in this browser profile's IndexedDB, with no
 * cloud sync. Clearing site data, reinstalling, or moving to a new machine silently loses weeks
 * of history the dashboard's History/Forecast views depend on. This is the insurance for that:
 * export to a local JSON file, and restore it back in later — additive only (never overwrites
 * already-stored snapshots or a fresher fingerprint, never touches whatever daemon token this
 * install already has) so restoring is safe to do more than once.
 */
export function BackupRestoreSection({ settings, onSettingsRestored }: { settings: Settings; onSettingsRestored: (next: Settings) => void }) {
  const limitSnapshots = useLiveQuery(() => db.limitSnapshots.toArray(), []);
  const configFingerprints = useLiveQuery(() => db.configFingerprints.toArray(), []);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDone, setRestoreDone] = useState<{ snapshots: number; fingerprints: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function downloadBackup() {
    if (!limitSnapshots || !configFingerprints) return;
    const backup = buildBackup({ limitSnapshots, configFingerprints, settings });
    downloadJson(`headroom-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, backup);
  }

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setRestoreDone(null);
    const text = await file.text();
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      setRestoreError(parsed.error);
      setRestorePreview(null);
      return;
    }
    setRestoreError(null);
    // Read straight from Dexie rather than the `useLiveQuery` state above — that hook may not
    // have resolved yet on a freshly mounted page, which would otherwise make every incoming
    // record look "new" (comparing against an empty array) and duplicate history already stored.
    const [existingSnapshots, existingFingerprints] = await Promise.all([db.limitSnapshots.toArray(), db.configFingerprints.toArray()]);
    setRestorePreview({
      data: parsed.data,
      newSnapshots: snapshotsToRestore(existingSnapshots, parsed.data.limitSnapshots).length,
      newFingerprints: fingerprintsToRestore(existingFingerprints, parsed.data.configFingerprints).length,
    });
  }

  async function confirmRestore() {
    if (!restorePreview) return;
    const { data } = restorePreview;
    const [existingSnapshots, existingFingerprints] = await Promise.all([db.limitSnapshots.toArray(), db.configFingerprints.toArray()]);
    const toAddSnapshots = snapshotsToRestore(existingSnapshots, data.limitSnapshots);
    const toPutFingerprints = fingerprintsToRestore(existingFingerprints, data.configFingerprints);
    if (toAddSnapshots.length > 0) await db.limitSnapshots.bulkAdd(toAddSnapshots);
    if (toPutFingerprints.length > 0) await db.configFingerprints.bulkPut(toPutFingerprints);
    // `updateSettings` merges onto whatever this device's current settings are (lib/settings.ts)
    // — `data.settings` has no `daemonToken` field at all, so this can never clobber the token
    // this install already paired with.
    const next = await extensionMessenger.sendMessage('updateSettings', data.settings);
    onSettingsRestored(next);
    setRestoreDone({ snapshots: toAddSnapshots.length, fingerprints: toPutFingerprints.length });
    setRestorePreview(null);
  }

  return (
    <div style={styles.daemonBlock}>
      <p style={styles.hint}>
        Everything above lives only in this browser profile — clearing site data or moving to a new machine loses it for
        good. Back it up to a file you keep, and restore it later.
      </p>
      <div style={styles.backupRow}>
        <button type="button" onClick={downloadBackup} disabled={!limitSnapshots || !configFingerprints}>
          Download backup
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          Restore from file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          aria-label="Restore backup file"
          hidden
          onChange={(e) => void handleFileSelected(e)}
        />
      </div>

      {restoreError && <p style={styles.error}>{restoreError}</p>}

      {restorePreview && (
        <div style={styles.restorePreview}>
          <p>
            This backup was exported {new Date(restorePreview.data.exportedAt).toLocaleString()} and has{' '}
            {restorePreview.data.limitSnapshots.length} snapshot{restorePreview.data.limitSnapshots.length === 1 ? '' : 's'} and{' '}
            {restorePreview.data.configFingerprints.length} project fingerprint{restorePreview.data.configFingerprints.length === 1 ? '' : 's'}.
          </p>
          <p>
            {restorePreview.newSnapshots} new snapshot{restorePreview.newSnapshots === 1 ? '' : 's'} and {restorePreview.newFingerprints} project
            fingerprint{restorePreview.newFingerprints === 1 ? '' : 's'} will be added — anything already stored, or already more recent, is left
            alone. Settings will be restored too, except the daemon connection (kept as-is).
          </p>
          <div style={styles.backupRow}>
            <button type="button" onClick={() => void confirmRestore()}>
              Restore
            </button>
            <button type="button" onClick={() => setRestorePreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {restoreDone && (
        <p style={styles.ok}>
          Restored {restoreDone.snapshots} snapshot{restoreDone.snapshots === 1 ? '' : 's'} and {restoreDone.fingerprints} project fingerprint
          {restoreDone.fingerprints === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}

