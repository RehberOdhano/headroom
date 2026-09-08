import { z } from 'zod';

/**
 * Validates the local daemon's `/config*` HTTP JSON responses (`GET /config`,
 * `/config/projects`, `/config/claude-md`, `/config/claude-md/content`) — Claude Code's own
 * local configuration (permission rules, hooks, skills, CLAUDE.md docs), not usage data. A
 * distinct contract from `../daemon/schemas.ts` (ccusage-derived usage/session data), following
 * the same "every inbound payload gets a zod schema" rule (root CLAUDE.md section 5).
 */

export const permissionEffectSchema = z.enum(['allow', 'ask', 'deny']);

export const permissionRuleSchema = z.object({
  pattern: z.string(),
  effect: permissionEffectSchema,
});

export const settingsLayerSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  defaultMode: z.string().nullable(),
  allow: z.array(z.string()),
  ask: z.array(z.string()),
  deny: z.array(z.string()),
});

export const hookEntrySchema = z.object({
  event: z.string(),
  matcher: z.string().nullable(),
  command: z.string(),
  timeout: z.number().nullable(),
  statusMessage: z.string().nullable(),
  /** Which settings file this hook came from — a real, absolute path, so the UI can show it. */
  source: z.string(),
});

export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().nullable(),
  allowedTools: z.array(z.string()).nullable(),
  path: z.string(),
});

export const claudeConfigSnapshotSchema = z.object({
  global: settingsLayerSchema,
  project: settingsLayerSchema.nullable(),
  local: settingsLayerSchema.nullable(),
  hooks: z.array(hookEntrySchema),
  skills: z.array(skillSummarySchema),
});

export const knownProjectSchema = z.object({
  path: z.string(),
  lastActivity: z.string().nullable(),
});

export const knownProjectsResponseSchema = z.object({
  projects: z.array(knownProjectSchema),
});

export const claudeMdFileSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
});

export const claudeMdListResponseSchema = z.object({
  files: z.array(claudeMdFileSchema),
});

export const claudeMdContentResponseSchema = z.object({
  content: z.string(),
});

export type PermissionEffect = z.infer<typeof permissionEffectSchema>;
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type SettingsLayer = z.infer<typeof settingsLayerSchema>;
export type HookEntry = z.infer<typeof hookEntrySchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type ClaudeConfigSnapshot = z.infer<typeof claudeConfigSnapshotSchema>;
export type KnownProject = z.infer<typeof knownProjectSchema>;
export type ClaudeMdFile = z.infer<typeof claudeMdFileSchema>;
