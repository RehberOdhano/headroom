import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { withFixtureClaudeDir } from './helpers/fixture-claude-dir.js';

describe('daemon app', () => {
  it('responds to /health', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /sessions returns the ccusage session report', async () => {
    await withFixtureClaudeDir(async (claudeConfigDir) => {
      const res = await createApp({ ccusage: { claudeConfigDir } }).request('/sessions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe('00000000-0000-4000-8000-000000000001');
    });
  });

  it('GET /sessions/:id returns a single session', async () => {
    await withFixtureClaudeDir(async (claudeConfigDir) => {
      const res = await createApp({ ccusage: { claudeConfigDir } }).request(
        '/sessions/00000000-0000-4000-8000-000000000001',
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    });
  });

  it('GET /sessions/:id 404s for an unknown id', async () => {
    await withFixtureClaudeDir(async (claudeConfigDir) => {
      const res = await createApp({ ccusage: { claudeConfigDir } }).request('/sessions/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  it('GET /aggregate?by=project groups by project path', async () => {
    await withFixtureClaudeDir(async (claudeConfigDir) => {
      const res = await createApp({ ccusage: { claudeConfigDir } }).request('/aggregate?by=project');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body.projects)).toEqual(['-fixture-project']);
    });
  });

  it('GET /aggregate?by=day groups by date', async () => {
    await withFixtureClaudeDir(async (claudeConfigDir) => {
      const res = await createApp({ ccusage: { claudeConfigDir } }).request('/aggregate?by=day');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.daily).toHaveLength(1);
      expect(body.daily[0].date).toBe('2026-08-20');
    });
  });

  it('GET /aggregate?by=model sums usage per model', async () => {
    await withFixtureClaudeDir(async (claudeConfigDir) => {
      const res = await createApp({ ccusage: { claudeConfigDir } }).request('/aggregate?by=model');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toEqual([
        expect.objectContaining({ modelName: 'claude-sonnet-5', inputTokens: 10, outputTokens: 20 }),
      ]);
    });
  });

  it('GET /aggregate without ?by rejects with 400', async () => {
    const res = await createApp().request('/aggregate');
    expect(res.status).toBe(400);
  });

  describe('/search', () => {
    it('finds sessions whose content matches the query', async () => {
      await withFixtureClaudeDir(
        async (claudeConfigDir) => {
          const res = await createApp({ ccusage: { claudeConfigDir } }).request('/search?q=aggregate');
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.matches).toHaveLength(1);
          expect(body.matches[0]).toMatchObject({
            sessionId: '11111111-1111-4111-8111-111111111111',
            cwd: '/fixtures/project-alpha',
          });
        },
        'session-log-dir',
      );
    });

    it('rejects a missing ?q', async () => {
      const res = await createApp().request('/search');
      expect(res.status).toBe(400);
    });

    it('returns no matches for a query nothing contains', async () => {
      await withFixtureClaudeDir(
        async (claudeConfigDir) => {
          const res = await createApp({ ccusage: { claudeConfigDir } }).request('/search?q=nonexistentterm');
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.matches).toEqual([]);
          expect(body.hasMore).toBe(false);
        },
        'session-log-dir',
      );
    });

    it('paginates via ?limit and ?offset', async () => {
      await withFixtureClaudeDir(
        async (claudeConfigDir) => {
          const app = createApp({ ccusage: { claudeConfigDir } });
          const firstRes = await app.request('/search?q=the&limit=1&offset=0');
          const secondRes = await app.request('/search?q=the&limit=1&offset=1');
          const firstPage = await firstRes.json();
          const secondPage = await secondRes.json();

          expect(firstPage.matches).toHaveLength(1);
          expect(firstPage.hasMore).toBe(true);
          expect(secondPage.matches).toHaveLength(1);
          expect(secondPage.hasMore).toBe(false);
          expect(secondPage.matches[0].sessionId).not.toBe(firstPage.matches[0].sessionId);
        },
        'session-log-dir',
      );
    });
  });

  describe('GET /usage/patterns', () => {
    it('returns skill, command, subagent, and MCP-server usage counted from session logs', async () => {
      await withFixtureClaudeDir(
        async (claudeConfigDir) => {
          const res = await createApp({ ccusage: { claudeConfigDir } }).request('/usage/patterns');
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.skills).toEqual([{ name: 'code-review', count: 1 }]);
          expect(body.commands).toEqual([{ name: '/compact', count: 1 }]);
          expect(body.agents).toEqual([{ subagentType: 'Explore', count: 2, inputTokens: 60, outputTokens: 25 }]);
          expect(body.mcpServers.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
            { name: 'claude-in-chrome', count: 1 },
            { name: 'filesystem', count: 1 },
          ]);
        },
        'session-log-dir',
      );
    });

    it('returns empty arrays when there is no session data', async () => {
      // Explicit nonexistent dir, not a bare createApp() — that would fall through to this
      // real machine's own ~/.claude, which has real session logs and would make this test
      // depend on developer-machine state.
      const res = await createApp({ ccusage: { claudeConfigDir: '/does/not/exist' } }).request('/usage/patterns');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ skills: [], commands: [], agents: [], mcpServers: [] });
    });
  });

  describe('/sessions/:id/export', () => {
    it('renders a session transcript as markdown', async () => {
      await withFixtureClaudeDir(
        async (claudeConfigDir) => {
          const res = await createApp({ ccusage: { claudeConfigDir } }).request(
            '/sessions/22222222-2222-4222-8222-222222222222/export',
          );
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toContain('text/markdown');
          const text = await res.text();
          expect(text).toContain('export markdown feature');
        },
        'session-log-dir',
      );
    });

    it('404s for an unknown session id', async () => {
      const res = await createApp().request('/sessions/does-not-exist/export');
      expect(res.status).toBe(404);
    });
  });

  describe('/config*', () => {
    it('GET /config/projects lists known project dirs from session logs', async () => {
      await withFixtureClaudeDir(
        async (claudeConfigDir) => {
          const res = await createApp({ ccusage: { claudeConfigDir } }).request('/config/projects');
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.projects.map((p: { path: string }) => p.path)).toContain('/fixtures/project-alpha');
        },
        'session-log-dir',
      );
    });

    it('GET /config returns global-only when no projectDir is given', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const claudeConfigDir = path.join(dir, 'home');
          const res = await createApp({ ccusage: { claudeConfigDir } }).request('/config');
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.global.allow).toEqual(['WebFetch']);
          expect(body.project).toBeNull();
        },
        'claude-config-dir',
      );
    });

    it('GET /config combines all three layers for a given projectDir', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const claudeConfigDir = path.join(dir, 'home');
          const projectDir = path.join(dir, 'project');
          const res = await createApp({ ccusage: { claudeConfigDir } }).request(
            `/config?projectDir=${encodeURIComponent(projectDir)}`,
          );
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.project.deny).toContain('Bash(rm -rf *)');
          expect(body.local.deny).toContain('Bash(kill *)');
          expect(body.skills).toHaveLength(1);
        },
        'claude-config-dir',
      );
    });

    it('GET /config/claude-md lists CLAUDE.md files under a project', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const res = await createApp().request(`/config/claude-md?projectDir=${encodeURIComponent(projectDir)}`);
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.files).toHaveLength(2);
        },
        'claude-config-dir',
      );
    });

    it('GET /config/claude-md/content 404s for a path outside the enumerated set', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const outside = path.join(dir, 'home', 'settings.json');
          const res = await createApp().request(
            `/config/claude-md/content?projectDir=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(outside)}`,
          );
          expect(res.status).toBe(404);
        },
        'claude-config-dir',
      );
    });

    it('PUT /config/claude-md/content overwrites an enumerated file', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const filePath = path.join(projectDir, 'CLAUDE.md');
          const res = await createApp().request('/config/claude-md/content', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, path: filePath, content: '# Edited\n' }),
          });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ content: '# Edited\n' });

          const readBack = await createApp().request(
            `/config/claude-md/content?projectDir=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(filePath)}`,
          );
          expect(await readBack.json()).toEqual({ content: '# Edited\n' });
        },
        'claude-config-dir',
      );
    });

    it('PUT /config/claude-md/content 404s for a path outside the enumerated set', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const outside = path.join(dir, 'home', 'settings.json');
          const res = await createApp().request('/config/claude-md/content', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, path: outside, content: 'clobbered' }),
          });
          expect(res.status).toBe(404);
        },
        'claude-config-dir',
      );
    });

    it('PUT /config/agents/model updates a project agent\'s model field', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const filePath = path.join(projectDir, '.claude', 'agents', 'reviewer.md');
          const res = await createApp().request('/config/agents/model', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, path: filePath, model: 'haiku' }),
          });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({
            name: 'reviewer',
            description: 'Read-only reviewer used only in daemon fixtures, not real conversation content.',
            model: 'haiku',
            path: filePath,
            scope: 'project',
          });
        },
        'claude-config-dir',
      );
    });

    it('PUT /config/agents/model 404s for a path outside the project-scope agents it can enumerate', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const globalAgentPath = path.join(dir, 'home', 'agents', 'personal-helper.md');
          const res = await createApp().request('/config/agents/model', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, path: globalAgentPath, model: 'opus' }),
          });
          expect(res.status).toBe(404);
        },
        'claude-config-dir',
      );
    });

    it('PUT /config/agents/model rejects an empty model', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const filePath = path.join(projectDir, '.claude', 'agents', 'reviewer.md');
          const res = await createApp().request('/config/agents/model', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, path: filePath, model: '   ' }),
          });
          expect(res.status).toBe(400);
        },
        'claude-config-dir',
      );
    });

    it('POST /config/permissions writes an override to settings.local.json', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const res = await createApp().request('/config/permissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, pattern: 'Bash(npm publish *)', effect: 'deny' }),
          });
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.deny).toContain('Bash(npm publish *)');
        },
        'claude-config-dir',
      );
    });

    it('rejects a relative projectDir on every route that accepts one, with 400', async () => {
      const app = createApp();
      const getRes = await app.request(`/config?projectDir=${encodeURIComponent('relative/path')}`);
      expect(getRes.status).toBe(400);

      const claudeMdRes = await app.request(`/config/claude-md?projectDir=${encodeURIComponent('relative/path')}`);
      expect(claudeMdRes.status).toBe(400);

      const postRes = await app.request('/config/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: 'relative/path', pattern: 'Bash(rm -rf *)', effect: 'deny' }),
      });
      expect(postRes.status).toBe(400);
    });

    it('rejects a nonexistent absolute projectDir with 400 rather than creating it', async () => {
      await withFixtureClaudeDir(async (dir) => {
        const nonexistent = path.join(dir, 'does-not-exist');
        const res = await createApp().request('/config/permissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDir: nonexistent, pattern: 'Bash(rm -rf *)', effect: 'deny' }),
        });
        expect(res.status).toBe(400);
        const { existsSync } = await import('node:fs');
        expect(existsSync(nonexistent)).toBe(false);
      }, 'claude-config-dir');
    });

    it('POST /config/permissions rejects a missing field with 400', async () => {
      const res = await createApp().request('/config/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: 'Bash(rm -rf *)', effect: 'deny' }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE /config/permissions removes a rule from settings.local.json', async () => {
      await withFixtureClaudeDir(
        async (dir) => {
          const projectDir = path.join(dir, 'project');
          const res = await createApp().request('/config/permissions', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, pattern: 'Bash(kill *)', effect: 'deny' }),
          });
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.deny).toEqual([]);
        },
        'claude-config-dir',
      );
    });
  });

  describe('POST /bootstrap', () => {
    let parent: string;

    beforeEach(() => {
      parent = mkdtempSync(path.join(tmpdir(), 'headroom-app-bootstrap-'));
    });

    afterEach(() => {
      rmSync(parent, { recursive: true, force: true });
    });

    it('creates a new project folder with a scaffold inferred from the picked tags, and a CLAUDE.md', async () => {
      const targetDir = path.join(parent, 'new-project');
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir, mode: 'create', name: 'New Project', description: 'A test.', technologies: ['TypeScript'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.createdFolder).toBe(true);
      expect(body.createdFiles.some((f: string) => f.endsWith('CLAUDE.md'))).toBe(true);
      expect(body.createdFiles.some((f: string) => f.endsWith('package.json'))).toBe(true);
      expect(body.inferredStack).toBe('node-typescript');
    });

    it('rejects create mode when the target already exists, with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir: parent, mode: 'create', name: 'x', description: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects existing mode when the target does not exist, with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir: path.join(parent, 'nope'), mode: 'existing', name: 'x', description: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a missing name with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir: path.join(parent, 'x'), mode: 'create', description: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('records unmatched tags in CLAUDE.md and infers "other" when none match a built-in template', async () => {
      const targetDir = path.join(parent, 'rust-project');
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir, mode: 'create', name: 'rust-project', description: '', technologies: ['Rust'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.inferredStack).toBe('other');

      const { readFileSync } = await import('node:fs');
      const claudeMd = readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('Tech stack: Rust');
      expect(claudeMd).toContain('No built-in scaffold template matches this stack yet');
    });

    it('saves an uploaded document under docs/ and never overwrites it on a second run', async () => {
      const targetDir = path.join(parent, 'with-doc');
      const app = createApp();
      const first = await app.request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir,
          mode: 'create',
          name: 'with-doc',
          description: '',
          document: { filename: 'brief.md', content: 'original brief', encoding: 'utf8' },
        }),
      });
      expect(first.status).toBe(200);

      const second = await app.request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir,
          mode: 'existing',
          name: 'with-doc',
          description: '',
          document: { filename: 'brief.md', content: 'a different brief', encoding: 'utf8' },
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.skippedFiles.some((f: string) => f.endsWith('brief.md'))).toBe(true);

      const { readFileSync } = await import('node:fs');
      expect(readFileSync(path.join(targetDir, 'docs', 'brief.md'), 'utf-8')).toBe('original brief');
    });

    it('initializes a real git repo when initGit is true', async () => {
      const targetDir = path.join(parent, 'git-project');
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir, mode: 'create', name: 'git-project', description: '', initGit: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.gitInitialized).toBe(true);

      const { existsSync } = await import('node:fs');
      expect(existsSync(path.join(targetDir, '.git'))).toBe(true);
    });

    it('defaults initGit and runVerification to false, never touching git or running any command', async () => {
      const targetDir = path.join(parent, 'plain-project');
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir, mode: 'create', name: 'plain-project', description: '' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.gitInitialized).toBe(false);
      expect(body.verification).toBeNull();

      const { existsSync } = await import('node:fs');
      expect(existsSync(path.join(targetDir, '.git'))).toBe(false);
    });

    it('rejects a non-boolean initGit with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir: path.join(parent, 'x'), mode: 'create', name: 'x', description: '', initGit: 'yes' }),
      });
      expect(res.status).toBe(400);
    });

    it('records technologies in CLAUDE.md when present', async () => {
      const targetDir = path.join(parent, 'tagged-project');
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir,
          mode: 'create',
          name: 'tagged-project',
          description: '',
          technologies: ['React', 'PostgreSQL'],
        }),
      });
      expect(res.status).toBe(200);

      const { readFileSync } = await import('node:fs');
      expect(readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8')).toContain('Tech stack: React, PostgreSQL');
    });

    it('rejects a non-array technologies with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir: path.join(parent, 'x'), mode: 'create', name: 'x', description: '', technologies: 'React' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a technologies array containing a non-string with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir: path.join(parent, 'x'),
          mode: 'create',
          name: 'x',
          description: '',
          technologies: ['React', 42],
        }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a document missing a valid encoding with 400', async () => {
      const res = await createApp().request('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir: path.join(parent, 'x'),
          mode: 'create',
          name: 'x',
          description: '',
          document: { filename: 'brief.md', content: 'hi' },
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /bootstrap/detect', () => {
    let parent: string;

    beforeEach(() => {
      parent = mkdtempSync(path.join(tmpdir(), 'headroom-app-detect-'));
    });

    afterEach(() => {
      rmSync(parent, { recursive: true, force: true });
    });

    it('detects name, description, and technologies from a real package.json, collapsing the implied Node.js tag since React is more specific', async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        path.join(parent, 'package.json'),
        JSON.stringify({ name: 'my-tool', description: 'does things', dependencies: { react: '^18.0.0' } }),
      );

      const res = await createApp().request(`/bootstrap/detect?targetDir=${encodeURIComponent(parent)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: 'my-tool', description: 'does things', technologies: ['React'] });
    });

    it('rejects a missing targetDir with 400', async () => {
      const res = await createApp().request('/bootstrap/detect');
      expect(res.status).toBe(400);
    });

    it('rejects a nonexistent targetDir with 400', async () => {
      const res = await createApp().request(`/bootstrap/detect?targetDir=${encodeURIComponent(path.join(parent, 'nope'))}`);
      expect(res.status).toBe(400);
    });
  });

  describe('auth', () => {
    const TOKEN = 'test-token-value';

    it('allows /health without a token', async () => {
      const res = await createApp({ token: TOKEN }).request('/health');
      expect(res.status).toBe(200);
    });

    it('rejects other routes with no token', async () => {
      const res = await createApp({ token: TOKEN }).request('/aggregate?by=day');
      expect(res.status).toBe(401);
    });

    it('rejects an incorrect bearer token', async () => {
      const res = await createApp({ token: TOKEN }).request('/aggregate?by=day', {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts the correct bearer token and reaches the route handler', async () => {
      const res = await createApp({ token: TOKEN }).request('/aggregate', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      // 400 (missing ?by), not 401/403 — proves auth passed and the route handler ran.
      expect(res.status).toBe(400);
    });

    it('rejects a web page Origin outright', async () => {
      const res = await createApp({ token: TOKEN }).request('/aggregate?by=day', {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example.com' },
      });
      expect(res.status).toBe(403);
    });

    it('accepts an extension-scheme Origin with the right token', async () => {
      await withFixtureClaudeDir(async (claudeConfigDir) => {
        const res = await createApp({ token: TOKEN, ccusage: { claudeConfigDir } }).request('/aggregate?by=day', {
          headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'chrome-extension://abcdefghijklmnop' },
        });
        expect(res.status).toBe(200);
      });
    });
  });

  describe('pairing', () => {
    const TOKEN = 'test-token-value';
    let pairingConfigDir: string;

    beforeEach(() => {
      pairingConfigDir = mkdtempSync(path.join(tmpdir(), 'headroom-pairing-'));
    });

    afterEach(() => {
      rmSync(pairingConfigDir, { recursive: true, force: true });
    });

    it('is not registered when the app has no token', async () => {
      const res = await createApp().request('/pair', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('hands back the token on first request, unauthenticated', async () => {
      const res = await createApp({ token: TOKEN, pairingConfigDir }).request('/pair', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: TOKEN });
    });

    it('403s every request after the first', async () => {
      const app = createApp({ token: TOKEN, pairingConfigDir });
      await app.request('/pair', { method: 'POST' });
      const res = await app.request('/pair', { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'already_paired' });
    });

    it('rejects a web page Origin outright, same as every other route', async () => {
      const res = await createApp({ token: TOKEN, pairingConfigDir }).request('/pair', {
        method: 'POST',
        headers: { Origin: 'https://evil.example.com' },
      });
      expect(res.status).toBe(403);
    });

    it('accepts an extension-scheme Origin', async () => {
      const res = await createApp({ token: TOKEN, pairingConfigDir }).request('/pair', {
        method: 'POST',
        headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
      });
      expect(res.status).toBe(200);
    });
  });
});
