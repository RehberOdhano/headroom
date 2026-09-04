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
