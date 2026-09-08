import { z } from 'zod';
import { limitEntrySchema } from './usage.js';

// Confirmed against fixtures/claude-ai/message_limit.overage.sse.txt and
// message_limit.five_hour.sse.txt — the `message_limit` SSE event on POST
// .../chat_conversations/{id}/completion, captured from the same account 3 days apart in two
// different billing states. See docs/discovery/claude-ai-endpoints.md for the full comparison.
//
// The two captures differ enough, and consistently enough with `overageInUse`, to model as a
// real discriminated union rather than a single loose object:
// - overageInUse: true  -> has overageStatus/overageResetsAt, windows keyed "overage", a
//   top-level `notice`.
// - overageInUse: false -> has overageDisabledReason instead, windows keyed "5h"/"7d", a
//   `resolved` object (whose `limit` is the exact same shape as one entry of /usage's
//   `limits[]` — reused from usage.ts) instead of a top-level `notice`.
// Caveat, still unverified: whether `resolved`/`notice` presence is really caused by
// overageInUse, or is a claude.ai change that happened to land in the 3 days between captures.
// Only one sample of each branch exists — if a fixture ever contradicts this shape, that's a
// real "data shape changed" signal, not a bug in the schema.

const windowEntrySchema = z.object({
  status: z.string(),
  resets_at: z.number(),
  utilization: z.number(),
});

// Confirmed identical value shape under 3 different real keys ("overage", "5h", "7d") across
// both captures — a record is a generalization from repeated observation, not a guess. Whether
// a 4th kind of key (e.g. per-model) ever appears is unverified.
const windowsSchema = z.record(z.string(), windowEntrySchema);

const noticeSchema = z
  .object({
    // Observed as a non-null string once ("Now using usage credits"); text/cta only null so far.
    title: z.string().nullable(),
    text: z.unknown(),
    cta: z.unknown(),
    is_dismissible: z.boolean(),
  })
  .passthrough();

const commonFields = {
  // Only "within_limit" observed. Docs flag other values (e.g. an over-limit/blocked state) as
  // unverified, so this stays an open string, not z.literal.
  type: z.string(),
  resetsAt: z.unknown(),
  remaining: z.unknown(),
  perModelLimit: z.unknown(),
  // "overage" and "five_hour" observed; "seven_day" expected but uncaptured.
  representativeClaim: z.string(),
};

const overageInUseVariant = z
  .object({
    ...commonFields,
    overageInUse: z.literal(true),
    overageStatus: z.string(),
    overageResetsAt: z.number(),
    windows: windowsSchema,
    notice: noticeSchema,
  })
  .passthrough();

const overageDisabledVariant = z
  .object({
    ...commonFields,
    overageInUse: z.literal(false),
    overageDisabledReason: z.string(),
    windows: windowsSchema,
    resolved: z
      .object({
        status: z.string(),
        limit: limitEntrySchema,
        // Only observed null — unverified when populated.
        spend: z.unknown(),
        disabled_reason: z.string(),
        notice: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

const messageLimitDetailSchema = z.discriminatedUnion('overageInUse', [
  overageInUseVariant,
  overageDisabledVariant,
]);

export const messageLimitEventSchema = z
  .object({
    type: z.literal('message_limit'),
    message_limit: messageLimitDetailSchema,
  })
  .passthrough();

export type MessageLimitEvent = z.infer<typeof messageLimitEventSchema>;
