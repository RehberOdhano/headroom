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

export class HeadroomDb extends Dexie {
  rawRecords!: EntityTable<RawRecord, 'id'>;
  limitSnapshots!: EntityTable<LimitSnapshotRecord, 'id'>;
  meta!: EntityTable<MetaRecord, 'key'>;

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
  }
}

export const db = new HeadroomDb();
