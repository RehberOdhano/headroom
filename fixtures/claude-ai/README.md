# claude.ai fixtures

Raw, anonymized samples of claude.ai API responses, captured from a real logged-in session.
Full narrative and findings: `docs/discovery/claude-ai-endpoints.md`.

| File | Endpoint | Captured | Account state |
|---|---|---|---|
| `usage.get.overage.json` | `GET /api/organizations/{org_id}/usage` | 2026-08-26T17:20:00Z | overage |
| `usage.get.credits-disabled.json` | same | 2026-08-29T09:28:00Z | credits disabled (same account, 3 days later) |
| `message_limit.overage.sse.txt` | `POST .../chat_conversations/{id}/completion` (SSE) | 2026-08-26T17:23:32Z | overage |
| `message_limit.five_hour.sse.txt` | same | 2026-08-29T09:28:30Z | credits disabled (same account, 3 days later) |
| `code.rate-limit-event.json` | `GET /v1/code/sessions/{id}/events` (claude.ai/code) | 2026-09-04T18:15:02Z | not in overage |

Each file's own `_fixture_meta` (JSON) or header comment (SSE) lists exactly what in it is
unverified — check that before writing a schema or test against it. The two pairs are from the
*same account* days apart, which is itself informative: fields present in the later capture but
entirely absent from the earlier one (`locked_reason`, `juniper_tide`, the whole `resolved`
object) are real evidence claude.ai adds fields over time, not a hypothetical.
