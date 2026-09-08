import { z } from 'zod';

// Confirmed against fixtures/claude-ai/code.rate-limit-event.json — one `rate_limit_event`
// entry from `GET /v1/code/sessions/{id}/events` (claude.ai/code's event log, distinct from
// claude.ai chat's `message_limit` SSE event). See docs/discovery/claude-ai-endpoints.md's
// "claude.ai/code" section for the full capture narrative.
//
// Only one real capture exists (isUsingOverage: false) — unlike message-limit.ts this is NOT
// yet modeled as a discriminated union. Every field below was actually present in that one
// capture, so each is required rather than optional, but whether the same shape holds when
// isUsingOverage: true (an overage-representative variant) is unverified. Same rule as the rest
// of this package: a field only gets a real zod type once a fixture shows it.

const unifiedWindowEntrySchema = z.object({
  resetsAt: z.number(),
  utilization: z.number(),
});

// Confirmed keys "five_hour" and "seven_day" present together in the one capture — a record,
// not a fixed two-key object, for the same reason message-limit.ts's `windowsSchema` is a
// record: a third key (e.g. per-model) is unverified, not ruled out. Note this entry shape has
// no `status` field, unlike message_limit's `windows[key]` — confirmed absent, not an oversight.
const unifiedWindowsSchema = z.record(z.string(), unifiedWindowEntrySchema);

export const rateLimitInfoSchema = z
  .object({
    isUsingOverage: z.boolean(),
    overageResetsAt: z.number(),
    overageStatus: z.string(),
    // "five_hour" observed; "seven_day" expected but uncaptured — same open-string treatment as
    // message-limit.ts's `representativeClaim`.
    rateLimitType: z.string(),
    resetsAt: z.number(),
    // Account-level status ("allowed" observed) — a different vocabulary from usage.ts's
    // `severity` ("normal" etc.), not a renamed version of it. Don't conflate the two.
    status: z.string(),
    unifiedWindows: unifiedWindowsSchema,
  })
  .passthrough();

export const rateLimitEventSchema = z
  .object({
    event_type: z.literal('rate_limit_event'),
    created_at: z.string(),
    payload: z
      .object({
        type: z.literal('rate_limit_event'),
        session_id: z.string(),
        rate_limit_info: rateLimitInfoSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;
export type RateLimitEvent = z.infer<typeof rateLimitEventSchema>;
