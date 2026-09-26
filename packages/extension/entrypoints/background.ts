import {
  messageLimitEventSchema,
  normalizeUsageResponse,
  rateLimitEventSchema,
  upgradeSnapshotFromCodeRateLimitEvent,
  upgradeSnapshotFromMessageLimit,
  usageResponseSchema,
  type LimitBar,
  type LimitSnapshot,
} from '@headroom/shared';
import { setBadgeBackgroundColor, setBadgeText } from '../lib/action-badge.js';
import { extensionMessenger, sendToTabIgnoringMissingReceiver } from '../lib/messaging.js';
import { db, type RawRecord } from '../lib/db.js';
import { thresholdCrossed, type AlertState } from '../lib/alerts.js';
import { barHistory } from '../lib/history.js';
import { paceAlertFor } from '../lib/pace-alert.js';
import { formatResetLabel } from '../lib/format.js';
import { getDaemonSessions } from '../lib/daemon-client.js';
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
    const id = await storeRawRecord(message.data);
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
  // Onboarding: a first install lands on the options page's setup checklist instead of leaving
  // the user to guess what to do next. Updates deliberately don't — they get the dashboard's
  // one-time "what's new" banner instead.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') void browser.runtime.openOptionsPage();
    // Versions before the what's-new banner never recorded `lastSeenVersion`, so without this an
    // upgrading user would look exactly like a fresh install and never see the notes. The
    // previous version is the truthful "last seen" here.
    if (details.reason === 'update' && details.previousVersion) void recordPreviousVersion(details.previousVersion);
  });
  browser.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  // Auto-pairing (lib/pairing.ts): keeps trying until a token is configured, so a user who
  // never opens the options page still ends up connected once the daemon is installed —
  // tryPairNow() itself is a no-op fetch-wise once daemonToken is already set.
  browser.alarms.create(PAIR_ALARM_NAME, { periodInMinutes: PAIR_INTERVAL_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM_NAME) {
      void pollUsage();
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

async function recordPreviousVersion(previousVersion: string): Promise<void> {
  if (!(await db.meta.get('lastSeenVersion'))) await db.meta.put({ key: 'lastSeenVersion', value: previousVersion });
}

async function pollUsage(): Promise<void> {
  const cached = await db.meta.get('orgId');
  if (!cached) {
    log('poll skipped — no org id known yet (open claude.ai Settings > Usage once)');
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
    await storeRawRecord({ endpoint: 'usage', capturedAt, raw });
    await normalizeAndStoreUsage(raw, capturedAt);
    log('poll captured a fresh usage snapshot');
  } catch (error) {
    log('poll fetch threw', error);
  }
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
  await checkPaceAlerts(snapshot);
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

/** Raw captures only feed the options page's "Export fixtures" (schema-building samples), so a
 *  recent handful is plenty — without a cap, every 5-minute poll stored another full /usage body
 *  forever. Also trims the backlog on installs that predate the cap, on their next capture. */
const MAX_RAW_RECORDS = 50;

async function storeRawRecord(record: Omit<RawRecord, 'id'>): Promise<number | undefined> {
  const id = await db.rawRecords.add(record);
  const excess = (await db.rawRecords.count()) - MAX_RAW_RECORDS;
  if (excess > 0) {
    await db.rawRecords.bulkDelete(await db.rawRecords.orderBy('capturedAt').limit(excess).primaryKeys());
  }
  return id;
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

/** Opt-in forecast-based heads-up — see lib/pace-alert.ts for what qualifies. Only the current
 *  run matters to the forecast, so a bounded recent slice of history is enough. */
async function checkPaceAlerts(snapshot: LimitSnapshot): Promise<void> {
  const settings = await getSettings();
  if (!settings.paceAlertEnabled) return;

  const recent = await db.limitSnapshots.orderBy('capturedAt').reverse().limit(100).toArray();
  const bars = [
    { key: 'session', label: 'Session (5h)', bar: snapshot.session },
    { key: 'weekly', label: 'Weekly', bar: snapshot.weekly },
  ] as const;
  for (const { key, label, bar } of bars) {
    const alert = paceAlertFor(label, bar, barHistory(recent, key));
    if (alert) await notifyOnce(`paceAlerted:${key}:${alert.windowKey}`, alert);
  }
}

/** The one place that actually calls `browser.notifications.create` — every check below builds
 *  a title/message and decides for itself whether this is a good time to notify, but none of
 *  them need to know what a notification object looks like. */
async function sendNotification(title: string, message: string): Promise<void> {
  await browser.notifications.create({ type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title, message });
}

/**
 * Fires a notification at most once per `metaKey` (a limit window, here). Fits any alert whose
 * dedup is "have I ever fired for this exact key" — `checkBarAlert` below needs its own logic
 * instead, since "crossed a threshold" has to compare against the *previous* crossing, not just
 * check a key's existence.
 */
async function notifyOnce(metaKey: string, notification: { title: string; message: string }): Promise<boolean> {
  if (await db.meta.get(metaKey)) return false;

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

  await db.meta.put({ key: metaKey, value: JSON.stringify({ resetsAt: bar.resetsAt, threshold: crossed }) });
  await sendNotification(`Claude usage: ${label} at ${crossed}%+`, `${bar.percent}% used — resets ${formatResetLabel(bar.resetsAt)}.`);
  log('threshold alert fired', key, crossed, bar.percent);
}

/**
 * A single small "is anything worth my attention?" count on the toolbar icon, aggregating
 * signals that would otherwise only surface if the user happened to open the right dashboard
 * tab: sessions nearing Claude Code's 30-day log cleanup. Deliberately excludes Guardrails config drift —
 * checking that for every known project on every 5-minute poll would mean a `/config` fetch per
 * project, too much daemon load for a background badge.
 */
async function checkSessionsAndBadge(): Promise<void> {
  const settings = await getSettings();
  if (!settings.daemonUrl || !settings.daemonToken) {
    await setBadgeText('');
    return;
  }

  const sessionsResult = await getDaemonSessions(settings);
  const sessions = sessionsResult.ok ? sessionsResult.data.sessions : [];

  const count = findRetentionWarnings(sessions).length;
  await setBadgeText(count > 0 ? String(count) : '');
  if (count > 0) await setBadgeBackgroundColor('#d64545');
}
