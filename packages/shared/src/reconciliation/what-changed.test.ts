import { describe, expect, it } from 'vitest';
import { computeWhatChanged, type WindowUsageSummary } from './what-changed.js';

const EMPTY: WindowUsageSummary = { totalTokens: 0, projectTokens: {}, modelTokens: {}, largestSession: null };

describe('computeWhatChanged', () => {
  it('returns nothing when there is no current-window data at all', () => {
    expect(computeWhatChanged(EMPTY, null)).toEqual([]);
  });

  it('returns nothing when there is no comparable prior window and nothing dominates the current one', () => {
    // Ten projects split evenly (10% each) — no single one clears the 15% "worth mentioning" floor.
    const projectTokens = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`project-${i}`, 100]));
    const current: WindowUsageSummary = {
      totalTokens: 1000,
      projectTokens,
      modelTokens: {},
      largestSession: { projectPath: 'project-0', tokens: 100 }, // 10% — also below the floor
    };
    expect(computeWhatChanged(current, null)).toEqual([]);
  });

  it('reports a dominant project as a plain current-window fact with no prior window to compare', () => {
    const current: WindowUsageSummary = {
      totalTokens: 1000,
      projectTokens: { 'payments-api': 410, 'internal-tools': 300, other: 290 },
      modelTokens: {},
      largestSession: null,
    };
    const findings = computeWhatChanged(current, null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ kind: 'project-share', text: 'payments-api represents 41% of observed CLI activity this window.' });
  });

  it('suppresses the comparison wording for an insignificant share swing, even though the dominant model is still mentioned as a plain fact', () => {
    // sonnet moves from 52% to 51% — a 1pp swing, well under the 10pp comparison threshold — but
    // it's still the dominant model in both windows, so the plain "represents X%" fact still fires.
    const current: WindowUsageSummary = { totalTokens: 1000, projectTokens: {}, modelTokens: { opus: 490, sonnet: 510 }, largestSession: null };
    const previous: WindowUsageSummary = { totalTokens: 1000, projectTokens: {}, modelTokens: { opus: 480, sonnet: 520 }, largestSession: null };
    const findings = computeWhatChanged(current, previous);
    const modelFinding = findings.find((f) => f.kind === 'model-share');
    expect(modelFinding?.text).not.toContain('compared with the same elapsed portion');
    expect(modelFinding?.text).toBe('sonnet represents 51% of observed CLI activity this window.');
  });

  it('suppresses a share dimension entirely when neither window has a dominant contributor', () => {
    const projectTokens = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`project-${i}`, 100]));
    const current: WindowUsageSummary = { totalTokens: 1000, projectTokens, modelTokens: {}, largestSession: null };
    const previous: WindowUsageSummary = { totalTokens: 1000, projectTokens, modelTokens: {}, largestSession: null };
    expect(computeWhatChanged(current, previous).find((f) => f.kind === 'project-share')).toBeUndefined();
  });

  it('reports a significant model-share swing as a before/after comparison', () => {
    const current: WindowUsageSummary = { totalTokens: 1000, projectTokens: {}, modelTokens: { opus: 670, sonnet: 330 }, largestSession: null };
    const previous: WindowUsageSummary = { totalTokens: 1000, projectTokens: {}, modelTokens: { opus: 480, sonnet: 520 }, largestSession: null };
    const findings = computeWhatChanged(current, previous);
    const modelFinding = findings.find((f) => f.kind === 'model-share');
    expect(modelFinding?.text).toBe('opus share increased from 48% to 67% compared with the same elapsed portion of the previous window.');
  });

  it('reports a largest session once it clears the share floor', () => {
    const current: WindowUsageSummary = {
      totalTokens: 1000,
      projectTokens: {},
      modelTokens: {},
      largestSession: { projectPath: 'payments-api', tokens: 180 },
    };
    const findings = computeWhatChanged(current, null);
    expect(findings).toEqual([{ kind: 'largest-session', text: 'One session represents 18% of observed CLI activity.' }]);
  });

  it('omits the largest-session finding when it does not clear the share floor', () => {
    const current: WindowUsageSummary = {
      totalTokens: 1000,
      projectTokens: {},
      modelTokens: {},
      largestSession: { projectPath: 'payments-api', tokens: 50 },
    };
    expect(computeWhatChanged(current, null)).toEqual([]);
  });

  it('reports a significant CLI token volume change', () => {
    const current: WindowUsageSummary = { ...EMPTY, totalTokens: 1380 };
    const previous: WindowUsageSummary = { ...EMPTY, totalTokens: 1000 };
    const findings = computeWhatChanged(current, previous);
    expect(findings).toEqual([{ kind: 'cli-volume', text: 'Observed CLI tokens up 38% compared with the same elapsed portion of the previous window.' }]);
  });

  it('suppresses an insignificant CLI token volume change', () => {
    const current: WindowUsageSummary = { ...EMPTY, totalTokens: 1050 };
    const previous: WindowUsageSummary = { ...EMPTY, totalTokens: 1000 };
    expect(computeWhatChanged(current, previous)).toEqual([]);
  });

  it('reports server-observed account usage movement independently of any CLI data', () => {
    const findings = computeWhatChanged(EMPTY, null, { currentPercentPoints: 28, previousPercentPoints: 12 });
    expect(findings).toEqual([
      { kind: 'account-usage', text: 'Weekly usage has moved 28 points so far this window — faster than the 12-point move over the same portion of the previous window.' },
    ]);
  });

  it('suppresses an insignificant account usage movement difference', () => {
    expect(computeWhatChanged(EMPTY, null, { currentPercentPoints: 14, previousPercentPoints: 12 })).toEqual([]);
  });

  it('can report multiple independent findings at once', () => {
    const current: WindowUsageSummary = {
      totalTokens: 1380,
      projectTokens: { 'payments-api': 700, other: 680 },
      modelTokens: { opus: 670, sonnet: 710 },
      largestSession: { projectPath: 'payments-api', tokens: 300 },
    };
    const previous: WindowUsageSummary = {
      totalTokens: 1000,
      projectTokens: { 'payments-api': 400, other: 600 },
      modelTokens: { opus: 480, sonnet: 520 },
      largestSession: null,
    };
    const findings = computeWhatChanged(current, previous, { currentPercentPoints: 28, previousPercentPoints: 12 });
    expect(findings.map((f) => f.kind).sort()).toEqual(
      ['account-usage', 'cli-volume', 'largest-session', 'model-share', 'project-share'].sort(),
    );
  });
});
