import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { DaemonSearchMatch, DaemonSearchResponse } from '@headroom/shared';

/**
 * Reads Claude Code's raw per-session JSONL transcripts directly — the one thing ccusage
 * doesn't expose (it only ever reports token/cost aggregates, never message content). No real
 * conversation content is stored anywhere in this codebase; this file only reads it on demand
 * for search/export. A transcript line's `type` is one of many housekeeping values (`mode`,
 * `permission-mode`, `file-history-snapshot`, ...); only `user`/`assistant` lines carry a
 * `message: {role, content}`, where `content` is either a plain string or an array of blocks
 * (`{type: 'text'|'thinking'|'tool_use'|'tool_result'|'image', ...}`).
 *
 * Search only scans `text` blocks (and string content) — tool calls/results and thinking are
 * noise for a human searching their own chat history. Export additionally embeds `image`
 * blocks, which carry the real base64 image bytes inline (`{type: 'image', source: {type,
 * media_type, data}}` — standard Anthropic content-block shape) right there in the JSONL, not
 * just a file reference. Each pasted image also produces two redundant text placeholders
 * alongside the real block ("[Image #1]", and a second turn "[Image: source:
 * /path/to/image-cache/...]") — export drops both once the actual image is embedded, since
 * repeating a local absolute path into a portable markdown file is neither useful nor private.
 */

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    /** Present on assistant lines in both main and subagent transcripts. `'<synthetic>'` is a
     *  real sentinel Claude Code writes for a non-model-generated entry (e.g. a synthesized
     *  turn) — never a second real model; callers reading this for attribution must treat it
     *  (and any other non-string value) as "no model", not as a distinct model name. */
    model?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  timestamp?: string;
  cwd?: string;
}

export interface SessionFile {
  sessionId: string;
  filePath: string;
}

/** Locates every `<projects>/*\/<sessionId>.jsonl` file. Matches by filename, not by decoding
 *  the project directory's name (`-Users-you-projects-my-app`) back into a real path — that
 *  decode is ambiguous whenever a real path segment itself contains a hyphen (very common:
 *  "my-app"). Each transcript line already carries its own real `cwd`, which is what callers
 *  should use instead. */
export function findSessionFiles(claudeConfigDir: string): SessionFile[] {
  const projectsDir = path.join(claudeConfigDir, 'projects');
  const results: SessionFile[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const fullProjectDir = path.join(projectsDir, projectDir);
    let files: string[];
    try {
      files = readdirSync(fullProjectDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        results.push({ sessionId: file.slice(0, -'.jsonl'.length), filePath: path.join(fullProjectDir, file) });
      }
    }
  }

  return results;
}

export interface KnownProjectDir {
  path: string;
  lastActivity: string | null;
}

/** Distinct real `cwd` values seen across every session transcript, each with its latest known
 *  `timestamp` — the source for the Guardrails tab's project picker. Deliberately reuses this
 *  already-vetted transcript-reading path rather than touching `~/.claude.json` (broader,
 *  mode-600 cross-project config unrelated to session history) just to list project paths. */
export function findKnownProjectDirs(claudeConfigDir: string): KnownProjectDir[] {
  const latestByPath = new Map<string, string | null>();

  for (const { filePath } of findSessionFiles(claudeConfigDir)) {
    let cwd: string | null = null;
    let lastActivity: string | null = null;
    for (const entry of readTranscriptLines(filePath)) {
      if (entry.cwd) cwd = entry.cwd;
      if (entry.timestamp) lastActivity = entry.timestamp;
    }
    if (!cwd) continue;
    const existing = latestByPath.get(cwd) ?? null;
    if (!existing || (lastActivity && lastActivity > existing)) {
      latestByPath.set(cwd, lastActivity);
    }
  }

  return [...latestByPath.entries()]
    .map(([dirPath, lastActivity]) => ({ path: dirPath, lastActivity }))
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    })
    .map((block) => block.text)
    .join('\n');
}

/** Matches the two redundant text placeholders Claude Code emits alongside a real `image`
 *  block for a pasted image — see the file-level doc comment. */
function isImagePlaceholderText(text: string): boolean {
  return /^\[Image #\d+\]$/.test(text) || /^\[Image: source: .+\]$/.test(text);
}

const TOOL_SUMMARY_MAX_LENGTH = 200;

function truncateSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TOOL_SUMMARY_MAX_LENGTH ? `${trimmed.slice(0, TOOL_SUMMARY_MAX_LENGTH)}…` : trimmed;
}

