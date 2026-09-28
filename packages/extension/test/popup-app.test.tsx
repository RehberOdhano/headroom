// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import App from '../entrypoints/popup/App.tsx';
import { db, type LimitSnapshotRecord } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';

function bar(percent: number) {
  return { percent, resetsAt: '2026-08-30T00:00:00Z', severity: 'normal', isActive: true };
}

describe('popup App', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    // The popup sends 'refreshUsage' on mount — needs a real background listener, or that
    // in-flight request just never resolves the "Refreshing…" state.
    backgroundDefinition.main();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the empty state with no capture yet, and a button to open Settings → Usage', async () => {
    render(<App />);
    expect(await screen.findByText(/No usage data yet/)).toBeTruthy();
    const button = await screen.findByRole('link', { name: /Open Settings → Usage/ });
    expect(button.getAttribute('href')).toBe('https://claude.ai/settings/usage');
  });

  it('tells a detected-but-no-snapshot-yet user to wait, instead of repeating the same instruction', async () => {
    // orgId is set the moment any capture arrives, before a snapshot necessarily lands in
    // limitSnapshots — see background.ts's 'captured' handler. A user in this gap already did
    // the right thing; telling them to do it again reads as the extension being stuck.
    await db.meta.put({ key: 'orgId', value: 'org-123' });
    render(<App />);
    expect(await screen.findByText(/Account detected/)).toBeTruthy();
    expect(screen.queryByText(/No usage data yet/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Open Settings → Usage/ })).toBeNull();
  });

  it('tells a detected user their usage data failed to parse, instead of the generic "hasn\'t landed yet" message', async () => {
    // background.ts records this breadcrumb when a real /usage response fails schema
    // validation (e.g. a shape claude.ai only sends for an account with genuinely zero usage) —
    // without it, this case is indistinguishable from a plain "hasn't captured yet" delay, which
    // is exactly what made a real, permanently-stuck failure read as "just needs a moment".
    await db.meta.put({ key: 'orgId', value: 'org-123' });
    await db.meta.put({ key: 'usageParseError', value: JSON.stringify({ capturedAt: '2026-08-26T17:20:00Z' }) });
    render(<App />);
    expect(await screen.findByText(/couldn't be read/)).toBeTruthy();
    expect(screen.queryByText(/hasn't landed yet/)).toBeNull();
  });

  it('renders bars and an extra-credits row without throwing', async () => {
    const snapshot: LimitSnapshotRecord = {
      capturedAt: new Date().toISOString(),
      source: 'usage',
      session: bar(39),
      weekly: bar(31),
      extraCredits: { percent: 75.19, usedAmount: 46.28, limitAmount: 61.55, currency: 'USD' },
    };
    await db.limitSnapshots.add(snapshot);

    render(<App />);

    expect(await screen.findByText('Session (5h)')).toBeTruthy();
    expect(await screen.findByText('Weekly')).toBeTruthy();
    expect(await screen.findByText('Extra credits')).toBeTruthy();
  });

  it('notes which surface the latest snapshot came from', async () => {
    await db.limitSnapshots.add({
      capturedAt: new Date().toISOString(),
      source: 'rate_limit_event',
      session: bar(17),
      weekly: bar(29),
    });

    render(<App />);

    expect(await screen.findByText(/via Claude Code web/)).toBeTruthy();
  });

  it(
    'renders without throwing for a barely-positive rate outside a representable Date range ' +
      '(same regression as the dashboard — the popup headline shares forecastBurnRate)',
    async () => {
      const now = new Date();
      const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
      await db.limitSnapshots.bulkAdd([
        { capturedAt: sixDaysAgo.toISOString(), source: 'usage', session: bar(61), weekly: bar(61) },
        { capturedAt: now.toISOString(), source: 'usage', session: bar(61.000001), weekly: bar(61.000001) },
      ]);

      render(<App />);

      expect(await screen.findByText('Session (5h)')).toBeTruthy();
      expect(await screen.findByText('Weekly')).toBeTruthy();
    },
  );

  it('shows no headline when nothing needs attention, and labels each bar as a progressbar', async () => {
    await db.limitSnapshots.add({
      capturedAt: new Date().toISOString(),
      source: 'usage',
      session: { percent: 12, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), severity: 'normal', isActive: true },
      weekly: null,
    });
    render(<App />);
    expect((await screen.findByRole('progressbar', { name: 'Session (5h)' })).getAttribute('aria-valuenow')).toBe('12');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('flags a bar that is already at its limit', async () => {
    await db.limitSnapshots.add({
      capturedAt: new Date().toISOString(),
      source: 'usage',
      session: bar(100),
      weekly: null,
    });
    render(<App />);
    expect(await screen.findByText(/Session limit reached/)).toBeTruthy();
  });

  it('shows a one-time rating prompt the first time the forecast warns, and not again after remount', async () => {
    const now = Date.now();
    const HOUR = 3_600_000;
    // Same shape as headline.test.ts's "steep" fixture: 10%/hour for 5 points, projects full
    // ~5h out while the reset is 8h away — a real 'warn' headline, not a limit-reached 'alert'.
    const resetsAt = new Date(now + 8 * HOUR).toISOString();
    const steepSnapshots: LimitSnapshotRecord[] = [4, 3, 2, 1, 0].map((hoursAgo, i) => ({
      capturedAt: new Date(now - hoursAgo * HOUR).toISOString(),
      source: 'usage',
      session: { percent: 10 + i * 10, resetsAt, severity: 'normal', isActive: true },
      weekly: null,
    }));
    await db.limitSnapshots.bulkAdd(steepSnapshots);

    const { unmount } = render(<App />);
    expect(await screen.findByText(/runs out/)).toBeTruthy();
    expect(await screen.findByText(/rate headroom on the Chrome Web Store/)).toBeTruthy();
    unmount();

    render(<App />);
    expect(await screen.findByText(/runs out/)).toBeTruthy();
    expect(screen.queryByText(/rate headroom on the Chrome Web Store/)).toBeNull();
  });
});
