import { homedir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getDaily,
  getDailyByProject,
  getSession,
  getSessions,
  type CcusageOptions,
} from './adapters/ccusage.js';
import { aggregateByModel } from './aggregate.js';
import { exportSessionMarkdown, searchSessions } from './adapters/session-log.js';
import { forbiddenOrigin, isPaired, markPaired, requireAuth } from './auth.js';
import type { SessionWatcher } from './watcher.js';

const AGGREGATE_KINDS = ['project', 'day', 'model'] as const;
type AggregateKind = (typeof AGGREGATE_KINDS)[number];

function isAggregateKind(value: string | undefined): value is AggregateKind {
  return AGGREGATE_KINDS.includes(value as AggregateKind);
}

function dateRangeFromQuery(c: { req: { query(name: string): string | undefined } }): Pick<CcusageOptions, 'since' | 'until'> {
  const since = c.req.query('since');
  const until = c.req.query('until');
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
}

export interface CreateAppOptions {
  ccusage?: CcusageOptions;
  /** Bearer token required on every route except /health. Omitted in most tests, which
   *  exercise routes directly without needing to also thread a token through every request —
   *  `cli.ts`, the daemon's real entrypoint, always passes one. */
  token?: string;
  /** Backs `GET /events`; the route is only registered when a watcher is provided. */
  watcher?: SessionWatcher;
  /** Where `/pair`'s single-use marker lives (auth.ts). Tests override this so they never touch
   *  a real machine's actual pairing state; `cli.ts` never sets it, so it defaults to
   *  `~/.config/claude-usage/paired`. */
  pairingConfigDir?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const ccusageOptions = options.ccusage ?? {};
  const claudeConfigDir = ccusageOptions.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');

  if (options.token) {
    const token = options.token;
    app.use('*', async (c, next) => {
      if (c.req.path === '/health' || c.req.path === '/pair') return next();
      return requireAuth(token)(c, next);
    });
  }

  app.get('/health', (c) => c.json({ ok: true }));

  // Unauthenticated by design — this is how the extension gets the token in the first place —
  // but still Origin-scheme-gated (forbiddenOrigin) and single-use (isPaired/markPaired), so it
  // degrades to the same "whoever has local access right after install" trust boundary as the
  // old manual copy-paste, rather than leaving the token fetchable indefinitely by anything that
  // can spoof an extension-scheme Origin. Only registered when the daemon actually has a token
  // to hand out (cli.ts always does; most tests that don't pass `token` skip it entirely).
  if (options.token) {
    const token = options.token;
    app.post('/pair', (c) => {
      const forbidden = forbiddenOrigin(c);
      if (forbidden) return forbidden;
      if (isPaired(options.pairingConfigDir)) return c.json({ error: 'already_paired' }, 403);
      markPaired(options.pairingConfigDir);
      return c.json({ token });
    });
  }

  app.get('/sessions', async (c) => {
    try {
      const report = await getSessions({ ...ccusageOptions, ...dateRangeFromQuery(c) });
      return c.json(report);
    } catch (error) {
      return c.json({ error: 'ccusage_failed', message: String(error) }, 502);
    }
  });

  app.get('/sessions/:id', async (c) => {
    try {
      const session = await getSession(c.req.param('id'), { ...ccusageOptions, ...dateRangeFromQuery(c) });
      if (!session) return c.json({ error: 'not_found' }, 404);
      return c.json(session);
    } catch (error) {
      return c.json({ error: 'ccusage_failed', message: String(error) }, 502);
    }
  });

  app.get('/sessions/:id/export', (c) => {
    const markdown = exportSessionMarkdown(claudeConfigDir, c.req.param('id'));
    if (markdown === null) return c.json({ error: 'not_found' }, 404);
    return c.text(markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  app.get('/search', (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'invalid_query', message: '?q is required' }, 400);
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Number(limitParam) : 20;
    const offsetParam = c.req.query('offset');
    const offset = offsetParam ? Number(offsetParam) : 0;
    return c.json(
      searchSessions(
        claudeConfigDir,
        q,
        Number.isFinite(limit) ? limit : 20,
        Number.isFinite(offset) && offset >= 0 ? offset : 0,
      ),
    );
  });

  app.get('/aggregate', async (c) => {
    const by = c.req.query('by');
    if (!isAggregateKind(by)) {
      return c.json(
        { error: 'invalid_query', message: `?by must be one of: ${AGGREGATE_KINDS.join(', ')}` },
        400,
      );
    }

    const scopedOptions = { ...ccusageOptions, ...dateRangeFromQuery(c) };
    try {
      if (by === 'project') {
        return c.json(await getDailyByProject(scopedOptions));
      }
      if (by === 'day') {
        return c.json(await getDaily(scopedOptions));
      }
      // by === 'model'
      const daily = await getDaily(scopedOptions);
      return c.json({ models: aggregateByModel(daily) });
    } catch (error) {
      return c.json({ error: 'ccusage_failed', message: String(error) }, 502);
    }
  });

  if (options.watcher) {
    const watcher = options.watcher;
    app.get('/events', (c) =>
      streamSSE(c, async (stream) => {
        const send = () => stream.writeSSE({ event: 'changed', data: JSON.stringify({ at: new Date().toISOString() }) });
        const unsubscribe = watcher.onChange(send);
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            unsubscribe();
            resolve();
          });
        });
      }),
    );
  }

  return app;
}
