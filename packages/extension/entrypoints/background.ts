import {
  messageLimitEventSchema,
  normalizePrepaidCredits,
  normalizeUsageResponse,
  prepaidCreditsResponseSchema,
  rateLimitEventSchema,
  soonestExpiringPromoTranche,
  upgradeSnapshotFromCodeRateLimitEvent,
  upgradeSnapshotFromMessageLimit,
  usageResponseSchema,
  type LimitBar,
  type LimitSnapshot,
  type PrepaidCreditsSnapshot,
} from '@headroom/shared';
import { findAnomalousSessions, type DaemonSession } from '@headroom/shared';
import { setBadgeBackgroundColor, setBadgeText } from '../lib/action-badge.js';
import { extensionMessenger, sendToTabIgnoringMissingReceiver } from '../lib/messaging.js';
import { db } from '../lib/db.js';
import { thresholdCrossed, type AlertState } from '../lib/alerts.js';
import { formatCcusageDate, formatResetLabel, formatTokens } from '../lib/format.js';
import { getDaemonByProject, getDaemonDaily, getDaemonSessions } from '../lib/daemon-client.js';
import { isWithinQuietHours } from '../lib/quiet-hours.js';
import { attemptPairing } from '../lib/pairing.js';
import { findRetentionWarnings } from '../lib/retention.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import type { BadgeSnapshot, DaemonHealth, PairingStatus, Settings } from '../lib/protocol.js';

// See claude-hook.content.ts — same debug toggle, flip off before shipping.
const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log('[headroom:background]', ...args);

const POLL_ALARM_NAME = 'headroom-poll-usage';
const POLL_INTERVAL_MINUTES = 5;

// See lib/pairing.ts. 1 minute is the shortest repeating period Chrome allows a published
// extension's alarm to fire at, so this is as fast as automatic pairing can happen without the
// user opening the options page and clicking "Check now" (background.ts's pollUsage above
// follows the same "never fetch on startup, only via an alarm or a message" pattern — worth
// keeping consistent so tests never trigger a real network call just by loading the background
// worker).
const PAIR_ALARM_NAME = 'headroom-attempt-pairing';
const PAIR_INTERVAL_MINUTES = 1;

export default defineBackground(() => {
  log('installed — listening for captures');

  extensionMessenger.onMessage('captured', async (message) => {
    const id = await db.rawRecords.add(message.data);
    log('stored record', id, message.data.endpoint, message.data.capturedAt);

    if (message.data.orgId) {
      await db.meta.put({ key: 'orgId', value: message.data.orgId });
    }

    if (message.data.endpoint === 'usage') {
      await normalizeAndStoreUsage(message.data.raw, message.data.capturedAt);
    } else if (message.data.endpoint === 'message_limit') {
      await normalizeAndStoreMessageLimit(message.data.raw, message.data.capturedAt);
    } else if (message.data.endpoint === 'rate_limit_event') {
      await normalizeAndStoreCodeRateLimitEvent(message.data.raw, message.data.capturedAt);
    }
  });

  extensionMessenger.onMessage('refreshUsage', async () => {
    log('refresh requested');
    await pollUsage();
  });

  extensionMessenger.onMessage('getBadgeSnapshot', async () => {
    const latest = await db.limitSnapshots.orderBy('capturedAt').last();
    return latest ? toBadgeSnapshot(latest) : null;
  });

  extensionMessenger.onMessage('openDashboard', async () => {
    await browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
  });

  extensionMessenger.onMessage('getSettings', () => getSettings());
  extensionMessenger.onMessage('updateSettings', (message) => updateSettings(message.data));
  extensionMessenger.onMessage('attemptPairing', () => tryPairNow());
  extensionMessenger.onMessage('getDaemonHealth', () => getStoredDaemonHealth());

  // Keeps bars fresh without requiring the user to visit claude.ai's Settings > Usage page —
  // that page is the *only* place claude.ai's own frontend fetches /usage, so without this
  // the extension would otherwise stay silent until the user happened to land there.
  browser.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  // Auto-pairing (lib/pairing.ts): keeps trying until a token is configured, so a user who
  // never opens the options page still ends up connected once the daemon is installed —
  // tryPairNow() itself is a no-op fetch-wise once daemonToken is already set.
  browser.alarms.create(PAIR_ALARM_NAME, { periodInMinutes: PAIR_INTERVAL_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM_NAME) {
      void pollUsage();
      void pollPrepaidCredits();
      void checkCliBudget();
      void checkPerProjectCliBudgets();
      void checkWeeklyDigest();
      void checkSessionsAndBadge();
    }
    // Once a token is configured, pairing itself becomes a no-op (tryPairNow returns early) —
    // this same 1-minute tick then does something else useful instead: recheck the daemon is
    // still actually reachable, since a stale "Connected automatically" status otherwise never
    // updates again after the one successful pairing (see checkDaemonHealth's doc comment).
    if (alarm.name === PAIR_ALARM_NAME) void pairOrCheckHealth();
  });
});

