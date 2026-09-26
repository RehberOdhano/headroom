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
    await screen.findByRole('tab', { name: 'Search' });
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

  describe('progressive disclosure', () => {
    it('shows only the tabs that work without the daemon until it is connected', async () => {
      render(<App />);
      await screen.findByText(/No snapshots captured in this window yet/);
      expect(screen.getByRole('tab', { name: 'Usage & Forecast' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'CLI Attribution' })).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Search' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'Guardrails' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'New Project' })).toBeNull();
      // The CLI tab doubles as the install prompt, with a copy-paste command.
      expect(await screen.findByText(/npm install -g @rehberodhano\/claude-usage-companion-daemon/)).toBeTruthy();
    });

    it('moves between tabs with the arrow keys (roving tabindex)', async () => {
      render(<App />);
      await screen.findByText(/No snapshots captured in this window yet/);
      const first = screen.getByRole('tab', { name: 'Usage & Forecast' });
      const second = screen.getByRole('tab', { name: 'CLI Attribution' });
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

  describe('New Project → Guardrails handoff', () => {
    it('"Go to Guardrails" switches tabs and pre-fills the Guardrails project picker', async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/bootstrap')) {
          return jsonResponse({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
        }
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: { path: '/x', exists: false, defaultMode: null, allow: [], ask: [], deny: [] },
            project: null,
            local: null,
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<App />);

      fireEvent.click(await screen.findByRole('tab', { name: 'New Project' }));
      // Scoped to the New Project tabpanel — its target-dir field and Guardrails' own manual-path
      // field share the same placeholder text, and every tab stays mounted simultaneously.
      const panels = screen.getAllByRole('tabpanel', { hidden: true });
      const newProjectPanel = within(panels[panels.length - 1]!);

      fireEvent.change(await newProjectPanel.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(newProjectPanel.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(newProjectPanel.getByText('Set up project'));
      await newProjectPanel.findByText(/1 file written/);

      fireEvent.click(newProjectPanel.getByText('Go to Guardrails →'));

      const guardrailsPanel = within(panels[panels.length - 2]!); // config tabpanel, just before new-project
      expect(panels[panels.length - 1]!.hasAttribute('hidden')).toBe(true); // New Project, now hidden
      expect(await guardrailsPanel.findByText('Manual path active: /tmp/x')).toBeTruthy();
      // Regression check: the visible input field itself must show the path too, not just the
      // "Manual path active" summary text above it — ProjectPicker's own draft state used to be
      // seeded from `manualProjectDir` only once, on mount, so a path set from outside (this
      // handoff) never reached the field the user actually sees. New Project's own (still
      // mounted, now-hidden) field also shows "/tmp/x", so this must stay scoped to Guardrails.
      const guardrailsPathInput = guardrailsPanel.getByPlaceholderText('/absolute/path/to/project') as HTMLInputElement;
      expect(guardrailsPathInput.value).toBe('/tmp/x');
    });
  });
});
