import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepaidCreditsResponseSchema } from './prepaid-credits.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/claude-ai',
);

function loadFixture(name: string) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  expect(_fixture_meta).toBeDefined();
  return body;
}

describe('prepaidCreditsResponseSchema', () => {
  it('parses the real capture', () => {
    const parsed = prepaidCreditsResponseSchema.parse(loadFixture('prepaid-credits.get.json'));

    expect(parsed.balance.credits.amount_minor).toBe(3811);
    expect(parsed.balance.money).toBeNull();
    expect(parsed.promo_tranches).toHaveLength(1);
    expect(parsed.promo_tranches[0]).toMatchObject({
      remaining_amount_minor_units: 3809,
      program_id: 'credit_program_v2',
    });
    expect(parsed.next_expires_at).toBe('2026-09-19T00:00:00Z');
    expect(parsed.tranches).toEqual([]);
  });
});
