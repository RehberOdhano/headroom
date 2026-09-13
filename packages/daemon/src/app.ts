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
import { exportSessionMarkdown, findKnownProjectDirs, searchSessions } from './adapters/session-log.js';
import { aggregateUsagePatterns } from './adapters/usage-patterns.js';
import { getGitActivity } from './adapters/git-activity.js';
import {
  findClaudeMdFiles,
  isValidProjectDir,
  readClaudeConfigSnapshot,
  readClaudeMdContent,
  removePermissionRule,
  writeAgentModel,
  writeClaudeMdContent,
  writePermissionRule,
} from './adapters/claude-config.js';
import { canCreateNewProjectDir, runBootstrap } from './adapters/bootstrap.js';
import { detectExistingProject } from './adapters/project-detect.js';
import { forbiddenOrigin, isPaired, markPaired, requireAuth } from './auth.js';
import type { BootstrapDocumentEncoding, BootstrapMode, PermissionEffect } from '@headroom/shared';
import type { SessionWatcher } from './watcher.js';

const PERMISSION_EFFECTS = ['allow', 'ask', 'deny'] as const;

function isPermissionEffect(value: unknown): value is PermissionEffect {
  return typeof value === 'string' && (PERMISSION_EFFECTS as readonly string[]).includes(value);
}

const BOOTSTRAP_MODES = ['create', 'existing'] as const;

function isBootstrapMode(value: unknown): value is BootstrapMode {
  return typeof value === 'string' && (BOOTSTRAP_MODES as readonly string[]).includes(value);
}

