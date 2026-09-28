import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';
import { daemonSession, zeroTotals } from './helpers.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claude-ai',
);

function loadUsageFixture(name: string): unknown {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  return body;
}

/** Same fixture, with the session bar's percent (and optionally resets_at) overridden — lets
 *  threshold-alert tests drive specific crossings without hand-building a whole usage payload. */
function usageFixtureWithSessionPercent(percent: number, resetsAt?: string): Record<string, unknown> {
  const body = loadUsageFixture('usage.get.overage.json') as { limits: { kind: string; percent: number; resets_at: string }[] };
  const session = body.limits.find((entry) => entry.kind === 'session')!;
  session.percent = percent;
  if (resetsAt) session.resets_at = resetsAt;
  return body;
}

function loadMessageLimitFixture(name: string): unknown {
  const text = readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  const dataLine = text.split('\n').find((line) => line.startsWith('data:') && line.includes('message_limit'));
  if (!dataLine) throw new Error(`no message_limit data line in ${name}`);
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

function loadRateLimitEventFixture(name: string): unknown {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  return body;
}

describe('background', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    backgroundDefinition.main();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a captured payload relayed from a content script', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: { five_hour: { utilization: 39 } },
    });

    const records = await db.rawRecords.toArray();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: { five_hour: { utilization: 39 } },
    });
  });

  it('on an update, records the previous version so the what\'s-new banner can tell an upgrade from a fresh install', async () => {
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.1.4' } as never);
    await vi.waitFor(async () => expect((await db.meta.get('lastSeenVersion'))?.value).toBe('0.1.4'));
  });

  it('on an update, does not overwrite a version the banner already recorded', async () => {
    await db.meta.put({ key: 'lastSeenVersion', value: '0.2.0' });
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.1.4' } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await db.meta.get('lastSeenVersion'))?.value).toBe('0.2.0');
  });

  it('caps stored raw captures, dropping the oldest', async () => {
    for (let i = 0; i < 53; i++) {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: new Date(Date.now() - (60 - i) * 60_000).toISOString(),
        raw: { seq: i },
      });
    }
    const records = await db.rawRecords.orderBy('capturedAt').toArray();
    expect(records).toHaveLength(50);
    expect((records[0]!.raw as { seq: number }).seq).toBe(3);
  });

  it('stores multiple captures independently', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: {},
    });
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'message_limit',
      capturedAt: '2026-08-26T17:23:32Z',
      raw: {},
    });

    const records = await db.rawRecords.toArray();
    expect(records.map((r) => r.endpoint).sort()).toEqual(['message_limit', 'usage']);
  });

  it('normalizes a valid usage capture into a limit snapshot', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: loadUsageFixture('usage.get.overage.json'),
    });

    const snapshots = await db.limitSnapshots.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      capturedAt: '2026-08-26T17:20:00Z',
      session: { percent: 39 },
      weekly: { percent: 31 },
    });
  });

  it('does not create a snapshot (and does not throw) for a usage payload that fails validation', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: { not: 'a real usage response' },
    });

    const snapshots = await db.limitSnapshots.toArray();
    expect(snapshots).toHaveLength(0);
    // The raw capture is still stored — only normalization is skipped.
    const records = await db.rawRecords.toArray();
    expect(records).toHaveLength(1);
  });

  it('records a usageParseError breadcrumb when a usage payload fails validation, so the UI can tell that apart from just not having captured anything yet', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: { not: 'a real usage response' },
    });

    const error = await db.meta.get('usageParseError');
    expect(error).toBeTruthy();
    expect(JSON.parse(error!.value)).toMatchObject({ capturedAt: '2026-08-26T17:20:00Z' });
  });

  it('clears a prior usageParseError once a later usage payload parses successfully', async () => {
    await db.meta.put({ key: 'usageParseError', value: JSON.stringify({ capturedAt: 'earlier' }) });

    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: loadUsageFixture('usage.get.overage.json'),
    });

    expect(await db.meta.get('usageParseError')).toBeUndefined();
  });

  it('does not normalize message_limit captures (v1 scope: usage-only bars)', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'message_limit',
      capturedAt: '2026-08-26T17:23:32Z',
      raw: { anything: true },
    });

    const snapshots = await db.limitSnapshots.toArray();
    expect(snapshots).toHaveLength(0);
  });

  it('caches the org id from a captured payload', async () => {
    await extensionMessenger.sendMessage('captured', {
      endpoint: 'usage',
      capturedAt: '2026-08-26T17:20:00Z',
      raw: {},
      orgId: 'org-123',
    });

    expect(await db.meta.get('orgId')).toEqual({ key: 'orgId', value: 'org-123' });
  });

  describe('refreshUsage', () => {
    it('does nothing (and does not throw) when no org id is known yet', async () => {
      await extensionMessenger.sendMessage('refreshUsage');

      expect(await db.rawRecords.count()).toBe(0);
      expect(await db.limitSnapshots.count()).toBe(0);
    });

    it('fetches /usage for the cached org id and stores + normalizes the result', async () => {
      await db.meta.put({ key: 'orgId', value: 'org-123' });
      const usageBody = loadUsageFixture('usage.get.overage.json');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(usageBody),
      } as Response);

      await extensionMessenger.sendMessage('refreshUsage');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://claude.ai/api/organizations/org-123/usage',
        expect.objectContaining({ credentials: 'include' }),
      );
      const records = await db.rawRecords.toArray();
      expect(records).toHaveLength(1);
      expect(records[0]?.endpoint).toBe('usage');
      const snapshots = await db.limitSnapshots.toArray();
      expect(snapshots[0]).toMatchObject({ session: { percent: 39 }, weekly: { percent: 31 } });
    });

    it('does not throw and stores nothing if the poll fetch fails', async () => {
      await db.meta.put({ key: 'orgId', value: 'org-123' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response);

      await extensionMessenger.sendMessage('refreshUsage');

      expect(await db.rawRecords.count()).toBe(0);
    });
  });

  describe('attemptPairing', () => {
    it('POSTs /pair, stores the returned token, and reports paired: true', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ token: 'paired-token' }),
      } as Response);

      const result = await extensionMessenger.sendMessage('attemptPairing');

      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/pair', { method: 'POST' });
      expect(result).toEqual({ paired: true });
      expect((await extensionMessenger.sendMessage('getSettings')).daemonToken).toBe('paired-token');
    });

    it('is a no-op — does not fetch — once a token is already configured', async () => {
      await extensionMessenger.sendMessage('updateSettings', { daemonToken: 'existing-token' });
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      const result = await extensionMessenger.sendMessage('attemptPairing');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({ paired: true });
    });

    it('reports already_paired without touching settings when the daemon rejects it', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'already_paired' }),
      } as Response);

      const result = await extensionMessenger.sendMessage('attemptPairing');

      expect(result).toEqual({ paired: false, reason: 'already_paired' });
      expect((await extensionMessenger.sendMessage('getSettings')).daemonToken).toBe('');
    });

    it('reports unreachable when the daemon cannot be reached at all', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await extensionMessenger.sendMessage('attemptPairing');

      expect(result).toEqual({ paired: false, reason: 'unreachable' });
    });
  });

  describe('daemon health check', () => {
    const PAIR_ALARM_NAME = 'headroom-attempt-pairing';

    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
      });
    });

    it('returns null before any check has ever run', async () => {
      expect(await extensionMessenger.sendMessage('getDaemonHealth')).toBeNull();
    });

    it('records a reachable check via the pairing alarm once already paired', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);

      await fakeBrowser.alarms.onAlarm.trigger({ name: PAIR_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(async () => {
        const health = await extensionMessenger.sendMessage('getDaemonHealth');
        expect(health?.ok).toBe(true);
      });
    });

    it('records unreachable when the daemon cannot be reached', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await fakeBrowser.alarms.onAlarm.trigger({ name: PAIR_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(async () => {
        const health = await extensionMessenger.sendMessage('getDaemonHealth');
        expect(health?.ok).toBe(false);
      });
    });

    it('does not touch /health while still unpaired — the alarm only retries pairing', async () => {
      await extensionMessenger.sendMessage('updateSettings', { daemonToken: '' });
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await fakeBrowser.alarms.onAlarm.trigger({ name: PAIR_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/pair', { method: 'POST' });
      });
      expect(await extensionMessenger.sendMessage('getDaemonHealth')).toBeNull();
    });
  });

  describe('attention badge', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    it('clears the badge when the daemon is not configured', async () => {
      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(async () => {
        expect(await fakeBrowser.action.getBadgeText({})).toBe('');
      });
    });

    it('counts sessions nearing the retention cleanup window', async () => {
      await extensionMessenger.sendMessage('updateSettings', { daemonToken: 'existing-token', daemonUrl: 'http://127.0.0.1:4317' });
      const nearlyExpired = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString(); // ~3 days left of 30

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/sessions')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              sessions: [
                {
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                  firstActivity: nearlyExpired,
                  inputTokens: 0,
                  lastActivity: nearlyExpired,
                  modelBreakdowns: [],
                  modelsUsed: [],
                  outputTokens: 0,
                  projectPath: '-fixture-project',
                  sessionId: 's1',
                  totalCost: 1,
                  totalTokens: 100,
                },
              ],
              totals: zeroTotals,
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(async () => {
        expect(await fakeBrowser.action.getBadgeText({})).toBe('1');
      });
    });
  });

  describe('pace alerts', () => {
    const HOUR = 3_600_000;
    const resetsAt = () => new Date(Date.now() + 8 * HOUR).toISOString();

    /** Four earlier snapshots at 10/20/30/40% an hour apart — with the 50% capture below, a
     *  steady 10%/hour run projecting ~5h to full, well before the 8h-away reset. */
    async function seedSteepRun() {
      for (const [hoursAgo, percent] of [[4, 10], [3, 20], [2, 30], [1, 40]] as const) {
        await db.limitSnapshots.add({
          capturedAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
          source: 'usage',
          session: { percent, resetsAt: resetsAt(), severity: 'normal', isActive: true },
          weekly: null,
        });
      }
    }
    const capture = (percent: number) =>
      extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: new Date().toISOString(),
        raw: usageFixtureWithSessionPercent(percent, resetsAt()),
      });

    it('is off by default', async () => {
      await seedSteepRun();
      await capture(50);
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('warns once per window when on pace to run out before the reset', async () => {
      await extensionMessenger.sendMessage('updateSettings', { paceAlertEnabled: true });
      await seedSteepRun();
      await capture(50);

      const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ title: expect.stringContaining('on pace to run out') });

      await capture(52);
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
    });
  });

  describe('threshold alerts', () => {
    it('does not notify below the lowest threshold', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(50),
      });

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('notifies once a bar crosses a threshold', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(85),
      });

      const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ title: expect.stringContaining('80%+') });
    });

    it('does not re-notify the same threshold on a later poll in the same window', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(85),
      });
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:25:00Z',
        raw: usageFixtureWithSessionPercent(88),
      });

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
    });

    it('notifies again for a higher threshold crossed in the same window', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(85),
      });
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:25:00Z',
        raw: usageFixtureWithSessionPercent(97),
      });

      const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
      expect(created).toHaveLength(2);
      expect(created[1]).toMatchObject({ title: expect.stringContaining('95%+') });
    });

    it('allows a threshold to fire again once the window has actually reset', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(97),
      });
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T20:00:00Z',
        raw: usageFixtureWithSessionPercent(85, '2026-08-27T00:00:00.000000+00:00'),
      });

      const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
      expect(created).toHaveLength(2);
      expect(created[1]).toMatchObject({ title: expect.stringContaining('80%+') });
    });
  });

  describe('badge', () => {
    it('getBadgeSnapshot returns null before any snapshot exists', async () => {
      const result = await extensionMessenger.sendMessage('getBadgeSnapshot');
      expect(result).toBeNull();
    });

    it('getBadgeSnapshot returns the latest bars after a capture', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: loadUsageFixture('usage.get.overage.json'),
      });

      const result = await extensionMessenger.sendMessage('getBadgeSnapshot');
      expect(result).toMatchObject({ session: { percent: 39 }, weekly: { percent: 31 } });
    });

    it('does not query tabs to push a badge update when the badge is disabled', async () => {
      await extensionMessenger.sendMessage('updateSettings', { badgeEnabled: false });
      const queryTabs = vi.spyOn(browser.tabs, 'query');

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: loadUsageFixture('usage.get.overage.json'),
      });

      expect(queryTabs).not.toHaveBeenCalled();
    });

    it('queries claude.ai tabs to push a badge update when enabled, and does not throw if none are listening', async () => {
      const queryTabs = vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 7 }] as any);
      // fake-browser has no in-memory tabs.sendMessage — reject the same way a real browser
      // would for a tab with no content script listening (sendToTabIgnoringMissingReceiver,
      // lib/messaging.ts, must swallow this rather than let it throw/reject upward).
      const sendMessage = vi.spyOn(browser.tabs, 'sendMessage').mockRejectedValue(new Error('Receiving end does not exist'));

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: loadUsageFixture('usage.get.overage.json'),
      });

      expect(queryTabs).toHaveBeenCalledWith({ url: 'https://claude.ai/*' });
      expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'badgeUpdate' }));
    });

    it('openDashboard opens the dashboard page in a new tab', async () => {
      const createTab = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);

      await extensionMessenger.sendMessage('openDashboard');

      expect(createTab).toHaveBeenCalledWith({ url: browser.runtime.getURL('/dashboard.html') });
    });
  });

  describe('message_limit normalization', () => {
    it('normalizes a message_limit event into a message_limit-sourced snapshot', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'message_limit',
        capturedAt: '2026-08-29T09:28:30Z',
        raw: loadMessageLimitFixture('message_limit.five_hour.sse.txt'),
      });

      const snapshots = await db.limitSnapshots.toArray();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        source: 'message_limit',
        session: { percent: 29, severity: 'normal', isActive: true },
        weekly: { percent: 55 },
      });
    });

    it('does not create a snapshot for the overage branch (no window data to apply)', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'message_limit',
        capturedAt: '2026-08-29T09:28:30Z',
        raw: loadMessageLimitFixture('message_limit.overage.sse.txt'),
      });

      expect(await db.limitSnapshots.count()).toBe(0);
    });

    it('carries the previous weekly severity forward while still updating its percent from the exact fraction', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-29T09:00:00Z',
        raw: loadUsageFixture('usage.get.overage.json'), // weekly severity: "normal" per this fixture
      });

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'message_limit',
        capturedAt: '2026-08-29T09:28:30Z',
        raw: loadMessageLimitFixture('message_limit.five_hour.sse.txt'), // representativeClaim: five_hour -> weekly isn't the resolved window
      });

      const snapshots = await db.limitSnapshots.toArray();
      const latest = snapshots.at(-1)!;
      expect(latest.source).toBe('message_limit');
      expect(latest.weekly?.percent).toBe(55); // fresh exact fraction from this event's "7d" window
      expect(latest.weekly?.severity).toBe('normal'); // carried forward, not guessed
    });

    it('does not throw and stores nothing for a message_limit payload that fails validation', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'message_limit',
        capturedAt: '2026-08-29T09:28:30Z',
        raw: { not: 'a real message_limit event' },
      });

      expect(await db.limitSnapshots.count()).toBe(0);
    });

    it('pushes a badge update and checks thresholds for a message_limit-sourced snapshot too', async () => {
      const queryTabs = vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as any);

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'message_limit',
        capturedAt: '2026-08-29T09:28:30Z',
        raw: loadMessageLimitFixture('message_limit.five_hour.sse.txt'),
      });

      expect(queryTabs).toHaveBeenCalledWith({ url: 'https://claude.ai/*' });
    });
  });

  describe('rate_limit_event normalization (claude.ai/code)', () => {
    it('normalizes a rate_limit_event into a rate_limit_event-sourced snapshot', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'rate_limit_event',
        capturedAt: '2026-09-04T18:15:02Z',
        raw: loadRateLimitEventFixture('code.rate-limit-event.json'),
      });

      const snapshots = await db.limitSnapshots.toArray();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        source: 'rate_limit_event',
        session: { percent: 17 },
        weekly: { percent: 29 },
      });
    });

    it('carries the previous session severity forward — rate_limit_info has no per-window severity at all', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-09-04T18:00:00Z',
        raw: loadUsageFixture('usage.get.overage.json'), // session severity: "normal" per this fixture
      });

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'rate_limit_event',
        capturedAt: '2026-09-04T18:15:02Z',
        raw: loadRateLimitEventFixture('code.rate-limit-event.json'),
      });

      const snapshots = await db.limitSnapshots.toArray();
      const latest = snapshots.at(-1)!;
      expect(latest.source).toBe('rate_limit_event');
      expect(latest.session?.percent).toBe(17); // fresh exact fraction from unifiedWindows.five_hour
      expect(latest.session?.severity).toBe('normal'); // carried forward, not guessed
    });

    it('does not throw and stores nothing for a rate_limit_event payload that fails validation', async () => {
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'rate_limit_event',
        capturedAt: '2026-09-04T18:15:02Z',
        raw: { not: 'a real rate_limit_event' },
      });

      expect(await db.limitSnapshots.count()).toBe(0);
      // The raw capture is still stored — only normalization is skipped, same contract as usage/message_limit.
      const records = await db.rawRecords.toArray();
      expect(records).toHaveLength(1);
    });

    it('pushes a badge update and checks thresholds for a rate_limit_event-sourced snapshot too', async () => {
      const queryTabs = vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as any);

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'rate_limit_event',
        capturedAt: '2026-09-04T18:15:02Z',
        raw: loadRateLimitEventFixture('code.rate-limit-event.json'),
      });

      expect(queryTabs).toHaveBeenCalledWith({ url: 'https://claude.ai/*' });
    });
  });

  describe('configurable retention and thresholds', () => {
    it('prunes snapshots older than the configured retention, not the old fixed default', async () => {
      await extensionMessenger.sendMessage('updateSettings', { snapshotRetentionDays: 1 });
      await db.limitSnapshots.add({
        capturedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'usage',
        session: null,
        weekly: null,
      });

      // Any successful normalize triggers a prune.
      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: new Date().toISOString(),
        raw: loadUsageFixture('usage.get.overage.json'),
      });

      const snapshots = await db.limitSnapshots.toArray();
      expect(snapshots).toHaveLength(1); // only the just-added one; the 2-day-old one was pruned
    });

    it('fires an alert at a user-configured threshold the default thresholds would miss', async () => {
      await extensionMessenger.sendMessage('updateSettings', { alertThresholds: [50, 90] });

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(60), // below default 80, above custom 50
      });

      const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ title: expect.stringContaining('50%+') });
    });

    it('does not fire any alert when thresholds are configured empty', async () => {
      await extensionMessenger.sendMessage('updateSettings', { alertThresholds: [] });

      await extensionMessenger.sendMessage('captured', {
        endpoint: 'usage',
        capturedAt: '2026-08-26T17:20:00Z',
        raw: usageFixtureWithSessionPercent(99),
      });

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });
  });
});
