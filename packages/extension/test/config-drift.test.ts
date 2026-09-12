import { describe, expect, it } from 'vitest';
import type { ClaudeConfigSnapshot, SettingsLayer } from '@headroom/shared';
import { describeConfigDrift, diffConfigSummaries, fingerprintSnapshot, riskyDriftAdditions } from '../lib/config-drift.js';

function layer(overrides: Partial<SettingsLayer> = {}): SettingsLayer {
  return { path: '/x/.claude/settings.json', exists: true, defaultMode: null, allow: [], ask: [], deny: [], ...overrides };
}

function snapshot(overrides: Partial<ClaudeConfigSnapshot> = {}): ClaudeConfigSnapshot {
  return { global: layer({ exists: false }), project: null, local: null, hooks: [], skills: [], agents: [], ...overrides };
}

describe('fingerprintSnapshot', () => {
  it('combines and dedupes permission rules across layers, ignoring layers that do not exist', () => {
    const { summary } = fingerprintSnapshot(
      snapshot({
        global: layer({ allow: ['WebFetch'] }),
        project: layer({ allow: ['WebFetch', 'Bash(git commit *)'] }),
        local: layer({ exists: false, allow: ['Bash(rm -rf *)'] }),
      }),
    );
    expect(summary.allow).toEqual(['Bash(git commit *)', 'WebFetch']);
  });

  it('is order-independent — the same content in a different layer order/arrangement fingerprints identically', () => {
    const a = fingerprintSnapshot(snapshot({ global: layer({ allow: ['B', 'A'] }) }));
    const b = fingerprintSnapshot(snapshot({ global: layer({ allow: ['A', 'B'] }) }));
    expect(a.hash).toBe(b.hash);
  });

  it('excludes hooks/skills from other projects — only what is on the snapshot itself', () => {
    const { summary } = fingerprintSnapshot(
      snapshot({
        hooks: [{ event: 'Stop', matcher: null, command: 'echo hi', timeout: null, statusMessage: null, source: '/x' }],
        skills: [{ name: 'demo', description: 'x', argumentHint: null, allowedTools: null, path: '/x/demo/SKILL.md' }],
      }),
    );
    expect(summary.hooks).toEqual(['Stop::echo hi']);
    expect(summary.skills).toEqual(['demo']);
  });
});

describe('diffConfigSummaries / describeConfigDrift', () => {
  const empty = { allow: [], ask: [], deny: [], hooks: [], skills: [] };

  it('describes newly-added and newly-removed entries in plain wording', () => {
    const drift = diffConfigSummaries(empty, { ...empty, allow: ['WebFetch'], hooks: [] });
    expect(describeConfigDrift(drift)).toBe('1 new allow rule');
  });

  it('pluralizes when more than one entry changed', () => {
    const drift = diffConfigSummaries(empty, { ...empty, allow: ['A', 'B'] });
    expect(describeConfigDrift(drift)).toBe('2 new allow rules');
  });

  it('combines multiple kinds of change into one message', () => {
    const drift = diffConfigSummaries({ ...empty, hooks: ['Stop::old'] }, { ...empty, allow: ['A'], hooks: [] });
    expect(describeConfigDrift(drift)).toBe('1 new allow rule, 1 hook removed');
  });

  it('falls back to "Something" when nothing actually differs', () => {
    expect(describeConfigDrift(diffConfigSummaries(empty, empty))).toBe('Something');
  });
});

describe('riskyDriftAdditions', () => {
  const empty = { allow: [], ask: [], deny: [], hooks: [], skills: [] };

  it('flags a newly-allowed pattern that matches a known-risky one', () => {
    const drift = diffConfigSummaries(empty, { ...empty, allow: ['Bash(rm -rf *)'] });
    const risky = riskyDriftAdditions(drift);
    expect(risky.some((r) => r.pattern === 'Bash(rm -rf *)')).toBe(true);
  });

  it('does not flag a newly-added deny rule — tightening access is never risky', () => {
    const drift = diffConfigSummaries(empty, { ...empty, deny: ['Bash(rm -rf *)'] });
    expect(riskyDriftAdditions(drift)).toEqual([]);
  });

  it('does not flag an allow addition that is not on the known-risky list', () => {
    const drift = diffConfigSummaries(empty, { ...empty, allow: ['WebFetch'] });
    expect(riskyDriftAdditions(drift)).toEqual([]);
  });
});
