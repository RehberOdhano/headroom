import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rateLimitEventSchema } from './code-rate-limit.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/claude-ai',
);

function loadRateLimitEvent(name: string) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
  const { _fixture_meta, ...body } = raw;
  return body;
}

describe('rateLimitEventSchema', () => {
  it('parses a real claude.ai/code rate_limit_event capture', () => {
    const parsed = rateLimitEventSchema.parse(loadRateLimitEvent('code.rate-limit-event.json'));

    expect(parsed.event_type).toBe('rate_limit_event');
    expect(parsed.payload.rate_limit_info.rateLimitType).toBe('five_hour');
    expect(parsed.payload.rate_limit_info.isUsingOverage).toBe(false);
    expect(parsed.payload.rate_limit_info.unifiedWindows.five_hour?.utilization).toBe(0.17);
    expect(parsed.payload.rate_limit_info.unifiedWindows.seven_day?.utilization).toBe(0.29);
  });
});
