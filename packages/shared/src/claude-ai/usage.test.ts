import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { usageResponseSchema } from './usage.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/claude-ai',
);

function loadFixture(name: string) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  expect(_fixture_meta).toBeDefined(); // sanity: fixture still carries its metadata block
  return body;
}

describe('usageResponseSchema', () => {
  it('parses the overage fixture', () => {
    const parsed = usageResponseSchema.parse(loadFixture('usage.get.overage.json'));

    expect(parsed.five_hour.utilization).toBe(39);
    expect(parsed.seven_day.utilization).toBe(31);
    expect(parsed.limits).toHaveLength(2);
    expect(parsed.limits[0]).toMatchObject({ kind: 'session', percent: 39 });
    expect(parsed.extra_usage.is_enabled).toBe(true);
    expect(parsed.spend.used.amount_minor).toBe(4628);
    expect(parsed.spend.limit).not.toBeNull();
    // Unlaunched/codename fields stay accessible but untyped.
    expect(parsed.tangelo).toBeNull();
    expect(parsed.nimbus_quill).not.toBeNull();
    // This capture predates locked_reason/juniper_tide — must not be required.
    expect(parsed.five_hour.locked_reason).toBeUndefined();
    expect(parsed.juniper_tide).toBeUndefined();
  });

  it('parses the credits-disabled fixture, where several overage fields go null', () => {
    const parsed = usageResponseSchema.parse(loadFixture('usage.get.credits-disabled.json'));

    expect(parsed.extra_usage.is_enabled).toBe(false);
    expect(parsed.extra_usage.monthly_limit).toBeNull();
    expect(parsed.spend.limit).toBeNull();
    expect(parsed.spend.cap).toBeNull();
    expect(parsed.five_hour.locked_reason).toBeNull();
    expect(parsed.juniper_tide).toBeNull();
    expect(parsed.limits.map((l) => l.kind)).toEqual(['session', 'weekly_all']);
  });
});
