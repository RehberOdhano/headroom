#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Claude Code statusline hook script: configured via `statusLine` in `~/.claude/settings.json`,
 * invoked with the current session's context as JSON on stdin, expected to print one line to
 * stdout.
 *
 * Three segments: today's CLI token total (daemon-sourced, no dollar amounts — model name and
 * context-window % are already shown by whatever statusline script this is piped into), the
 * account's 5-hour session rate-limit window, and its weekly window. Both windows come straight
 * from Claude Code's own stdin payload (`rate_limits.five_hour`/`rate_limits.seven_day`, Pro/Max
 * only, absent until the first API response in the session) — this is the same shared
 * account-level limit claude.ai's Settings -> Usage page shows, just surfaced by the CLI itself
 * rather than requiring the browser extension. `spend_limit` is in the same `rate_limits`
 * object but still out of scope here.
 *
 * No build step: plain Node (>=20, for global `fetch`), no imports outside this file, so it
 * can be referenced directly by path in `statusLine` before npm distribution exists.
 */

const TOKEN_PATH = path.join(homedir(), '.config', 'claude-usage', 'token');
const DAEMON_URL = process.env.CLAUDE_USAGE_DAEMON_URL ?? 'http://127.0.0.1:4317';

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function formatResetIn(resetsAtEpochSeconds, now = new Date()) {
  const minutesLeft = Math.round((resetsAtEpochSeconds * 1000 - now.getTime()) / 60_000);
  if (minutesLeft <= 0) return null;
  const hours = Math.floor(minutesLeft / 60);
  const minutes = minutesLeft % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatRateLimitWindow(label, window, now) {
  if (!window || typeof window.used_percentage !== 'number') return null;
  const pct = Math.round(window.used_percentage);
  const resetIn = typeof window.resets_at === 'number' ? formatResetIn(window.resets_at, now) : null;
  return resetIn ? `${label}: ${pct}% (resets in ${resetIn})` : `${label}: ${pct}%`;
}

export function formatSessionWindow(rateLimits, now = new Date()) {
  return formatRateLimitWindow('Session', rateLimits?.five_hour, now);
}

export function formatWeeklyWindow(rateLimits, now = new Date()) {
  return formatRateLimitWindow('Weekly', rateLimits?.seven_day, now);
}

export function buildStatusLine(input, todayTotals) {
  const parts = [];
  const sessionPart = formatSessionWindow(input?.rate_limits);
  if (sessionPart) parts.push(sessionPart);
  const weeklyPart = formatWeeklyWindow(input?.rate_limits);
  if (weeklyPart) parts.push(weeklyPart);
  if (todayTotals) parts.push(`Today: ${formatTokens(todayTotals.totalTokens)} Tokens`);
  return parts.length > 0 ? parts.join(' | ') : 'Claude usage: daemon not running';
}

export async function fetchTodayUsage(fetchImpl = fetch) {
  let token;
  try {
    token = readFileSync(TOKEN_PATH, 'utf-8').trim();
  } catch {
    return null; // daemon never installed/started — no token file yet
  }

  try {
    const response = await fetchImpl(`${DAEMON_URL}/aggregate?by=day&since=${formatDate(new Date())}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.totals ?? null;
  } catch {
    return null; // daemon not running right now — fail silent, a statusline must never error
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // Invalid/missing stdin — still print something rather than nothing.
  }

  const todayTotals = await fetchTodayUsage();
  process.stdout.write(buildStatusLine(input, todayTotals));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
