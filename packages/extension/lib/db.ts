import Dexie, { type EntityTable } from 'dexie';
import type { LimitSnapshot } from '@headroom/shared';
import type { CapturedEndpoint } from './protocol.js';

export interface RawRecord {
  id?: number;
  endpoint: CapturedEndpoint;
  capturedAt: string;
  raw: unknown;
}

export interface LimitSnapshotRecord extends LimitSnapshot {
  id?: number;
}

export interface MetaRecord {
  key: string;
  value: string;
}

/** The structured pieces `fingerprintSnapshot()` (Config.tsx) hashes — stored alongside the hash
 *  so a later mismatch can be diffed into specific wording ("2 new allow rules") instead of a
 *  one-size-fits-all "changed" message. Sorted arrays, same as the hash itself. */
export interface ConfigFingerprintSummary {
  allow: string[];
  ask: string[];
  deny: string[];
  hooks: string[];
  skills: string[];
}

/** Last-seen Guardrails config fingerprint for one project — lets Config.tsx flag "changed since
 *  you last viewed this project" without the (deliberately stateless, see root README) daemon
 *  tracking anything itself. `projectDir` is the primary key: one row per project. `summary` is
 *  optional only because Dexie doesn't enforce a shape on existing rows if this type changes in
 *  the future the way it did once already here — not because it's meant to be routinely absent. */
export interface ConfigFingerprintRecord {
  projectDir: string;
  fingerprint: string;
  summary?: ConfigFingerprintSummary;
  checkedAt: string;
}

export class HeadroomDb extends Dexie {
  rawRecords!: EntityTable<RawRecord, 'id'>;
  limitSnapshots!: EntityTable<LimitSnapshotRecord, 'id'>;
  meta!: EntityTable<MetaRecord, 'key'>;
  configFingerprints!: EntityTable<ConfigFingerprintRecord, 'projectDir'>;

  constructor() {
    super('headroom');
    this.version(1).stores({
      rawRecords: '++id, endpoint, capturedAt',
    });
    // v2: normalized limit-bar history (packages/shared's LimitSnapshot), appended — never
    // overwritten — each time the background worker successfully validates and normalizes a
    // /usage capture. This is what the popup renders from; rawRecords stays capture-mode's
    // untouched export source.
    this.version(2).stores({
      rawRecords: '++id, endpoint, capturedAt',
      limitSnapshots: '++id, capturedAt',
    });
    // v3: tiny key/value table — currently just the org id, extracted from a captured request
    // URL, so the background worker can poll /usage on its own instead of only ever seeing
    // data when the user happens to visit claude.ai's Settings > Usage page.
    this.version(3).stores({
      rawRecords: '++id, endpoint, capturedAt',
      limitSnapshots: '++id, capturedAt',
      meta: 'key',
    });
    // v4: one fingerprint per project, for Config.tsx's Guardrails-drift detection ("changed
    // since you last viewed this project") — see ConfigFingerprintRecord's doc comment.
    this.version(4).stores({
      rawRecords: '++id, endpoint, capturedAt',
      limitSnapshots: '++id, capturedAt',
      meta: 'key',
      configFingerprints: 'projectDir',
    });
  }
}

export const db = new HeadroomDb();
