import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findClaudeMdFiles,
  isValidProjectDir,
  readClaudeConfigSnapshot,
  readClaudeMdContent,
  readHooksLayer,
  readSettingsLayer,
  readSkills,
  removePermissionRule,
  writeClaudeMdContent,
  writePermissionRule,
} from '../src/adapters/claude-config.js';
import { findKnownProjectDirs } from '../src/adapters/session-log.js';
import { withFixtureClaudeDir } from './helpers/fixture-claude-dir.js';

function paths(dir: string): { claudeConfigDir: string; projectDir: string } {
  return { claudeConfigDir: path.join(dir, 'home'), projectDir: path.join(dir, 'project') };
}

describe('readSettingsLayer', () => {
  it('reads a populated layer', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { claudeConfigDir } = paths(dir);
      const layer = readSettingsLayer(path.join(claudeConfigDir, 'settings.json'));
      expect(layer.exists).toBe(true);
      expect(layer.defaultMode).toBe('auto');
      expect(layer.allow).toEqual(['WebFetch']);
      expect(layer.deny).toEqual(['Bash(sudo *)']);
    }, 'claude-config-dir');
  });

  it('returns an absent layer for a missing file', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const layer = readSettingsLayer(path.join(dir, 'does-not-exist.json'));
      expect(layer.exists).toBe(false);
      expect(layer.allow).toEqual([]);
    }, 'claude-config-dir');
  });

  it('fails soft on invalid JSON rather than throwing', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const badPath = path.join(dir, 'bad.json');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(badPath, '{ not valid json');
      expect(() => readSettingsLayer(badPath)).not.toThrow();
      expect(readSettingsLayer(badPath).exists).toBe(false);
    }, 'claude-config-dir');
  });
});

describe('readHooksLayer', () => {
  it('flattens hooks with a matcher', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const filePath = path.join(projectDir, '.claude', 'settings.json');
      const hooks = readHooksLayer(filePath);
      expect(hooks).toEqual([
        {
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          command: 'echo pre-edit',
          timeout: 10,
          statusMessage: 'Checking edit',
          source: filePath,
        },
      ]);
    }, 'claude-config-dir');
  });

  it('flattens hooks with no matcher (e.g. Stop)', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { claudeConfigDir } = paths(dir);
      const filePath = path.join(claudeConfigDir, 'settings.json');
      const hooks = readHooksLayer(filePath);
      expect(hooks).toEqual([
        { event: 'Stop', matcher: null, command: 'echo global-stop-hook', timeout: null, statusMessage: null, source: filePath },
      ]);
    }, 'claude-config-dir');
  });
});

describe('readSkills', () => {
  it('parses a real SKILL.md frontmatter', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { claudeConfigDir, projectDir } = paths(dir);
      const skills = readSkills(projectDir, claudeConfigDir);
      expect(skills).toEqual([
        {
          name: 'demo',
          description: 'A demo skill used only in daemon fixtures, not real conversation content.',
          argumentHint: '<thing>',
          allowedTools: ['Read', 'Glob', 'Write'],
          path: path.join(projectDir, '.claude', 'skills', 'demo', 'SKILL.md'),
        },
      ]);
    }, 'claude-config-dir');
  });
});

describe('readClaudeConfigSnapshot', () => {
  it('combines global/project/local layers and merges hooks', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { claudeConfigDir, projectDir } = paths(dir);
      const snapshot = readClaudeConfigSnapshot({ claudeConfigDir, projectDir });
      expect(snapshot.global.allow).toEqual(['WebFetch']);
      expect(snapshot.project?.deny).toEqual(['Bash(rm -rf *)', 'Read(.env)']);
      expect(snapshot.local?.deny).toEqual(['Bash(kill *)']);
      expect(snapshot.hooks).toHaveLength(2);
      expect(snapshot.skills).toHaveLength(1);
    }, 'claude-config-dir');
  });

  it('omits project/local layers when no projectDir is given', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { claudeConfigDir } = paths(dir);
      const snapshot = readClaudeConfigSnapshot({ claudeConfigDir });
      expect(snapshot.project).toBeNull();
      expect(snapshot.local).toBeNull();
    }, 'claude-config-dir');
  });
});

