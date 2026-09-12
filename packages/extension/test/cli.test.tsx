// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import { CliTab, SearchTab } from '../entrypoints/dashboard/Cli.tsx';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';
import { jsonResponse, zeroTotals } from './helpers.js';

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
        if (requested.includes('/usage/patterns')) {
          return jsonResponse({
            skills: [{ name: 'code-review', count: 3 }],
            commands: [{ name: '/compact', count: 2 }],
            agents: [{ subagentType: 'Explore', count: 1, inputTokens: 50, outputTokens: 20 }],
            mcpServers: [{ name: 'claude-in-chrome', count: 7 }],
          });
        }
        return jsonResponse({});
      });

      render(<CliTab />);

      // A single model carries 100% of tokens — the model-mix column.
      expect(await screen.findByText('100%')).toBeTruthy();
      // Top-usage leaderboard, built entirely client-side from /sessions and /aggregate?by=day.
      expect(await screen.findByText('Priciest sessions')).toBeTruthy();
      expect(await screen.findByText('Priciest days')).toBeTruthy();
      expect(screen.getAllByText('/proj-a').length).toBeGreaterThan(0);
      // CSV export buttons added alongside the By-project/By-model tables.
      expect(screen.getAllByText('Download CSV').length).toBe(2);
      // Skill/slash-command/subagent/MCP usage patterns, from the /usage/patterns route.
      expect(await screen.findByText('code-review')).toBeTruthy();
      expect(screen.getByText('/compact')).toBeTruthy();
      expect(screen.getByText('Explore')).toBeTruthy();
      expect(screen.getByText('MCP servers')).toBeTruthy();
      expect(screen.getByText('claude-in-chrome')).toBeTruthy();
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

    it('marks an anomalous session with how many times a typical session it cost', async () => {
      const session = (overrides: Record<string, unknown>) => ({
        sessionId: 's1',
        projectPath: '/proj-a',
        totalTokens: 100,
        totalCost: 1,
        lastActivity: '2026-08-01T00:00:00Z',
        firstActivity: '2026-08-01T00:00:00Z',
        inputTokens: 60,
        outputTokens: 40,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelBreakdowns: [],
        modelsUsed: [],
        ...overrides,
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) {
          return jsonResponse({
            sessions: [
              session({ sessionId: 'a', projectPath: '/proj-a', totalCost: 1 }),
              session({ sessionId: 'b', projectPath: '/proj-b', totalCost: 1.2 }),
              session({ sessionId: 'c', projectPath: '/proj-runaway', totalCost: 20 }),
            ],
            totals: zeroTotals,
          });
        }
        return jsonResponse({});
      });

      render(<CliTab />);
      fireEvent.click(await screen.findByRole('button', { name: 'Top usage' }));

      // Costs: 1, 1.2, 20 -> median (typical) is 1.2, so the $20 session is ~17x that.
      const runawayRow = (await screen.findByText('/proj-runaway')).closest('div')!;
      expect(runawayRow.textContent).toContain('17× a typical session');
      const normalRow = screen.getByText('/proj-a').closest('div')!;
      expect(normalRow.textContent).not.toContain('a typical session');
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

    it('switches CLI attribution sub-views by toggling hidden, not unmounting them, and keeps retention warnings outside the panel', async () => {
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
        if (requested.includes('/usage/patterns')) return jsonResponse({ skills: [], commands: [], agents: [] });
        return jsonResponse({});
      });

      render(<CliTab />);

      // Retention warnings render outside/above the sub-nav'd panel — always visible regardless
      // of which CLI attribution sub-view is selected, since it's a time-sensitive alert.
      expect(await screen.findByText('Sessions nearing cleanup')).toBeTruthy();

      const overviewPanel = (await screen.findByText('No CLI usage recorded yet in the last 30 days.')).closest('div')!;
      expect(overviewPanel.hasAttribute('hidden')).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Top usage' }));
      // Both sub-views are mounted throughout — switching just flips which one is hidden.
      expect(overviewPanel.hasAttribute('hidden')).toBe(true);
      expect(screen.getByText('Sessions nearing cleanup')).toBeTruthy();
    });
  });
});
