import { describe, expect, it } from 'vitest';
import { findAnomalousSessions, medianSessionCost } from './session-anomaly.js';
import type { DaemonSession } from '../daemon/schemas.js';

function session(overrides: Partial<DaemonSession>): DaemonSession {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    firstActivity: '2026-01-01T00:00:00Z',
    inputTokens: 100,
    lastActivity: '2026-01-01T01:00:00Z',
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

describe('findAnomalousSessions', () => {
  it('returns nothing for an empty list', () => {
    expect(findAnomalousSessions([])).toEqual([]);
  });

  it('flags a session costing far more than the median', () => {
    const sessions = [
      session({ sessionId: 'a', totalCost: 1 }),
      session({ sessionId: 'b', totalCost: 1.2 }),
      session({ sessionId: 'c', totalCost: 0.9 }),
      session({ sessionId: 'd', totalCost: 15 }),
    ];
    expect(findAnomalousSessions(sessions).map((s) => s.sessionId)).toEqual(['d']);
  });

  it('does not flag anything when costs are all similar', () => {
    const sessions = [session({ sessionId: 'a', totalCost: 2 }), session({ sessionId: 'b', totalCost: 2.5 }), session({ sessionId: 'c', totalCost: 1.8 })];
    expect(findAnomalousSessions(sessions)).toEqual([]);
  });

  it('applies the floor so a cheap window does not flag everything', () => {
    // median is 0.01, 5x that is 0.05 — without a floor, a $1 session in an otherwise-tiny
    // window would look anomalous even though $1 is unremarkable in absolute terms.
    const sessions = [session({ sessionId: 'a', totalCost: 0.01 }), session({ sessionId: 'b', totalCost: 0.01 }), session({ sessionId: 'c', totalCost: 1 })];
    expect(findAnomalousSessions(sessions)).toEqual([]);
  });

  it('a custom floor can make a session flag that the default floor would not', () => {
    const sessions = [session({ sessionId: 'a', totalCost: 0.01 }), session({ sessionId: 'b', totalCost: 0.01 }), session({ sessionId: 'c', totalCost: 1 })];
    expect(findAnomalousSessions(sessions, { minFloor: 0.5 }).map((s) => s.sessionId)).toEqual(['c']);
  });
});

describe('medianSessionCost', () => {
  it('returns 0 for an empty list', () => {
    expect(medianSessionCost([])).toBe(0);
  });

  it('averages the two middle values for an even-length list', () => {
    const sessions = [session({ totalCost: 1 }), session({ totalCost: 3 })];
    expect(medianSessionCost(sessions)).toBe(2);
  });

  it('returns the middle value for an odd-length list, order-independent', () => {
    const sessions = [session({ totalCost: 20 }), session({ totalCost: 1 }), session({ totalCost: 1.2 })];
    expect(medianSessionCost(sessions)).toBe(1.2);
  });
});