describe('writePermissionRule / removePermissionRule', () => {
  it('adds a new pattern while preserving unrelated keys', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const updated = writePermissionRule({ projectDir, pattern: 'Bash(npm publish *)', effect: 'deny' });
      expect(updated.deny).toContain('Bash(npm publish *)');
      expect(updated.deny).toContain('Bash(kill *)');

      const onDisk = JSON.parse(readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf-8'));
      expect(onDisk.someUnrelatedKey).toBe('must survive a rewrite');
    }, 'claude-config-dir');
  });

  it('moves a pattern between effects instead of duplicating it', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      writePermissionRule({ projectDir, pattern: 'Bash(kill *)', effect: 'ask' });
      const layer = readSettingsLayer(path.join(projectDir, '.claude', 'settings.local.json'));
      expect(layer.deny).not.toContain('Bash(kill *)');
      expect(layer.ask).toContain('Bash(kill *)');
    }, 'claude-config-dir');
  });

  it('creates .claude/settings.local.json when absent', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { claudeConfigDir } = paths(dir);
      const bareProjectDir = path.join(dir, 'no-config-yet');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(bareProjectDir, { recursive: true });

      const updated = writePermissionRule({ projectDir: bareProjectDir, pattern: 'Bash(rm -rf *)', effect: 'deny' });
      expect(updated.exists).toBe(true);
      expect(updated.deny).toEqual(['Bash(rm -rf *)']);
      void claudeConfigDir;
    }, 'claude-config-dir');
  });

  it('removes a pattern it can find in settings.local.json', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const updated = removePermissionRule({ projectDir, pattern: 'Bash(kill *)', effect: 'deny' });
      expect(updated.deny).toEqual([]);
    }, 'claude-config-dir');
  });

  it('no-ops removing a pattern that only exists in the shared settings.json', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const before = readSettingsLayer(path.join(projectDir, '.claude', 'settings.local.json'));
      const after = removePermissionRule({ projectDir, pattern: 'Bash(rm -rf *)', effect: 'deny' });
      expect(after).toEqual(before);
    }, 'claude-config-dir');
  });
});

describe('findClaudeMdFiles / readClaudeMdContent', () => {
  it('finds every CLAUDE.md under the project, recursively', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const files = findClaudeMdFiles(projectDir);
      expect(files.map((f) => f.relativePath).sort()).toEqual(['CLAUDE.md', path.join('nested', 'CLAUDE.md')]);
    }, 'claude-config-dir');
  });

  it('reads content for an enumerated file', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const [file] = findClaudeMdFiles(projectDir);
      const content = readClaudeMdContent(projectDir, file.path);
      expect(content).toContain('Fixture project');
    }, 'claude-config-dir');
  });

  it('rejects a path outside the enumerated set (path traversal guard)', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir, claudeConfigDir } = paths(dir);
      const outsideFile = path.join(claudeConfigDir, 'settings.json');
      expect(readClaudeMdContent(projectDir, outsideFile)).toBeNull();
    }, 'claude-config-dir');
  });
});

describe('writeClaudeMdContent', () => {
  it('overwrites an enumerated file and the new content reads back', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      const [file] = findClaudeMdFiles(projectDir);
      const ok = writeClaudeMdContent(projectDir, file.path, '# Edited\n\nNew content.\n');
      expect(ok).toBe(true);
      expect(readClaudeMdContent(projectDir, file.path)).toBe('# Edited\n\nNew content.\n');
    }, 'claude-config-dir');
  });

  it('rejects a path outside the enumerated set instead of writing it', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir, claudeConfigDir } = paths(dir);
      const outsideFile = path.join(claudeConfigDir, 'settings.json');
      const before = readFileSync(outsideFile, 'utf-8');
      const ok = writeClaudeMdContent(projectDir, outsideFile, 'clobbered');
      expect(ok).toBe(false);
      expect(readFileSync(outsideFile, 'utf-8')).toBe(before);
    }, 'claude-config-dir');
  });
});

describe('findKnownProjectDirs', () => {
  it('lists distinct cwd values from real session transcripts', async () => {
    await withFixtureClaudeDir(
      async (dir) => {
        const projects = findKnownProjectDirs(dir);
        expect(projects.map((p) => p.path)).toContain('/fixtures/project-alpha');
      },
      'session-log-dir',
    );
  });
});

describe('isValidProjectDir', () => {
  it('accepts an existing absolute directory', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      expect(isValidProjectDir(projectDir)).toBe(true);
    }, 'claude-config-dir');
  });

  it('rejects a relative path', () => {
    expect(isValidProjectDir('relative/path')).toBe(false);
  });

  it('rejects a nonexistent absolute path', async () => {
    await withFixtureClaudeDir(async (dir) => {
      expect(isValidProjectDir(path.join(dir, 'does-not-exist'))).toBe(false);
    }, 'claude-config-dir');
  });

  it('rejects a path that is a file, not a directory', async () => {
    await withFixtureClaudeDir(async (dir) => {
      const { projectDir } = paths(dir);
      expect(isValidProjectDir(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
    }, 'claude-config-dir');
  });
});