function isBootstrapDocument(
  value: unknown,
): value is { filename: string; content: string; encoding: BootstrapDocumentEncoding } | null {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  const candidate = value as { filename?: unknown; content?: unknown; encoding?: unknown };
  return (
    typeof candidate.filename === 'string' &&
    typeof candidate.content === 'string' &&
    (candidate.encoding === 'utf8' || candidate.encoding === 'base64')
  );
}

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

  app.get('/usage/patterns', (c) => c.json(aggregateUsagePatterns(claudeConfigDir)));

  app.get('/config/projects', (c) => c.json({ projects: findKnownProjectDirs(claudeConfigDir) }));

  app.get('/config', (c) => {
    const projectDir = c.req.query('projectDir');
    if (projectDir && !isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_query', message: '?projectDir must be an existing absolute directory' }, 400);
    }
    return c.json(readClaudeConfigSnapshot(projectDir ? { claudeConfigDir, projectDir } : { claudeConfigDir }));
  });

  app.get('/config/claude-md', (c) => {
    const projectDir = c.req.query('projectDir');
    if (!projectDir) return c.json({ error: 'invalid_query', message: '?projectDir is required' }, 400);
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_query', message: '?projectDir must be an existing absolute directory' }, 400);
    }
    return c.json({ files: findClaudeMdFiles(projectDir) });
  });

  app.get('/config/git-activity', async (c) => {
    const projectDir = c.req.query('projectDir');
    const since = c.req.query('since');
    if (!projectDir || !since) {
      return c.json({ error: 'invalid_query', message: '?projectDir and ?since are required' }, 400);
    }
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_query', message: '?projectDir must be an existing absolute directory' }, 400);
    }
    return c.json(await getGitActivity(projectDir, since));
  });

  app.get('/config/claude-md/content', (c) => {
    const projectDir = c.req.query('projectDir');
    const filePath = c.req.query('path');
    if (!projectDir || !filePath) {
      return c.json({ error: 'invalid_query', message: '?projectDir and ?path are required' }, 400);
    }
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_query', message: '?projectDir must be an existing absolute directory' }, 400);
    }
    const content = readClaudeMdContent(projectDir, filePath);
    if (content === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ content });
  });

  app.put('/config/claude-md/content', async (c) => {
    const body = await c.req.json().catch(() => null);
    const projectDir = body?.projectDir;
    const filePath = body?.path;
    const content = body?.content;
    if (typeof projectDir !== 'string' || typeof filePath !== 'string' || typeof content !== 'string') {
      return c.json({ error: 'invalid_body', message: 'projectDir, path, and content are required' }, 400);
    }
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_body', message: 'projectDir must be an existing absolute directory' }, 400);
    }
    const ok = writeClaudeMdContent(projectDir, filePath, content);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ content });
  });

  app.put('/config/agents/model', async (c) => {
    const body = await c.req.json().catch(() => null);
    const projectDir = body?.projectDir;
    const filePath = body?.path;
    const model = body?.model;
    if (typeof projectDir !== 'string' || typeof filePath !== 'string' || typeof model !== 'string' || !model.trim()) {
      return c.json({ error: 'invalid_body', message: 'projectDir, path, and a non-empty model are required' }, 400);
    }
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_body', message: 'projectDir must be an existing absolute directory' }, 400);
    }
    const updated = writeAgentModel({ projectDir, requestedPath: filePath, model: model.trim() });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(updated);
  });

  app.post('/config/permissions', async (c) => {
    const body = await c.req.json().catch(() => null);
    const projectDir = body?.projectDir;
    const pattern = body?.pattern;
    const effect = body?.effect;
    if (typeof projectDir !== 'string' || typeof pattern !== 'string' || !isPermissionEffect(effect)) {
      return c.json({ error: 'invalid_body', message: 'projectDir, pattern, and effect are required' }, 400);
    }
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_body', message: 'projectDir must be an existing absolute directory' }, 400);
    }
    return c.json(writePermissionRule({ projectDir, pattern, effect }));
  });

  app.delete('/config/permissions', async (c) => {
    const body = await c.req.json().catch(() => null);
    const projectDir = body?.projectDir;
    const pattern = body?.pattern;
    const effect = body?.effect;
    if (typeof projectDir !== 'string' || typeof pattern !== 'string' || !isPermissionEffect(effect)) {
      return c.json({ error: 'invalid_body', message: 'projectDir, pattern, and effect are required' }, 400);
    }
    if (!isValidProjectDir(projectDir)) {
      return c.json({ error: 'invalid_body', message: 'projectDir must be an existing absolute directory' }, 400);
    }
    return c.json(removePermissionRule({ projectDir, pattern, effect }));
  });

  // Read-only, deterministic, no LLM — reads a handful of well-known config file shapes
  // (package.json/pyproject.toml/go.mod, or a CLAUDE.md this tool wrote earlier) to prefill the
  // "Use existing folder" form. Never writes anything.
  app.get('/bootstrap/detect', (c) => {
    const targetDir = c.req.query('targetDir');
    if (!targetDir) return c.json({ error: 'invalid_query', message: '?targetDir is required' }, 400);
    if (!isValidProjectDir(targetDir)) {
      return c.json({ error: 'invalid_query', message: '?targetDir must be an existing absolute directory' }, 400);
    }
    return c.json(detectExistingProject(targetDir));
  });

  // No LLM. Writing files here is deterministic and offline, same as everywhere else in this
  // adapter — the one exception is `runVerification: true`, which spawns the stack's real
  // install/test commands and therefore does reach the network (npm/PyPI/Go module registries).
  // That's a deliberate, explicit, opt-in carve-out of this daemon's usual "no network calls of
  // its own" rule — see root CLAUDE.md and packages/daemon/CLAUDE.md.
  app.post('/bootstrap', async (c) => {
    const body = await c.req.json().catch(() => null);
    const targetDir = body?.targetDir;
    const mode = body?.mode;
    const name = body?.name;
    const description = body?.description ?? '';
    const technologies = body?.technologies ?? [];
    const document = body?.document ?? null;
    const initGit = body?.initGit ?? false;
    const runVerificationFlag = body?.runVerification ?? false;

    if (
      typeof targetDir !== 'string' ||
      !isBootstrapMode(mode) ||
      typeof name !== 'string' ||
      !name.trim() ||
      typeof description !== 'string' ||
      !isBootstrapDocument(document) ||
      !Array.isArray(technologies) ||
      !technologies.every((tag: unknown): tag is string => typeof tag === 'string') ||
      typeof initGit !== 'boolean' ||
      typeof runVerificationFlag !== 'boolean'
    ) {
      return c.json(
        {
          error: 'invalid_body',
          message:
            'targetDir, mode, and a non-empty name are required; document, if present, must be {filename, content, encoding}; technologies, if present, must be an array of strings; initGit and runVerification must be booleans',
        },
        400,
      );
    }

    if (mode === 'create' && !canCreateNewProjectDir(targetDir)) {
      return c.json(
        { error: 'invalid_body', message: 'targetDir must be an absolute path that does not already exist, with an existing parent directory' },
        400,
      );
    }
    if (mode === 'existing' && !isValidProjectDir(targetDir)) {
      return c.json({ error: 'invalid_body', message: 'targetDir must be an existing absolute directory' }, 400);
    }

    return c.json(
      await runBootstrap({
        targetDir,
        mode,
        name: name.trim(),
        description,
        technologies,
        document,
        initGit,
        runVerification: runVerificationFlag,
      }),
    );
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
