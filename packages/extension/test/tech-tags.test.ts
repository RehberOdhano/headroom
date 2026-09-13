import { describe, expect, it } from 'vitest';
import { addTechTag, filterTechTagSuggestions, mergeDetectedTechTags } from '../lib/tech-tags.js';

describe('filterTechTagSuggestions', () => {
  it('returns nothing for an empty query', () => {
    expect(filterTechTagSuggestions('', [])).toEqual([]);
    expect(filterTechTagSuggestions('   ', [])).toEqual([]);
  });

  it('matches case-insensitively by substring', () => {
    expect(filterTechTagSuggestions('react', [])).toContain('React');
    expect(filterTechTagSuggestions('REACT', [])).toContain('React');
  });

  it('excludes already-selected tags, case-insensitively', () => {
    expect(filterTechTagSuggestions('react', ['react'])).not.toContain('React');
  });

  it('caps results at the given limit', () => {
    expect(filterTechTagSuggestions('a', [], undefined, 3)).toHaveLength(3);
  });

  it('matches against a custom catalog when one is passed, including tags outside KNOWN_TECH_TAGS', () => {
    expect(filterTechTagSuggestions('elix', [], ['Elixir', 'Phoenix'])).toEqual(['Elixir']);
  });
});

describe('addTechTag', () => {
  it('appends a trimmed tag', () => {
    expect(addTechTag(['React'], '  PostgreSQL  ')).toEqual(['React', 'PostgreSQL']);
  });

  it('does not add an empty or whitespace-only tag', () => {
    expect(addTechTag(['React'], '   ')).toEqual(['React']);
  });

  it('does not add a duplicate, case-insensitively', () => {
    expect(addTechTag(['React'], 'react')).toEqual(['React']);
  });

  it('accepts a tag outside the known catalog, same as stack "other"', () => {
    expect(addTechTag([], 'MyInternalFramework')).toEqual(['MyInternalFramework']);
  });
});

describe('mergeDetectedTechTags', () => {
  it('adds detected tags not already selected', () => {
    expect(mergeDetectedTechTags(['React'], ['React', 'PostgreSQL'])).toEqual(['React', 'PostgreSQL']);
  });

  it('never drops a tag the user already picked', () => {
    expect(mergeDetectedTechTags(['MyInternalFramework'], ['React'])).toEqual(['MyInternalFramework', 'React']);
  });

  it('returns the same array reference when nothing new was detected', () => {
    const selected = ['React'];
    expect(mergeDetectedTechTags(selected, ['react'])).toBe(selected);
  });
});
