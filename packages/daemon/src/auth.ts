import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Context, Next } from 'hono';

export const TOKEN_DIR = path.join(homedir(), '.config', 'claude-usage');
export const TOKEN_PATH = path.join(TOKEN_DIR, 'token');
const PAIRED_MARKER_PATH = path.join(TOKEN_DIR, 'paired');

function tokenPath(configDir?: string): string {
  return configDir ? path.join(configDir, 'token') : TOKEN_PATH;
}

function pairedMarkerPath(configDir?: string): string {
  return configDir ? path.join(configDir, 'paired') : PAIRED_MARKER_PATH;
}

/** Generates a fresh token and writes it to `~/.config/claude-usage/token` (0600), overwriting
 *  any existing one. Used by `daemon install`/on first `daemon start`. `configDir` overrides
 *  the directory — tests pass a temp dir so they never touch a real machine's actual token.
 *  Also clears the pairing marker (below): a fresh token re-opens a one-time auto-pairing
 *  window, same as the old flow re-opened whenever you re-ran `install` and re-pasted by hand. */
export function generateToken(configDir?: string): string {
  const token = randomBytes(32).toString('hex');
  const dir = configDir ?? TOKEN_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath(configDir), token, { mode: 0o600 });
  rmSync(pairedMarkerPath(configDir), { force: true });
  return token;
}

/** Whether `/pair` (below) has already been claimed for the current token. Auto-pairing is
 *  intentionally single-use — the first extension to ask right after `install`/a token rotation
 *  gets it, and every request after that 403s — so it degrades to the same trust boundary as
 *  the old copy-paste flow (whoever has local access during that window) rather than leaving an
 *  unauthenticated way to fetch the token indefinitely. */
export function isPaired(configDir?: string): boolean {
  return existsSync(pairedMarkerPath(configDir));
}

/** Marks `/pair` as claimed. `configDir` overrides the directory for tests, same as above. */
export function markPaired(configDir?: string): void {
  const dir = configDir ?? TOKEN_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(pairedMarkerPath(configDir), new Date().toISOString(), { mode: 0o600 });
}

/** Reads the existing token, generating one first if none exists yet — so `daemon start` alone
 *  (without a prior `install`) still works, e.g. during development. */
export function readOrCreateToken(configDir?: string): string {
  const file = tokenPath(configDir);
  if (existsSync(file)) return readFileSync(file, 'utf-8').trim();
  return generateToken(configDir);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch rather than returning false — lengths differing
  // is itself not sensitive (token length is fixed and public), so comparing on a padded copy
  // keeps this branch-free without leaking anything.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Bearer token + Origin check, both required before this is network-reachable from a browser.
 * The Origin check can't pin a specific extension ID —
 * Chrome/Edge only assign one once published to a store, and it differs per browser and per
 * unpacked/dev install — so instead it allowlists the *scheme* (`chrome-extension:`,
 * `moz-extension:`, `safari-web-extension:`) plus same-machine tooling (no Origin header at
 * all, e.g. curl or the statusline script), and rejects any `http(s):` page origin outright.
 * That's the actual threat this defends against: an arbitrary website's `fetch` reaching the
 * local daemon (a "localhost drive-by" / DNS-rebinding-style attack), not a same-origin
 * extension the token itself already gates.
 */
/** The Origin half of the check documented above, split out so `/pair` (app.ts) can reuse it
 *  without the bearer-token half — `/pair`'s whole job is handing out that token in the first
 *  place, so it can't require it, but it still must not be reachable from an arbitrary webpage. */
export function forbiddenOrigin(c: Context): Response | null {
  const origin = c.req.header('Origin');
  if (origin && !/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
    return c.json({ error: 'forbidden_origin' }, 403);
  }
  return null;
}

export function requireAuth(token: string) {
  return async (c: Context, next: Next) => {
    const forbidden = forbiddenOrigin(c);
    if (forbidden) return forbidden;

    const authHeader = c.req.header('Authorization');
    const headerToken = authHeader?.match(/^Bearer (.+)$/)?.[1];
    // /events is EventSource-backed and can't set custom headers, so it's the one route that
    // also accepts the token as a query param — see app.ts.
    const queryToken = c.req.query('token');
    const presented = headerToken ?? queryToken;

    if (!presented || !safeEqual(presented, token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    await next();
  };
}
