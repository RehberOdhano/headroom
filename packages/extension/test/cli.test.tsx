// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(await screen.findByText(/see Claude Code CLI usage here/)).toBeTruthy();
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

    it('shows "No CLI usage recorded" only for a genuinely empty, successful result — not a failed one', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);
      expect(await screen.findByText('No CLI usage recorded yet in the last 30 days.')).toBeTruthy();
    });

    it('shows a section-level error for a failed daily/summary request, without hiding By-project/By-model/By-session data that loaded fine', async () => {
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', totalTokens: 500 });
      const dailyEntry = { date: '2026-08-01', totalTokens: 500, totalCost: 0, inputTokens: 300, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return new Response('', { status: 500 });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: { '/proj-a': [dailyEntry] }, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) {
          return jsonResponse({ models: [{ modelName: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, cost: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }] });
        }
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
      // Partial success: the other three sections still render real data.
      expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
      expect(screen.getAllByText('/proj-a').length).toBeGreaterThan(0);
      // Must not also claim a confirmed-empty result — the daily fetch failing is unknown, not zero.
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
    });

    it('shows a section-level error for a failed By-project request, without hiding By-model/By-session data that loaded fine', async () => {
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', totalTokens: 500 });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return new Response('', { status: 500 });
        if (requested.includes('/aggregate?by=model')) {
          return jsonResponse({ models: [{ modelName: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, cost: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }] });
        }
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
      // Partial success: the other two sections still render real data.
      expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
      expect(screen.getByText('/proj-a')).toBeTruthy();
      // Must not also claim a confirmed-empty result.
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
    });

    it('shows a section-level error for a failed By-model request, without hiding By-project/By-session data that loaded fine', async () => {
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', totalTokens: 500 });
      const dailyEntry = { date: '2026-08-01', totalTokens: 500, totalCost: 0, inputTokens: 300, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: { '/proj-a': [dailyEntry] }, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return new Response('', { status: 500 });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
      expect(screen.getAllByText('/proj-a').length).toBeGreaterThan(0);
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
    });

    it('shows a section-level error for a failed sessions request, without hiding By-project/By-model data that loaded fine', async () => {
      const dailyEntry = { date: '2026-08-01', totalTokens: 500, totalCost: 0, inputTokens: 300, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, modelBreakdowns: [], modelsUsed: [] };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: { '/proj-a': [dailyEntry] }, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) {
          return jsonResponse({ models: [{ modelName: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, cost: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }] });
        }
        if (requested.includes('/sessions')) return new Response('', { status: 500 });
        return jsonResponse({});
      });

      render(<CliTab />);

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
      expect(screen.getByText('/proj-a')).toBeTruthy();
      expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
    });

    it('shows a rejected-token error only once, even though it fails every section identically', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

      render(<CliTab />);

      expect(await screen.findAllByText('Daemon rejected the token — check it in settings.')).toHaveLength(1);
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
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

    it('renders retention warnings in the Sessions tab, above search', async () => {
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
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<SearchTab />);

      // Above the search box, not buried behind it.
      expect(await screen.findByText('Sessions nearing cleanup')).toBeTruthy();
      expect(await screen.findByText('Search CLI sessions')).toBeTruthy();
    });

    it('shows an explicit error, not silence, when the retention check\'s sessions fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/sessions')) return new Response('', { status: 500 });
        return jsonResponse({});
      });

      render(<SearchTab />);

      // Must not be indistinguishable from "no sessions nearing cleanup" (which renders nothing).
      expect(await screen.findByText('Couldn’t check sessions nearing cleanup.')).toBeTruthy();
      expect(screen.queryByText('Sessions nearing cleanup')).toBeNull();
    });

    it('still shows real CLI usage in the Activity tab for a session that is also nearing retention cleanup', async () => {
      const oldEnough = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', lastActivity: oldEnough, totalTokens: 1000 });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: { ...zeroTotals, totalTokens: 1000 } });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);

      expect(await screen.findByText('By session')).toBeTruthy();
      expect(screen.queryByText('No CLI usage recorded yet in the last 30 days.')).toBeNull();
      // Retention warnings moved to the Sessions tab — not duplicated here.
      expect(screen.queryByText('Sessions nearing cleanup')).toBeNull();
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
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<SearchTab />);
      const retentionHeading = await screen.findByText('Sessions nearing cleanup');
      // Scoped to the retention card specifically — SessionSearch now shares this tab and has
      // its own, separate "Include tool calls" checkbox for its own export action.
      const retentionCard = within(retentionHeading.closest('section')!);

      fireEvent.click(retentionCard.getByText('Export markdown'));
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/sessions\/s1\/export$/), expect.anything());
      });

      fireEvent.click(retentionCard.getByLabelText('Include tool calls in export (as short summaries)'));
      fireEvent.click(retentionCard.getByText('Export markdown'));
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/sessions/s1/export?toolCalls=true'), expect.anything());
      });
    });

    it('lazily loads a session\'s subagent activity only once its row is expanded, labeled as separate from the session total', async () => {
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', totalTokens: 1000 });
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/sessions/s1/subagents')) {
          return jsonResponse({
            subagents: [
              {
                agentId: 'a1',
                agentType: 'Explore',
                description: 'Explore aggregate pipeline',
                toolUseId: 'toolu_1',
                model: 'claude-sonnet-5',
                inputTokens: 60,
                outputTokens: 25,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 85,
              },
            ],
          });
        }
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);
      await screen.findByText('By session');

      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/subagents'))).toBe(false);

      fireEvent.click(screen.getByText('Show'));

      // Type, description, tokens, and model each render as their own column/element (for
      // independent styling and alignment), not one concatenated string.
      expect(await screen.findByText('Explore')).toBeTruthy();
      expect(screen.getByText('Explore aggregate pipeline')).toBeTruthy();
      expect(screen.getByText('85')).toBeTruthy();
      expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
      expect(screen.getByText(/tracked separately from the session total above/)).toBeTruthy();

      fireEvent.click(screen.getByText('Hide'));
      expect(screen.queryByText('Explore aggregate pipeline')).toBeNull();
    });

    it('tells a daemon that lacks the subagent route apart from a session with genuinely no subagents', async () => {
      const session = daemonSession({ sessionId: 's1', projectPath: '/proj-a', totalTokens: 1000 });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        // An older, already-paired daemon simply doesn't have this route yet.
        if (requested.includes('/sessions/s1/subagents')) return jsonResponse({ error: 'not_found' }, 404);
        if (requested.includes('/aggregate?by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
        if (requested.includes('/aggregate?by=model')) return jsonResponse({ models: [] });
        if (requested.includes('/sessions')) return jsonResponse({ sessions: [session], totals: zeroTotals });
        return jsonResponse({});
      });

      render(<CliTab />);
      await screen.findByText('By session');
      fireEvent.click(screen.getByText('Show'));

      expect(await screen.findByText(/older version that doesn.t support it yet/)).toBeTruthy();
      // Must not read as a confirmed, genuine zero-subagent result.
      expect(screen.queryByText('No subagent activity observed for this session.')).toBeNull();
    });
  });
});
