# headroom — Claude Usage Companion

A cross-browser extension (Chrome, Edge, Firefox) with an optional local daemon that gives you
one place to see Claude usage across claude.ai and the Claude Code CLI: session and weekly
limit bars, burn-rate forecasts, multi-week history, CLI attribution, cross-project session
search, and retention warnings.

Usage data is captured at the network level (`fetch`/SSE), not by scraping claude.ai's DOM, so
the extension keeps working through frontend redesigns. Nothing leaves your machine.

> "headroom" is the repository name; "Claude Usage Companion" is the product name shown in the
> extension itself.

## Status

Pre-release. Submitted to the Chrome Web Store (pending review). Not yet submitted to Edge
Add-ons or Firefox AMO — install from a local checkout in the meantime (see below). Verified
working end to end on Chrome, Edge, and Firefox.

## Why this exists

Existing Claude usage trackers take one of two approaches, both with drawbacks: they inject UI
into claude.ai's DOM (which breaks on every frontend change), or they cover claude.ai chat only
and ignore the CLI. Neither forecasts usage or tracks history over time.

headroom is built differently, and adds what's missing elsewhere:

- Network-level capture instead of DOM scraping, so it's resilient to redesigns
- Burn-rate forecasting ("at current pace, reaches limit at ~8:00 PM")
- Multi-week usage history with charts
- CLI attribution surfaced directly in the browser
- Cross-project CLI session search
- Session retention warnings before Claude Code's 30-day log cleanup

**Out of scope, by design:** the Claude desktop app's per-conversation detail (not visible to a
browser; its usage is still reflected in your shared session/weekly totals) and API console /
pay-as-you-go usage.

## Installation

### Extension

```sh
git clone <this repo>
cd headroom
pnpm install
pnpm --filter @headroom/extension run build        # add ":firefox" suffix for Firefox
```

| Browser | Steps |
| --- | --- |
| Chrome / Edge | Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, click **Load unpacked**, select `packages/extension/.output/chrome-mv3`. |
| Firefox | Run `pnpm --filter @headroom/extension run build:firefox`, then load `packages/extension/.output/firefox-mv2` via `about:debugging` → **This Firefox** → **Load Temporary Add-on**. For live reload during development, use `pnpm --filter @headroom/extension run dev:firefox` instead. |

Once installed, visit any claude.ai page once so the extension can detect your account. After
that it polls in the background — the popup and dashboard update on their own.

### Daemon (optional)

The extension is fully functional on its own. The daemon is a separate, opt-in component that
reads your local Claude Code session logs (`~/.claude/projects/**/*.jsonl`) to unlock CLI
attribution, cross-project session search, and retention warnings. It never communicates with
claude.ai, and claude.ai never communicates with it. It is stateless and read-only — all
persistent state lives in the extension.

Not yet published to npm; run it from the checkout:

```sh
cd packages/daemon
pnpm exec tsx src/cli.ts install    # generates a token, registers a login-time service, starts it
```

No token to copy or paste: open the extension's options page and it pairs with the daemon
automatically within about a minute (a **Check now** button forces this immediately). The
daemon exposes a one-time, unauthenticated `/pair` endpoint that hands the extension its token
on first request, then locks itself — see `packages/daemon/src/auth.ts` for the trust model.
Re-running `install` issues a fresh token and reopens the pairing window. A manual **Advanced**
field in the options page also accepts a pasted token directly, for edge cases.

`install` registers a background service so the daemon survives a reboot: a launchd agent on
macOS, a systemd `--user` unit on Linux, or a Task Scheduler task on Windows. On Linux, also run
`loginctl enable-linger $USER` so it survives logging out. To run it in the foreground instead,
use `pnpm exec tsx src/cli.ts start`.

To uninstall:

| Platform | Command |
| --- | --- |
| macOS | `launchctl unload ~/Library/LaunchAgents/com.headroom.claude-usage-daemon.plist && rm ~/Library/LaunchAgents/com.headroom.claude-usage-daemon.plist` |
| Linux | `systemctl --user disable --now claude-usage-daemon.service` |
| Windows | `schtasks /delete /tn ClaudeUsageDaemon /f` |

