import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

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
  message?: { role?: string; content?: unknown };
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

/** Export's version of `extractText`: also embeds `image` blocks as markdown image tags with
 *  the block's own base64 data inlined (`data:` URI) — no dependency on the image-cache file
 *  still existing on disk, and the result stays a single portable file. Drops the placeholder
 *  text blocks that would otherwise duplicate/leak a local path once the real image renders. */
function renderContentForExport(content: unknown): string {
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

export interface SessionSearchMatch {
  sessionId: string;
  /** The session's real working directory, read from the transcript itself. */
  cwd: string | null;
  matchCount: number;
  /** First match, with ~40 chars of context on each side. */
  snippet: string;
  lastActivity: string | null;
}

export interface SessionSearchPage {
  matches: SessionSearchMatch[];
  /** True when more matches exist past this page's `offset + limit` — computed from the full
   *  in-memory match list before slicing, so it's exact, not an "is this page full?" guess. */
  hasMore: boolean;
}

/**
 * `offset`/`limit` paginate a search that always recomputes the full match list from every
 * session file on each call (no persisted index) — a real cost for a large history, but the
 * simplest correct thing given this reads raw JSONL fresh every time. Matches are stable
 * across calls with the same query as long as no session file changes mid-pagination, which
 * is the same assumption unpaginated search already made.
 */
export function searchSessions(claudeConfigDir: string, query: string, limit = 20, offset = 0): SessionSearchPage {
  const needle = query.toLowerCase();
  const matches: SessionSearchMatch[] = [];

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
 *  running `claude --resume <id>` then `/export` in a terminal, without needing one open. */
export function exportSessionMarkdown(claudeConfigDir: string, sessionId: string): string | null {
  const file = findSessionFiles(claudeConfigDir).find((f) => f.sessionId === sessionId);
  if (!file) return null;

  const lines = ['# Claude Code session', ''];
  for (const entry of readTranscriptLines(file.filePath)) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (!entry.message) continue;
    const text = renderContentForExport(entry.message.content).trim();
    if (!text) continue;
    const heading = entry.type === 'user' ? '## User' : '## Assistant';
    lines.push(heading, '', text, '');
  }
  return lines.join('\n');
}
