import { describe, expect, it } from 'vitest';
import { exportSessionMarkdown, findSessionFiles, searchSessions } from '../src/adapters/session-log.js';
import { withFixtureClaudeDir } from './helpers/fixture-claude-dir.js';

describe('findSessionFiles', () => {
  it('finds every session file across every project directory', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const files = findSessionFiles(dir);
      expect(files.map((f) => f.sessionId).sort()).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ]);
    }, 'session-log-dir');
  });

  it('returns an empty array when the projects directory does not exist', () => {
    expect(findSessionFiles('/does/not/exist')).toEqual([]);
  });
});

describe('searchSessions', () => {
  it('matches text-block content in an assistant message array', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { matches } = searchSessions(dir, 'aggregate');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: '/fixtures/project-alpha',
        matchCount: 2, // once in the user turn, once in the assistant's text block
      });
      expect(matches[0]!.snippet).toContain('aggregate');
    }, 'session-log-dir');
  });

  it('matches plain string message content', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { matches } = searchSessions(dir, 'markdown');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ sessionId: '22222222-2222-4222-8222-222222222222' });
    }, 'session-log-dir');
  });

  it('does not match tool_use block content', async () => {
    await withFixtureClaudeDir(async (dir) => {
      // "Read" only appears inside the alpha session's tool_use block, never in user/assistant
      // text — if that leaked into search results, this would find it.
      const { matches } = searchSessions(dir, 'file_path');
      expect(matches).toEqual([]);
    }, 'session-log-dir');
  });

  it('is case-insensitive', async () => {
    await withFixtureClaudeDir(async (dir) => {
      expect(searchSessions(dir, 'AGGREGATE').matches).toHaveLength(1);
    }, 'session-log-dir');
  });

  it('sorts by most recent activity first', async () => {
    await withFixtureClaudeDir(async (dir) => {
      // "the" appears in both sessions' turns — beta (2026-08-15) is more recent than alpha (2026-08-10).
      const { matches } = searchSessions(dir, 'the');
      expect(matches.map((m) => m.sessionId)).toEqual([
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
      ]);
    }, 'session-log-dir');
  });

  it('returns nothing for a query no session contains', async () => {
    await withFixtureClaudeDir(async (dir) => {
      expect(searchSessions(dir, 'zzz-nonexistent-zzz')).toEqual({ matches: [], hasMore: false });
    }, 'session-log-dir');
  });

  describe('pagination', () => {
    it('reports hasMore: false when every match fits on one page', async () => {
      await withFixtureClaudeDir(async (dir) => {
        // Both fixture sessions match "the" — 2 matches total, well under the default limit.
        const result = searchSessions(dir, 'the');
        expect(result.matches).toHaveLength(2);
        expect(result.hasMore).toBe(false);
      }, 'session-log-dir');
    });

    it('slices to limit and reports hasMore: true when matches remain', async () => {
      await withFixtureClaudeDir(async (dir) => {
        const page = searchSessions(dir, 'the', 1, 0);
        expect(page.matches).toHaveLength(1);
        expect(page.hasMore).toBe(true);
      }, 'session-log-dir');
    });

    it('offset returns the next page, continuing the same sort order', async () => {
      await withFixtureClaudeDir(async (dir) => {
        const firstPage = searchSessions(dir, 'the', 1, 0);
        const secondPage = searchSessions(dir, 'the', 1, 1);

        expect(secondPage.matches).toHaveLength(1);
        expect(secondPage.hasMore).toBe(false);
        expect(secondPage.matches[0]!.sessionId).not.toBe(firstPage.matches[0]!.sessionId);
      }, 'session-log-dir');
    });
  });
});

describe('exportSessionMarkdown', () => {
  it('renders user/assistant turns as markdown, skipping tool_use blocks', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const markdown = exportSessionMarkdown(dir, '11111111-1111-4111-8111-111111111111');
      expect(markdown).toContain('## User');
      expect(markdown).toContain("let's refactor the aggregate pipeline");
      expect(markdown).toContain('## Assistant');
      expect(markdown).toContain('sure, refactoring the aggregate pipeline now');
      expect(markdown).not.toContain('tool_use');
    }, 'session-log-dir');
  });

  it('returns null for an unknown session id', async () => {
    await withFixtureClaudeDir(async (dir) => {
      expect(exportSessionMarkdown(dir, 'does-not-exist')).toBeNull();
    }, 'session-log-dir');
  });

  it('embeds a pasted image as an inline data URI, dropping the redundant placeholder text', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const markdown = exportSessionMarkdown(dir, '22222222-2222-4222-8222-222222222222')!;

      expect(markdown).toContain('![](data:image/png;base64,iVBORw0KGgo');
      expect(markdown).not.toContain('[Image #1]');
      expect(markdown).not.toContain('[Image: source:');
      // The following turn's real text should still render normally.
      expect(markdown).toContain('got the screenshot, markdown export looks correct');
    }, 'session-log-dir');
  });
});
