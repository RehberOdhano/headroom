import { describe, expect, it } from 'vitest';
import { getDaily, getDailyByProject, getSessions } from '../src/adapters/ccusage.js';
import { withFixtureClaudeDir } from './helpers/fixture-claude-dir.js';

// Contract tests: spawn the real, pinned ccusage binary against a known fixture and assert
// exact numbers. If ccusage changes its output shape or math on a version bump, these fail
// loudly instead of silently producing wrong usage numbers downstream.

describe('ccusage adapter (contract)', () => {
  it('getSessions() matches the fixture session', async () => {
    const report = await withFixtureClaudeDir((claudeConfigDir) =>
      getSessions({ claudeConfigDir }),
    );

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      sessionId: '00000000-0000-4000-8000-000000000001',
      projectPath: '-fixture-project',
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 100,
      cacheReadTokens: 50,
      totalTokens: 180,
      modelsUsed: ['claude-sonnet-5'],
    });
    expect(report.totals.totalTokens).toBe(180);
  });

  it('getDaily() groups the fixture session under its one active date', async () => {
    const report = await withFixtureClaudeDir((claudeConfigDir) => getDaily({ claudeConfigDir }));

    expect(report.daily).toHaveLength(1);
    expect(report.daily[0]).toMatchObject({
      date: '2026-08-20',
      totalTokens: 180,
    });
  });

  it('getDailyByProject() keys the report by the fixture project path', async () => {
    const report = await withFixtureClaudeDir((claudeConfigDir) =>
      getDailyByProject({ claudeConfigDir }),
    );

    expect(Object.keys(report.projects)).toEqual(['-fixture-project']);
    expect(report.projects['-fixture-project']?.[0]).toMatchObject({
      date: '2026-08-20',
      totalTokens: 180,
    });
  });
});
