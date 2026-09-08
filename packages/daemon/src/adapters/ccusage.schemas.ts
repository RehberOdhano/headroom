import { z } from 'zod';

// Shapes confirmed by spawning ccusage@20.0.20 (pinned, see package.json) against
// packages/daemon/fixtures/claude-dir and inspecting real stdout. Not from any docs —
// ccusage publishes no JSON schema for its CLI output.

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

export const sessionSchema = z.object({
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

export const sessionsReportSchema = z.object({
  sessions: z.array(sessionSchema),
  totals: totalsSchema,
});

// Shared by `ccusage claude daily --json` (no `project` key) and
// `ccusage claude daily --instances --json` (adds `project`, nested under a
// `projects` map keyed by project path instead of a flat `daily` array).
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

export const dailyReportSchema = z.object({
  daily: z.array(dailyEntrySchema),
  totals: totalsSchema,
});

export const projectDailyReportSchema = z.object({
  projects: z.record(z.string(), z.array(dailyEntrySchema)),
  totals: totalsSchema,
});

export type Session = z.infer<typeof sessionSchema>;
export type SessionsReport = z.infer<typeof sessionsReportSchema>;
export type DailyReport = z.infer<typeof dailyReportSchema>;
export type ProjectDailyReport = z.infer<typeof projectDailyReportSchema>;
export type ModelBreakdown = z.infer<typeof modelBreakdownSchema>;
