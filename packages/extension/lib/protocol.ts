import type { LimitBar } from '@headroom/shared';

/**
 * Endpoints the page-world hook currently captures. See docs/discovery/claude-ai-endpoints.md.
 * Extend this union (and the hook's URL matching) as more endpoints are confirmed — do not
 * add parsing/normalization here, this package stays capture-mode-only for now.
 *
 * `rate_limit_event` is claude.ai/code's counterpart of `message_limit` — a `GET
 * /v1/code/sessions/{id}/events` response entry rather than an SSE frame. Its `raw` is always a
 * single already-filtered event object, never the full events response: that endpoint's other
 * entries (`user`/`assistant`/`system`/`control_*`) carry real conversation content, so the hook
 * filters down to just the `rate_limit_event` entries before anything ever leaves the page —
 * see claude-hook.content.ts's `captureCodeEvents`.
 */
export type CapturedEndpoint = 'usage' | 'message_limit' | 'rate_limit_event';

/** What the on-page badge (and its "loading" request) needs — a thin slice of a LimitSnapshot. */
export interface BadgeSnapshot {
  session: LimitBar | null;
  weekly: LimitBar | null;
  capturedAt: string;
}

/**
 * User-configurable options, persisted via `lib/settings.ts` (backed by `db.meta`, key
 * `settings`). Defined here rather than in `lib/settings.ts` itself so this file — the one
 * `db.ts` already depends on for `CapturedEndpoint` — stays a dependency-free leaf and
 * `lib/settings.ts` can depend on both this and `db.ts` without a cycle.
 */
export interface Settings {
  /** Optional minimal on-page badge on claude.ai. */
  badgeEnabled: boolean;
  /** Local daemon base URL. */
  daemonUrl: string;
  /** Bearer token pasted from `~/.config/claude-usage/token` after `daemon install`. */
  daemonToken: string;
  /** How long to keep `limitSnapshots` history. */
  snapshotRetentionDays: number;
  /** Percent thresholds worth a notification, any order/length. An empty array turns threshold
   *  alerts off entirely. */
  alertThresholds: number[];
}

export interface CapturedPayload {
  endpoint: CapturedEndpoint;
  capturedAt: string;
  /** Unparsed response body (JSON for `usage`, one SSE event's `data` field for `message_limit`,
   *  one already-filtered event object for `rate_limit_event`). */
  raw: unknown;
  /**
   * Parsed out of the request URL when present (both watched endpoints have it). Lets the
   * background worker cache it and poll `/usage` on its own — see entrypoints/background.ts —
   * instead of only ever seeing data when the user happens to visit Settings > Usage.
   */
  orgId?: string;
}

/** Used for both the MAIN-world <-> ISOLATED-world leg and the content-script <-> background leg. */
export interface CaptureProtocolMap {
  captured(payload: CapturedPayload): void;
}

/** Result of one auto-pairing attempt (lib/pairing.ts) — `paired` reflects whether a token is
 *  configured *after* this call, whether that's because this call just obtained one or because
 *  one was already set; `reason` is only present when `paired` is false. */
export interface PairingStatus {
  paired: boolean;
  reason?: 'unreachable' | 'already_paired' | 'invalid_response';
}

/** Extension-only leg (popup/options/badge <-> background) — a superset of CaptureProtocolMap. */
export interface ExtensionProtocolMap extends CaptureProtocolMap {
  /** Ask the background worker to fetch a fresh /usage snapshot right now, if it can. */
  refreshUsage(): void;
  /** Badge's initial load: the latest snapshot, or null if nothing captured yet. */
  getBadgeSnapshot(): BadgeSnapshot | null;
  /** Pushed by the background worker to each open claude.ai tab after every normalize — the
   *  badge can't share the extension's IndexedDB (content scripts get the *page's* origin), so
   *  it can't use Dexie's cross-context live query the way the popup/dashboard do. */
  badgeUpdate(payload: BadgeSnapshot): void;
  /** Badge click: content scripts can't open the browser action popup or a new tab directly. */
  openDashboard(): void;
  getSettings(): Settings;
  updateSettings(partial: Partial<Settings>): Settings;
  /** Options page's "Check now" button — see lib/pairing.ts. The background worker also does
   *  this itself on a timer whenever no token is configured, so this is a manual nudge for
   *  impatient users, not the only way pairing happens. */
  attemptPairing(): PairingStatus;
}
