import { z } from 'zod';

// Confirmed against fixtures/claude-ai/usage.get.overage.json and usage.get.credits-disabled.json
// (GET /api/organizations/{org}/usage) — same account, 3 days apart, in different billing
// states. See docs/discovery/claude-ai-endpoints.md and each fixture's `_fixture_meta`.
//
// Every field that has only ever been observed as `null` in EVERY capture is `z.unknown()`, not
// guessed. Fields observed as a real value in one capture and `null` in another are nullable,
// not `z.unknown()` — that's a confirmed type, just a confirmed-nullable one (e.g. spend.limit,
// extra_usage.monthly_limit). Fields observed only in the later capture (`locked_reason`,
// `juniper_tide` — proven absent, not just null, in the earlier one) are `.optional()`: the two
// captures are proof claude.ai adds fields to this response over time. This whole object
// intentionally does NOT use `.strict()` for the same reason — a schema built from only the
// earlier capture would already have broken on the later one.

/** Shape shared by `five_hour`, `seven_day`, and `nimbus_quill`. */
const limitWindowSchema = z.object({
  utilization: z.number(),
  resets_at: z.string().nullable(),
  // Only ever observed as null — real (non-null) shape unverified.
  limit_dollars: z.unknown(),
  used_dollars: z.unknown(),
  remaining_dollars: z.unknown(),
  // Absent entirely from usage.get.overage.json; present (always null so far) in
  // usage.get.credits-disabled.json, captured 3 days later on the same account.
  locked_reason: z.unknown().optional(),
});

const moneySchema = z.object({
  amount_minor: z.number(),
  currency: z.string(),
  exponent: z.number(),
});

/** `spend.cap.credits` — like moneySchema but no `currency` key in the one sample seen. */
const creditsAmountSchema = z.object({
  amount_minor: z.number(),
  exponent: z.number(),
});

const extraUsageSchema = z.object({
  is_enabled: z.boolean(),
  // Real values when is_enabled=true (overage fixture); all null together when is_enabled=false
  // (credits-disabled fixture) — confirmed-nullable, not unverified.
  monthly_limit: z.number().nullable(),
  used_credits: z.number().nullable(),
  utilization: z.number().nullable(),
  currency: z.string().nullable(),
  decimal_places: z.number().nullable(),
  // Only observed null in both captures — real shape when populated is unverified.
  disabled_reason: z.unknown(),
  user_disabled: z.boolean(),
  spend_limit_reached: z.boolean(),
  credits_ever_enabled: z.boolean(),
  daily: z.unknown(),
  weekly: z.unknown(),
});

/** Exported: `message-limit.ts`'s `resolved.limit` is the same shape, reused there. */
export const limitEntrySchema = z.object({
  // `kind`/`group`/`severity` are confirmed to be strings; only "session"/"weekly_all" (kind)
  // and "normal" (severity) observed so far, so these stay z.string() rather than a closed
  // enum — whether other values exist is unverified.
  kind: z.string(),
  group: z.string(),
  percent: z.number(),
  severity: z.string(),
  resets_at: z.string(),
  // Always null in both fixtures (all entries) — unverified.
  scope: z.unknown(),
  is_active: z.boolean(),
});

const spendSchema = z.object({
  used: moneySchema,
  // A real object when spend is enabled (overage fixture), null when disabled
  // (credits-disabled fixture) — confirmed-nullable.
  limit: moneySchema.nullable(),
  percent: z.number(),
  severity: z.string(),
  enabled: z.boolean(),
  disabled_reason: z.unknown(),
  cap: z
    .object({
      // Always null in both fixtures — unverified.
      money: z.unknown(),
      credits: creditsAmountSchema,
    })
    .nullable(),
  balance: z.unknown(),
  auto_reload: z.unknown(),
  disclaimer: z.string(),
  can_purchase_credits: z.boolean(),
  can_toggle: z.boolean(),
});

export const usageResponseSchema = z
  .object({
    five_hour: limitWindowSchema,
    seven_day: limitWindowSchema,
    nimbus_quill: limitWindowSchema.nullable(),
    // Codename-obfuscated, unlaunched limit surfaces — every one null in both captures.
    // Real (non-null) shape unverified for all of them; see docs/discovery/claude-ai-endpoints.md.
    seven_day_oauth_apps: z.unknown(),
    seven_day_opus: z.unknown(),
    seven_day_sonnet: z.unknown(),
    seven_day_cowork: z.unknown(),
    seven_day_omelette: z.unknown(),
    tangelo: z.unknown(),
    iguana_necktie: z.unknown(),
    omelette_promotional: z.unknown(),
    cinder_cove: z.unknown(),
    amber_ladder: z.unknown(),
    // Absent entirely from usage.get.overage.json; present (null) in
    // usage.get.credits-disabled.json — see limitWindowSchema's locked_reason comment above.
    juniper_tide: z.unknown().optional(),
    extra_usage: extraUsageSchema,
    limits: z.array(limitEntrySchema),
    spend: spendSchema,
    member_dashboard_available: z.boolean(),
  })
  .passthrough();

export type UsageResponse = z.infer<typeof usageResponseSchema>;
