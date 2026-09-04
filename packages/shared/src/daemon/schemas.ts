import { z } from 'zod';

/**
 * Validates the local daemon's HTTP JSON responses (`GET /sessions`, `/aggregate`, `/search`)
 * — a distinct contract from `packages/daemon/src/adapters/ccusage.schemas.ts`, which validates
 * ccusage's own CLI output. The daemon happens to pass ccusage's report shapes straight through
 * today, but the extension shouldn't assume that holds forever just because both packages live
 * in this repo.
 */

const modelBreakdownSchema = z.object({
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
  inputTokens: z.number(),
  modelName: z.string(),
  outputTokens: z.number(),
});

const totalsSchema = z.object({
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalCost: z.number(),
  totalTokens: z.number(),
});

export const daemonSessionSchema = z.object({
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  firstActivity: z.string(),
  inputTokens: z.number(),
  lastActivity: z.string(),
  modelBreakdowns: z.array(modelBreakdownSchema),
  modelsUsed: z.array(z.string()),
  outputTokens: z.number(),
  projectPath: z.string(),
  sessionId: z.string(),
  totalCost: z.number(),
  totalTokens: z.number(),
});

export const daemonSessionsReportSchema = z.object({
  sessions: z.array(daemonSessionSchema),
  totals: totalsSchema,
});

const dailyEntrySchema = z.object({
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  date: z.string(),
  inputTokens: z.number(),
  modelBreakdowns: z.array(modelBreakdownSchema),
  modelsUsed: z.array(z.string()),
  outputTokens: z.number(),
  project: z.string().optional(),
  totalCost: z.number(),
  totalTokens: z.number(),
});

export const daemonDailyReportSchema = z.object({
  daily: z.array(dailyEntrySchema),
  totals: totalsSchema,
});

export const daemonProjectDailyReportSchema = z.object({
  projects: z.record(z.string(), z.array(dailyEntrySchema)),
  totals: totalsSchema,
});

export const daemonModelAggregateResponseSchema = z.object({
  models: z.array(modelBreakdownSchema),
});

export const daemonSearchMatchSchema = z.object({
  sessionId: z.string(),
  cwd: z.string().nullable(),
  matchCount: z.number(),
  snippet: z.string(),
  lastActivity: z.string().nullable(),
});

export const daemonSearchResponseSchema = z.object({
  matches: z.array(daemonSearchMatchSchema),
  /** True when more matches exist past this page's `offset + limit` (daemon's `?offset`/`?limit`
   *  pagination on `/search`) — lets the UI show a "Load more" control without a separate count. */
  hasMore: z.boolean(),
});

/** `POST /pair`'s success body — the auto-pairing handshake (packages/daemon/src/app.ts,
 *  src/auth.ts) that hands the extension its token without a manual copy-paste. */
export const daemonPairResponseSchema = z.object({
  token: z.string(),
});

export type DaemonSession = z.infer<typeof daemonSessionSchema>;
export type DaemonSessionsReport = z.infer<typeof daemonSessionsReportSchema>;
export type DaemonDailyReport = z.infer<typeof daemonDailyReportSchema>;
export type DaemonProjectDailyReport = z.infer<typeof daemonProjectDailyReportSchema>;
export type DaemonModelAggregate = z.infer<typeof modelBreakdownSchema>;
export type DaemonSearchMatch = z.infer<typeof daemonSearchMatchSchema>;
export type DaemonPairResponse = z.infer<typeof daemonPairResponseSchema>;
