import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentUsage, NamedCount, UsagePatterns } from '@headroom/shared';
import { findSessionFiles } from './session-log.js';

/**
 * Reads the same raw `.jsonl` transcripts as `session-log.ts`, but counts *how* Claude Code was
 * used (skills, slash commands, subagent types) rather than searching conversation text — every
 * value extracted here is a structural marker (a name, a count, a token total), never
 * conversation content.
 *
 * Subagent (`Agent` tool) transcripts are **not** inline in a session's own `.jsonl` — Claude
 * Code writes them to `<projectDir>/<sessionId>/subagents/agent-<hash>.jsonl`, a sibling
 * directory named after the session id, never itself a `.jsonl` file. `findSessionFiles()`
 * ignores these on purpose (see its own doc comment); they need their own directory walk.
 */

interface ToolUseBlock {
  type: 'tool_use';
  name?: string;
  input?: { skill?: string };
}

interface UsageNumbers {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptLine {
  type?: string;
  message?: { role?: string; content?: unknown; usage?: UsageNumbers };
  attributionAgent?: string;
}

function readLines(filePath: string): TranscriptLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines: TranscriptLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // Truncated final line or corrupt entry — same best-effort handling as session-log.ts.
    }
  }
  return lines;
}

/** Every `<projectDir>/<sessionId>/subagents/*.jsonl` file across every known project —
 *  `findSessionFiles`'s sibling for the one place it deliberately doesn't look. */
export function findSubagentFiles(claudeConfigDir: string): string[] {
  const projectsDir = path.join(claudeConfigDir, 'projects');
  const results: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const fullProjectDir = path.join(projectsDir, projectDir);
    let sessionEntries: string[];
    try {
      sessionEntries = readdirSync(fullProjectDir);
    } catch {
      continue;
    }
    for (const entry of sessionEntries) {
      const subagentsDir = path.join(fullProjectDir, entry, 'subagents');
      let subagentFiles: string[];
      try {
        subagentFiles = readdirSync(subagentsDir);
      } catch {
        continue;
      }
      for (const file of subagentFiles) {
        if (file.endsWith('.jsonl')) results.push(path.join(subagentsDir, file));
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

const COMMAND_NAME_PATTERN = /<command-name>([^<]+)<\/command-name>/;

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toSortedCounts(counts: Map<string, number>): NamedCount[] {
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/**
 * Skill invocations and slash-command usage, counted from every main session transcript.
 * Deliberately doesn't also scan subagent transcripts for these two facets — a subagent can't
 * itself invoke `/slash-commands` or run `Skill` the way the top-level loop can — so this walk
 * stays separate from `aggregateAgentUsage`'s subagent-only walk below.
 */
function aggregateSkillsAndCommands(claudeConfigDir: string): Pick<UsagePatterns, 'skills' | 'commands'> {
  const skillCounts = new Map<string, number>();
  const commandCounts = new Map<string, number>();

  for (const { filePath } of findSessionFiles(claudeConfigDir)) {
    for (const entry of readLines(filePath)) {
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const content = entry.message?.content;

      if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content as ToolUseBlock[]) {
          if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
            bump(skillCounts, block.input.skill);
          }
        }
      }

      if (entry.type === 'user') {
        const match = COMMAND_NAME_PATTERN.exec(extractText(content));
        if (match) bump(commandCounts, match[1]!.trim());
      }
    }
  }

  return { skills: toSortedCounts(skillCounts), commands: toSortedCounts(commandCounts) };
}

/** Token usage grouped by subagent type (`attributionAgent`, set on every assistant line inside
 *  a `subagents/*.jsonl` file — directly the subagent_type string, no correlation needed with
 *  the parent's own `Agent` tool_use). Tokens only, no $ cost: cost requires per-model pricing
 *  tables that live inside ccusage (see ccusage.ts's doc comment on why this codebase always
 *  shells out to it rather than reimplementing pricing), which this walk deliberately doesn't
 *  depend on. */
function aggregateAgentUsage(claudeConfigDir: string): AgentUsage[] {
  const byAgent = new Map<string, AgentUsage>();

  for (const filePath of findSubagentFiles(claudeConfigDir)) {
    for (const entry of readLines(filePath)) {
      if (entry.type !== 'assistant') continue;
      const subagentType = entry.attributionAgent;
      const usage = entry.message?.usage;
      if (!subagentType || !usage) continue;

      const existing = byAgent.get(subagentType) ?? { subagentType, count: 0, inputTokens: 0, outputTokens: 0 };
      existing.count += 1;
      existing.inputTokens += usage.input_tokens ?? 0;
      existing.outputTokens += usage.output_tokens ?? 0;
      byAgent.set(subagentType, existing);
    }
  }

  return [...byAgent.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

const MCP_TOOL_PATTERN = /^mcp__(.+?)__(.+)$/;

/**
 * MCP tool calls, grouped by server — `tool_use` blocks named `mcp__<server>__<tool>` (e.g.
 * `mcp__claude-in-chrome__navigate`). The server capture is non-greedy so a tool name that
 * itself contains `__` still resolves to the right server. Grouped by server only, not per-tool
 * — "which MCP servers do I actually use" is the useful signal here, not a full per-tool
 * breakdown.
 *
 * Unlike `aggregateSkillsAndCommands` (main-session-only — a subagent can't itself invoke
 * `/slash-commands` or run `Skill` the way the top-level loop can), this scans **both** main
 * session files and subagent transcripts: a subagent can legitimately be granted MCP tool
 * access, so excluding subagent transcripts would undercount real usage.
 */
function aggregateMcpUsage(claudeConfigDir: string): NamedCount[] {
  const counts = new Map<string, number>();
  const files = [...findSessionFiles(claudeConfigDir).map((file) => file.filePath), ...findSubagentFiles(claudeConfigDir)];

  for (const filePath of files) {
    for (const entry of readLines(filePath)) {
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ToolUseBlock[]) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const match = MCP_TOOL_PATTERN.exec(block.name);
        if (match) bump(counts, match[1]!);
      }
    }
  }

  return toSortedCounts(counts);
}

export function aggregateUsagePatterns(claudeConfigDir: string): UsagePatterns {
  const { skills, commands } = aggregateSkillsAndCommands(claudeConfigDir);
  return {
    skills,
    commands,
    agents: aggregateAgentUsage(claudeConfigDir),
    mcpServers: aggregateMcpUsage(claudeConfigDir),
  };
}
