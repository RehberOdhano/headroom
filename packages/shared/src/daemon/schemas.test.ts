import { describe, expect, it } from 'vitest';
import {
  daemonDailyReportSchema,
  daemonModelAggregateResponseSchema,
  daemonProjectDailyReportSchema,
  daemonSearchResponseSchema,
  daemonSessionsReportSchema,
} from './schemas.js';

// Representative shapes, not real conversation content — hand-authored rather than captured,
// since real captures would be private session history.

const totals = {
  cacheCreationTokens: 100,
  cacheReadTokens: 50,
  inputTokens: 10,
  outputTokens: 20,
  totalCost: 0.5,
  totalTokens: 180,
};

const modelBreakdown = {
  cacheCreationTokens: 100,
  cacheReadTokens: 50,
  cost: 0.5,
  inputTokens: 10,
  modelName: 'claude-sonnet-5',
  outputTokens: 20,
};

describe('daemonSessionsReportSchema', () => {
  it('parses a /sessions response', () => {
    const result = daemonSessionsReportSchema.safeParse({
      sessions: [
        {
          cacheCreationTokens: 100,
          cacheReadTokens: 50,
          firstActivity: '2026-08-20T10:00:00.000Z',
          inputTokens: 10,
          lastActivity: '2026-08-20T10:05:00.000Z',
          modelBreakdowns: [modelBreakdown],
          modelsUsed: ['claude-sonnet-5'],
          outputTokens: 20,
          projectPath: '/fixtures/project',
          sessionId: '00000000-0000-4000-8000-000000000001',
          totalCost: 0.5,
          totalTokens: 180,
        },
      ],
      totals,
    });
    expect(result.success).toBe(true);
  });
});

describe('daemonDailyReportSchema / daemonProjectDailyReportSchema', () => {
  const dailyEntry = { ...totals, date: '2026-08-20', modelBreakdowns: [modelBreakdown], modelsUsed: ['claude-sonnet-5'] };

  it('parses a /aggregate?by=day response', () => {
    expect(daemonDailyReportSchema.safeParse({ daily: [dailyEntry], totals }).success).toBe(true);
  });

  it('parses a /aggregate?by=project response, project keyed by directory name', () => {
    const result = daemonProjectDailyReportSchema.safeParse({
      projects: { '-fixture-project': [dailyEntry] },
      totals,
    });
    expect(result.success).toBe(true);
  });
});

describe('daemonModelAggregateResponseSchema', () => {
  it('parses a /aggregate?by=model response', () => {
    expect(daemonModelAggregateResponseSchema.safeParse({ models: [modelBreakdown] }).success).toBe(true);
  });
});

describe('daemonSearchResponseSchema', () => {
  it('parses a /search response, including null cwd/lastActivity', () => {
    const result = daemonSearchResponseSchema.safeParse({
      matches: [
        { sessionId: 'abc', cwd: null, matchCount: 1, snippet: '…hello…', lastActivity: null },
        { sessionId: 'def', cwd: '/fixtures/project', matchCount: 2, snippet: '…world…', lastActivity: '2026-08-20T10:00:00.000Z' },
      ],
      hasMore: true,
    });
    expect(result.success).toBe(true);
  });

  it('parses an empty match list', () => {
    expect(daemonSearchResponseSchema.safeParse({ matches: [], hasMore: false }).success).toBe(true);
  });

  it('rejects a response missing hasMore (daemon pagination pre-dates this field)', () => {
    expect(daemonSearchResponseSchema.safeParse({ matches: [] }).success).toBe(false);
  });
});
