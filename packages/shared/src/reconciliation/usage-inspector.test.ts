import { describe, expect, it } from 'vitest';
import { correlateLocalActivity, type SessionOverlapInput } from './usage-inspector.js';

function session(overrides: Partial<SessionOverlapInput> = {}): SessionOverlapInput {
  return {
    sessionId: 'session-1',
    projectPath: '/fixtures/project-a',
    firstActivity: '2026-08-29T14:00:00Z',
    lastActivity: '2026-08-29T14:30:00Z',
    totalTokens: 1000,
    modelBreakdowns: [{ modelName: 'claude-sonnet-5', inputTokens: 600, outputTokens: 400 }],
    ...overrides,
  };
}

const WINDOW_START = '2026-08-29T14:10:00Z';
const WINDOW_END = '2026-08-29T15:05:00Z';

describe('correlateLocalActivity', () => {
  it('reports no local activity, explicitly, when nothing overlaps the window', () => {
    const outside = session({ firstActivity: '2026-08-29T10:00:00Z', lastActivity: '2026-08-29T10:30:00Z' });
    const result = correlateLocalActivity([outside], WINDOW_START, WINDOW_END);
    expect(result.hasLocalActivity).toBe(false);
    expect(result.totalObservedTokens).toBe(0);
    expect(result.projectShares).toEqual([]);
  });

  it('includes a session that starts before the window but ends inside it', () => {
    const s = session({ firstActivity: '2026-08-29T13:50:00Z', lastActivity: '2026-08-29T14:20:00Z' });
    const result = correlateLocalActivity([s], WINDOW_START, WINDOW_END);
    expect(result.hasLocalActivity).toBe(true);
  });

  it('includes a session that starts inside the window but ends after it', () => {
    const s = session({ firstActivity: '2026-08-29T14:50:00Z', lastActivity: '2026-08-29T16:00:00Z' });
    const result = correlateLocalActivity([s], WINDOW_START, WINDOW_END);
    expect(result.hasLocalActivity).toBe(true);
  });

  it('excludes a session entirely outside the window on either side', () => {
    const before = session({ firstActivity: '2026-08-29T12:00:00Z', lastActivity: '2026-08-29T13:00:00Z' });
    const after = session({ firstActivity: '2026-08-29T16:00:00Z', lastActivity: '2026-08-29T17:00:00Z' });
    const result = correlateLocalActivity([before, after], WINDOW_START, WINDOW_END);
    expect(result.hasLocalActivity).toBe(false);
  });

  it('aggregates project and model shares across multiple overlapping sessions', () => {
    const sessions = [
      session({
        sessionId: 's1',
        projectPath: 'payments-api',
        totalTokens: 480,
        modelBreakdowns: [{ modelName: 'claude-opus-5', inputTokens: 300, outputTokens: 180 }],
      }),
      session({
        sessionId: 's2',
        projectPath: 'auth-service',
        totalTokens: 520,
        modelBreakdowns: [{ modelName: 'claude-sonnet-5', inputTokens: 300, outputTokens: 220 }],
      }),
    ];
    const result = correlateLocalActivity(sessions, WINDOW_START, WINDOW_END);

    expect(result.totalObservedTokens).toBe(1000);
    expect(result.projectShares[0]).toMatchObject({ key: 'auth-service', tokens: 520, sharePercent: 52 });
    expect(result.projectShares[1]).toMatchObject({ key: 'payments-api', tokens: 480, sharePercent: 48 });
    expect(result.modelShares.find((m) => m.key === 'claude-opus-5')).toMatchObject({ tokens: 480, sharePercent: 48 });
  });

  it('reports up to the 3 largest overlapping sessions by token volume, not all of them', () => {
    const sessions = [
      session({ sessionId: 's1', totalTokens: 100 }),
      session({ sessionId: 's2', totalTokens: 900 }),
      session({ sessionId: 's3', totalTokens: 500 }),
      session({ sessionId: 's4', totalTokens: 300 }),
    ];
    const result = correlateLocalActivity(sessions, WINDOW_START, WINDOW_END);
    expect(result.largestSessions).toHaveLength(3);
    expect(result.largestSessions.map((s) => s.sessionId)).toEqual(['s2', 's3', 's4']);
  });
});