/** A `tool_result` block's own `content` is the same string-or-blocks shape as a message's —
 *  reuses `extractText`'s `text`-block-only extraction rather than a second near-duplicate. */
function extractToolResultText(content: unknown): string {
  return extractText(content);
}

/** One-line summaries, not the full call/result — keeps the export readable (this is the
 *  "leave tool calls out to keep it readable" tradeoff, made opt-in instead of permanent). A
 *  `tool_use` block's `input` can be any shape depending on the tool, so it's summarized as
 *  compact JSON rather than guessing at per-tool field names like `file_path` or `command`. */
function renderToolUseSummary(block: { name?: unknown; input?: unknown }): string | null {
  if (typeof block.name !== 'string') return null;
  const inputSummary = block.input !== undefined ? truncateSummary(JSON.stringify(block.input)) : '';
  return `> 🔧 **${block.name}**${inputSummary ? ` \`${inputSummary}\`` : ''}`;
}

function renderToolResultSummary(block: { content?: unknown; is_error?: unknown }): string | null {
  const text = truncateSummary(extractToolResultText(block.content));
  if (!text) return null;
  return `> ${block.is_error === true ? '⚠️' : '↩'} ${text}`;
}

/** Export's version of `extractText`: also embeds `image` blocks as markdown image tags with
 *  the block's own base64 data inlined (`data:` URI) — no dependency on the image-cache file
 *  still existing on disk, and the result stays a single portable file. Drops the placeholder
 *  text blocks that would otherwise duplicate/leak a local path once the real image renders.
 *  `includeToolCalls` additionally renders `tool_use`/`tool_result` blocks as compact one-line
 *  summaries (opt-in — see `exportSessionMarkdown`'s doc comment for why this defaults off). */
function renderContentForExport(content: unknown, includeToolCalls: boolean): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;

    if (type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && !isImagePlaceholderText(text.trim())) parts.push(text);
      continue;
    }

    if (type === 'image') {
      const source = (block as { source?: unknown }).source;
      const mediaType = (source as { media_type?: unknown } | undefined)?.media_type;
      const data = (source as { data?: unknown } | undefined)?.data;
      if (typeof mediaType === 'string' && typeof data === 'string') {
        parts.push(`![](data:${mediaType};base64,${data})`);
      }
      continue;
    }

    if (!includeToolCalls) continue;

    if (type === 'tool_use') {
      const summary = renderToolUseSummary(block as { name?: unknown; input?: unknown });
      if (summary) parts.push(summary);
      continue;
    }

    if (type === 'tool_result') {
      const summary = renderToolResultSummary(block as { content?: unknown; is_error?: unknown });
      if (summary) parts.push(summary);
    }
  }
  return parts.join('\n\n');
}

function readTranscriptLines(filePath: string): TranscriptLine[] {
  const raw = readFileSync(filePath, 'utf-8');
  const lines: TranscriptLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // A truncated final line (session still being written) or a corrupt one — skip it, this
      // is read-only best-effort search, not the source of truth for token accounting.
    }
  }
  return lines;
}

/**
 * `offset`/`limit` paginate a search that always recomputes the full match list from every
 * session file on each call (no persisted index) — a real cost for a large history, but the
 * simplest correct thing given this reads raw JSONL fresh every time. Matches are stable
 * across calls with the same query as long as no session file changes mid-pagination, which
 * is the same assumption unpaginated search already made.
 */
export function searchSessions(claudeConfigDir: string, query: string, limit = 20, offset = 0): DaemonSearchResponse {
  const needle = query.toLowerCase();
  const matches: DaemonSearchMatch[] = [];

  for (const { sessionId, filePath } of findSessionFiles(claudeConfigDir)) {
    let matchCount = 0;
    let snippet = '';
    let cwd: string | null = null;
    let lastActivity: string | null = null;

    for (const entry of readTranscriptLines(filePath)) {
      if (entry.cwd) cwd = entry.cwd;
      if (entry.timestamp) lastActivity = entry.timestamp;
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      if (!entry.message) continue;

      const text = extractText(entry.message.content);
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;

      matchCount += 1;
      if (!snippet) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + needle.length + 40);
        snippet = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
      }
    }

    if (matchCount > 0) matches.push({ sessionId, cwd, matchCount, snippet, lastActivity });
  }

  const sorted = matches.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  return {
    matches: sorted.slice(offset, offset + limit),
    hasMore: sorted.length > offset + limit,
  };
}

/** Renders a session's transcript as readable markdown — the browser-side equivalent of
 *  running `claude --resume <id>` then `/export` in a terminal, without needing one open.
 *  `includeToolCalls` defaults to `false`: tool calls/results (and thinking) are noise for the
 *  common case of re-reading a conversation, so they're left out unless asked for — same
 *  reasoning as `searchSessions` only scanning `text` blocks. When on, each call/result renders
 *  as a compact one-line summary (see `renderToolUseSummary`/`renderToolResultSummary`), not the
 *  full raw input/output, to keep the export readable either way. */
export function exportSessionMarkdown(
  claudeConfigDir: string,
  sessionId: string,
  { includeToolCalls = false }: { includeToolCalls?: boolean } = {},
): string | null {
  const file = findSessionFiles(claudeConfigDir).find((f) => f.sessionId === sessionId);
  if (!file) return null;

  const lines = ['# Claude Code session', ''];
  for (const entry of readTranscriptLines(file.filePath)) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (!entry.message) continue;
    const text = renderContentForExport(entry.message.content, includeToolCalls).trim();
    if (!text) continue;
    const heading = entry.type === 'user' ? '## User' : '## Assistant';
    lines.push(heading, '', text, '');
  }
  return lines.join('\n');
}

export interface SubagentSummary {
  agentId: string;
  /** From the sibling `.meta.json` — `null` when it's missing or malformed rather than guessed. */
  agentType: string | null;
  description: string | null;
  /** Links back to the specific `tool_use` block in the parent transcript that spawned this
   *  agent (verified against real local data — see root CLAUDE.md's subagent-attribution notes).
   *  `null` when the `.meta.json` doesn't have one. */
  toolUseId: string | null;
  /** The one real model observed across this agent's assistant lines, or `null` if none were
   *  found. Real local data never showed more than one genuine model per agent invocation
   *  (the one apparent counter-example was Claude Code's own `'<synthetic>'` sentinel, not a
   *  second model) — this reports the first one found rather than trying to represent multiple. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Sum of the four fields above. Reported entirely independently of ccusage's own
   *  session/project/model totals elsewhere in this codebase — never added to or merged with
   *  them. Real local data gave inconsistent signals on whether ccusage's own totals already
   *  include subagent activity, so this number must never be presented as additive. */
  totalTokens: number;
}

interface SubagentMetaFile {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
}

/** Fail-soft like every other hand-edited-adjacent file this adapter reads — a missing or
 *  malformed `.meta.json` resolves to all-null fields rather than throwing. */
function readSubagentMeta(filePath: string): { agentType: string | null; description: string | null; toolUseId: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as SubagentMetaFile;
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : null,
      description: typeof parsed.description === 'string' ? parsed.description : null,
      toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : null,
    };
  } catch {
    return { agentType: null, description: null, toolUseId: null };
  }
}

/**
 * Every subagent transcript for one session — `<projectDir>/<sessionId>/subagents/agent-*.jsonl`,
 * each with a sibling `agent-*.meta.json` (real structure, confirmed against real local Claude
 * Code data, not the assumed shape an earlier fixture guessed at). `findSessionFiles` never
 * descends into this directory on its own — this is the one place that does, and only when a
 * caller explicitly asks for one session's subagents, never as part of the regular session list.
 * Read-only: nothing here writes anything.
 */
export function findSubagentSummaries(claudeConfigDir: string, sessionId: string): SubagentSummary[] {
  const file = findSessionFiles(claudeConfigDir).find((f) => f.sessionId === sessionId);
  if (!file) return [];

  const subagentsDir = path.join(path.dirname(file.filePath), sessionId, 'subagents');
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return [];
  }

  const summaries: SubagentSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const agentId = entry.slice('agent-'.length, -'.jsonl'.length);
    const meta = readSubagentMeta(path.join(subagentsDir, entry.replace(/\.jsonl$/, '.meta.json')));

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let model: string | null = null;

    for (const line of readTranscriptLines(path.join(subagentsDir, entry))) {
      if (line.type !== 'assistant' || !line.message) continue;
      if (!model && typeof line.message.model === 'string' && line.message.model !== '<synthetic>') {
        model = line.message.model;
      }
      const usage = line.message.usage;
      if (!usage) continue;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    }

    summaries.push({
      agentId,
      agentType: meta.agentType,
      description: meta.description,
      toolUseId: meta.toolUseId,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    });
  }
  return summaries;
}
