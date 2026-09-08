const CONTENT_KEYS = new Set(['text', 'content', 'title', 'cta', 'prompt', 'disclaimer']);

// Broad on purpose: any key ending in "id" (case-insensitive) is treated as an identifier,
// including uuid/parentUuid/traceId/requestId/sessionId/org_id. This can over-match a rare
// non-identifier field name — acceptable, since the failure mode for an exported fixture is
// "redacted too much" rather than "leaked something".
function isIdKey(key: string): boolean {
  return key.toLowerCase().endsWith('id');
}

function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(key.toLowerCase());
}

/**
 * Recursively strips identifier and free-text values out of a captured payload before it's
 * exported as a fixture. Only replaces string leaves on flagged keys — object-valued keys
 * (e.g. `message_start.message`) are recursed into, not wholesale redacted, so structural
 * shape (which is the point of a fixture) survives.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'string') {
        if (isIdKey(key)) {
          out[key] = '[redacted:id]';
          continue;
        }
        if (isContentKey(key)) {
          out[key] = '[redacted:content]';
          continue;
        }
      }
      out[key] = redact(v);
    }
    return out;
  }
  return value;
}
