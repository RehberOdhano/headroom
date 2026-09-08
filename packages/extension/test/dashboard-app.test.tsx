// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import App from '../entrypoints/dashboard/App.tsx';
import { db, type LimitSnapshotRecord } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';

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
    await db.limitSnapshots.bulkAdd([
      { capturedAt: '2026-09-04T18:00:00Z', source: 'usage', session: bar(10), weekly: bar(20) },
      { capturedAt: '2026-09-04T18:15:02Z', source: 'rate_limit_event', session: bar(17), weekly: null },
    ]);

    render(<App />);

    expect(await screen.findByText(/via Claude Code web/)).toBeTruthy();
    expect(await screen.findByText(/via periodic check/)).toBeTruthy();
  });

  it('switches tabs by toggling each panel\'s hidden attribute, not unmounting them', async () => {
    render(<App />);
    await screen.findByText(/No snapshots captured in this window yet/);

    const panelsByLabel = () => {
      const [charts, cli, search] = screen.getAllByRole('tabpanel', { hidden: true });
      return { charts: charts!, cli: cli!, search: search! };
    };

    let panels = panelsByLabel();
    expect(panels.charts.hasAttribute('hidden')).toBe(false);
    expect(panels.cli.hasAttribute('hidden')).toBe(true);
    expect(panels.search.hasAttribute('hidden')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));

    panels = panelsByLabel();
    expect(panels.charts.hasAttribute('hidden')).toBe(true);
    expect(panels.search.hasAttribute('hidden')).toBe(false);
    // Both panels are still in the DOM (mounted) even while hidden — not remounted on switch back.
    expect(panels.cli.hasAttribute('hidden')).toBe(true);
  });

  describe('extra usage credits', () => {
    it('is hidden entirely when no snapshot has ever carried extraCredits', async () => {
      await db.limitSnapshots.add({ capturedAt: new Date().toISOString(), source: 'usage', session: bar(10), weekly: bar(20) });
      render(<App />);
      await screen.findByText('Session (5h)');
      expect(screen.queryByText('Extra usage credits')).toBeNull();
    });

    it('shows amounts with a note when percent is null instead of an empty card', async () => {
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: bar(10),
        weekly: bar(20),
        extraCredits: { percent: null, usedAmount: 12.5, limitAmount: 50, currency: 'USD' },
      });

      render(<App />);

      expect(await screen.findByText('Extra usage credits')).toBeTruthy();
      expect(await screen.findByText(/USD 12.50 \/ 50.00 used — percent not reported yet/)).toBeTruthy();
    });

    it('shows a plain "no usage yet" note when every field is null', async () => {
      await db.limitSnapshots.add({
        capturedAt: new Date().toISOString(),
        source: 'usage',
        session: bar(10),
        weekly: bar(20),
        extraCredits: { percent: null, usedAmount: null, limitAmount: null, currency: null },
      });

      render(<App />);

      expect(await screen.findByText('Extra usage credits')).toBeTruthy();
      expect(await screen.findByText(/Enabled on your plan, but no usage reported yet/)).toBeTruthy();
    });
  });
});
