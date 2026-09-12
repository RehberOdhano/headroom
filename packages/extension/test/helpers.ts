import type { DaemonSession } from '@headroom/shared';

export function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(String(body)) } as Response;
}

export const zeroTotals = { totalTokens: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

export function daemonSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    firstActivity: '2026-08-01T00:00:00Z',
    inputTokens: 100,
    lastActivity: '2026-08-01T01:00:00Z',
    modelBreakdowns: [],
    modelsUsed: [],
    outputTokens: 50,
    projectPath: '-fixture-project',
    sessionId: 'session-1',
    totalCost: 1,
    totalTokens: 150,
    ...overrides,
  };
}
