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

  describe('prepaid credits poll', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    function prepaidCreditsBody(expiresAt: string): Record<string, unknown> {
      const body = loadUsageFixture('prepaid-credits.get.json') as {
        promo_tranches: { expires_at: string }[];
        next_expires_at: string;
      };
      body.promo_tranches[0]!.expires_at = expiresAt;
      body.next_expires_at = expiresAt;
      return body;
    }

    function mockPrepaidCredits(body: Record<string, unknown>) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/prepaid/credits')) {
          return { ok: true, status: 200, json: async () => body } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });
    }

    it('does nothing when no org id is known yet', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/prepaid/credits'), expect.anything());
    });

    it('fetches and stores a normalized snapshot for the cached org id', async () => {
      await db.meta.put({ key: 'orgId', value: 'org-123' });
      const farFuture = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      mockPrepaidCredits(prepaidCreditsBody(farFuture));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(async () => {
        const stored = await db.meta.get('prepaidCredits');
        expect(stored).toBeDefined();
        expect(JSON.parse(stored!.value)).toMatchObject({ balanceAmount: 38.11, currency: 'USD' });
      });
    });

    it('fires a notification when the soonest promo tranche expires within 7 days', async () => {
      await db.meta.put({ key: 'orgId', value: 'org-123' });
      const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      mockPrepaidCredits(prepaidCreditsBody(soon));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ title: expect.stringContaining('expiring soon') });
      });
    });

    it('does not notify when the soonest promo tranche expires more than 7 days out', async () => {
      await db.meta.put({ key: 'orgId', value: 'org-123' });
      const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const fetchMock = mockPrepaidCredits(prepaidCreditsBody(farFuture));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('does not re-notify for the same expiring tranche twice', async () => {
      await db.meta.put({ key: 'orgId', value: 'org-123' });
      const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      mockPrepaidCredits(prepaidCreditsBody(soon));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await vi.waitFor(() => expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
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

  describe('CLI budget alert', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
      });
    });

    function mockDailyCost(cost: number) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) {
          return { ok: true, status: 200, json: async () => ({ daily: [], totals: { ...zeroTotals, totalCost: cost } }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });
    }

    it('fires a notification once this month\'s CLI spend reaches the configured budget', async () => {
      await extensionMessenger.sendMessage('updateSettings', { cliMonthlyBudget: 50 });
      mockDailyCost(52.5);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ title: expect.stringContaining('budget') });
      });
    });

    it('does not notify while spend stays under the budget', async () => {
      await extensionMessenger.sendMessage('updateSettings', { cliMonthlyBudget: 50 });
      const fetchMock = mockDailyCost(10);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('does not fetch anything when no budget is configured (the default)', async () => {
      const fetchMock = mockDailyCost(999);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/aggregate'), expect.anything());
    });

    it('does not re-notify for the same calendar month once already alerted', async () => {
      await extensionMessenger.sendMessage('updateSettings', { cliMonthlyBudget: 50 });
      mockDailyCost(60);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await vi.waitFor(() => expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
    });
  });

  describe('per-project CLI budget alert', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
      });
    });

    function mockByProjectCost(slug: string, cost: number) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=project')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              projects: { [slug]: [{ ...zeroTotals, totalCost: cost, date: '2026-08-01', modelBreakdowns: [], modelsUsed: [] }] },
              totals: zeroTotals,
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });
    }

    it('fires once a specific project\'s CLI spend crosses its own budget', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        perProjectCliBudgets: [{ projectDir: '/Users/x/riverpoint', monthlyBudget: 20 }],
      });
      mockByProjectCost('-Users-x-riverpoint', 25);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ title: expect.stringContaining('project CLI budget') });
        expect(created[0]?.message).toContain('/Users/x/riverpoint');
      });
    });

    it('does not notify while a project stays under its own budget', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        perProjectCliBudgets: [{ projectDir: '/Users/x/riverpoint', monthlyBudget: 20 }],
      });
      const fetchMock = mockByProjectCost('-Users-x-riverpoint', 5);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('does not notify when the response has no data for that project\'s slug', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        perProjectCliBudgets: [{ projectDir: '/Users/x/riverpoint', monthlyBudget: 20 }],
      });
      const fetchMock = mockByProjectCost('-Users-x-someone-else', 999);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('does not fetch anything with no per-project budgets configured (the default)', async () => {
      const fetchMock = mockByProjectCost('-anything', 999);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/aggregate?by=project'), expect.anything());
    });
  });

  describe('session anomaly alert', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
      });
    });

    function mockSessions(sessions: unknown[]) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/sessions')) {
          return { ok: true, status: 200, json: async () => ({ sessions, totals: zeroTotals }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });
    }

    it('fires once for a session whose cost is far above the rest', async () => {
      mockSessions([
        daemonSession({ sessionId: 'a', totalCost: 1 }),
        daemonSession({ sessionId: 'b', totalCost: 1.2 }),
        daemonSession({ sessionId: 'c', totalCost: 20, projectPath: '-Users-x-riverpoint' }),
      ]);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ title: expect.stringContaining('unusually high') });
        expect(created[0]?.message).toContain('-Users-x-riverpoint');
      });
    });

    it('does not re-notify for the same session on a later tick', async () => {
      mockSessions([
        daemonSession({ sessionId: 'a', totalCost: 1 }),
        daemonSession({ sessionId: 'b', totalCost: 1.2 }),
        daemonSession({ sessionId: 'c', totalCost: 20 }),
      ]);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await vi.waitFor(() => expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
    });

    it('does not notify when every session costs about the same', async () => {
      const fetchMock = mockSessions([daemonSession({ sessionId: 'a', totalCost: 1 }), daemonSession({ sessionId: 'b', totalCost: 1.1 })]);

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
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

  describe('quiet hours', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    // Brackets the *real* current hour rather than faking the clock — this file's own history
    // notes fake timers can hang vi.waitFor's internal polling, so window bounds are computed
    // relative to wall-clock time instead.
    function quietWindowCoveringNow(): { quietHoursStart: number; quietHoursEnd: number } {
      const hour = new Date().getHours();
      return { quietHoursStart: hour, quietHoursEnd: (hour + 2) % 24 };
    }

    it('suppresses a CLI budget alert during quiet hours but does not lose it — it fires on the next check once quiet hours end', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
        cliMonthlyBudget: 50,
        quietHoursEnabled: true,
        ...quietWindowCoveringNow(),
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) {
          return { ok: true, status: 200, json: async () => ({ daily: [], totals: { ...zeroTotals, totalCost: 60 } }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);

      // Quiet hours off now — the same crossing (never marked as alerted) fires this time.
      await extensionMessenger.sendMessage('updateSettings', { quietHoursEnabled: false });
      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
      });
    });

    it('does not suppress anything when disabled (the default)', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
        cliMonthlyBudget: 50,
        quietHoursEnabled: false,
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) {
          return { ok: true, status: 200, json: async () => ({ daily: [], totals: { ...zeroTotals, totalCost: 60 } }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
      });
    });
  });

  describe('weekly digest', () => {
    const POLL_ALARM_NAME = 'headroom-poll-usage';

    it('does not fire when disabled (the default)', async () => {
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: { percent: 40, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
        weekly: { percent: 20, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
    });

    it('fires with the past week\'s peak percentages once enabled, using only local data with no daemon configured', async () => {
      await extensionMessenger.sendMessage('updateSettings', { weeklyDigestEnabled: true });
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: { percent: 73, resetsAt: new Date().toISOString(), severity: 'warning', isActive: true },
        weekly: { percent: 41, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
        expect(created).toHaveLength(1);
        expect(created[0]?.message).toContain('Peak session: 73%');
        expect(created[0]?.message).toContain('Peak weekly: 41%');
        expect(created[0]?.message).not.toContain('CLI:');
      });
    });

    it('appends a CLI tokens/cost line when the daemon is configured', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        weeklyDigestEnabled: true,
        daemonToken: 'existing-token',
        daemonUrl: 'http://127.0.0.1:4317',
      });
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: { percent: 30, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
        weekly: { percent: 15, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ daily: [], totals: { totalTokens: 12000, totalCost: 3.5, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });

      await vi.waitFor(() => {
        const created = Object.values(fakeBrowser.notifications.getAllCreateOptions());
        expect(created).toHaveLength(1);
        expect(created[0]?.message).toContain('CLI: 12.0K tokens, $3.50');
      });
    });

    it('does not fire twice within the same 7-day window', async () => {
      await extensionMessenger.sendMessage('updateSettings', { weeklyDigestEnabled: true });
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: { percent: 10, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
        weekly: { percent: 5, resetsAt: new Date().toISOString(), severity: 'normal', isActive: true },
      });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await vi.waitFor(() => expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1));

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(1);
    });

    it('does not fire when there is no snapshot data yet, even if enabled', async () => {
      await extensionMessenger.sendMessage('updateSettings', { weeklyDigestEnabled: true });

      await fakeBrowser.alarms.onAlarm.trigger({ name: POLL_ALARM_NAME, scheduledTime: Date.now(), persistAcrossSessions: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Object.keys(fakeBrowser.notifications.getAllCreateOptions())).toHaveLength(0);
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
