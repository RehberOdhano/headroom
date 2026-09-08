import {
  daemonDailyReportSchema,
  daemonProjectDailyReportSchema,
  daemonModelAggregateResponseSchema,
  daemonSearchResponseSchema,
  daemonSessionsReportSchema,
  claudeConfigSnapshotSchema,
  claudeMdContentResponseSchema,
  claudeMdListResponseSchema,
  knownProjectsResponseSchema,
  settingsLayerSchema,
  type ClaudeConfigSnapshot,
  type ClaudeMdFile,
  type DaemonDailyReport,
  type DaemonModelAggregate,
  type DaemonProjectDailyReport,
  type DaemonSearchMatch,
  type DaemonSessionsReport,
  type KnownProject,
  type PermissionEffect,
  type SettingsLayer,
} from '@headroom/shared';
import type { Settings } from './protocol.js';

export type DaemonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'not_configured' | 'unreachable' | 'unauthorized' | 'invalid_response'; message: string };

function baseHeaders(settings: Settings): HeadersInit {
  return settings.daemonToken ? { Authorization: `Bearer ${settings.daemonToken}` } : {};
}

async function daemonFetch<T>(
  settings: Settings,
  path: string,
  schema: { safeParse(data: unknown): { success: boolean; data?: T; error?: unknown } },
  init?: RequestInit,
): Promise<DaemonResult<T>> {
  if (!settings.daemonUrl) {
    return { ok: false, error: 'not_configured', message: 'No daemon URL configured.' };
  }

  let response: Response;
  try {
    response = await fetch(`${settings.daemonUrl}${path}`, {
      ...init,
      headers: { ...baseHeaders(settings), ...init?.headers },
    });
  } catch (error) {
    return { ok: false, error: 'unreachable', message: `Could not reach the daemon: ${String(error)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'unauthorized', message: 'Daemon rejected the token — check it in settings.' };
  }
  if (!response.ok) {
    // Most daemon error responses are `{error, message}` (see packages/daemon/src/app.ts) — a
    // real message (e.g. "?projectDir must be an existing absolute directory") is far more
    // actionable than a bare status code. Falls back to the generic text for a body that isn't
    // JSON, has no `message`, or (some test mocks) has no `.json()` at all.
    let message = `Daemon returned ${response.status}.`;
    try {
      const body: unknown = await response.json();
      const candidate = (body as { message?: unknown } | null)?.message;
      if (typeof candidate === 'string' && candidate) message = candidate;
    } catch {
      // not JSON, or already consumed — keep the generic message.
    }
    return { ok: false, error: 'unreachable', message };
  }

  const raw: unknown = await response.json();
  const result = schema.safeParse(raw);
  if (!result.success) {
    // The daemon's shape moved out from under this schema — fail soft rather than throw.
    return { ok: false, error: 'invalid_response', message: 'Daemon response did not match the expected shape.' };
  }
  return { ok: true, data: result.data as T };
}

export function getDaemonSessions(settings: Settings, params?: { since?: string; until?: string }): Promise<DaemonResult<DaemonSessionsReport>> {
  return daemonFetch(settings, `/sessions${toQuery(params)}`, daemonSessionsReportSchema);
}

export function getDaemonDaily(settings: Settings, params?: { since?: string; until?: string }): Promise<DaemonResult<DaemonDailyReport>> {
  return daemonFetch(settings, `/aggregate?by=day${toQuery(params, '&')}`, daemonDailyReportSchema);
}

export function getDaemonByProject(settings: Settings, params?: { since?: string; until?: string }): Promise<DaemonResult<DaemonProjectDailyReport>> {
  return daemonFetch(settings, `/aggregate?by=project${toQuery(params, '&')}`, daemonProjectDailyReportSchema);
}

export function getDaemonByModel(settings: Settings, params?: { since?: string; until?: string }): Promise<DaemonResult<{ models: DaemonModelAggregate[] }>> {
  return daemonFetch(settings, `/aggregate?by=model${toQuery(params, '&')}`, daemonModelAggregateResponseSchema);
}

export function searchDaemonSessions(
  settings: Settings,
  query: string,
  { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<DaemonResult<{ matches: DaemonSearchMatch[]; hasMore: boolean }>> {
  return daemonFetch(
    settings,
    `/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
    daemonSearchResponseSchema,
  );
}

export async function exportDaemonSession(settings: Settings, sessionId: string): Promise<DaemonResult<string>> {
  if (!settings.daemonUrl) return { ok: false, error: 'not_configured', message: 'No daemon URL configured.' };
  try {
    const response = await fetch(`${settings.daemonUrl}/sessions/${encodeURIComponent(sessionId)}/export`, {
      headers: baseHeaders(settings),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'unauthorized', message: 'Daemon rejected the token — check it in settings.' };
    }
    if (!response.ok) return { ok: false, error: 'unreachable', message: `Daemon returned ${response.status}.` };
    return { ok: true, data: await response.text() };
  } catch (error) {
    return { ok: false, error: 'unreachable', message: `Could not reach the daemon: ${String(error)}` };
  }
}

export function getDaemonConfigProjects(settings: Settings): Promise<DaemonResult<{ projects: KnownProject[] }>> {
  return daemonFetch(settings, '/config/projects', knownProjectsResponseSchema);
}

export function getDaemonConfig(settings: Settings, projectDir?: string): Promise<DaemonResult<ClaudeConfigSnapshot>> {
  const query = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
  return daemonFetch(settings, `/config${query}`, claudeConfigSnapshotSchema);
}

export function getDaemonClaudeMdList(settings: Settings, projectDir: string): Promise<DaemonResult<{ files: ClaudeMdFile[] }>> {
  return daemonFetch(settings, `/config/claude-md?projectDir=${encodeURIComponent(projectDir)}`, claudeMdListResponseSchema);
}

export function getDaemonClaudeMdContent(
  settings: Settings,
  projectDir: string,
  filePath: string,
): Promise<DaemonResult<{ content: string }>> {
  return daemonFetch(
    settings,
    `/config/claude-md/content?projectDir=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(filePath)}`,
    claudeMdContentResponseSchema,
  );
}

/** Overwrites an enumerated CLAUDE.md file — the daemon's second write path
 *  (`writeClaudeMdContent`, packages/daemon/src/adapters/claude-config.ts), guarded the same way
 *  as the read: the daemon only accepts a `path` it can itself re-derive via a fresh directory
 *  scan of `projectDir`, never an arbitrary client-supplied path. No autosave — the caller
 *  decides when to write. */
export function updateDaemonClaudeMdContent(
  settings: Settings,
  projectDir: string,
  filePath: string,
  content: string,
): Promise<DaemonResult<{ content: string }>> {
  return daemonFetch(settings, '/config/claude-md/content', claudeMdContentResponseSchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, path: filePath, content }),
  });
}

/** Writes/removes a permission-rule override — always `.claude/settings.local.json` on the
 *  daemon side (`writePermissionRule`/`removePermissionRule`, packages/daemon/src/adapters/
 *  claude-config.ts), never the shared `settings.json`. See Config.tsx for the UI-level framing
 *  ("overridden locally", not "removed"). */
export function addDaemonPermissionRule(
  settings: Settings,
  params: { projectDir: string; pattern: string; effect: PermissionEffect },
): Promise<DaemonResult<SettingsLayer>> {
  return daemonFetch(settings, '/config/permissions', settingsLayerSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function removeDaemonPermissionRule(
  settings: Settings,
  params: { projectDir: string; pattern: string; effect: PermissionEffect },
): Promise<DaemonResult<SettingsLayer>> {
  return daemonFetch(settings, '/config/permissions', settingsLayerSchema, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

function toQuery(params: { since?: string; until?: string } | undefined, prefix: '?' | '&' = '?'): string {
  if (!params) return '';
  const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (entries.length === 0) return '';
  return prefix + entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}
