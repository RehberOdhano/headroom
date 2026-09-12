import { useEffect, useState } from 'react';
import type { DaemonProjectDailyReport, GitActivityResponse } from '@headroom/shared';
import { getDaemonByProject, getDaemonGitActivity, type DaemonResult } from '../../../lib/daemon-client.js';
import { formatCcusageDate } from '../../../lib/format.js';
import { extensionMessenger } from '../../../lib/messaging.js';
import type { Settings } from '../../../lib/protocol.js';

/**
 * Per-project CLI budget + tokens/cost-per-commit, both keyed off the *real* absolute
 * `projectDir` from the picker above (never a free-typed path) — a project's CLI cost is only
 * ever queryable through ccusage's own slug form (`/` -> `-`, the same transform Claude Code
 * itself applies when naming a project's session-log directory), and that transform is only
 * safe to compute forward from a trusted real path, never the other direction: a literal `-` in
 * a real directory name is indistinguishable from an encoded `/` once reversed.
 */
export function ProjectUsageSection({ settings, projectDir }: { settings: Settings; projectDir: string }) {
  const [gitActivity, setGitActivity] = useState<DaemonResult<GitActivityResponse> | null>(null);
  const [projectCost, setProjectCost] = useState<DaemonResult<DaemonProjectDailyReport> | null>(null);
  const existingBudget = settings.perProjectCliBudgets.find((entry) => entry.projectDir === projectDir)?.monthlyBudget ?? null;
  const [budgetInput, setBudgetInput] = useState(existingBudget === null ? '' : String(existingBudget));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBudgetInput(existingBudget === null ? '' : String(existingBudget));
    setSaved(false);
    // Only re-seed when the selected project changes — an in-progress edit for the *current*
    // project shouldn't be clobbered by `settings` reference changes from unrelated updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  useEffect(() => {
    const since = formatCcusageDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    void getDaemonGitActivity(settings, projectDir, since).then(setGitActivity);
    void getDaemonByProject(settings, { since }).then(setProjectCost);
  }, [settings.daemonUrl, settings.daemonToken, projectDir]);

  async function saveBudget(value: string): Promise<void> {
    const trimmed = value.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    const withoutThisProject = settings.perProjectCliBudgets.filter((entry) => entry.projectDir !== projectDir);
    const next = parsed !== null && !Number.isNaN(parsed) && parsed >= 0 ? [...withoutThisProject, { projectDir, monthlyBudget: parsed }] : withoutThisProject;
    await extensionMessenger.sendMessage('updateSettings', { perProjectCliBudgets: next });
    setSaved(true);
  }

  const slug = projectDir.replace(/\//g, '-');
  const days = projectCost?.ok ? projectCost.data.projects[slug] : undefined;
  const projectSpend = days ? days.reduce((sum, d) => sum + d.totalCost, 0) : null;
  const commitCount = gitActivity?.ok && gitActivity.data.isGitRepo ? gitActivity.data.commitCount : 0;

  return (
    <section className="card compact-card">
      <div className="card-header">
        <h2 className="card-title">Project usage</h2>
      </div>

      {commitCount > 0 && projectSpend !== null && (
        <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
          ≈${(projectSpend / commitCount).toFixed(2)} / commit this month ({commitCount} commit{commitCount === 1 ? '' : 's'}, $
          {projectSpend.toFixed(2)} total)
        </p>
      )}

      <div className="spend-limit-block">
        <label className="spend-limit-title" htmlFor="project-budget-input">
          Set monthly spend limit
        </label>
        <p className="hint">Get notified once this project's CLI spend crosses a limit you set.</p>
        <div className="spend-limit-input-wrap">
          <span className="spend-limit-prefix">$</span>
          <input
            id="project-budget-input"
            className="spend-limit-input"
            type="number"
            min="0"
            step="0.01"
            placeholder="No limit"
            value={budgetInput}
            onChange={(event) => {
              setBudgetInput(event.target.value);
              setSaved(false);
            }}
            onBlur={(event) => void saveBudget(event.target.value)}
          />
        </div>
        <p className="hint spend-limit-caption">{saved ? 'Saved — this limit is active now.' : 'This limit goes into effect immediately once saved.'}</p>
      </div>
    </section>
  );
}
