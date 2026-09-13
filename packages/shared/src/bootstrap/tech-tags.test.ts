import { describe, expect, it } from 'vitest';
import { KNOWN_TECH_TAGS, TECH_TAG_CATEGORIES } from './tech-tags.js';

describe('TECH_TAG_CATEGORIES', () => {
  it('has no duplicate tags across categories', () => {
    const seen = new Set<string>();
    for (const { tags } of TECH_TAG_CATEGORIES) {
      for (const tag of tags) {
        expect(seen.has(tag)).toBe(false);
        seen.add(tag);
      }
    }
  });

  it('flattens into KNOWN_TECH_TAGS in the same order', () => {
    expect(KNOWN_TECH_TAGS).toEqual(TECH_TAG_CATEGORIES.flatMap((entry) => entry.tags));
  });
});
