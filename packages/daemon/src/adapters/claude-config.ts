import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, ClaudeConfigSnapshot, ClaudeMdFile, HookEntry, PermissionEffect, SettingsLayer, SkillSummary } from '@headroom/shared';

/**
 * Reads (and, for `settings.local.json` only, writes) Claude Code's local configuration:
 * permission rules, hooks, and skills. Everything here is read-only except
 * `writePermissionRule`/`removePermissionRule`, which touch nothing but a project's
 * `.claude/settings.local.json` — never the shared `settings.json` (project or global). A
 * browser-reachable UI must never silently rewrite a file a team commits and reviews.
 *
 * Every read here fails soft (missing file, invalid JSON, or an unexpected shape all resolve to
 * an empty/absent result) rather than throwing — this reads files a human hand-edits, unlike
 * ccusage's own structured `--json` output.
 */

/**
 * Every `/config*` route accepts `projectDir` as a plain client-supplied string — there's no
 * "current project" the daemon can derive on its own. Without this check, an absent/relative/
 * nonexistent `projectDir` would still be handed straight to `path.join()`, meaning a request
 * could touch a path outside any real project (a relative `projectDir` resolves against the
 * daemon *process's* cwd, not any project) or one that doesn't exist at all. This doesn't defend
 * against a caller who already holds the bearer token and wants to target a directory it has
 * real write access to — every route accepts that same trust boundary — it defends against a
 * `projectDir` that's simply wrong (malformed, relative, or already-gone) silently doing
 * something instead of failing loudly with 400.
 */
export function isValidProjectDir(projectDir: string): boolean {
  if (!path.isAbsolute(projectDir)) return false;
  try {
    return statSync(projectDir).isDirectory();
  } catch {
    return false;
  }
}

function emptyLayer(filePath: string): SettingsLayer {
  return { path: filePath, exists: false, defaultMode: null, allow: [], ask: [], deny: [] };
}

/** The one guard every "does this JSON key look like an object?" check in this file reduces to. */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    return asPlainObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Reads one settings file's `permissions` key. Returns an "absent" layer (not a thrown error)
 *  for a missing file, invalid JSON, or a `permissions` key that isn't an object. */
export function readSettingsLayer(filePath: string): SettingsLayer {
  const parsed = readJsonObject(filePath);
  if (!parsed) return emptyLayer(filePath);

  const permissions = asPlainObject(parsed.permissions);
  if (!permissions) {
    return { ...emptyLayer(filePath), exists: true };
  }
  return {
    path: filePath,
    exists: true,
    defaultMode: typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null,
    allow: toStringArray(permissions.allow),
    ask: toStringArray(permissions.ask),
    deny: toStringArray(permissions.deny),
  };
}

/** Flattens one settings file's `hooks` object (`{EventName: [{matcher?, hooks: [{command, ...}]}]}`)
 *  into a flat list, each entry tagged with `source` so the UI can show which file it came from. */
export function readHooksLayer(filePath: string): HookEntry[] {
  const parsed = readJsonObject(filePath);
  if (!parsed) return [];
  const hooks = asPlainObject(parsed.hooks);
  if (!hooks) return [];

  const entries: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const groupObj = asPlainObject(group);
      if (!groupObj) continue;
      const matcher = typeof groupObj.matcher === 'string' ? groupObj.matcher : null;
      const commandList = Array.isArray(groupObj.hooks) ? groupObj.hooks : [];
      for (const hook of commandList) {
        const hookObj = asPlainObject(hook);
        if (!hookObj || typeof hookObj.command !== 'string') continue;
        entries.push({
          event,
          matcher,
          command: hookObj.command,
          timeout: typeof hookObj.timeout === 'number' ? hookObj.timeout : null,
          statusMessage: typeof hookObj.statusMessage === 'string' ? hookObj.statusMessage : null,
          source: filePath,
        });
      }
    }
  }
  return entries;
}

