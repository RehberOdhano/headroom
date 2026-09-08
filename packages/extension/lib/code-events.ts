/** One entry from `GET /v1/code/sessions/{id}/events`'s `data` array — only the two fields this
 *  module cares about. Most real entries (`user`/`assistant`/`system`/`control_*`) carry real
 *  conversation content, which is exactly why this stays this narrow: callers must never widen
 *  it to pass whole entries around beyond what's picked here. */
export interface CodeEventEnvelope {
  event_type?: unknown;
  created_at?: unknown;
}

/**
 * Picks the single `rate_limit_event` to forward from one `/events` response, given the latest
 * `created_at` already forwarded across *all* previous requests for this page (not just this
 * one) — or `null` if there's nothing new.
 *
 * A single page load fires several `/events` requests covering different slices of a session's
 * history (different `sort_order`/`cursor`), so "the latest matching entry in this one
 * response" isn't enough on its own: an older slice's own latest can still be older than one
 * already forwarded from a different slice moments earlier. Without this check, percentages
 * can appear to jump backwards.
 */
export function pickFreshRateLimitEvent<T extends CodeEventEnvelope>(
  events: readonly T[],
  lastForwardedCreatedAt: string | null,
): (T & { created_at: string }) | null {
  const rateLimitEvents = events.filter(
    (event): event is T & { created_at: string } =>
      event.event_type === 'rate_limit_event' && typeof event.created_at === 'string',
  );
  if (rateLimitEvents.length === 0) return null;

  const latest = rateLimitEvents.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  if (lastForwardedCreatedAt !== null && latest.created_at <= lastForwardedCreatedAt) return null;
  return latest;
}
