import { describe, expect, it } from 'vitest';
import { formatUpdatedAgo, PROVENANCE_LABEL } from '../lib/provenance.js';

describe('PROVENANCE_LABEL', () => {
  it('has a distinct label for each of the three categories', () => {
    expect(PROVENANCE_LABEL.server).toMatch(/Claude/);
    expect(PROVENANCE_LABEL.local).toMatch(/local Claude Code session logs/);
    expect(PROVENANCE_LABEL.derived).toMatch(/estimate/);
    // Estimates must read as visibly distinguishable from a server/local observation — a bare
    // number with no "this is approximate" cue would overclaim precision it doesn't have.
    const labels = Object.values(PROVENANCE_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('formatUpdatedAgo', () => {
  const now = new Date('2026-08-29T12:00:00Z');

  it('reports "just now" for anything under a minute old', () => {
    expect(formatUpdatedAgo('2026-08-29T11:59:45Z', now)).toBe('just now');
  });

  it('formats minutes for a recent capture', () => {
    expect(formatUpdatedAgo('2026-08-29T11:57:00Z', now)).toBe('3m ago');
  });

  it('formats hours for an old capture, without a dramatic stale warning', () => {
    expect(formatUpdatedAgo('2026-08-29T09:30:00Z', now)).toBe('3h ago');
  });

  it('uses the same plain wording at any age — no separate "stale" variant', () => {
    // A genuinely old capture (22 minutes — past the old 15-minute poll-cadence threshold this
    // design deliberately dropped) still reads as a plain, non-alarming "X ago", not a warning.
    const text = formatUpdatedAgo('2026-08-29T11:38:00Z', now);
    expect(text).toBe('22m ago');
    expect(text.toLowerCase()).not.toContain('stale');
    expect(text.toLowerCase()).not.toContain('broken');
  });
});