/** Attempts auto-pairing if no token is configured yet; a no-op otherwise. Shared by the
 *  periodic alarm above and the options page's "Check now" button (attemptPairing message). */
async function tryPairNow(): Promise<PairingStatus> {
  const settings = await getSettings();
  if (settings.daemonToken) return { paired: true };
  if (!settings.daemonUrl) return { paired: false, reason: 'unreachable' };

  const result = await attemptPairing(settings.daemonUrl);
  if (!result.ok) return { paired: false, reason: result.reason };

  await updateSettings({ daemonToken: result.token });
  log('auto-paired with daemon');
  return { paired: true };
}

async function pairOrCheckHealth(): Promise<void> {
  const settings = await getSettings();
  if (!settings.daemonToken) {
    await tryPairNow();
    return;
  }
  await checkDaemonHealth(settings.daemonUrl);
}

/**
 * Pairing only ever reflects that a token was *once* obtained — nothing rechecks liveness after
 * that, so a crashed daemon or a stopped launchd/systemd service would otherwise leave
 * `Settings.tsx` showing "Connected automatically" forever. `/health` is deliberately
 * unauthenticated (auth.ts), so this can't distinguish "daemon down" from "wrong token" — that's
 * fine here, this is a liveness signal, not a token check (the options page's existing "Test
 * connection" button already covers the authed case). Recorded in `db.meta`, the same
 * general-purpose KV table already used for `orgId` and alert state.
 */
async function checkDaemonHealth(daemonUrl: string): Promise<void> {
  let ok: boolean;
  try {
    const response = await fetch(`${daemonUrl}/health`);
    ok = response.ok;
  } catch {
    ok = false;
  }
  const health: DaemonHealth = { ok, checkedAt: new Date().toISOString() };
  await db.meta.put({ key: 'daemonHealth', value: JSON.stringify(health) });
}

async function getStoredDaemonHealth(): Promise<DaemonHealth | null> {
  const stored = await db.meta.get('daemonHealth');
  return stored ? (JSON.parse(stored.value) as DaemonHealth) : null;
}

async function pollUsage(): Promise<void> {
  const cached = await db.meta.get('orgId');
  if (!cached) {
    log('poll skipped — no org id known yet (visit claude.ai once)');
    return;
  }

  try {
    const response = await fetch(`https://claude.ai/api/organizations/${cached.value}/usage`, {
      credentials: 'include',
    });
    if (!response.ok) {
      log('poll fetch failed', response.status);
      return;
    }
    const raw: unknown = await response.json();
    const capturedAt = new Date().toISOString();
    await db.rawRecords.add({ endpoint: 'usage', capturedAt, raw });
    await normalizeAndStoreUsage(raw, capturedAt);
    log('poll captured a fresh usage snapshot');
  } catch (error) {
    log('poll fetch threw', error);
  }
}

/**
 * Purchased/promotional credit balance — a separate endpoint from `/usage`, polled on the same
 * tick. Stored as a single JSON snapshot in `db.meta` (key `prepaidCredits`) rather than an
 * appended `limitSnapshots`-style history: unlike a limit bar, a credit balance has no "history
 * over the reset window" worth charting, only a current value.
 */
