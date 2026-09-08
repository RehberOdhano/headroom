import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptPairing } from '../lib/pairing.js';

describe('attemptPairing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the token on a successful pairing response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'abc123' }),
    } as Response);

    const result = await attemptPairing('http://127.0.0.1:4317');

    expect(result).toEqual({ ok: true, token: 'abc123' });
  });

  it('POSTs to /pair with no body/headers — the whole point is not needing a token yet', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'abc123' }),
    } as Response);

    await attemptPairing('http://127.0.0.1:4317');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/pair', { method: 'POST' });
  });

  it('reports already_paired distinctly from other failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'already_paired' }),
    } as Response);

    const result = await attemptPairing('http://127.0.0.1:4317');

    expect(result).toEqual({ ok: false, reason: 'already_paired' });
  });

  it('reports unreachable when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await attemptPairing('http://127.0.0.1:4317');

    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports invalid_response when the body does not match the schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ notAToken: true }),
    } as Response);

    const result = await attemptPairing('http://127.0.0.1:4317');

    expect(result).toEqual({ ok: false, reason: 'invalid_response' });
  });
});
