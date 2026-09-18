import { describe, expect, it } from 'vitest';
import { BACKUP_VERSION, buildBackup, fingerprintsToRestore, parseBackup, snapshotsToRestore } from '../lib/backup.js';
import type { ConfigFingerprintRecord, LimitSnapshotRecord } from '../lib/db.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

const bar = (percent: number) => ({ percent, resetsAt: '2026-09-01T00:00:00Z', severity: 'normal' as const, isActive: true });

const snapshot = (id: number, capturedAt: string): LimitSnapshotRecord => ({
  id,
  capturedAt,
  source: 'usage',
  session: bar(10),
  weekly: bar(20),
});

const fingerprint = (projectDir: string, checkedAt: string): ConfigFingerprintRecord => ({
  projectDir,
  fingerprint: 'abc',
  checkedAt,
});

describe('buildBackup', () => {
  it('strips ids from snapshots and the daemon token from settings', () => {
    const backup = buildBackup({
      limitSnapshots: [snapshot(1, '2026-08-29T10:00:00Z')],
      configFingerprints: [fingerprint('/p', '2026-08-29T10:00:00Z')],
      settings: { ...DEFAULT_SETTINGS, daemonToken: 'secret-token' },
    });

    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.limitSnapshots).toEqual([{ capturedAt: '2026-08-29T10:00:00Z', source: 'usage', session: bar(10), weekly: bar(20) }]);
    expect('id' in backup.limitSnapshots[0]!).toBe(false);
    expect('daemonToken' in backup.settings).toBe(false);
    expect(backup.configFingerprints).toEqual([fingerprint('/p', '2026-08-29T10:00:00Z')]);
  });
});

describe('parseBackup', () => {
  it('round-trips a real backup file', () => {
    const backup = buildBackup({
      limitSnapshots: [snapshot(1, '2026-08-29T10:00:00Z')],
      configFingerprints: [],
      settings: DEFAULT_SETTINGS,
    });
    const result = parseBackup(JSON.stringify(backup));
    expect(result).toEqual({ ok: true, data: backup });
  });

  it('rejects invalid JSON', () => {
    expect(parseBackup('{not json')).toEqual({ ok: false, error: 'That file is not valid JSON.' });
  });

  it('rejects a file missing the expected shape', () => {
    expect(parseBackup(JSON.stringify({ hello: 'world' }))).toEqual({
      ok: false,
      error: 'That file is not a headroom backup.',
    });
  });

  it('rejects an unsupported version', () => {
    expect(parseBackup(JSON.stringify({ version: 99 }))).toEqual({
      ok: false,
      error: 'Unsupported backup version (99).',
    });
  });
});

describe('snapshotsToRestore', () => {
  it('drops snapshots already present, keyed by capturedAt + source', () => {
    const existing = [snapshot(1, '2026-08-29T10:00:00Z')];
    const incoming = [
      { capturedAt: '2026-08-29T10:00:00Z', source: 'usage' as const, session: bar(10), weekly: bar(20) },
      { capturedAt: '2026-08-29T11:00:00Z', source: 'usage' as const, session: bar(15), weekly: bar(25) },
    ];

    expect(snapshotsToRestore(existing, incoming)).toEqual([incoming[1]]);
  });

  it('keeps everything when nothing overlaps', () => {
    const incoming = [{ capturedAt: '2026-08-29T10:00:00Z', source: 'usage' as const, session: bar(10), weekly: bar(20) }];
    expect(snapshotsToRestore([], incoming)).toEqual(incoming);
  });
});

describe('fingerprintsToRestore', () => {
  it('restores a fingerprint for a project with none stored yet', () => {
    const incoming = [fingerprint('/p', '2026-08-29T10:00:00Z')];
    expect(fingerprintsToRestore([], incoming)).toEqual(incoming);
  });

  it('skips a project whose stored fingerprint is already newer', () => {
    const existing = [fingerprint('/p', '2026-08-30T10:00:00Z')];
    const incoming = [fingerprint('/p', '2026-08-29T10:00:00Z')];
    expect(fingerprintsToRestore(existing, incoming)).toEqual([]);
  });

  it('restores a project whose backup fingerprint is newer than what is stored', () => {
    const existing = [fingerprint('/p', '2026-08-28T10:00:00Z')];
    const incoming = [fingerprint('/p', '2026-08-29T10:00:00Z')];
    expect(fingerprintsToRestore(existing, incoming)).toEqual(incoming);
  });
});