/** A `SKILL.md`'s YAML frontmatter is, in every real example seen so far, flat scalar/comma-list
 *  fields (`name`, `description`, `argument-hint`, `allowed-tools`) — this hand-rolled parser
 *  covers exactly that, deliberately not a full YAML parser. Returns null for anything that
 *  doesn't look like `---\n...\n---` frontmatter, so a malformed skill is skipped, not thrown. */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return fields;
}

function readSkillsFromDir(skillsDir: string): SkillSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    const skillMdPath = path.join(skillsDir, entry, 'SKILL.md');
    let raw: string;
    try {
      raw = readFileSync(skillMdPath, 'utf-8');
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    if (!frontmatter?.name || !frontmatter.description) continue;
    skills.push({
      name: frontmatter.name,
      description: frontmatter.description,
      argumentHint: frontmatter['argument-hint'] ?? null,
      allowedTools: frontmatter['allowed-tools']
        ? frontmatter['allowed-tools'].split(',').map((tool) => tool.trim()).filter(Boolean)
        : null,
      path: skillMdPath,
    });
  }
  return skills;
}

/** Project skills (`<projectDir>/.claude/skills/*\/SKILL.md`) plus global personal skills
 *  (`<claudeConfigDir>/skills/*\/SKILL.md`) — not plugin-installed skills, whose storage location
 *  is unverified (deliberately not built, same as other "no real fixture yet" gaps in this repo). */
export function readSkills(projectDir: string | undefined, claudeConfigDir: string): SkillSummary[] {
  const results: SkillSummary[] = [];
  if (projectDir) results.push(...readSkillsFromDir(path.join(projectDir, '.claude', 'skills')));
  results.push(...readSkillsFromDir(path.join(claudeConfigDir, 'skills')));
  return results;
}

/** Unlike skills, a subagent definition is one flat `<name>.md` directly inside the agents
 *  directory — no per-agent subfolder. Reuses the same `parseFrontmatter()` as skills (same flat
 *  scalar-field YAML shape). Only `name`, `description`, and `model` are surfaced —
 *  `tools`/`disallowedTools` and the system-prompt body are left unparsed since model routing is
 *  all this reads them for. */
function readAgentsFromDir(agentsDir: string, scope: AgentDefinition['scope']): AgentDefinition[] {
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(agentsDir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    if (!frontmatter?.name) continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description ?? '',
      model: frontmatter.model ?? null,
      path: filePath,
      scope,
    });
  }
  return agents;
}

/** Project subagents (`<projectDir>/.claude/agents/*.md`, editable — see `writeAgentModel`)
 *  plus global personal ones (`<claudeConfigDir>/agents/*.md`, read-only: writes never touch
 *  global/shared config, same restraint as permission overrides). */
export function readAgentDefinitions(projectDir: string | undefined, claudeConfigDir: string): AgentDefinition[] {
  const results: AgentDefinition[] = [];
  if (projectDir) results.push(...readAgentsFromDir(path.join(projectDir, '.claude', 'agents'), 'project'));
  results.push(...readAgentsFromDir(path.join(claudeConfigDir, 'agents'), 'global'));
  return results;
}

export function readClaudeConfigSnapshot({
  claudeConfigDir,
  projectDir,
}: {
  claudeConfigDir: string;
  projectDir?: string;
}): ClaudeConfigSnapshot {
  const globalSettingsPath = path.join(claudeConfigDir, 'settings.json');
  const global = readSettingsLayer(globalSettingsPath);
  const hooks = [...readHooksLayer(globalSettingsPath)];

  let project: SettingsLayer | null = null;
  let local: SettingsLayer | null = null;
  if (projectDir) {
    const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
    const localSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');
    project = readSettingsLayer(projectSettingsPath);
    local = readSettingsLayer(localSettingsPath);
    hooks.push(...readHooksLayer(projectSettingsPath), ...readHooksLayer(localSettingsPath));
  }

  return {
    global,
    project,
    local,
    hooks,
    skills: readSkills(projectDir, claudeConfigDir),
    agents: readAgentDefinitions(projectDir, claudeConfigDir),
  };
}