async function pollPrepaidCredits(): Promise<void> {
  const cached = await db.meta.get('orgId');
  if (!cached) return;

  try {
    const response = await fetch(`https://claude.ai/api/organizations/${cached.value}/prepaid/credits`, {
      credentials: 'include',
    });
    if (!response.ok) {
      log('prepaid credits poll fetch failed', response.status);
      return;
    }
    const raw: unknown = await response.json();
    const result = prepaidCreditsResponseSchema.safeParse(raw);
    if (!result.success) {
      log('prepaid credits payload failed schema validation, skipping snapshot', result.error.issues.slice(0, 3));
      return;
    }
    const snapshot = normalizePrepaidCredits(result.data, new Date().toISOString());
    await db.meta.put({ key: 'prepaidCredits', value: JSON.stringify(snapshot) });
    await checkPromoCreditsExpiring(snapshot);
    log('polled prepaid credits', snapshot.balanceAmount);
  } catch (error) {
    log('prepaid credits poll fetch threw', error);
  }
}

const PROMO_EXPIRY_WARNING_DAYS = 7;

/** Warns once per promo tranche (keyed by its own `expiresAt`, so a new grant re-arms the alert)
 *  as it enters its final week — the money is otherwise silently lost with no reminder anywhere
 *  in claude.ai's own UI outside this settings page. */
