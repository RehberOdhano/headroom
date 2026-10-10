import { describe, expect, it } from 'vitest';
import { matchesQuery } from '../lib/filter.js';

describe('matchesQuery', () => {
  it('matches everything for an empty (or whitespace-only) query', () => {
    expect(matchesQuery('', 'anything')).toBe(true);
    expect(matchesQuery('   ', 'anything')).toBe(true);
  });

  it('matches case-insensitively against any of the given fields', () => {
    expect(matchesQuery('GIT', 'Bash(git commit *)', null)).toBe(true);
    expect(matchesQuery('git', null, 'a description mentioning Git')).toBe(true);
  });

  it('does not match when no field contains the query', () => {
    expect(matchesQuery('docker', 'Bash(git commit *)', undefined)).toBe(false);
  });
});