/** Read-modify-write on `<projectDir>/.claude/settings.local.json` only — never `settings.json`
 *  (project or global). Removes `pattern` from whichever of allow/ask/deny currently holds it
 *  before adding it to `effect`'s array, so one pattern can't end up listed under two conflicting
 *  effects; every other key in the file is preserved untouched. Starts from `{}` if the file is
 *  missing or not valid JSON — there's nothing safe to preserve from content that doesn't parse. */
export function writePermissionRule({
  projectDir,
  pattern,
  effect,
}: {
  projectDir: string;
  pattern: string;
  effect: PermissionEffect;
}): SettingsLayer {
  const dir = path.join(projectDir, '.claude');
  const filePath = path.join(dir, 'settings.local.json');
  mkdirSync(dir, { recursive: true });

  const parsed = readJsonObject(filePath) ?? {};
  const permissions = asPlainObject(parsed.permissions) ?? {};

  const allow = toStringArray(permissions.allow).filter((existing) => existing !== pattern);
  const ask = toStringArray(permissions.ask).filter((existing) => existing !== pattern);
  const deny = toStringArray(permissions.deny).filter((existing) => existing !== pattern);
  (effect === 'allow' ? allow : effect === 'ask' ? ask : deny).push(pattern);

  parsed.permissions = { ...permissions, allow, ask, deny };
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  return readSettingsLayer(filePath);
}

/** Removes `pattern` from `effect`'s array in `settings.local.json` only. A rule that only
 *  exists in `settings.json` (project or global) can't be removed here — there's nothing in
 *  `settings.local.json` to remove — so this is a no-op returning the layer unchanged; the UI
 *  is expected to label such a rule "defined elsewhere" rather than offer to remove it. */
export function removePermissionRule({
  projectDir,
  pattern,
  effect,
}: {
  projectDir: string;
  pattern: string;
  effect: PermissionEffect;
}): SettingsLayer {
  const filePath = path.join(projectDir, '.claude', 'settings.local.json');
  const parsed = readJsonObject(filePath);
  if (!parsed) return readSettingsLayer(filePath);

  const permissions = asPlainObject(parsed.permissions);
  if (!permissions) return readSettingsLayer(filePath);
  const current = toStringArray(permissions[effect]);
  if (!current.includes(pattern)) return readSettingsLayer(filePath);

  parsed.permissions = { ...permissions, [effect]: current.filter((entry) => entry !== pattern) };
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  return readSettingsLayer(filePath);
}

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.output', '.wxt', 'coverage']);
const MAX_CLAUDE_MD_FILES = 200;

/** Recursively finds every file literally named `CLAUDE.md` under `projectDir`, skipping common
 *  noise directories. Capped at `MAX_CLAUDE_MD_FILES` to bound cost on a very large repo. */
export function findClaudeMdFiles(projectDir: string): ClaudeMdFile[] {
  const results: ClaudeMdFile[] = [];

  function walk(dir: string): void {
    if (results.length >= MAX_CLAUDE_MD_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_CLAUDE_MD_FILES) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'CLAUDE.md') {
        const fullPath = path.join(dir, entry.name);
        results.push({ path: fullPath, relativePath: path.relative(projectDir, fullPath) });
      }
    }
  }

  walk(projectDir);
  return results;
}

/** Re-derives the allowed set via `findClaudeMdFiles` and only reads `requestedPath` if it's a
 *  member of that set — a client-supplied path is never trusted directly, which is what stops a
 *  crafted `?path=` from reading an arbitrary file outside the project. */
