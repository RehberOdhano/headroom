import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { messageLimitEventSchema } from './message-limit.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/claude-ai',
);

/** Minimal, test-only SSE extraction — just enough to pull one event's `data` out of a fixture. */
function extractEventData(sse: string, eventName: string): unknown {
  const lines = sse.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `event: ${eventName}`) {
      const dataLine = lines[i + 1];
      if (!dataLine?.startsWith('data: ')) {
        throw new Error(`expected a data: line after event: ${eventName}`);
      }
      return JSON.parse(dataLine.slice('data: '.length));
    }
  }
  throw new Error(`event ${eventName} not found in fixture`);
}

function loadEvent(fixtureName: string) {
  const sse = readFileSync(path.join(FIXTURES_DIR, fixtureName), 'utf-8');
  return extractEventData(sse, 'message_limit');
}

describe('messageLimitEventSchema', () => {
  it('parses the overage variant (overageInUse: true)', () => {
    const parsed = messageLimitEventSchema.parse(loadEvent('message_limit.overage.sse.txt'));

    expect(parsed.message_limit.overageInUse).toBe(true);
    if (!parsed.message_limit.overageInUse) throw new Error('unreachable');
    expect(parsed.message_limit.representativeClaim).toBe('overage');
    expect(parsed.message_limit.overageStatus).toBe('within_limit');
    expect(parsed.message_limit.windows.overage?.utilization).toBe(0);
    expect(parsed.message_limit.notice.title).toBe('Now using usage credits');
    expect(parsed.message_limit.notice.text).toBeNull();
  });

  it('parses the credits-disabled variant (overageInUse: false)', () => {
    const parsed = messageLimitEventSchema.parse(loadEvent('message_limit.five_hour.sse.txt'));

    expect(parsed.message_limit.overageInUse).toBe(false);
    if (parsed.message_limit.overageInUse) throw new Error('unreachable');
    expect(parsed.message_limit.representativeClaim).toBe('five_hour');
    expect(parsed.message_limit.overageDisabledReason).toBe('org_level_disabled');
    expect(parsed.message_limit.windows['5h']?.utilization).toBe(0.29);
    expect(parsed.message_limit.windows['7d']?.utilization).toBe(0.55);
    expect(parsed.message_limit.resolved.limit.kind).toBe('session');
    expect(parsed.message_limit.resolved.limit.percent).toBe(29);
  });
});
