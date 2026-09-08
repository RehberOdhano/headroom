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
import { extensionMessenger, sendToTabIgnoringMissingReceiver } from '../lib/messaging.js';
import { db } from '../lib/db.js';
import { thresholdCrossed, type AlertState } from '../lib/alerts.js';
import { formatResetLabel } from '../lib/format.js';
import { attemptPairing } from '../lib/pairing.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import type { BadgeSnapshot, PairingStatus } from '../lib/protocol.js';

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

  // Keeps bars fresh without requiring the user to visit claude.ai's Settings > Usage page —
  // that page is the *only* place claude.ai's own frontend fetches /usage, so without this
  // the extension would otherwise stay silent until the user happened to land there.
  browser.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  // Auto-pairing (lib/pairing.ts): keeps trying until a token is configured, so a user who
  // never opens the options page still ends up connected once the daemon is installed —
  // tryPairNow() itself is a no-op fetch-wise once daemonToken is already set.
  browser.alarms.create(PAIR_ALARM_NAME, { periodInMinutes: PAIR_INTERVAL_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM_NAME) void pollUsage();
    if (alarm.name === PAIR_ALARM_NAME) void tryPairNow();
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
  await checkBarAlert('session', 'Session (5h)', snapshot.session, settings.alertThresholds);
  await checkBarAlert('weekly', 'Weekly', snapshot.weekly, settings.alertThresholds);
}

async function checkBarAlert(
  key: 'session' | 'weekly',
  label: string,
  bar: LimitBar | null,
  thresholds: number[],
): Promise<void> {
  if (!bar) return;

  const metaKey = `alertState:${key}`;
  const stored = await db.meta.get(metaKey);
  const lastAlert: AlertState | null = stored ? (JSON.parse(stored.value) as AlertState) : null;

  const crossed = thresholdCrossed(bar, lastAlert, thresholds);
  if (crossed === null) return;

  await db.meta.put({ key: metaKey, value: JSON.stringify({ resetsAt: bar.resetsAt, threshold: crossed }) });
  await browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: `Claude usage: ${label} at ${crossed}%+`,
    message: `${bar.percent}% used — resets ${formatResetLabel(bar.resetsAt)}.`,
  });
  log('threshold alert fired', key, crossed, bar.percent);
}
