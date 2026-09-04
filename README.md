# headroom — Claude Usage Companion

A cross-browser extension (Chrome, Edge, Firefox) plus an optional local daemon that together
put Claude usage — claude.ai *and* the Claude Code CLI — in one place: session/weekly limit bars,
burn-rate forecasts, weeks of history, CLI attribution, cross-project session search, and
retention warnings, without depending on claude.ai's DOM (which breaks on every redesign) or
sending anything off your machine.

"headroom" is the repo/directory name; "Claude Usage Companion" is the product name shown in
the extension itself.

## Status

Pre-release. Not published to the Chrome Web Store, Edge Add-ons, or Firefox AMO yet — install
it from a local checkout (below). Built and tested on Chrome; Firefox/Edge builds compile and
typecheck but haven't been run live yet.

## Why

Existing Claude usage trackers either inject into claude.ai's DOM (breaks on every frontend
change), only cover claude.ai chat and not the CLI, or don't forecast/track history at all.
This one captures data via a network-level `fetch`/SSE hook instead of DOM scraping, and adds
the things nobody else has: burn-rate forecasting, multi-week history, CLI attribution inside
the browser, cross-project CLI session search, and session retention warnings.

**Not covered, on purpose:** the Claude desktop app's per-conversation detail (invisible to a
browser — its usage shows up in your shared session/weekly totals, same as any other surface,
just not broken out separately), and the API console / pay-as-you-go usage.

## Install the extension

```
git clone <this repo>
cd headroom
pnpm install
pnpm --filter @headroom/extension run build      # or build:firefox for Firefox
```

**Chrome / Edge:** open `chrome://extensions` (or `edge://extensions`), enable Developer mode,
"Load unpacked", select `packages/extension/.output/chrome-mv3`.

**Firefox:** `pnpm --filter @headroom/extension run build:firefox`, then load
`packages/extension/.output/firefox-mv2` via `about:debugging` → "This Firefox" → "Load
Temporary Add-on" (or `pnpm --filter @headroom/extension run dev:firefox` for a live-reloading
dev session).

Once loaded, visit any claude.ai page once so the extension can find your account — after
that it polls in the background and the popup/dashboard update on their own; no need to keep
visiting Settings → Usage.

## The daemon (optional)

The extension is fully useful on its own. The daemon is a separate, manual, opt-in add-on that
unlocks CLI attribution, cross-project session search, and retention warnings by reading your
local Claude Code session logs (`~/.claude/projects/**/*.jsonl`) — it never talks to claude.ai
and claude.ai never talks to it. It's stateless and read-only: all persistent state lives in
the extension.

No npm package is published yet, so run it from the checkout:

```
cd packages/daemon
pnpm exec tsx src/cli.ts install    # generates a token, registers a login-time service, starts it now
```

Nothing to copy or paste after that — open the extension's options page and it pairs with the
daemon on its own within about a minute (a "Check now" button forces it immediately). Under the
hood: the daemon exposes a one-time, unauthenticated `/pair` endpoint that hands the extension
its token the first time it asks; it locks itself after that single request, so it degrades to
the same "whoever has local access right after install" trust boundary as the old copy-paste
flow rather than leaving the token fetchable indefinitely (`packages/daemon/src/auth.ts`).
Re-running `install` issues a fresh token and reopens the pairing window. A manual "Advanced"
field in the options page still accepts a pasted token directly, for edge cases.

`install` registers a real background service so the daemon survives a reboot: a launchd agent
on macOS, a systemd `--user` unit on Linux (also run `loginctl enable-linger $USER` so it
survives logging out), or a Task Scheduler task on Windows. If you'd rather not install a
background service, `pnpm exec tsx src/cli.ts start` runs it in the foreground for as long as
that terminal stays open.

To remove it: macOS — `launchctl unload ~/Library/LaunchAgents/com.headroom.claude-usage-daemon.plist
&& rm ~/Library/LaunchAgents/com.headroom.claude-usage-daemon.plist`; Linux —
`systemctl --user disable --now claude-usage-daemon.service`; Windows —
`schtasks /delete /tn ClaudeUsageDaemon /f`. The token file
(`~/.config/claude-usage/token`) is safe to delete afterward too.

