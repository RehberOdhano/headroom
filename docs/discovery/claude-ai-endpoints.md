# claude.ai endpoint discovery

Resolves the first open question in `CLAUDE.md` section 13: exact request/response shapes
for `/usage` and `message_limit`. Captured by driving a real, logged-in claude.ai session
(Pro plan) with the `claude-in-chrome` tool and reading actual network responses — not
inferred from documentation, because there isn't any.

Raw, anonymized samples live in `fixtures/claude-ai/`. This doc is the narrative; the fixture
files are the source of truth for exact shapes, and each carries its own `_fixture_meta`
(or header comment for the SSE files) with endpoint, capture date, account state, and an
explicit `unverified` list — read those before writing a zod schema against them.

## Samples captured

| Sample | Endpoint | Captured | Account state | File |
|---|---|---|---|---|
| Usage snapshot A | `GET /api/organizations/{org_id}/usage` | 2026-08-26T17:20:00Z | overage | `usage.get.overage.json` |
| Usage snapshot B | same | 2026-08-29T09:28:00Z | credits disabled | `usage.get.credits-disabled.json` |
| Completion stream A | `POST .../chat_conversations/{id}/completion` (SSE) | 2026-08-26T17:23:32Z | overage | `message_limit.overage.sse.txt` |
| Completion stream B | same | 2026-08-29T09:28:30Z | credits disabled | `message_limit.five_hour.sse.txt` |

A and B are the *same account*, 3 days apart, in two different billing states — which turned
out to be more useful than two random accounts would have been: it shows which fields are
state-dependent (null vs. populated, present vs. absent vs. differently-shaped) on one fixed
account, rather than leaving that ambiguous.

## `GET /api/organizations/{org_id}/usage`

`org_id` comes from the `lastActiveOrg` cookie, or can be read off the URL of any other
`/api/organizations/{org_id}/...` request the app makes. Same-origin, no auth header beyond
the session cookie.

1. **The top-level object is not closed, and this is now proven, not assumed.** Snapshot A
   lacks a `locked_reason` key entirely (not even null) on `five_hour`/`seven_day`/
   `nimbus_quill`; snapshot B — same account, 3 days later — has it, always null so far. Same
   story for a new top-level codename key, `juniper_tide` (also always null). Something on
   claude.ai's side started sending these fields between the two captures. **This is exactly
   the failure mode `.passthrough()` schemas are meant to survive** — a strict schema built
   from snapshot A would have accepted snapshot B fine (extra unknown keys), but a schema that
   required `locked_reason` (built from snapshot B) would reject snapshot A outright. The zod
   schema marks every field that hasn't been confirmed present in *every* capture as optional.
2. **Fields can flip between a populated object and `null` depending on account state**, not
   just within one "unverified" field but across an entire sub-object:
   - `spend.limit`: a `{amount_minor, currency, exponent}` object in snapshot A (overage,
     credits in use), `null` in snapshot B (credits disabled).
   - `spend.cap`: `{money: null, credits: {...}}` in A, `null` outright in B.
   - `extra_usage.monthly_limit` / `used_credits` / `utilization` / `currency` /
     `decimal_places`: real numbers/strings in A, all `null` in B (`extra_usage.is_enabled`
     flips false).
   None of these were guessable from A alone — the schema now types them nullable based on
   having seen both states for the same fields.
3. **There's a normalized `limits[]` array**, separate from `five_hour`/`seven_day`:
   `{kind, group, percent, severity, resets_at, scope, is_active}`. Both captures have exactly
   `kind: "session"` and `kind: "weekly_all"` entries; `is_active` flips between them based on
   which one is currently binding (session was active in A, weekly in B). Still the more
   forward-compatible source for the limit-bars feature (`CLAUDE.md` section 8.1) than hand-picking
   `five_hour`/`seven_day`. Unverified: whether `kind` ever takes a third value.

## `message_limit` SSE event

The completion stream is a raw `fetch()` response body (`ReadableStream`), **not**
`EventSource` — the extension's page-world hook must wrap `fetch` and tee/clone the response
body, or it will never see this event. `message_limit` arrives after `message_delta` and
before `message_stop`, bracketed by the standard Anthropic message-stream events.

Two structurally different captures now exist:

**Overage** (`message_limit.overage.sse.txt`, `representativeClaim: "overage"`):
```json
{
  "type": "within_limit", "resetsAt": null, "remaining": null, "perModelLimit": null,
  "representativeClaim": "overage", "overageStatus": "within_limit",
  "overageResetsAt": 1788220800, "overageInUse": true,
  "windows": { "overage": { "status": "within_limit", "resets_at": 1788220800, "utilization": 0.0 } },
  "notice": { "title": "Now using usage credits", "text": null, "cta": null, "is_dismissible": true }
}
```

**Credits disabled** (`message_limit.five_hour.sse.txt`, `representativeClaim: "five_hour"`):
```json
{
  "type": "within_limit", "resetsAt": null, "remaining": null, "perModelLimit": null,
  "representativeClaim": "five_hour", "overageDisabledReason": "org_level_disabled",
  "overageInUse": false,
  "windows": {
    "5h": { "status": "within_limit", "resets_at": 1788007200, "utilization": 0.29 },
    "7d": { "status": "within_limit", "resets_at": 1788008400, "utilization": 0.55 }
  },
  "resolved": {
    "status": "ok",
    "limit": { "kind": "session", "group": "session", "percent": 29, "severity": "normal",
               "resets_at": "2026-08-29T12:40:00+00:00", "scope": null, "is_active": true },
    "spend": null, "disabled_reason": "org_level_disabled", "notice": null
  }
}
```

Findings:

1. **`overageStatus` and `overageDisabledReason` look mutually exclusive**, gated on
   `overageInUse`: present one or the other, never both, in the two captures so far. Model this
   as "the field that exists depends on `overageInUse`", not as two independent optional
   fields that happen to alternate.
2. **`windows` is keyed dynamically, and the real keys are now known for two cases**: `"overage"`
   when overage is representative, `"5h"`/`"7d"` (short codes, *not* `"session"`/`"weekly"` as
   originally guessed here) otherwise. Both entries were present together in the credits-disabled
   capture — `windows` isn't single-keyed to just the representative claim. Still unverified:
   whether a third key (e.g. per-model) ever appears, and the `"seven_day"`-representative case
   specifically (only `"five_hour"` has been seen for the non-overage side).
3. **A `resolved` object appears only in the credits-disabled capture.** Its `limit` sub-object
   is structurally identical to one entry of `/usage`'s `limits[]` array. Whether `resolved` is
   absent specifically *because* of overage, or because claude.ai shipped a change in the 3 days
   between captures (plausible — section above already proved `/usage` gained fields in that
   window), is unverified. `resolved.spend` and `resolved.notice` were both `null` here; real
   shape unverified.
4. **`notice`** (present in the overage capture, absent — folded into `resolved.notice: null` —
   in the other) still only has one non-null example: `title` as a string, `text`/`cta` null.
5. **`message_limit.type`** was `"within_limit"` in both captures. Still unverified: any other
   value (e.g. an over-limit/blocked state).

## `claude.ai/code` (Claude Code on the web) — no longer blocked

Loaded successfully on 2026-09-04 (prior attempts across at least two sessions had always hit a
blank tab — see the closed item below for what that turned out to be). The account viewed had
an active Claude Code CLI session mirrored to the web, at `https://claude.ai/code/session_{id}`.

Endpoints observed (all same-origin, session-cookie auth like the rest of claude.ai):

- `GET /v1/code/sessions/{id}` — session metadata: `config` (model, git `sources`/`outcomes`,
  `mcp_connector_ids`), `external_metadata` (`rate_limit_info` — see below, `worktree_state`,
  `current_branches`, a `post_turn_summary` with `status_category`/`status_detail`/
  `needs_action`), `client_presence`, `connection_status`, `worker_status`, `status_bucket`,
  `security_tier`. **Requires an `anthropic-version` request header** (e.g. `2023-06-01`) —
  omitting it returns `400 invalid_request_error: "anthropic-version: header is required"`. This
  only matters for a manual/hook-side `fetch`; the page's own requests already send it, so a
  passive `window.fetch`-wrapping hook (the extension's actual capture mechanism, `CLAUDE.md`
  section 5) never needs to construct this header itself.
- `GET /v1/code/sessions/{id}/events?limit=&sort_order=&cursor=` — paginated event log,
  `{data: [...], resume_cursor}`. Each event: `{event_id, event_type, created_at, sequence_num,
  source, sent_by_account_id, device_attestation_status, payload}`. `event_type` values seen in
  one real session: `user`, `assistant`, `system`, `result`, `control_request`,
  `control_response`, `control_cancel_request`, **`rate_limit_event`**.
