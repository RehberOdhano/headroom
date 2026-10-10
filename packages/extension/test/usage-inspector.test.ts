import { describe, expect, it, vi } from 'vitest';
import { formatUsageInspectorFindings, loadUsageInspector } from '../lib/usage-inspector.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { daemonSession, jsonResponse, zeroTotals } from './helpers.js';

const SETTINGS = { ...DEFAULT_SETTINGS, daemonUrl: 'http://127.0.0.1:4317', daemonToken: 'test-token' };

describe('loadUsageInspector', () => {
  it('returns null when the daemon cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await loadUsageInspector(SETTINGS, '2026-08-29T14:10:00Z', '2026-08-29T15:05:00Z');
    expect(result).toBeNull();
  });

  it('correlates real sessions overlapping the window', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        sessions: [
          daemonSession({
            sessionId: 's1',
            projectPath: 'payments-api',
            firstActivity: '2026-08-29T14:20:00Z',
            lastActivity: '2026-08-29T14:40:00Z',
            totalTokens: 500,
          }),
          daemonSession({
            sessionId: 's2',
            projectPath: 'unrelated',
            firstActivity: '2026-08-28T09:00:00Z',
            lastActivity: '2026-08-28T09:30:00Z',
            totalTokens: 9999,
          }),
        ],
        totals: zeroTotals,
      }),
    );

    const result = await loadUsageInspector(SETTINGS, '2026-08-29T14:10:00Z', '2026-08-29T15:05:00Z');
    expect(result?.hasLocalActivity).toBe(true);
    expect(result?.totalObservedTokens).toBe(500); // only the overlapping session counted
  });
});

describe('formatUsageInspectorFindings', () => {
  it('says explicitly when no local activity was observed, without implying an error', () => {
    const lines = formatUsageInspectorFindings({
      windowStart: '2026-08-29T14:10:00Z',
      windowEnd: '2026-08-29T15:05:00Z',
      hasLocalActivity: false,
      totalObservedTokens: 0,
      projectShares: [],
      modelShares: [],
      largestSessions: [],
    });
    expect(lines).toEqual([
      'Headroom did not observe local Claude Code activity matching this increase. Usage from claude.ai or other unobserved sources may have contributed.',
    ]);
  });

  it('never uses causal wording', () => {
    const lines = formatUsageInspectorFindings({
      windowStart: '2026-08-29T14:10:00Z',
      windowEnd: '2026-08-29T15:05:00Z',
      hasLocalActivity: true,
      totalObservedTokens: 1000,
      projectShares: [{ key: 'payments-api', tokens: 480, sharePercent: 48 }],
      modelShares: [{ key: 'claude-opus-5', tokens: 710, sharePercent: 71 }],
      largestSessions: [{ sessionId: 's1', projectPath: 'payments-api', tokens: 480 }],
    });
    const joined = lines.join(' ');
    expect(joined).not.toMatch(/caused/i);
    expect(joined).not.toMatch(/responsible for/i);
    expect(joined).not.toMatch(/consumed \d+% of your weekly limit/i);
    expect(joined).toContain('Largest local contributor observed during this period: payments-api (48%');
    expect(joined).toContain('Correlated local activity by model: claude-opus-5 71%');
  });
});
