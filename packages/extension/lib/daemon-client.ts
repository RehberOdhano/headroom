import {
  daemonDailyReportSchema,
  daemonProjectDailyReportSchema,
  daemonModelAggregateResponseSchema,
  daemonSearchResponseSchema,
  daemonSessionsReportSchema,
  type DaemonDailyReport,
  type DaemonModelAggregate,
  type DaemonProjectDailyReport,
  type DaemonSearchMatch,
  type DaemonSessionsReport,
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
): Promise<DaemonResult<T>> {
  if (!settings.daemonUrl) {
    return { ok: false, error: 'not_configured', message: 'No daemon URL configured.' };
  }

  let response: Response;
  try {
    response = await fetch(`${settings.daemonUrl}${path}`, { headers: baseHeaders(settings) });
  } catch (error) {
    return { ok: false, error: 'unreachable', message: `Could not reach the daemon: ${String(error)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'unauthorized', message: 'Daemon rejected the token — check it in settings.' };
  }
  if (!response.ok) {
    return { ok: false, error: 'unreachable', message: `Daemon returned ${response.status}.` };
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

function toQuery(params: { since?: string; until?: string } | undefined, prefix: '?' | '&' = '?'): string {
  if (!params) return '';
  const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (entries.length === 0) return '';
  return prefix + entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}
