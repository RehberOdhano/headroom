import { z } from 'zod';

/**
 * Validates the local daemon's HTTP JSON responses (`GET /sessions`, `/aggregate`, `/search`)
 * — a distinct contract from `packages/daemon/src/adapters/ccusage.schemas.ts`, which validates
 * ccusage's own CLI output. The daemon happens to pass ccusage's report shapes straight through
 * today, but the extension shouldn't assume that holds forever just because both packages live
 * in this repo.
 */

/** `GET /config/projects`'s response — real project paths read directly from session
 *  transcripts' own `cwd` field (`findKnownProjectDirs`, packages/daemon/src/adapters/
 *  session-log.ts). Despite the route's `/config/` prefix (a historical holdover from when it
 *  backed the now-removed Guardrails project picker), this is plain session-log reading, used
 *  today by Settings → Diagnostics' project count. */
export const knownProjectSchema = z.object({
  path: z.string(),
  lastActivity: z.string().nullable(),
});

export const knownProjectsResponseSchema = z.object({
  projects: z.array(knownProjectSchema),
});

export type KnownProject = z.infer<typeof knownProjectSchema>;

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

/** `GET /sessions/:id/subagents` — see `packages/daemon/src/adapters/session-log.ts`'s
 *  `SubagentSummary` doc comment for the double-counting caveat: `totalTokens` here is reported
 *  entirely independently of ccusage's own session/project/model totals and must never be
 *  presented as additive to them. */
export const daemonSubagentSummarySchema = z.object({
  agentId: z.string(),
  agentType: z.string().nullable(),
  description: z.string().nullable(),
  toolUseId: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
});

export const daemonSubagentsResponseSchema = z.object({
  subagents: z.array(daemonSubagentSummarySchema),
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
export type DaemonSearchResponse = z.infer<typeof daemonSearchResponseSchema>;
export type DaemonPairResponse = z.infer<typeof daemonPairResponseSchema>;
export type DaemonSubagentSummary = z.infer<typeof daemonSubagentSummarySchema>;
export type DaemonSubagentsResponse = z.infer<typeof daemonSubagentsResponseSchema>;
