import { z } from 'zod';

// Confirmed against fixtures/claude-ai/prepaid-credits.get.json (GET
// /api/organizations/{org}/prepaid/credits) — see that fixture's `_fixture_meta` for exactly
// which fields are still unverified. Same `.passthrough()`/`z.unknown()` conventions as usage.ts:
// a field observed as non-null gets a real type, a field only ever observed null stays
// `z.unknown()` rather than guessed.

const creditsAmountSchema = z.object({
  amount_minor: z.number(),
  exponent: z.number(),
});

const balanceSchema = z.object({
  // Only ever observed null, alongside a populated `credits` — real shape unverified.
  money: z.unknown(),
  credits: creditsAmountSchema,
});

const promoTrancheSchema = z.object({
  remaining_amount_minor_units: z.number(),
  currency: z.string(),
  expires_at: z.string(),
  granted_amount_minor_units: z.number(),
  granted_at: z.string(),
  remaining: balanceSchema,
  granted: balanceSchema,
  program_id: z.string(),
  // Only ever observed null — real (non-null) shape unverified.
  name: z.unknown(),
});

export const prepaidCreditsResponseSchema = z
  .object({
    amount: z.number(),
    currency: z.string(),
    balance: balanceSchema,
    balance_credits: z.number(),
    // Only ever observed null — real (non-null) shape unverified for all four.
    auto_reload_settings: z.unknown(),
    pending_invoice_amount_cents: z.unknown(),
    last_paid_purchase_cents: z.unknown(),
    expiry_policy_months: z.unknown(),
    // Always empty in the one account captured — item shape unverified.
    tranches: z.array(z.unknown()),
    promo_tranches: z.array(promoTrancheSchema),
    // Only ever observed as a string (this account always has an active promo grant) — nullable
    // here defensively, since an account with no promo credit at all almost certainly gets null
    // rather than an omitted key, but that specific capture doesn't exist yet to confirm it.
    next_expires_at: z.string().nullable(),
  })
  .passthrough();

export type PrepaidCreditsResponse = z.infer<typeof prepaidCreditsResponseSchema>;
