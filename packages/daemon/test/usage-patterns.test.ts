import { describe, expect, it } from 'vitest';
import { aggregateUsagePatterns, findSubagentFiles } from '../src/adapters/usage-patterns.js';
import { withFixtureClaudeDir } from './helpers/fixture-claude-dir.js';

describe('findSubagentFiles', () => {
  it('finds subagent transcripts nested under <sessionId>/subagents/, distinct from main session files', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const files = findSubagentFiles(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('/11111111-1111-4111-8111-111111111111/subagents/agent-test0001.jsonl');
    }, 'session-log-dir');
  });

  it('returns an empty array when the projects directory does not exist', () => {
    expect(findSubagentFiles('/does/not/exist')).toEqual([]);
  });
});

describe('aggregateUsagePatterns', () => {
  it('counts Skill tool_use invocations by skill name', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { skills } = aggregateUsagePatterns(dir);
      expect(skills).toEqual([{ name: 'code-review', count: 1 }]);
    }, 'session-log-dir');
  });

  it('counts slash commands from <command-name> markers in user messages', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { commands } = aggregateUsagePatterns(dir);
      expect(commands).toEqual([{ name: '/compact', count: 1 }]);
    }, 'session-log-dir');
  });

  it('sums subagent token usage grouped by attributionAgent, independent of the main-session walk', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { agents } = aggregateUsagePatterns(dir);
      // Two assistant lines in the fixture's Explore subagent transcript: the original
      // text-only turn (50/20) plus an MCP tool_use turn (10/5) added for the MCP-usage tests
      // below — both count toward the same subagent type.
      expect(agents).toEqual([{ subagentType: 'Explore', count: 2, inputTokens: 60, outputTokens: 25 }]);
    }, 'session-log-dir');
  });

  it('counts MCP tool_use invocations by server, from both main sessions and subagent transcripts', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { mcpServers } = aggregateUsagePatterns(dir);
      // "filesystem" comes from the main alpha session; "claude-in-chrome" comes from the
      // Explore subagent's own transcript — confirms both scan paths are actually exercised.
      expect(mcpServers.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'claude-in-chrome', count: 1 },
        { name: 'filesystem', count: 1 },
      ]);
    }, 'session-log-dir');
  });

  it('returns empty arrays, not a throw, when there is no session data at all', () => {
    expect(aggregateUsagePatterns('/does/not/exist')).toEqual({ skills: [], commands: [], agents: [], mcpServers: [] });
  });
});
