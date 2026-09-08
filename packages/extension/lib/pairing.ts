import { daemonPairResponseSchema } from '@headroom/shared';

export type PairingResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'unreachable' | 'already_paired' | 'invalid_response' };

/**
 * Auto-pairing: `POST /pair` on the daemon (packages/daemon/src/app.ts, src/auth.ts) hands back
 * the token without the user ever copying one by hand. It's unauthenticated by design but
 * single-use server-side — the daemon 403s every call after the first one following an
 * `install`/token rotation — so this is safe to retry on a timer without needing to know
 * whether pairing already happened; a stale "already_paired" response just means stop asking
 * until the user explicitly re-pairs (daemon-side token rotation reopens the window).
 */
export async function attemptPairing(daemonUrl: string): Promise<PairingResult> {
  let response: Response;
  try {
    response = await fetch(`${daemonUrl}/pair`, { method: 'POST' });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (!response.ok) {
    // 403 covers both forbidden_origin and already_paired (auth.ts) — either way there is
    // nothing this extension instance can do about it right now, so both collapse to the same
    // outward reason; already_paired is the one worth surfacing distinctly in the UI.
    let body: { error?: string } = {};
    try {
      body = (await response.json()) as { error?: string };
    } catch {
      // fall through — treat as unreachable below
    }
    if (body.error === 'already_paired') return { ok: false, reason: 'already_paired' };
    return { ok: false, reason: 'unreachable' };
  }

  const raw: unknown = await response.json();
  const result = daemonPairResponseSchema.safeParse(raw);
  if (!result.success) return { ok: false, reason: 'invalid_response' };
  return { ok: true, token: result.data.token };
}