export function readClaudeMdContent(projectDir: string, requestedPath: string): string | null {
  const allowed = findClaudeMdFiles(projectDir).some((file) => file.path === requestedPath);
  if (!allowed) return null;
  try {
    return readFileSync(requestedPath, 'utf-8');
  } catch {
    return null;
  }
}

/** The daemon's second write path (alongside `writePermissionRule`/`removePermissionRule`),
 *  backing the Guardrails tab's CLAUDE.md editor. Deliberately reuses the exact same
 *  enumerate-then-check-membership guard as `readClaudeMdContent` — a client-supplied path is
 *  never trusted directly for a write any more than for a read, so this can only ever overwrite
 *  a file `findClaudeMdFiles` already found for real under `projectDir`, never an arbitrary path.
 *  No backup/versioning beyond whatever the file's own git history provides — this overwrites
 *  unconditionally, the same simplicity level as the permission-rule writes. */
export function writeClaudeMdContent(projectDir: string, requestedPath: string, content: string): boolean {
  const allowed = findClaudeMdFiles(projectDir).some((file) => file.path === requestedPath);
  if (!allowed) return false;
  writeFileSync(requestedPath, content, 'utf-8');
  return true;
}

/** Sets `key: value` inside a `---\n...\n---` frontmatter block only — replaces the line if
 *  `key:` already appears there, otherwise appends one just before the closing `---`. Every
 *  other line (other frontmatter fields, and the entire body below the block) passes through
 *  byte-for-byte untouched: this is a targeted line edit, not a YAML round-trip, so a subagent's
 *  `tools`/`disallowedTools`/system-prompt body can never be silently reformatted or dropped by
 *  writing its `model:` field. Returns null (refuses to write) if `content` doesn't start with
 *  recognizable frontmatter at all. */
function setFrontmatterField(content: string, key: string, value: string): string | null {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content);
  if (!match) return null;
  const open = match[1] ?? '';
  const body = match[2] ?? '';
  const close = match[3] ?? '';

  const keyLine = new RegExp(`^${key}:.*$`);
  let replaced = false;
  const lines = body.split(/\r?\n/).map((line) => {
    if (keyLine.test(line)) {
      replaced = true;
      return `${key}: ${value}`;
    }
    return line;
  });
  if (!replaced) lines.push(`${key}: ${value}`);

  return content.slice(0, match.index) + open + lines.join('\n') + close + content.slice(match.index + match[0].length);
}

/**
 * Edits only a project-level subagent's `model:` frontmatter field — never a global
 * `~/.claude/agents/*.md` one (same restraint as permission overrides: this daemon never writes
 * to config outside the one project it's been told about). Same enumerate-then-check-membership
 * guard as `writeClaudeMdContent`: re-derives the real project-scope agent files fresh and
 * refuses anything that isn't an exact match, so a crafted `path` can't target a file outside
 * `<projectDir>/.claude/agents/`. Unlike CLAUDE.md this is a real, team-committed file too (the
 * same trade-off already accepted for CLAUDE.md edits) — protected only by an explicit save on
 * the client side and the project's own git history, not by redirecting to a gitignored copy.
 */
export function writeAgentModel({
  projectDir,
  requestedPath,
  model,
}: {
  projectDir: string;
  requestedPath: string;
  model: string;
}): AgentDefinition | null {
  const allowed = readAgentsFromDir(path.join(projectDir, '.claude', 'agents'), 'project').some(
    (agent) => agent.path === requestedPath,
  );
  if (!allowed) return null;

  const raw = readFileSync(requestedPath, 'utf-8');
  const updated = setFrontmatterField(raw, 'model', model);
  if (updated === null) return null;
  writeFileSync(requestedPath, updated, 'utf-8');

  const frontmatter = parseFrontmatter(updated);
  if (!frontmatter?.name) return null;
  return { name: frontmatter.name, description: frontmatter.description ?? '', model: frontmatter.model ?? null, path: requestedPath, scope: 'project' };
}
