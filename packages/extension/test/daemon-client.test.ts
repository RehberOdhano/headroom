import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportDaemonSession,
  getDaemonByModel,
  getDaemonByProject,
  getDaemonDaily,
  getDaemonSessions,
  searchDaemonSessions,
} from '../lib/daemon-client.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import type { Settings } from '../lib/protocol.js';

const settings: Settings = { ...DEFAULT_SETTINGS, daemonUrl: 'http://127.0.0.1:4317', daemonToken: 'tok' };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(String(body)) } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getDaemonSessions', () => {
  it('returns not_configured when no daemon URL is set', async () => {
    const result = await getDaemonSessions({ ...settings, daemonUrl: '' });
    expect(result).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('returns unreachable when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await getDaemonSessions(settings);
    expect(result).toMatchObject({ ok: false, error: 'unreachable' });
  });

  it('returns unauthorized on a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    const result = await getDaemonSessions(settings);
    expect(result).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('returns invalid_response when the shape does not match the schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { not: 'a sessions report' }));
    const result = await getDaemonSessions(settings);
    expect(result).toMatchObject({ ok: false, error: 'invalid_response' });
  });

  it('returns parsed data on success, sending the bearer token', async () => {
    const body = { sessions: [], totals: { cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, totalTokens: 0 } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, body));

    const result = await getDaemonSessions(settings);

    expect(result).toEqual({ ok: true, data: body });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4317/sessions',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
  });

  it('appends since/until as query params', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { sessions: [], totals: { cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, totalTokens: 0 } }));

    await getDaemonSessions(settings, { since: '20260801', until: '20260830' });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/sessions?since=20260801&until=20260830', expect.anything());
  });
});

describe('getDaemonDaily / getDaemonByProject / getDaemonByModel', () => {
  it('hit the right aggregate endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('by=day')) return Promise.resolve(jsonResponse(200, { daily: [], totals: zeroTotals() }));
      if (String(url).includes('by=project')) return Promise.resolve(jsonResponse(200, { projects: {}, totals: zeroTotals() }));
      return Promise.resolve(jsonResponse(200, { models: [] }));
    });

    expect((await getDaemonDaily(settings)).ok).toBe(true);
    expect((await getDaemonByProject(settings)).ok).toBe(true);
    expect((await getDaemonByModel(settings)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('searchDaemonSessions', () => {
  it('URL-encodes the query and defaults limit/offset', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { matches: [], hasMore: false }));
    const result = await searchDaemonSessions(settings, 'foo bar');
    expect(result).toEqual({ ok: true, data: { matches: [], hasMore: false } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4317/search?q=foo%20bar&limit=20&offset=0',
      expect.anything(),
    );
  });

  it('passes a custom limit/offset for pagination', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { matches: [], hasMore: true }));
    await searchDaemonSessions(settings, 'foo', { limit: 20, offset: 20 });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/search?q=foo&limit=20&offset=20', expect.anything());
  });
});

describe('exportDaemonSession', () => {
  it('returns markdown text on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, '# Claude Code session'));
    const result = await exportDaemonSession(settings, 'abc-123');
    expect(result).toEqual({ ok: true, data: '# Claude Code session' });
  });

  it('returns not_configured with no daemon URL', async () => {
    const result = await exportDaemonSession({ ...settings, daemonUrl: '' }, 'abc-123');
    expect(result).toMatchObject({ ok: false, error: 'not_configured' });
  });

  it('returns unreachable on a non-ok, non-auth status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, { error: 'not_found' }));
    const result = await exportDaemonSession(settings, 'abc-123');
    expect(result).toMatchObject({ ok: false, error: 'unreachable' });
  });
});

function zeroTotals() {
  return { cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, totalTokens: 0 };
}