### Statusline (optional)

`packages/daemon/bin/statusline.mjs` is a self-contained script for Claude Code's `statusLine`
hook, printing three segments: `Session: <pct>%` and `Weekly: <pct>%`, each with a reset
countdown — the account's 5-hour and 7-day rate-limit windows, read directly from Claude Code's
own stdin payload (`rate_limits.five_hour`/`rate_limits.seven_day`, Pro/Max only, appear after
your first message in a session) — and `Today: <n> Tokens` (daemon-sourced CLI total — needs
the daemon). The two rate-limit segments are the same shared limits claude.ai's Settings ->
Usage page shows, so they work even without the daemon. Point `statusLine` in
`~/.claude/settings.json` at it directly, or — if you already have a custom statusline script —
pipe its own stdin through `node /path/to/packages/daemon/bin/statusline.mjs` and append the
output as one more segment (the token segment prints nothing if
`~/.config/claude-usage/token` doesn't exist, so it's safe to add unconditionally to a script
that runs whether or not the daemon is installed).

## Features

- **Limit bars** — session (5h) and weekly, from `/usage` polling, upgraded to exact unrounded
  fractions by `message_limit` SSE events while you're actively chatting on claude.ai, or by
  `rate_limit_event` entries while you're actively coding in a Claude Code on the web
  (`claude.ai/code`) session — both are the same shared account limit, just observed from a
  different surface; reset countdowns switch from a relative "in 3h 14m" to an absolute
  "Thu, 8:00 PM" once a day or more out.
- **Extra usage credits** — shown when your plan has pay-as-you-go credits enabled.
- **Burn-rate forecast** — "at current pace, reaches limit ~Thu 8:00 PM", linear projection
  over the current run since the last reset, confidence labeled low/medium/high.
- **History dashboard** — weeks of local snapshot history as charts, 24h/7d/30d windows.
- **Threshold alerts** — configurable browser notifications (default 80%/95%).
- **On-page badge** — a small, self-contained usage indicator on claude.ai (toggleable).
- **CLI attribution** *(daemon)* — token/cost totals by project and model, plus a rough
  tokens-per-percent-of-weekly-limit estimate.
- **Session search** *(daemon)* — full-text search across every local Claude Code session,
  with a one-click `cd <dir> && claude --resume <id>` copy button.
- **Retention warnings + export** *(daemon)* — flags sessions nearing Claude Code's 30-day
  log cleanup, with one-click markdown export (pasted images included, as embedded data URIs).

## Privacy & security

- Nothing leaves your machine. No accounts, no cloud sync, no analytics, no crash reporting.
- The extension only talks to `https://claude.ai` and `http://127.0.0.1` (the daemon).
- The daemon binds to `127.0.0.1` only, requires a bearer token on every route but `/health`,
  and rejects any `http(s):` page Origin outright (only extension-scheme origins get in).
- Nothing here logs conversation content — logs contain ids, counts, and timestamps only.
- All claude.ai endpoints used are undocumented and unofficial. They can and have already
  changed between two captures a few days apart; every payload is validated with a schema that
  fails soft (skips the bad snapshot, logs what didn't match) rather than breaking the pipeline.

## Known limitations

- Per-model limit rows aren't shown — no captured `/usage` response has ever included a
  `limits[]` entry for anything but the overall session/weekly kinds, so there's nothing real
  to build against yet.
- Firefox and Edge builds exist and pass typecheck/tests but haven't been run in a live browser.
- Not submitted to any extension store yet.

## Development

Monorepo, pnpm workspaces, TypeScript strict mode throughout.

```
packages/
  shared/     zod schemas + normalized usage model, shared across extension and daemon
  extension/  WXT + React + Dexie — the browser extension
  daemon/     Node + Hono — the optional local daemon
```

```
pnpm install
pnpm -r run test         # 257 tests across the three packages as of this writing
pnpm -r run typecheck
pnpm -r run build
```

Fixtures for claude.ai response shapes live in `fixtures/claude-ai/` — every schema in
`packages/shared` traces back to a real, anonymized capture, not a guess.

## License

MIT — see `LICENSE`.
