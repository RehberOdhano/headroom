import { KNOWN_RISKY_PATTERNS, type ClaudeConfigSnapshot, type SettingsLayer } from '@headroom/shared';
import type { ConfigFingerprintSummary } from './db.js';

/**
 * Deterministic fingerprint of a project's permission rules, hooks, and skills — used to detect
 * "did this change since I last looked" and, via `summary`, to describe *what* changed rather
 * than just that something did. Not persisted anywhere that treats it as meaningful content.
 * Deliberately excludes CLAUDE.md body text: that already has its own explicit diff-via-eyeballing
 * UI (preview/source + revert), so re-flagging it here would be redundant. Permission rules are
 * combined and deduped across global/project/local layers — the drift badge cares "was this
 * newly allowed at all", not which layer it lives in. Sorted + deduped so reordering or an
 * equivalent rule appearing in a different layer doesn't register as a "change".
 */
export function fingerprintSnapshot(snapshot: ClaudeConfigSnapshot): { hash: string; summary: ConfigFingerprintSummary } {
  const layers = [snapshot.global, snapshot.project, snapshot.local].filter(
    (layer): layer is SettingsLayer => Boolean(layer?.exists),
  );
  const collect = (key: 'allow' | 'ask' | 'deny') => [...new Set(layers.flatMap((layer) => layer[key]))].sort();

  const summary: ConfigFingerprintSummary = {
    allow: collect('allow'),
    ask: collect('ask'),
    deny: collect('deny'),
    hooks: [...new Set(snapshot.hooks.map((h) => `${h.event}:${h.matcher ?? ''}:${h.command}`))].sort(),
    skills: [...new Set(snapshot.skills.map((s) => s.name))].sort(),
  };

  return { hash: JSON.stringify(summary), summary };
}

interface SetDiff {
  added: string[];
  removed: string[];
}

function diffSet(prior: string[], current: string[]): SetDiff {
  return { added: current.filter((v) => !prior.includes(v)), removed: prior.filter((v) => !current.includes(v)) };
}

interface ConfigDrift {
  allow: SetDiff;
  ask: SetDiff;
  deny: SetDiff;
  hooks: SetDiff;
  skills: SetDiff;
}

export function diffConfigSummaries(prior: ConfigFingerprintSummary, current: ConfigFingerprintSummary): ConfigDrift {
  return {
    allow: diffSet(prior.allow, current.allow),
    ask: diffSet(prior.ask, current.ask),
    deny: diffSet(prior.deny, current.deny),
    hooks: diffSet(prior.hooks, current.hooks),
    skills: diffSet(prior.skills, current.skills),
  };
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

/** Turns a `ConfigDrift` into short wording like "2 new allow rules, 1 hook removed" — falls
 *  back to a generic "Something" when every bucket is empty (shouldn't happen in practice since
 *  this is only called after a fingerprint mismatch, but a hash collision or a `summary`-less
 *  prior record both land here). */
export function describeConfigDrift(drift: ConfigDrift): string {
  const parts: string[] = [];
  const describe = (diff: SetDiff, label: string) => {
    if (diff.added.length > 0) parts.push(`${diff.added.length} new ${pluralize(label, diff.added.length)}`);
    if (diff.removed.length > 0) parts.push(`${diff.removed.length} ${pluralize(label, diff.removed.length)} removed`);
  };
  describe(drift.allow, 'allow rule');
  describe(drift.ask, 'ask rule');
  describe(drift.deny, 'deny rule');
  describe(drift.hooks, 'hook');
  describe(drift.skills, 'skill');
  return parts.length > 0 ? parts.join(', ') : 'Something';
}

/** Newly-*allowed* patterns (never ask/deny — those tighten, not loosen, access) that match a
 *  bundled known-risky pattern — the escalation trigger for the drift badge's warning styling. */
export function riskyDriftAdditions(drift: ConfigDrift) {
  return KNOWN_RISKY_PATTERNS.filter((known) => drift.allow.added.includes(known.pattern));
}