- `GET /v1/sessions/{id}/events?limit=&after_id=` — note the different path (`/v1/sessions/`,
  no `/code/`) and cursor style (`after_id` vs. `cursor`); observed once, looks like a
  live-tail/polling variant of the same event log rather than a distinct feed. Unverified.
- `GET /v1/code/sessions/{id}/share`, `POST /v1/code/github/batch-branch-status` — observed,
  not investigated (share-link and repo-picker support respectively, both out of scope for
  usage tracking).
- The account-level endpoints are **identical** to claude.ai chat: `GET
  /api/organizations/{org_id}/usage`, `.../subscription_details`, `.../notification/preferences`,
  `.../prepaid/credits`, `.../overage_credit_grant`. Confirms `CLAUDE.md` section 4's assumption
  that `/usage` is the single source of truth across surfaces — claude.ai/code doesn't have (or
  need) its own copy.

### `rate_limit_event` — the claude.ai/code equivalent of `message_limit`

Fixture: `fixtures/claude-ai/code.rate-limit-event.json`. `payload.rate_limit_info`:

```json
{
  "isUsingOverage": false,
  "overageResetsAt": 1790812800,
  "overageStatus": "allowed",
  "rateLimitType": "five_hour",
  "resetsAt": 1788556200,
  "status": "allowed",
  "unifiedWindows": {
    "five_hour": { "resetsAt": 1788556200, "utilization": 0.17 },
    "seven_day": { "resetsAt": 1788613200, "utilization": 0.29 }
  }
}
```

Same shape family as `message_limit` (`isUsingOverage`/`overageStatus`/`overageResetsAt` mirror
`overageInUse`/`overageDisabledReason`; `unifiedWindows.five_hour`/`seven_day` carry the same
kind of exact unrounded `utilization` fraction `message_limit.windows.5h`/`7d` do) but under
different key names and delivered differently: a discrete event fetched from a REST event log,
not an inline SSE frame on a completion stream. `GET /v1/code/sessions/{id}` also surfaces a
lighter, non-historical snapshot at `external_metadata.rate_limit_info` (no `unifiedWindows`,
just `isUsingOverage`/`rateLimitType`/`resetsAt`/`status`) — useful for "is this session
currently rate-limited" but not for the exact percentage.

**Important scope note discovered live, not assumed:** the same event log's other
`event_type`s (`user`/`assistant`/`system`/`result`/`control_*`) carry real conversation
content — confirmed directly when a `post_turn_summary.needs_action` field on this very
session echoed back a fragment of this conversation's own text during capture. Per this
project's "never log conversation content" rule (`CLAUDE.md` section 9), those event types and
the `post_turn_summary` field are **deliberately not fixtured** and any future schema for them
must be validated structurally (shape/key names only) without a real captured value ever
landing in a committed fixture file.

### What was actually wrong before

Never a beta gate or a moved feature as speculated — the previous "did not load in three
attempts, redirected to a blank tab" almost certainly was actually the browser-automation tool's
own extension being disconnected each time (the exact same failure mode hit at the start of the
session that finally got this capture — `tabs_context_mcp` returned "Browser extension is not
connected" until Chrome was restarted). Nothing about `claude.ai/code` itself needed workaround.

## Still unresolved

- The `"seven_day"`-representative (as opposed to `"five_hour"`) non-overage variant, for both
  `message_limit` and the new `rate_limit_event`.
- `message_limit.type` values other than `"within_limit"`.
- Whether `resolved` and `notice` are truly overage-conditional or a time-based claude.ai change.
- Whether `rate_limit_event` ever appears for an overage-representative account, and whether it
  arrives via server push or only shows up once polled via `GET .../events` (only the latter was
  observed).
- The `/v1/sessions/{id}/events?after_id=` path's exact relationship to `/v1/code/sessions/{id}/
  events?cursor=` — same feed, different pagination style, or something else.

None of the above block building the `message_limit` discriminated union or the limit-bar UI
now that both major branches (overage / non-overage) are captured — they're refinements to
layer on once that's built, not blockers to starting it. Building claude.ai/code support in the
extension is now unblocked at the discovery level too, but is a separate, not-yet-started
feature-build task (hook wiring, a `rate_limit_event`/`external_metadata.rate_limit_info` zod
schema in `packages/shared`, and a decision on whether/how to fold it into the existing
`LimitSnapshot` model) — this doc only resolves the "can we even see the data" question.