The token file at `~/.config/claude-usage/token` can be deleted afterward as well.

### Statusline (optional)

`packages/daemon/bin/statusline.mjs` is a self-contained script for Claude Code's `statusLine`
hook. It prints three segments:

- `Session: <pct>%` and `Weekly: <pct>%`, each with a reset countdown — read directly from
  Claude Code's own stdin payload (`rate_limits.five_hour` / `rate_limits.seven_day`, Pro/Max
  only, available after the first message in a session). These reflect the same account-level
  limits shown on claude.ai's Settings → Usage page, so they work without the daemon.
- `Today: <n> Tokens` — daemon-sourced CLI token total; prints nothing if the daemon isn't
  installed.

Point `statusLine` in `~/.claude/settings.json` directly at the script, or pipe your existing
statusline script's stdin through `node /path/to/packages/daemon/bin/statusline.mjs` and append
its output as an additional segment.

## Features

| Feature | Description |
| --- | --- |
| Limit bars | Session (5h) and weekly usage from `/usage` polling, upgraded to exact unrounded fractions by `message_limit` SSE events (claude.ai chat) or `rate_limit_event` entries (Claude Code on the web) while active. Reset countdowns switch from relative ("in 3h 14m") to absolute ("Thu, 8:00 PM") once more than a day out. |
| Extra usage credits | Shown when your plan has pay-as-you-go credits enabled. |
| Burn-rate forecast | Linear projection over the current run since the last reset, with confidence labeled low/medium/high. |
| History dashboard | Weeks of local snapshot history as charts, with 24h/7d/30d windows. |
| Threshold alerts | Configurable browser notifications (default: 80% / 95%). |
| On-page badge | A small, self-contained, toggleable usage indicator on claude.ai. |
| CLI attribution *(daemon)* | Token and cost totals by project and model, plus a rough tokens-per-percent-of-weekly-limit estimate. |
| Session search *(daemon)* | Full-text search across local Claude Code sessions, with a one-click `cd <dir> && claude --resume <id>` copy button. |
| Retention warnings *(daemon)* | Flags sessions nearing Claude Code's 30-day log cleanup, with one-click markdown export (embedded images included). |

## Privacy & security

- Nothing leaves your machine — no accounts, no cloud sync, no analytics, no crash reporting.
- The extension only talks to `https://claude.ai` and `http://127.0.0.1` (the daemon).
- The daemon binds to `127.0.0.1` only, requires a bearer token on every route except
  `/health`, and rejects any `http(s):` page origin outright — only extension-scheme origins
  are accepted.
- No conversation content is ever logged. Logs contain only ids, counts, and timestamps.
- All claude.ai endpoints in use are undocumented and unofficial, and can change without
  notice — this has already been observed between two captures a few days apart. Every payload
  is validated against a schema that fails soft: a bad snapshot is skipped and logged rather
  than breaking the pipeline.

## Known limitations

- Per-model limit rows are not shown — no captured `/usage` response has ever included a
  `limits[]` entry beyond the overall session/weekly kinds, so there is nothing real to build
  against yet.
- Submitted to the Chrome Web Store (pending review); not yet submitted to Edge Add-ons or
  Firefox AMO.

## Development

Monorepo, pnpm workspaces, TypeScript strict mode throughout.

```
packages/
  shared/     zod schemas + normalized usage model, shared across extension and daemon
  extension/  WXT + React + Dexie — the browser extension
  daemon/     Node + Hono — the optional local daemon
```

```sh
pnpm install
pnpm -r run test         # 257 tests across the three packages as of this writing
pnpm -r run typecheck
pnpm -r run build
```

Fixtures for claude.ai response shapes live in `fixtures/claude-ai/`. Every schema in
`packages/shared` is derived from a real, anonymized capture rather than a guess.

## License

MIT — see [`LICENSE`](./LICENSE).
