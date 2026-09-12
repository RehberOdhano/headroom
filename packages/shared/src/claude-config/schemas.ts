import { z } from 'zod';

/**
 * Validates the local daemon's `/config*` HTTP JSON responses (`GET /config`,
 * `/config/projects`, `/config/claude-md`, `/config/claude-md/content`) — Claude Code's own
 * local configuration (permission rules, hooks, skills, CLAUDE.md docs), not usage data. A
 * distinct contract from `../daemon/schemas.ts` (ccusage-derived usage/session data).
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

/** A subagent definition's model routing (`<projectDir>/.claude/agents/*.md` or
 *  `<claudeConfigDir>/agents/*.md`) — `model` is whatever the frontmatter's `model:` field says
 *  verbatim (`inherit`, `opus`, `sonnet`, `haiku`, a full model id, or absent/null), never
 *  interpreted or defaulted here. `scope` distinguishes a project's own agents (editable) from
 *  global personal ones (shown read-only) — writes never touch shared/global config. */
export const agentDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string().nullable(),
  path: z.string(),
  scope: z.enum(['project', 'global']),
});

export const claudeConfigSnapshotSchema = z.object({
  global: settingsLayerSchema,
  project: settingsLayerSchema.nullable(),
  local: settingsLayerSchema.nullable(),
  hooks: z.array(hookEntrySchema),
  skills: z.array(skillSummarySchema),
  // `.default([])`, not a bare required array: the daemon is a long-running process that only
  // picks up a code change on restart (`launchctl kickstart ...`), so an extension rebuilt with
  // a newer shared schema will otherwise briefly talk to an older daemon whose response has no
  // `agents` key at all — that mismatch surfaced for real as "Daemon response did not match the
  // expected shape" across the *whole* Guardrails snapshot (permissions/hooks/skills included),
  // not just the new field. Defaulting keeps that skew from taking down everything else.
  agents: z.array(agentDefinitionSchema).default([]),
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
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type ClaudeConfigSnapshot = z.infer<typeof claudeConfigSnapshotSchema>;
export type KnownProject = z.infer<typeof knownProjectSchema>;
export type ClaudeMdFile = z.infer<typeof claudeMdFileSchema>;
