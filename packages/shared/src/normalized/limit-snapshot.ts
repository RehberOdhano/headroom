import type { UsageResponse } from '../claude-ai/usage.js';
import type { MessageLimitEvent } from '../claude-ai/message-limit.js';
import type { RateLimitInfo } from '../claude-ai/code-rate-limit.js';

/** One limit bar's worth of data — a single entry from /usage's `limits[]`. */
export interface LimitBar {
  percent: number;
  resetsAt: string;
  severity: string;
  isActive: boolean;
}

/** /usage's `extra_usage` block, when enabled — pay-as-you-go credits on top of the plan's
 *  included limit. Fields are individually nullable because the schema they come from
 *  (`extraUsageSchema`) only confirms them non-null *together* against one real "enabled"
 *  capture — not that each is independently guaranteed. */
export interface ExtraCreditsInfo {
  /** 0–100, already a percent (unlike message_limit's fractional utilization). */
  percent: number | null;
  /** Major currency units (e.g. dollars) — /usage gives these as minor-unit integers plus a
   *  `decimal_places` divisor; already divided here. */
  usedAmount: number | null;
  limitAmount: number | null;
  currency: string | null;
}

/**
 * The normalized shape the UI renders from: the two bars claude.ai's own Settings > Usage
 * page shows (session, weekly), plus extra usage credits when enabled. `source` records which
 * capture produced it — `usage` from a poll/page visit, `message_limit` from a live SSE event
 * during a claude.ai chat conversation, `rate_limit_event` from the equivalent event on a
 * claude.ai/code session's event log. Both of the latter are more precise than `usage`'s
 * already-rounded percent, but only available while actively chatting/coding respectively.
 * They share this one record type rather than being tracked separately because they describe
 * the same shared account-level session/weekly limit regardless of which surface produced the
 * reading. `extraCredits` is optional, not just nullable — a snapshot stored before this field
 * existed genuinely won't have the key at all.
 */
export interface LimitSnapshot {
  capturedAt: string;
  source: 'usage' | 'message_limit' | 'rate_limit_event';
  session: LimitBar | null;
  weekly: LimitBar | null;
  extraCredits?: ExtraCreditsInfo | null;
}

/**
 * Pure function: given a validated /usage response, extract the session/weekly bars from
 * `limits[]` by `kind`. Only "session" and "weekly_all" are known kinds (see usage.ts) — any
 * other kind is ignored for now rather than guessed at, so a bar is simply absent rather than
 * wrong if claude.ai ever adds a third kind.
 */
export function normalizeUsageResponse(usage: UsageResponse, capturedAt: string): LimitSnapshot {
  const toBar = (entry: UsageResponse['limits'][number]): LimitBar => ({
    percent: entry.percent,
    resetsAt: entry.resets_at,
    severity: entry.severity,
    isActive: entry.is_active,
  });

  const sessionEntry = usage.limits.find((entry) => entry.kind === 'session');
  const weeklyEntry = usage.limits.find((entry) => entry.kind === 'weekly_all');

  return {
    capturedAt,
    source: 'usage',
    session: sessionEntry ? toBar(sessionEntry) : null,
    weekly: weeklyEntry ? toBar(weeklyEntry) : null,
    extraCredits: toExtraCredits(usage.extra_usage),
  };
}

/** `used_credits`/`monthly_limit` are minor-unit integers (e.g. cents) — divide by
 *  `10^decimal_places` to get major units. `utilization` here is already 0–100, unlike
 *  message_limit's 0–1 fraction — a different scale despite the same field name. */
function toExtraCredits(extra: UsageResponse['extra_usage']): ExtraCreditsInfo | null {
  if (!extra.is_enabled) return null;
  const divisor = extra.decimal_places !== null ? 10 ** extra.decimal_places : 1;
  return {
    percent: extra.utilization,
    usedAmount: extra.used_credits !== null ? extra.used_credits / divisor : null,
    limitAmount: extra.monthly_limit !== null ? extra.monthly_limit / divisor : null,
    currency: extra.currency,
  };
}

type MessageLimitDetail = MessageLimitEvent['message_limit'];

/** `utilization * 100` as a plain float can land on `28.999999999999996` instead of `29`
 *  (binary floating-point, not a real precision loss) — round to 2 decimal places, which
 *  still preserves genuine sub-integer precision (e.g. 29.37) while killing that noise. */
function toPercent(utilization: number): number {
  return Math.round(utilization * 10_000) / 100;
}

const CLAIM_TO_BAR: Record<string, 'session' | 'weekly'> = {
  five_hour: 'session',
  seven_day: 'weekly',
};