async function checkPromoCreditsExpiring(snapshot: PrepaidCreditsSnapshot): Promise<void> {
  const soonest = soonestExpiringPromoTranche(snapshot);
  if (!soonest) return;

  const daysLeft = (new Date(soonest.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (daysLeft < 0 || daysLeft > PROMO_EXPIRY_WARNING_DAYS) return;

  const settings = await getSettings();
  const fired = await notifyOnce(`promoCreditsExpiringAlerted:${soonest.expiresAt}`, settings, {
    title: 'Claude usage: promotional credit expiring soon',
    message: `$${soonest.remainingAmount.toFixed(2)} in promotional credit expires ${formatResetLabel(soonest.expiresAt)}.`,
  });
  if (fired) log('promo credits expiring alert fired', soonest.expiresAt, soonest.remainingAmount);
}

async function normalizeAndStoreUsage(raw: unknown, capturedAt: string): Promise<void> {
  const result = usageResponseSchema.safeParse(raw);
  if (!result.success) {
    // claude.ai's shape moved out from under the schema — log and skip this snapshot rather
    // than throw. A proper "data shape changed" UI indicator is follow-up work.
    log(
      'usage payload failed schema validation, skipping snapshot',
      result.error.issues.slice(0, 3),
    );
    return;
  }
  await storeSnapshotAndReact(normalizeUsageResponse(result.data, capturedAt));
}

/** `message_limit` SSE events (only fire while actively chatting) carry exact, unrounded
 *  utilization fractions — more precise than /usage's already-rounded integer percent. See
 *  `upgradeSnapshotFromMessageLimit`'s doc comment for exactly what is and isn't upgraded. */
async function normalizeAndStoreMessageLimit(raw: unknown, capturedAt: string): Promise<void> {
  const result = messageLimitEventSchema.safeParse(raw);
  if (!result.success) {
    log(
      'message_limit payload failed schema validation, skipping snapshot',
      result.error.issues.slice(0, 3),
    );
    return;
  }
  const previous = (await db.limitSnapshots.orderBy('capturedAt').last()) ?? null;
  const snapshot = upgradeSnapshotFromMessageLimit(result.data.message_limit, previous, capturedAt);
  if (!snapshot) {
    log('message_limit event carried no window data (overage branch), skipping snapshot');
    return;
  }
  await storeSnapshotAndReact(snapshot);
}

/** claude.ai/code's `rate_limit_event` — the same role as `message_limit` above, but for
 *  Claude Code on the web sessions instead of claude.ai chat. See
 *  `upgradeSnapshotFromCodeRateLimitEvent`'s doc comment for what is and isn't upgraded. */
async function normalizeAndStoreCodeRateLimitEvent(raw: unknown, capturedAt: string): Promise<void> {
  const result = rateLimitEventSchema.safeParse(raw);
  if (!result.success) {
    log(
      'rate_limit_event payload failed schema validation, skipping snapshot',
      result.error.issues.slice(0, 3),
    );
    return;
  }
  const previous = (await db.limitSnapshots.orderBy('capturedAt').last()) ?? null;
  const snapshot = upgradeSnapshotFromCodeRateLimitEvent(
    result.data.payload.rate_limit_info,
    previous,
    capturedAt,
  );
  if (!snapshot) {
    log('rate_limit_event carried no window data, skipping snapshot');
    return;
  }
  await storeSnapshotAndReact(snapshot);
}

async function storeSnapshotAndReact(snapshot: LimitSnapshot): Promise<void> {
  const id = await db.limitSnapshots.add(snapshot);
  log('stored limit snapshot', id, snapshot.source, snapshot.session?.percent, snapshot.weekly?.percent);
  await pruneOldSnapshots();
  await checkThresholdAlerts(snapshot);
  await pushBadgeUpdate(snapshot);
}

function toBadgeSnapshot(snapshot: LimitSnapshot): BadgeSnapshot {
  return { session: snapshot.session, weekly: snapshot.weekly, capturedAt: snapshot.capturedAt };
}

/** Pushes to every open claude.ai tab's badge content script — it can't share the extension's
 *  IndexedDB (see protocol.ts's `badgeUpdate` doc), so it can't just watch Dexie itself.
 *  `sendToTabIgnoringMissingReceiver` (not `extensionMessenger.sendMessage(..., tab.id)`)
 *  specifically to avoid a Chrome "Unchecked runtime.lastError" log entry for every tab without
 *  a currently-mounted badge (still loading, disabled, or just closed) — see its doc comment. */
async function pushBadgeUpdate(snapshot: LimitSnapshot): Promise<void> {
  const settings = await getSettings();
  if (!settings.badgeEnabled) return;

  const payload = toBadgeSnapshot(snapshot);
  const tabs = await browser.tabs.query({ url: 'https://claude.ai/*' });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    sendToTabIgnoringMissingReceiver('badgeUpdate', payload, tab.id);
  }
}

async function pruneOldSnapshots(): Promise<void> {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - settings.snapshotRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const deleted = await db.limitSnapshots.where('capturedAt').below(cutoff).delete();
  if (deleted > 0) log('pruned old limit snapshots', deleted);
}

async function checkThresholdAlerts(snapshot: LimitSnapshot): Promise<void> {
  const settings = await getSettings();
  await checkBarAlert('session', 'Session (5h)', snapshot.session, settings);
  await checkBarAlert('weekly', 'Weekly', snapshot.weekly, settings);
}

/** The one place that actually calls `browser.notifications.create` — every check below builds
 *  a title/message and decides for itself whether this is a good time to notify, but none of
 *  them need to know what a notification object looks like. */
async function sendNotification(title: string, message: string): Promise<void> {
  await browser.notifications.create({ type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title, message });
}

/**
 * Fires a notification at most once per `metaKey`, honoring quiet hours. If the key is already
 * recorded, or `now` falls inside quiet hours, this is a no-op that leaves state untouched —
 * quiet hours are meant to delay a suppressed alert to the next check, not lose it. Fits any
 * alert whose dedup is "have I ever fired for this exact key" (a CLI budget for a given month, a
 * specific anomalous session) — `checkBarAlert` below needs its own logic instead, since
 * "crossed a threshold" has to compare against the *previous* crossing, not just check a key's
 * existence.
 */
async function notifyOnce(metaKey: string, settings: Settings, notification: { title: string; message: string }): Promise<boolean> {
  if (await db.meta.get(metaKey)) return false;
  if (isWithinQuietHours(new Date(), settings)) return false;

  await db.meta.put({ key: metaKey, value: 'true' });
  await sendNotification(notification.title, notification.message);
  return true;
}

async function checkBarAlert(
  key: 'session' | 'weekly',
  label: string,
  bar: LimitBar | null,
  settings: Settings,
): Promise<void> {
  if (!bar) return;

  const metaKey = `alertState:${key}`;
  const stored = await db.meta.get(metaKey);
  const lastAlert: AlertState | null = stored ? (JSON.parse(stored.value) as AlertState) : null;

  const crossed = thresholdCrossed(bar, lastAlert, settings.alertThresholds);
  if (crossed === null) return;

  // Checked *after* deciding a threshold was crossed but *before* persisting dedup state: a
  // suppressed alert isn't lost, it just fires on the next check once quiet hours end, since
  // `thresholdCrossed` will still see the same not-yet-recorded crossing then.
  if (isWithinQuietHours(new Date(), settings)) return;

  await db.meta.put({ key: metaKey, value: JSON.stringify({ resetsAt: bar.resetsAt, threshold: crossed }) });
  await sendNotification(`Claude usage: ${label} at ${crossed}%+`, `${bar.percent}% used — resets ${formatResetLabel(bar.resetsAt)}.`);
  log('threshold alert fired', key, crossed, bar.percent);
}

/**
 * A self-set $ budget, independent of `alertThresholds` (which only ever tracks claude.ai's own
 * plan-limit percentages, never $ CLI cost) — lets someone say "tell me if my CLI spend crosses
 * $50 this month" using the same figure CLI Attribution already shows. No-ops with no budget set
 * or no daemon configured, same "daemon is optional" gating every other daemon-backed feature
 * already has. The dedup key includes the calendar month, so it naturally re-arms next month
 * with no cleanup needed.
 */
function currentMonthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function checkCliBudget(): Promise<void> {
  const settings = await getSettings();
  if (settings.cliMonthlyBudget === null || !settings.daemonUrl || !settings.daemonToken) return;

  const now = new Date();
  const since = formatCcusageDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const result = await getDaemonDaily(settings, { since });
  if (!result.ok) return;

  const spent = result.data.totals.totalCost;
  if (spent < settings.cliMonthlyBudget) return;

  const fired = await notifyOnce(`cliBudgetAlerted:${currentMonthKey(now)}`, settings, {
    title: 'Claude usage: CLI budget exceeded',
    message: `$${spent.toFixed(2)} spent this month via the CLI — over your $${settings.cliMonthlyBudget.toFixed(2)} budget.`,
  });
  if (fired) log('CLI budget alert fired', spent, settings.cliMonthlyBudget);
}

/**
 * Per-project variant of `checkCliBudget` — additive, not a replacement. Fetches `/aggregate?
 * by=project` **once** and shares it across every configured project rather than one fetch per
 * project. Converts each real `projectDir` to ccusage's own slug form (`/` -> `-`, the same
 * transform Claude Code applies when naming a project's session-log directory) to look it up in
 * the response — only ever real-path -> slug, never the other direction (a literal `-` in a real
 * directory name would make reversing it ambiguous).
 */
async function checkPerProjectCliBudgets(): Promise<void> {
  const settings = await getSettings();
  if (settings.perProjectCliBudgets.length === 0 || !settings.daemonUrl || !settings.daemonToken) return;

  const now = new Date();
  const since = formatCcusageDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const result = await getDaemonByProject(settings, { since });
  if (!result.ok) return;

  const monthKey = currentMonthKey(now);
  for (const entry of settings.perProjectCliBudgets) {
    const slug = entry.projectDir.replace(/\//g, '-');
    const days = result.data.projects[slug];
    if (!days) continue;

    const spent = days.reduce((sum, d) => sum + d.totalCost, 0);
    if (spent < entry.monthlyBudget) continue;

    const fired = await notifyOnce(`cliBudgetAlerted:${slug}:${monthKey}`, settings, {
      title: 'Claude usage: project CLI budget exceeded',
      message: `${entry.projectDir}: $${spent.toFixed(2)} spent this month — over your $${entry.monthlyBudget.toFixed(2)} budget.`,
    });
    if (fired) log('per-project CLI budget alert fired', entry.projectDir, spent, entry.monthlyBudget);
  }
}

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Opt-in weekly summary notification. Built primarily from `db.limitSnapshots` (always local, no
 * daemon needed) so it's useful to every user, not just the subset who've installed the daemon —
 * matches this project's own "daemon is optional" principle. If the daemon *is* configured,
 * appends a second line with CLI tokens/cost for the week. Fires on whichever `POLL_ALARM_NAME`
 * tick first lands at least 7 days after the last one — not a precise weekly cron, just "roughly
 * once a week", which is all a digest needs to be.
 */
async function checkWeeklyDigest(): Promise<void> {
  const settings = await getSettings();
  if (!settings.weeklyDigestEnabled) return;

  const lastSentAt = await db.meta.get('lastWeeklyDigestAt');
  const now = Date.now();
  if (lastSentAt && now - new Date(lastSentAt.value).getTime() < DIGEST_INTERVAL_MS) return;

  const weekAgoIso = new Date(now - DIGEST_INTERVAL_MS).toISOString();
  const weekSnapshots = await db.limitSnapshots.where('capturedAt').aboveOrEqual(weekAgoIso).toArray();
  if (weekSnapshots.length === 0) return; // nothing to report yet — don't send an empty digest

  const peakPercent = (key: 'session' | 'weekly') => Math.max(0, ...weekSnapshots.map((s) => s[key]?.percent ?? 0));
  const lines = [`Peak session: ${Math.round(peakPercent('session'))}% · Peak weekly: ${Math.round(peakPercent('weekly'))}%`];

  if (settings.daemonUrl && settings.daemonToken) {
    const since = formatCcusageDate(new Date(now - DIGEST_INTERVAL_MS));
    const daily = await getDaemonDaily(settings, { since });
    if (daily.ok) {
      lines.push(`CLI: ${formatTokens(daily.data.totals.totalTokens)} tokens, $${daily.data.totals.totalCost.toFixed(2)}`);
    }
  }

  if (isWithinQuietHours(new Date(now), settings)) return;

  await db.meta.put({ key: 'lastWeeklyDigestAt', value: new Date(now).toISOString() });
  await sendNotification('Your weekly Claude usage', lines.join('\n'));
  log('weekly digest sent', lines);
}

const ANOMALY_MIN_COST_FLOOR = 2;

/**
 * Notifies once per session whose cost is far outside the norm for the account's recent
 * sessions — usually a stuck/looping agent rather than unusually valuable work. Shares the same
 * `findAnomalousSessions` heuristic the "Priciest sessions" table uses to mark rows, so the
 * notification and the UI never disagree about what counts as anomalous. Dedup is permanent per
 * `sessionId` (not per-month like the budget alerts) — a session's cost only grows while it's
 * active, so once flagged it stays flagged, no need to ever re-alert on it.
 */
async function checkSessionAnomalies(sessions: DaemonSession[], settings: Settings): Promise<void> {
  for (const session of findAnomalousSessions(sessions, { minFloor: ANOMALY_MIN_COST_FLOOR })) {
    const fired = await notifyOnce(`anomalyAlerted:${session.sessionId}`, settings, {
      title: 'Claude usage: unusually high session cost',
      message: `${session.projectPath}: $${session.totalCost.toFixed(2)} in one session — see Top Usage for details.`,
    });
    if (fired) log('session anomaly alert fired', session.sessionId, session.totalCost);
  }
}

/**
 * A single small "is anything worth my attention?" count on the toolbar icon, aggregating
 * signals that would otherwise only surface if the user happened to open the right dashboard
 * tab: sessions nearing Claude Code's 30-day log cleanup, and any CLI budget (global or
 * per-project) currently exceeded this month. Deliberately excludes Guardrails config drift —
 * checking that for every known project on every 5-minute poll would mean a `/config` fetch per
 * project, too much daemon load for a background badge. Fetches `/sessions` once and reuses it
 * for both the retention count and the anomaly check above, rather than fetching twice.
 */
async function checkSessionsAndBadge(): Promise<void> {
  const settings = await getSettings();
  if (!settings.daemonUrl || !settings.daemonToken) {
    await setBadgeText('');
    return;
  }

  const sessionsResult = await getDaemonSessions(settings);
  const sessions = sessionsResult.ok ? sessionsResult.data.sessions : [];

  await checkSessionAnomalies(sessions, settings);

  const retentionCount = findRetentionWarnings(sessions).length;
  const monthKey = currentMonthKey();
  const globalBudgetExceeded = settings.cliMonthlyBudget !== null && Boolean(await db.meta.get(`cliBudgetAlerted:${monthKey}`));
  let perProjectBudgetsExceeded = 0;
  for (const entry of settings.perProjectCliBudgets) {
    const slug = entry.projectDir.replace(/\//g, '-');
    if (await db.meta.get(`cliBudgetAlerted:${slug}:${monthKey}`)) perProjectBudgetsExceeded++;
  }

  const count = retentionCount + (globalBudgetExceeded ? 1 : 0) + perProjectBudgetsExceeded;
  await setBadgeText(count > 0 ? String(count) : '');
  if (count > 0) await setBadgeBackgroundColor('#d64545');
}
