import { describe, expect, it, vi } from 'vitest';
import { loadWhatChanged } from '../lib/what-changed.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { jsonResponse, zeroTotals } from './helpers.js';

const SETTINGS = { ...DEFAULT_SETTINGS, daemonUrl: 'http://127.0.0.1:4317', daemonToken: 'test-token' };

function dailyReport(totalTokens: number) {
  return { daily: [], totals: { ...zeroTotals, totalTokens } };
}

function projectReport(projects: Record<string, number>) {
  return {
    projects: Object.fromEntries(
      Object.entries(projects).map(([path, tokens]) => [
        path,
        [{ date: '2026-08-01', totalTokens: tokens, cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, modelBreakdowns: [], modelsUsed: [], totalCost: 0 }],
      ]),
    ),
    totals: zeroTotals,
  };
}

function modelReport(models: Record<string, number>) {
  return { models: Object.entries(models).map(([modelName, tokens]) => ({ modelName, inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 })) };
}

function sessionReport() {
  return { sessions: [], totals: zeroTotals };
}

describe('loadWhatChanged', () => {
  it('returns no findings when the daemon has no current-window data', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ error: 'ccusage_failed' }, 502));
    const result = await loadWhatChanged(SETTINGS, new Date('2026-08-29T00:00:00Z').toISOString(), [], new Date('2026-08-25T12:00:00Z'));
    expect(result).toEqual([]);
  });

  it('compares the current elapsed portion against the same elapsed portion of the previous week, not a full prior week', async () => {
    const now = new Date('2026-08-25T12:00:00Z');
    const weeklyResetsAt = new Date('2026-08-29T00:00:00Z').toISOString(); // window started 2026-08-22
    const fetchMock = vi.fn(async (url: string) => {
      const since = new URL(url).searchParams.get('since');
      // The current window starts 2026-08-22; the previous window starts 2026-08-15.
      const isCurrentWindow = since === '20260822';
      const projectTokens = isCurrentWindow ? { 'payments-api': 700, other: 300 } : { 'payments-api': 200, other: 800 };
      if (url.includes('by=day')) return jsonResponse(dailyReport(isCurrentWindow ? 1380 : 1000));
      if (url.includes('by=project')) return jsonResponse(projectReport(projectTokens));
      if (url.includes('by=model')) return jsonResponse(modelReport({}));
      if (url.includes('/sessions')) return jsonResponse(sessionReport());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);

    const findings = await loadWhatChanged(SETTINGS, weeklyResetsAt, [], now);

    const projectFinding = findings.find((f) => f.kind === 'project-share');
    expect(projectFinding?.text).toBe('payments-api share increased from 20% to 51% compared with the same elapsed portion of the previous window.');
    const volumeFinding = findings.find((f) => f.kind === 'cli-volume');
    expect(volumeFinding?.text).toBe('Observed CLI tokens up 38% compared with the same elapsed portion of the previous window.');

    // Confirm the "same elapsed duration" framing: the previous window's `until` must be exactly
    // the current window's elapsed duration (2026-08-25T12:00 - 2026-08-22T00:00 = 3.5 days)
    // past its own start (2026-08-15), landing on 2026-08-18 — never the full previous week.
    const previousCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('by=day') && String(call[0]).includes('since=20260815'));
    expect(previousCall).toBeTruthy();
    expect(String(previousCall![0])).toContain('until=20260818');
  });

  it('includes a server-observed account-usage finding when history reaches back far enough', async () => {
    const now = new Date('2026-08-25T12:00:00Z');
    const weeklyResetsAt = new Date('2026-08-29T00:00:00Z').toISOString();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('by=day')) return jsonResponse(dailyReport(0));
      if (u.includes('by=project')) return jsonResponse(projectReport({}));
      if (u.includes('by=model')) return jsonResponse(modelReport({}));
      if (u.includes('/sessions')) return jsonResponse(sessionReport());
      throw new Error(`unexpected fetch: ${u}`);
    });

    const history = [
      { capturedAt: '2026-08-15T00:00:00Z', percent: 0 }, // previous window start
      { capturedAt: '2026-08-18T00:00:00Z', percent: 12 }, // previous window, same elapsed point
      { capturedAt: '2026-08-22T00:00:00Z', percent: 0 }, // current window start (reset)
      { capturedAt: '2026-08-25T12:00:00Z', percent: 28 }, // now
    ];

    const findings = await loadWhatChanged(SETTINGS, weeklyResetsAt, history, now);
    const accountFinding = findings.find((f) => f.kind === 'account-usage');
    expect(accountFinding?.text).toBe(
      'Weekly usage has moved 28 points so far this window — faster than the 12-point move over the same portion of the previous window.',
    );
  });
});