/**
 * Upgrades a snapshot with a `message_limit` SSE event's more precise numbers, where the event
 * actually carries them.
 *
 * - `windows[key].utilization` is an exact, unrounded fraction (e.g. 0.2937), unlike /usage's
 *   already-rounded integer `percent`. `windows[key].resets_at` is epoch seconds, unlike
 *   /usage's ISO strings, so it's converted here.
 * - Only the window matching this event's own `representativeClaim` ("five_hour" -> session,
 *   "seven_day" -> weekly) comes with a resolved `severity`/`isActive`, via `resolved.limit`
 *   (the one fully-formed limit entry an event carries, same shape as /usage's `limits[]`
 *   entries). The other window in the same event still gets its `percent`/`resetsAt` updated
 *   from real data, but `severity`/`isActive` are carried forward from `previous` rather than
 *   guessed, since nothing in the event resolves them.
 *
 * Returns null when the event carries no window data to apply at all — the
 * `overageInUse: true` branch's `windows` only has an "overage" key, no five_hour/seven_day
 * numbers — callers should keep whatever /usage last gave them in that case.
 */
export function upgradeSnapshotFromMessageLimit(
  detail: MessageLimitDetail,
  previous: LimitSnapshot | null,
  capturedAt: string,
): LimitSnapshot | null {
  if (detail.overageInUse) return null;

  const representativeBar = CLAIM_TO_BAR[detail.representativeClaim];
  let session = previous?.session ?? null;
  let weekly = previous?.weekly ?? null;
  let changed = false;

  const applyWindow = (windowKey: string, barKey: 'session' | 'weekly'): void => {
    const window = detail.windows[windowKey];
    if (!window) return;

    const current = barKey === 'session' ? session : weekly;
    const isRepresentative = representativeBar === barKey;
    const next: LimitBar = {
      percent: toPercent(window.utilization),
      resetsAt: isRepresentative ? detail.resolved.limit.resets_at : new Date(window.resets_at * 1000).toISOString(),
      severity: isRepresentative ? detail.resolved.limit.severity : (current?.severity ?? 'normal'),
      isActive: isRepresentative ? detail.resolved.limit.is_active : (current?.isActive ?? false),
    };

    if (barKey === 'session') session = next;
    else weekly = next;
    changed = true;
  };

  applyWindow('5h', 'session');
  applyWindow('7d', 'weekly');

  if (!changed) return null;
  // message_limit events carry no extra_usage info at all — carry the last known value
  // forward rather than dropping it every time a live SSE event upgrades the bars.
  return { capturedAt, source: 'message_limit', session, weekly, extraCredits: previous?.extraCredits ?? null };
}

const UNIFIED_WINDOW_KEY_TO_BAR: Record<string, 'session' | 'weekly'> = {
  five_hour: 'session',
  seven_day: 'weekly',
};

/**
 * Upgrades a snapshot with a claude.ai/code `rate_limit_event`'s exact, unrounded utilization
 * fractions — the claude.ai/code counterpart of `upgradeSnapshotFromMessageLimit`. Unlike
 * `message_limit`, `unifiedWindows` carries both `five_hour` and `seven_day` uniformly (no
 * separate "representative" window with its own `resolved.limit`), so both bars' `percent`/
 * `resetsAt` update from real data here — but `rate_limit_info` has no per-window severity or
 * "is this the currently-binding one" flag at all, so `severity`/`isActive` are always carried
 * forward from `previous` for both bars rather than guessed. `rate_limit_info.status` is a
 * different, account-level allow/deny signal, not a renamed `severity` — deliberately not
 * mapped onto it.
 *
 * Returns null when neither window is present at all, for the same "nothing to apply" contract
 * as `upgradeSnapshotFromMessageLimit`.
 */
export function upgradeSnapshotFromCodeRateLimitEvent(
  info: RateLimitInfo,
  previous: LimitSnapshot | null,
  capturedAt: string,
): LimitSnapshot | null {
  let session = previous?.session ?? null;
  let weekly = previous?.weekly ?? null;
  let changed = false;

  for (const [windowKey, barKey] of Object.entries(UNIFIED_WINDOW_KEY_TO_BAR)) {
    const window = info.unifiedWindows[windowKey];
    if (!window) continue;

    const current = barKey === 'session' ? session : weekly;
    const next: LimitBar = {
      percent: toPercent(window.utilization),
      resetsAt: new Date(window.resetsAt * 1000).toISOString(),
      severity: current?.severity ?? 'normal',
      isActive: current?.isActive ?? false,
    };

    if (barKey === 'session') session = next;
    else weekly = next;
    changed = true;
  }

  if (!changed) return null;
  // rate_limit_event carries no extra_usage info either — same "carry the last known value
  // forward" rule as upgradeSnapshotFromMessageLimit.
  return { capturedAt, source: 'rate_limit_event', session, weekly, extraCredits: previous?.extraCredits ?? null };
}
