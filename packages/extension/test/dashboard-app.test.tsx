// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import App from '../entrypoints/dashboard/App.tsx';
import { db, type LimitSnapshotRecord } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';
import { jsonResponse } from './helpers.js';

function bar(percent: number) {
  return { percent, resetsAt: '2026-08-30T00:00:00Z', severity: 'normal', isActive: true };
}

describe('dashboard App', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    // Cli.tsx sends 'getSettings' on mount — needs a real background listener answering it, or
    // that promise never resolves. Default settings have an empty daemonToken, so Cli renders
    // its "connect the daemon" hint without making any network calls.
    backgroundDefinition.main();
    // fake-browser doesn't implement runtime.getManifest (used by the what's-new banner).
    fakeBrowser.runtime.getManifest = vi.fn(() => ({ version: '0.1.4' })) as never;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the empty state with no snapshot history', async () => {
    render(<App />);
    expect(await screen.findByText(/No snapshots captured in this window yet/)).toBeTruthy();
  });

  it(
    'renders without throwing for a barely-positive rate that would push the forecast past ' +
      "Date's representable range — regression test for forecastBurnRate's Invalid Date / " +
      'toISOString crash, fixed in packages/shared/src/forecast/burn-rate.ts',
    async () => {
      const now = new Date();
      const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
      // 0.000001 percentage points over 6 days is a real (if absurdly slow) positive rate —
      // small enough that projecting forward to 100% lands far outside a representable Date.
      const snapshots: LimitSnapshotRecord[] = [
        { capturedAt: sixDaysAgo.toISOString(), source: 'usage', session: bar(61), weekly: bar(61) },
        { capturedAt: now.toISOString(), source: 'usage', session: bar(61.000001), weekly: bar(61.000001) },
      ];
      await db.limitSnapshots.bulkAdd(snapshots);

      render(<App />);

      // Whatever the forecast text ends up being, both BarSections rendering at all (instead
      // of the whole tree crashing) is the actual regression check here.
      expect(await screen.findByText('Claude usage dashboard')).toBeTruthy();
      expect(await screen.findByText('Session (5h)')).toBeTruthy();
      expect(await screen.findByText('Weekly')).toBeTruthy();
    },
  );

  it('switches history windows without crashing', async () => {
    await db.limitSnapshots.add({
      capturedAt: new Date().toISOString(),
      source: 'usage',
      session: bar(50),
      weekly: bar(40),
    });

    render(<App />);
    await screen.findByText('50%');

    fireEvent.click(screen.getByText('30d'));

    expect(await screen.findByText('50%')).toBeTruthy();
  });

  it("notes each bar's own source — session and weekly can come from different snapshots", async () => {
    // Relative to the real wall clock, not hardcoded absolute timestamps — a fixed past date
    // eventually ages out of the dashboard's default 7-day window as real time passes (this
    // exact test started failing that way once "now" crossed 7 days past its old hardcoded
    // dates), the same class of bug this file's forecast test above works around too.
    const now = new Date();
    const fifteenMinutesLater = new Date(now.getTime() + 15 * 60 * 1000);
    await db.limitSnapshots.bulkAdd([
      { capturedAt: now.toISOString(), source: 'usage', session: bar(10), weekly: bar(20) },
      { capturedAt: fifteenMinutesLater.toISOString(), source: 'rate_limit_event', session: bar(17), weekly: null },
    ]);

    render(<App />);

    expect(await screen.findByText(/via Claude Code web/)).toBeTruthy();
    expect(await screen.findByText(/via periodic check/)).toBeTruthy();
  });

  it('switches tabs by toggling each panel\'s hidden attribute, not unmounting them', async () => {
    await extensionMessenger.sendMessage('updateSettings', {
      daemonUrl: 'http://127.0.0.1:4317',
      daemonToken: 'test-token',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));
    render(<App />);
    await screen.findByRole('tab', { name: 'Sessions' });
    await screen.findByText(/No snapshots captured in this window yet/);

    const panelsByLabel = () => {
      const [charts, cli, search] = screen.getAllByRole('tabpanel', { hidden: true });
      return { charts: charts!, cli: cli!, search: search! };
    };

    let panels = panelsByLabel();
    expect(panels.charts.hasAttribute('hidden')).toBe(false);
    expect(panels.cli.hasAttribute('hidden')).toBe(true);
    expect(panels.search.hasAttribute('hidden')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));

    panels = panelsByLabel();
    expect(panels.charts.hasAttribute('hidden')).toBe(true);
    expect(panels.search.hasAttribute('hidden')).toBe(false);
    // Both panels are still in the DOM (mounted) even while hidden — not remounted on switch back.
    expect(panels.cli.hasAttribute('hidden')).toBe(true);
  });

  describe('progressive disclosure', () => {
    it('shows only the tabs that work without the daemon until it is connected', async () => {
      render(<App />);
      await screen.findByText(/No snapshots captured in this window yet/);
      expect(screen.getByRole('tab', { name: 'Overview' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Activity' })).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Sessions' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'Guardrails' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'New Project' })).toBeNull();
      // The CLI tab doubles as the install prompt, with a copy-paste command.
      expect(await screen.findByText(/npm install -g @rehberodhano\/claude-usage-companion-daemon/)).toBeTruthy();
    });

    it('moves between tabs with the arrow keys (roving tabindex)', async () => {
      render(<App />);
      await screen.findByText(/No snapshots captured in this window yet/);
      const first = screen.getByRole('tab', { name: 'Overview' });
      const second = screen.getByRole('tab', { name: 'Activity' });
      expect(first.getAttribute('tabindex')).toBe('0');
      expect(second.getAttribute('tabindex')).toBe('-1');
      fireEvent.keyDown(first, { key: 'ArrowRight' });
      expect(second.getAttribute('aria-selected')).toBe('true');
      expect(second.getAttribute('tabindex')).toBe('0');
    });
  });

  describe("what's new banner", () => {
    it('stays silent on a fresh install and records the version', async () => {
      render(<App />);
      await screen.findByText(/No snapshots captured in this window yet/);
      expect(screen.queryByText(/What's new/)).toBeNull();
      await vi.waitFor(async () => expect((await db.meta.get('lastSeenVersion'))?.value).toBe('0.1.4'));
    });

    it('shows once after an update to a version with notes, and dismissing records it', async () => {
      fakeBrowser.runtime.getManifest = vi.fn(() => ({ version: '0.2.0' })) as never;
      await db.meta.put({ key: 'lastSeenVersion', value: '0.1.4' });
      render(<App />);
      expect(await screen.findByText(/What's new in 0.2.0/)).toBeTruthy();
      fireEvent.click(screen.getByText('Dismiss'));
      await vi.waitFor(async () => expect((await db.meta.get('lastSeenVersion'))?.value).toBe('0.2.0'));
      await vi.waitFor(() => expect(screen.queryByText(/What's new/)).toBeNull());
    });
  });

  describe('usage credits', () => {
    it('is hidden entirely when there is no extraCredits data', async () => {
      await db.limitSnapshots.add({ capturedAt: new Date().toISOString(), source: 'usage', session: bar(10), weekly: bar(20) });
      render(<App />);
      await screen.findByText('Session (5h)');
      expect(screen.queryByText('Usage credits')).toBeNull();
    });

    it('shows amounts with a note when percent is null instead of an empty section', async () => {
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: bar(10),
        weekly: bar(20),
        extraCredits: { percent: null, usedAmount: 12.5, limitAmount: 50, currency: 'USD' },
      });

      render(<App />);

      expect(await screen.findByText('Usage credits')).toBeTruthy();
      expect(await screen.findByText('Spent this month')).toBeTruthy();
      expect(await screen.findByText(/USD 12.50 \/ 50.00 spent — percent not reported yet/)).toBeTruthy();
    });

    it('shows a plain "no usage yet" note when every extraCredits field is null', async () => {
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: bar(10),
        weekly: bar(20),
        extraCredits: { percent: null, usedAmount: null, limitAmount: null, currency: null },
      });

      render(<App />);

      expect(await screen.findByText(/Enabled on your plan, but no usage reported yet/)).toBeTruthy();
    });
  });

  describe('safe pace and freshness', () => {
    it('shows a plain "Updated … ago" line for the latest snapshot', async () => {
      await db.limitSnapshots.add({ capturedAt: new Date().toISOString(), source: 'usage', session: bar(10), weekly: bar(20) });
      render(<App />);
      expect((await screen.findAllByText(/Updated just now/)).length).toBeGreaterThan(0);
    });

    it('shows a safe-pace line, including the comparison, once a medium/high-confidence forecast is established', async () => {
      const now = new Date();
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
      // 20 hours to reset, 50% used -> safe rate is 2.5%/h; the fitted rate below (10%/h) is
      // far above that, so both the base safe-pace line and its comparison clause should render.
      const resetsAt = new Date(now.getTime() + 20 * 60 * 60 * 1000).toISOString();
      const weeklyBar = (percent: number) => ({ percent, resetsAt, severity: 'normal', isActive: true });
      await db.limitSnapshots.bulkAdd([
        { capturedAt: hoursAgo(4), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(3), source: 'usage', session: null, weekly: weeklyBar(20) },
        { capturedAt: hoursAgo(2), source: 'usage', session: null, weekly: weeklyBar(30) },
        { capturedAt: hoursAgo(1), source: 'usage', session: null, weekly: weeklyBar(40) },
        { capturedAt: now.toISOString(), source: 'usage', session: null, weekly: weeklyBar(50) },
      ]);

      render(<App />);

      expect(await screen.findByText(/Average usage should stay around 2\.5%\/hour or lower to last until reset\./)).toBeTruthy();
      expect(await screen.findByText(/Your recent pace is about \d+% above that\./)).toBeTruthy();
    });

    it('shows an anomaly note when the current run is well above the account\'s own recent baseline', async () => {
      const now = new Date();
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
      const resetsAt = new Date(now.getTime() + 20 * 60 * 60 * 1000).toISOString();
      const weeklyBar = (percent: number) => ({ percent, resetsAt, severity: 'normal', isActive: true });
      await db.limitSnapshots.bulkAdd([
        { capturedAt: hoursAgo(6), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(5), source: 'usage', session: null, weekly: weeklyBar(15) },
        { capturedAt: hoursAgo(4), source: 'usage', session: null, weekly: weeklyBar(5) },
        { capturedAt: hoursAgo(3), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(2), source: 'usage', session: null, weekly: weeklyBar(2) },
        { capturedAt: hoursAgo(1), source: 'usage', session: null, weekly: weeklyBar(13) },
        { capturedAt: now.toISOString(), source: 'usage', session: null, weekly: weeklyBar(24) },
      ]);

      render(<App />);

      expect(await screen.findByText(/Usage is rising faster than its recent pattern/)).toBeTruthy();
    });

    it('lets you inspect an anomaly, correlating real local sessions against the anomalous window', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
      const now = new Date();
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
      const resetsAt = new Date(now.getTime() + 20 * 60 * 60 * 1000).toISOString();
      const weeklyBar = (percent: number) => ({ percent, resetsAt, severity: 'normal', isActive: true });
      await db.limitSnapshots.bulkAdd([
        { capturedAt: hoursAgo(6), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(5), source: 'usage', session: null, weekly: weeklyBar(15) },
        { capturedAt: hoursAgo(4), source: 'usage', session: null, weekly: weeklyBar(5) },
        { capturedAt: hoursAgo(3), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(2), source: 'usage', session: null, weekly: weeklyBar(2) },
        { capturedAt: hoursAgo(1), source: 'usage', session: null, weekly: weeklyBar(13) },
        { capturedAt: now.toISOString(), source: 'usage', session: null, weekly: weeklyBar(24) },
      ]);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/sessions')) {
          return jsonResponse({
            sessions: [
              {
                sessionId: 's1',
                projectPath: 'payments-api',
                firstActivity: hoursAgo(1.5),
                lastActivity: hoursAgo(0.5),
                totalTokens: 500,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalCost: 0,
                modelsUsed: ['claude-sonnet-5'],
                modelBreakdowns: [{ modelName: 'claude-sonnet-5', inputTokens: 300, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 }],
              },
            ],
            totals: { totalTokens: 500, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
          });
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      });

      render(<App />);

      await screen.findByText(/Usage is rising faster than its recent pattern/);
      fireEvent.click(await screen.findByText('Inspect →'));

      expect(await screen.findByText(/Largest local contributor observed during this period: payments-api/)).toBeTruthy();
    });

    it('tells a daemon fetch failure apart from a genuinely empty Usage Inspector result', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
      const now = new Date();
      const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
      const resetsAt = new Date(now.getTime() + 20 * 60 * 60 * 1000).toISOString();
      const weeklyBar = (percent: number) => ({ percent, resetsAt, severity: 'normal', isActive: true });
      await db.limitSnapshots.bulkAdd([
        { capturedAt: hoursAgo(6), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(5), source: 'usage', session: null, weekly: weeklyBar(15) },
        { capturedAt: hoursAgo(4), source: 'usage', session: null, weekly: weeklyBar(5) },
        { capturedAt: hoursAgo(3), source: 'usage', session: null, weekly: weeklyBar(10) },
        { capturedAt: hoursAgo(2), source: 'usage', session: null, weekly: weeklyBar(2) },
        { capturedAt: hoursAgo(1), source: 'usage', session: null, weekly: weeklyBar(13) },
        { capturedAt: now.toISOString(), source: 'usage', session: null, weekly: weeklyBar(24) },
      ]);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/sessions')) return new Response('', { status: 500 });
        throw new Error(`unexpected fetch: ${String(url)}`);
      });

      render(<App />);

      await screen.findByText(/Usage is rising faster than its recent pattern/);
      fireEvent.click(await screen.findByText('Inspect →'));

      expect(await screen.findByText(/Couldn.t reach the daemon/)).toBeTruthy();
    });

    it('omits the safe-pace line once a bar is at/over 100% (nothing left to pace against)', async () => {
      // A future reset time, so this isolates the percent>=100 clamp rather than coincidentally
      // also tripping the separate "reset already passed" null case.
      const resetsAt = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
      const fullBar = { percent: 100, resetsAt, severity: 'normal', isActive: true };
      await db.limitSnapshots.add({ capturedAt: new Date().toISOString(), source: 'usage', session: fullBar, weekly: fullBar });
      render(<App />);
      await screen.findByText('Session (5h)');
      expect(screen.queryByText(/Average usage should stay around/)).toBeNull();
    });
  });

  describe('Guardrails / New Project removal (product split)', () => {
    it('never renders a Guardrails or New Project tab, even with the daemon connected', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));
      render(<App />);

      await screen.findByRole('tab', { name: 'Sessions' });
      expect(screen.queryByRole('tab', { name: 'Guardrails' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'New Project' })).toBeNull();
      expect(screen.queryByText('Experimental')).toBeNull();
      expect(screen.queryByText(/Go to Guardrails/)).toBeNull();
    });
  });
});
