// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import { CliTab, SearchTab } from '../entrypoints/dashboard/Cli.tsx';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';
import { daemonSession, jsonResponse, zeroTotals } from './helpers.js';

describe('CliTab / SearchTab', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    backgroundDefinition.main();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('CliTab shows its own connect-the-daemon hint when not configured', async () => {
    render(<CliTab />);
    expect(await screen.findByText(/see Claude Code CLI usage and retention warnings here/)).toBeTruthy();
  });

  it('SearchTab shows a search-specific connect-the-daemon hint when not configured', async () => {
    render(<SearchTab />);
    expect(await screen.findByText(/search your Claude Code CLI sessions here/)).toBeTruthy();
  });

  describe('with the daemon configured', () => {
    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
    });

    it('loads more results on demand, appending rather than replacing the first page', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('offset=0')) {
          return jsonResponse({
            matches: [{ sessionId: 'a', cwd: '/x', matchCount: 1, snippet: 'first result', lastActivity: null }],
            hasMore: true,
          });
        }
        return jsonResponse({
          matches: [{ sessionId: 'b', cwd: '/y', matchCount: 1, snippet: 'second result', lastActivity: null }],
          hasMore: false,
        });
      });

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.click(screen.getByText('Search'));

      await screen.findByText('first result');
      expect(screen.queryByText('Load more')).toBeTruthy();

      fireEvent.click(screen.getByText('Load more'));

      await screen.findByText('second result');
      expect(screen.getByText('first result')).toBeTruthy(); // appended, not replaced
      expect(screen.queryByText('Load more')).toBeNull(); // hasMore: false on the second page

      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset=0'), expect.anything());
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset=1'), expect.anything());
    });

    it('shows "No matches." for a query that finds nothing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ matches: [], hasMore: false }));

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'nothing' } });
      fireEvent.click(screen.getByText('Search'));

      expect(await screen.findByText('No matches.')).toBeTruthy();
      expect(screen.queryByText('Load more')).toBeNull();
    });

    it('clears results when the search bar is emptied and resubmitted, instead of leaving stale results on screen', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ matches: [{ sessionId: 'a', cwd: '/x', matchCount: 1, snippet: 'first result', lastActivity: null }], hasMore: false }),
      );

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.click(screen.getByText('Search'));
      await screen.findByText('first result');

      fireEvent.change(input, { target: { value: '' } });
      fireEvent.click(screen.getByText('Search'));

      expect(screen.queryByText('first result')).toBeNull();
      // Cleared back to the pre-search state, not "No matches." — no search was actually run.
      expect(screen.queryByText('No matches.')).toBeNull();
    });

    it('surfaces an error instead of throwing when the daemon rejects the request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.click(screen.getByText('Search'));

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
    });

    it('shows a model-mix percentage and a top-usage leaderboard from data the daemon already serves', async () => {
      const session = {
        sessionId: 's1',
        projectPath: '/proj-a',
        totalTokens: 1000,
        totalCost: 1.23,
        lastActivity: '2026-08-01T00:00:00Z',
        firstActivity: '2026-08-01T00:00:00Z',
        inputTokens: 600,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelBreakdowns: [],
        modelsUsed: ['claude-sonnet-5'],
      };
      const totals = {
        totalTokens: 1000,
        totalCost: 1.23,
        inputTokens: 600,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      const dailyEntry = {
        date: '2026-08-01',
        totalTokens: 1000,
        totalCost: 1.23,
        inputTokens: 600,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelBreakdowns: [],
        modelsUsed: ['claude-sonnet-5'],
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) {
          return jsonResponse({ daily: [dailyEntry], totals });
        }
        if (requested.includes('/aggregate?by=project')) {
          return jsonResponse({ projects: { '/proj-a': [dailyEntry] }, totals });
        }
        if (requested.includes('/aggregate?by=model')) {
          return jsonResponse({
            models: [
              {
                modelName: 'claude-sonnet-5',
                inputTokens: 600,
                outputTokens: 400,
                cost: 1.23,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
            ],
          });
        }
        if (requested.includes('/sessions')) {
          return jsonResponse({ sessions: [session], totals });
        }
        return jsonResponse({});
      });

      render(<CliTab />);

      // A single model carries 100% of tokens — the model-mix column.
      expect(await screen.findByText('100%')).toBeTruthy();
      expect(screen.getAllByText('/proj-a').length).toBeGreaterThan(0);
      // Token-only: no dollar figures anywhere (API-equivalent cost isn't what a subscriber pays).
      expect(screen.queryByText('Cost')).toBeNull();
      expect(screen.queryByText(/equivalent API cost/)).toBeNull();
      expect(screen.queryByText(/\$\d/)).toBeNull();
      // CSV export buttons added alongside the By-project/By-model/By-session tables.
      expect(screen.getAllByText('Download CSV').length).toBe(3);
      // By-session table renders the same per-session data RetentionWarnings uses.
      expect(screen.getByText('By session')).toBeTruthy();
      expect(screen.getAllByText('/proj-a').length).toBeGreaterThan(0);
    });

    it('filters the By-project table by typing, without touching the By-model table', async () => {
      const totals = zeroTotals;
      const dailyEntryA = { date: '2026-08-01', totalTokens: 500, totalCost: 0.5, inputTokens: 300, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] };
      const dailyEntryB = { date: '2026-08-01', totalTokens: 700, totalCost: 0.7, inputTokens: 400, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals });
        if (requested.includes('/aggregate?by=project')) {
          return jsonResponse({ projects: { '/proj-alpha': [dailyEntryA], '/proj-beta': [dailyEntryB] }, totals });
        }
        if (requested.includes('/aggregate?by=model')) {
          return jsonResponse({
            models: [{ modelName: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, cost: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
          });
        }
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [], totals });
        return jsonResponse({});
      });

      render(<CliTab />);
      await screen.findByText('/proj-alpha');
      expect(screen.getByText('/proj-beta')).toBeTruthy();

      fireEvent.change(screen.getByPlaceholderText('Filter projects…'), { target: { value: 'alpha' } });
      expect(screen.getByText('/proj-alpha')).toBeTruthy();
      expect(screen.queryByText('/proj-beta')).toBeNull();
      // The other table's own row is untouched by the project filter.
      expect(screen.getByText('claude-sonnet-5')).toBeTruthy();

      fireEvent.change(screen.getByPlaceholderText('Filter projects…'), { target: { value: 'no-such-project' } });
      expect(await screen.findByText('No projects match "no-such-project".')).toBeTruthy();
    });

    it('shows a week-over-week delta computed from the same 30-day daily fetch, no new call', async () => {
      // Dates relative to the real wall clock at test-run time, not a hardcoded date — avoids
      // depending on (or needing to fake) the system clock, since weekOverWeek() buckets off
      // `new Date()` internally.
      const now = new Date();
      const isoDate = (d: Date) => d.toISOString().slice(0, 10);
      const today = isoDate(now);
      const tenDaysAgo = isoDate(new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));

      // "Today" (this week, 1000 tokens) and 10 days ago (last week, 500 tokens) — 100% up.
      const dailyEntries = [
        { date: today, totalTokens: 1000, totalCost: 1, inputTokens: 600, outputTokens: 400, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] },
        { date: tenDaysAgo, totalTokens: 500, totalCost: 0.5, inputTokens: 300, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] },
      ];
      const totals = { totalTokens: 1500, totalCost: 1.5, inputTokens: 900, outputTokens: 600, cacheCreationTokens: 0, cacheReadTokens: 0 };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: dailyEntries, totals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [], totals });
        return jsonResponse({});
      });

      render(<CliTab />);

      expect(await screen.findByText('▲ 100%')).toBeTruthy();
      expect(screen.getByText('vs last week')).toBeTruthy();
    });

    it('shows a weekly CLI-vs-chat split chart once at least two distinct weeks of data exist', async () => {
      const now = new Date();
      const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
      const dateStr = (d: Date) => d.toISOString().slice(0, 10);
      // 10-day spacing guarantees each point lands in a different calendar week (a week is only
      // 7 days), without depending on which day of the week "now" happens to be.
      const offsets = [20, 10, 0];

      await db.limitSnapshots.bulkAdd(
        offsets.map((n, i) => ({
          capturedAt: daysAgo(n).toISOString(),
          source: 'usage' as const,
          session: { percent: 10, resetsAt: now.toISOString(), severity: 'normal' as const, isActive: true },
          weekly: { percent: 10 + i * 20, resetsAt: now.toISOString(), severity: 'normal' as const, isActive: true },
        })),
      );

      const dailyEntries = offsets.map((n) => ({
        date: dateStr(daysAgo(n)),
        totalTokens: 100_000,
        totalCost: 1,
        inputTokens: 60_000,
        outputTokens: 40_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelBreakdowns: [],
        modelsUsed: [],
      }));
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) {
          return jsonResponse({ daily: dailyEntries, totals: { ...zeroTotals, totalTokens: 300_000, totalCost: 3 } });
        }
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [], totals: zeroTotals });
        return jsonResponse({});
      });

      const { container } = render(<CliTab />);

      await screen.findByText('CLI share of weekly-bar usage');
      expect(container.querySelectorAll('.stacked-bar-col').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('CLI (est.)')).toBeTruthy();
    });

    it('renders retention warnings alongside the attribution panel', async () => {
      const now = new Date();
      const oldEnough = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
      const session = {
        sessionId: 's1',
        projectPath: '/proj-a',
        totalTokens: 1000,
        totalCost: 1.23,
        lastActivity: oldEnough,
        firstActivity: oldEnough,
        inputTokens: 600,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelBreakdowns: [],
        modelsUsed: [],
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);

      // Time-sensitive, so it renders above the attribution panel rather than inside it.
      expect(await screen.findByText('Sessions nearing cleanup')).toBeTruthy();
      // The same session also shows up in the attribution panel's own By-session table below —
      // "no usage" would be wrong here, since this session's tokens are real CLI usage.
      expect(await screen.findByText('By session')).toBeTruthy();
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
    });

    it('only requests tool call summaries in the export once the checkbox is checked', async () => {
      const oldEnough = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', lastActivity: oldEnough });
      // jsdom doesn't implement the Blob-download APIs the export button uses — stub just enough
      // that clicking it doesn't throw (see options-app.test.tsx for the same pattern).
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/export')) return jsonResponse('# Claude Code session');
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);
      await screen.findByText('Sessions nearing cleanup');

      fireEvent.click(screen.getByText('Export markdown'));
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/sessions\/s1\/export$/), expect.anything());
      });

      fireEvent.click(screen.getByLabelText('Include tool calls in export (as short summaries)'));
      fireEvent.click(screen.getByText('Export markdown'));
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/sessions/s1/export?toolCalls=true'), expect.anything());
      });
    });
  });
});
