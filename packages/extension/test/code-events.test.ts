import { describe, expect, it } from 'vitest';
import { pickFreshRateLimitEvent } from '../lib/code-events.js';

describe('pickFreshRateLimitEvent', () => {
  it('returns null when there are no rate_limit_event entries', () => {
    const events = [{ event_type: 'user', created_at: '2026-09-04T18:00:00Z' }];
    expect(pickFreshRateLimitEvent(events, null)).toBeNull();
  });

  it('ignores entries with a missing or non-string created_at', () => {
    const events = [
      { event_type: 'rate_limit_event' },
      { event_type: 'rate_limit_event', created_at: 12345 },
    ];
    expect(pickFreshRateLimitEvent(events, null)).toBeNull();
  });

  it('picks the single rate_limit_event present', () => {
    const events = [
      { event_type: 'user', created_at: '2026-09-04T18:00:00Z' },
      { event_type: 'rate_limit_event', created_at: '2026-09-04T18:15:02Z' },
    ];
    expect(pickFreshRateLimitEvent(events, null)?.created_at).toBe('2026-09-04T18:15:02Z');
  });

  it('picks the latest among multiple rate_limit_event entries in one response', () => {
    const events = [
      { event_type: 'rate_limit_event', created_at: '2026-09-04T18:08:27Z' },
      { event_type: 'rate_limit_event', created_at: '2026-09-04T18:15:02Z' },
      { event_type: 'rate_limit_event', created_at: '2026-09-04T18:12:32Z' },
    ];
    expect(pickFreshRateLimitEvent(events, null)?.created_at).toBe('2026-09-04T18:15:02Z');
  });

  it('accepts the first event ever seen regardless of how old it is', () => {
    const events = [{ event_type: 'rate_limit_event', created_at: '2026-01-01T00:00:00Z' }];
    expect(pickFreshRateLimitEvent(events, null)?.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects a stale event from an older history slice — the real bug caught in live testing', () => {
    // One page refresh's different /events requests (different sort_order/cursor) cover
    // different slices of history — an older slice's own "latest" must not override a fresher
    // one already forwarded from a different slice (real capture: session 24% then 8%).
    const olderSliceEvents = [{ event_type: 'rate_limit_event', created_at: '2026-09-04T18:08:27Z' }];
    expect(pickFreshRateLimitEvent(olderSliceEvents, '2026-09-04T18:15:02Z')).toBeNull();
  });

  it('rejects an exact duplicate of the last forwarded created_at', () => {
    const events = [{ event_type: 'rate_limit_event', created_at: '2026-09-04T18:15:02Z' }];
    expect(pickFreshRateLimitEvent(events, '2026-09-04T18:15:02Z')).toBeNull();
  });

  it('accepts a genuinely newer event than the last forwarded one', () => {
    const events = [{ event_type: 'rate_limit_event', created_at: '2026-09-04T18:20:00Z' }];
    expect(pickFreshRateLimitEvent(events, '2026-09-04T18:15:02Z')?.created_at).toBe('2026-09-04T18:20:00Z');
  });
});
