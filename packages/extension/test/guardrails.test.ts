import { describe, expect, it } from 'vitest';
import type { ClaudeConfigSnapshot, SettingsLayer } from '@headroom/shared';
import { findInLayer, matchesQuery, resolveEffective } from '../lib/guardrails.js';

function layer(overrides: Partial<SettingsLayer> = {}): SettingsLayer {
  return { path: '/x/.claude/settings.json', exists: true, defaultMode: null, allow: [], ask: [], deny: [], ...overrides };
}

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

describe('findInLayer', () => {
  it('returns null for a null layer', () => {
    expect(findInLayer(null, 'WebFetch')).toBeNull();
  });

  it('returns the effect the pattern is listed under', () => {
    expect(findInLayer(layer({ deny: ['Bash(rm -rf *)'] }), 'Bash(rm -rf *)')).toBe('deny');
    expect(findInLayer(layer({ allow: ['WebFetch'] }), 'WebFetch')).toBe('allow');
  });

  it('returns null when the pattern is not listed under any effect', () => {
    expect(findInLayer(layer({ allow: ['WebFetch'] }), 'Bash(rm -rf *)')).toBeNull();
  });
});

describe('resolveEffective', () => {
  const snapshot: ClaudeConfigSnapshot = {
    global: layer({ allow: ['WebFetch'] }),
    project: layer({ deny: ['Bash(rm -rf *)'] }),
    local: layer({ allow: ['Bash(rm -rf *)'] }),
    hooks: [],
    skills: [],
    agents: [],
  };

  it('prefers a local override over project, which wins over global', () => {
    expect(resolveEffective(snapshot, 'Bash(rm -rf *)')).toEqual({ effect: 'allow', layer: 'local' });
  });

  it('falls through to global when no more specific layer has the pattern', () => {
    expect(resolveEffective(snapshot, 'WebFetch')).toEqual({ effect: 'allow', layer: 'global' });
  });

  it('returns null when no layer lists the pattern at all', () => {
    expect(resolveEffective(snapshot, 'Bash(kill *)')).toBeNull();
  });
});
