import type { PrepaidCreditsResponse } from '../claude-ai/prepaid-credits.js';

/** One `promo_tranches[]` entry, normalized to major currency units. */
export interface PromoCreditTranche {
  remainingAmount: number;
  grantedAmount: number;
  currency: string;
  expiresAt: string;
}

/**
 * `/prepaid/credits` normalized — purchased/promotional credit balance, distinct from
 * `LimitSnapshot.extraCredits` (pay-as-you-go overage spend against a monthly limit). A prepaid
 * balance has no history worth tracking the way limit bars do; this is a point-in-time snapshot,
 * not something to append to a growing series.
 */
export interface PrepaidCreditsSnapshot {
  capturedAt: string;
  balanceAmount: number;
  currency: string;
  autoReloadEnabled: boolean;
  promoTranches: PromoCreditTranche[];
}

/** Divides a minor-unit integer (e.g. cents) by `10^exponent` to get major units. */
function toMajorUnits(amountMinor: number, exponent: number): number {
  return amountMinor / 10 ** exponent;
}

export function normalizePrepaidCredits(response: PrepaidCreditsResponse, capturedAt: string): PrepaidCreditsSnapshot {
  return {
    capturedAt,
    balanceAmount: toMajorUnits(response.balance.credits.amount_minor, response.balance.credits.exponent),
    currency: response.currency,
    autoReloadEnabled: response.auto_reload_settings !== null,
    promoTranches: response.promo_tranches.map((tranche) => ({
      remainingAmount: toMajorUnits(tranche.remaining_amount_minor_units, tranche.remaining.credits.exponent),
      grantedAmount: toMajorUnits(tranche.granted_amount_minor_units, tranche.granted.credits.exponent),
      currency: tranche.currency,
      expiresAt: tranche.expires_at,
    })),
  };
}

/** The promo tranche expiring soonest, or null if there are none — what a "credits expiring
 *  soon" notification or UI warning should key off of. */
export function soonestExpiringPromoTranche(snapshot: PrepaidCreditsSnapshot): PromoCreditTranche | null {
  return snapshot.promoTranches.reduce<PromoCreditTranche | null>((soonest, tranche) => {
    if (!soonest) return tranche;
    return new Date(tranche.expiresAt) < new Date(soonest.expiresAt) ? tranche : soonest;
  }, null);
}
