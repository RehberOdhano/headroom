# Claude Usage Companion — daemon

Optional, local-only companion daemon for the [Claude Usage Companion](https://github.com/RehberOdhano/headroom)
browser extension (Chrome, Edge, Firefox). The extension is fully functional on its own — this
package is only worth installing once the extension is, since it's what pairs with it to unlock
everything below.

It reads your local Claude Code session logs (`~/.claude/projects/**/*.jsonl`). It never talks to
claude.ai, and claude.ai never talks to it. It's stateless and read-only with respect to any of
your projects — its only writes are to its own local config dir (the auth token and pairing
marker) — see the [main repo](https://github.com/RehberOdhano/headroom) for the full source and
docs.

## Install

Requires Node.js ≥20.

```sh
npm install -g @rehberodhano/claude-usage-companion-daemon
claude-usage-daemon install    # generates a token, registers a login-time service, starts it
```

No token to copy or paste: open the extension's options page and it pairs with the daemon
automatically within about a minute (a **Check now** button forces this immediately).

If you later reinstall the extension or clear its data, run `claude-usage-daemon install` again —
the daemon hands out its token only once, so a fresh extension otherwise can't pair.

`install` registers a background service so the daemon survives a reboot: a launchd agent on
macOS, a systemd `--user` unit on Linux, or a Task Scheduler task on Windows. On Linux, also run
`loginctl enable-linger $USER` so it survives logging out. To run it in the foreground instead,
use `claude-usage-daemon start`.

**Windows note:** the Task Scheduler registration path is unit-tested (mocked command
execution) but hasn't yet been verified end-to-end on a real Windows machine, unlike the macOS
and Linux paths. If `install` doesn't work as expected there, please open an issue on the
[main repo](https://github.com/RehberOdhano/headroom/issues) — running `claude-usage-daemon
start` in the foreground works regardless of platform.

## What it unlocks

Once paired, the extension's dashboard gets:

- CLI token attribution by project, model, and session, plus a rough
  tokens-per-percent-of-weekly-limit estimate
- Read-only subagent usage attribution (which subagents ran, their own token totals)
- Full-text session search with one-click resume
- Retention warnings before Claude Code's 30-day log cleanup, with markdown export

See the [main repo's README](https://github.com/RehberOdhano/headroom#features) for the full
feature reference.

## Uninstall

| Platform | Command |
| --- | --- |
| macOS | `launchctl unload ~/Library/LaunchAgents/com.headroom.claude-usage-daemon.plist && rm ~/Library/LaunchAgents/com.headroom.claude-usage-daemon.plist` |
| Linux | `systemctl --user disable --now claude-usage-daemon.service` |
| Windows | `schtasks /delete /tn ClaudeUsageDaemon /f` |

The token file at `~/.config/claude-usage/token` can be deleted afterward as well.

## Statusline

This package also installs `claude-usage-statusline`, a self-contained script for Claude Code's
`statusLine` hook. It prints session/weekly rate-limit windows (straight from Claude Code's own
stdin payload — works without the daemon) plus today's CLI token total (daemon-sourced). Point
`statusLine` in `~/.claude/settings.json` at `claude-usage-statusline`, or pipe your existing
statusline script's stdin through it and append its output as an additional segment.

## Privacy & security

- Nothing leaves your machine — no accounts, no cloud sync, no analytics.
- Binds to `127.0.0.1` only, requires a bearer token on every route except `/health` and the
  one-time `/pair`, and rejects any `http(s):` page origin outright. Requests with no `Origin`
  header at all (curl, the statusline script) are allowed, but still need the token.
- No conversation content is ever logged or sent anywhere. Session search and markdown export do
  read session content, but only locally and on demand, when you ask for them.

Full privacy policy: https://rehberodhano.github.io/headroom/privacy.html

## License

MIT — see [`LICENSE`](https://github.com/RehberOdhano/headroom/blob/main/LICENSE).
