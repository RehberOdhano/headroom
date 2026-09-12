import { describe, expect, it } from 'vitest';
import type { PrepaidCreditsResponse } from '../claude-ai/prepaid-credits.js';
import { normalizePrepaidCredits, soonestExpiringPromoTranche } from './prepaid-credits.js';

function response(overrides: Partial<PrepaidCreditsResponse> = {}): PrepaidCreditsResponse {
  return {
    amount: 3811,
    currency: 'USD',
    balance: { money: null, credits: { amount_minor: 3811, exponent: 2 } },
    balance_credits: 38,
    auto_reload_settings: null,
    pending_invoice_amount_cents: null,
    last_paid_purchase_cents: null,
    expiry_policy_months: null,
    tranches: [],
    promo_tranches: [],
    next_expires_at: null,
    ...overrides,
  };
}

describe('normalizePrepaidCredits', () => {
  it('converts minor-unit balances and currency', () => {
    const snapshot = normalizePrepaidCredits(response(), '2026-09-12T00:00:00Z');
    expect(snapshot.balanceAmount).toBe(38.11);
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.autoReloadEnabled).toBe(false);
  });

  it('normalizes promo tranches to major units', () => {
    const snapshot = normalizePrepaidCredits(
      response({
        promo_tranches: [
          {
            remaining_amount_minor_units: 3809,
            currency: 'USD',
            expires_at: '2026-09-19T00:00:00Z',
            granted_amount_minor_units: 10000,
            granted_at: '2026-07-22T06:42:50.714000Z',
            remaining: { money: null, credits: { amount_minor: 3809, exponent: 2 } },
            granted: { money: null, credits: { amount_minor: 10000, exponent: 2 } },
            program_id: 'credit_program_v2',
            name: null,
          },
        ],
      }),
      '2026-09-12T00:00:00Z',
    );

    expect(snapshot.promoTranches).toEqual([
      { remainingAmount: 38.09, grantedAmount: 100, currency: 'USD', expiresAt: '2026-09-19T00:00:00Z' },
    ]);
  });
});

describe('soonestExpiringPromoTranche', () => {
  it('returns null when there are no promo tranches', () => {
    const snapshot = normalizePrepaidCredits(response(), '2026-09-12T00:00:00Z');
    expect(soonestExpiringPromoTranche(snapshot)).toBeNull();
  });

  it('picks the earliest expiry among several tranches', () => {
    const snapshot = normalizePrepaidCredits(
      response({
        promo_tranches: [
          {
            remaining_amount_minor_units: 100,
            currency: 'USD',
            expires_at: '2026-12-01T00:00:00Z',
            granted_amount_minor_units: 100,
            granted_at: '2026-01-01T00:00:00Z',
            remaining: { money: null, credits: { amount_minor: 100, exponent: 2 } },
            granted: { money: null, credits: { amount_minor: 100, exponent: 2 } },
            program_id: 'later',
            name: null,
          },
          {
            remaining_amount_minor_units: 200,
            currency: 'USD',
            expires_at: '2026-09-19T00:00:00Z',
            granted_amount_minor_units: 200,
            granted_at: '2026-01-01T00:00:00Z',
            remaining: { money: null, credits: { amount_minor: 200, exponent: 2 } },
            granted: { money: null, credits: { amount_minor: 200, exponent: 2 } },
            program_id: 'sooner',
            name: null,
          },
        ],
      }),
      '2026-09-12T00:00:00Z',
    );

    expect(soonestExpiringPromoTranche(snapshot)?.expiresAt).toBe('2026-09-19T00:00:00Z');
  });
});
