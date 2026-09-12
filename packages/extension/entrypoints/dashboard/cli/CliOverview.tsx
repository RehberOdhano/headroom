import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { estimateTokensPerPercent, estimateWeeklyCliSplit } from '@headroom/shared';
import { db } from '../../../lib/db.js';
import { getDaemonByModel, getDaemonByProject, getDaemonDaily, type DaemonResult } from '../../../lib/daemon-client.js';
import { barHistory } from '../../../lib/history.js';
import { formatCcusageDate, formatTokens } from '../../../lib/format.js';
import { downloadCsv } from '../../../lib/downloads.js';
import type { Settings } from '../../../lib/protocol.js';
import { WeeklyCliSplitChart } from './WeeklyCliSplitChart.tsx';

export const RECENT_DAYS = 30;

/** This model's share of total tokens (input + output) across every model in the list — the
 *  model-mix breakdown. Returns 0 for an empty list rather than NaN. */
function modelTokenShare(
  model: { inputTokens: number; outputTokens: number },
  all: { inputTokens: number; outputTokens: number }[],
): number {
  const total = all.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
  if (total === 0) return 0;
  return ((model.inputTokens + model.outputTokens) / total) * 100;
}

function formatPercentShare(percent: number): string {
  return percent >= 10 ? Math.round(percent).toString() : percent.toFixed(1);
}

/** Whole days between `dateStr` (a ccusage daily entry's own `YYYY-MM-DD`, always UTC-midnight —
 *  confirmed against real ccusage output) and `now`'s UTC calendar day. 0 is today, 7 is a week
 *  ago. Comparing at day granularity (not raw timestamp subtraction) avoids an off-by-one from
 *  `now` having a time-of-day component. */
function daysSinceUtc(dateStr: string, now: Date): number {
  const dayMs = new Date(`${dateStr}T00:00:00Z`).getTime();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((todayMs - dayMs) / 86_400_000);
}

export interface WeekOverWeek {
  thisWeek: number;
  lastWeek: number;
  /** null when there's no prior week of data to compare against — a fresh install, or a daemon
   *  younger than 7 days — rather than a misleading "+Infinity%"/"0%". */
  deltaPercent: number | null;
}

/** Buckets the last 30 days of daily totals (already fetched for the stats above — no new
 *  fetch) into "last 7 days" vs. "the 7 days before that". */
function weekOverWeek(daily: { date: string; totalTokens: number }[], now: Date = new Date()): WeekOverWeek {
  let thisWeek = 0;
  let lastWeek = 0;
  for (const entry of daily) {
    const age = daysSinceUtc(entry.date, now);
    if (age >= 0 && age < 7) thisWeek += entry.totalTokens;
    else if (age >= 7 && age < 14) lastWeek += entry.totalTokens;
  }
  return { thisWeek, lastWeek, deltaPercent: lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek) * 100 : null };
}

/** Totals + stat-grid + by-project/by-model breakdowns — the "Overview" sub-view of
 *  `CliAttributionPanel`. Both tables sort by size descending (biggest project/model first) so
 *  the thing worth looking at is always the top row, not wherever the daemon happened to list
 *  it. */
export function CliOverview({ settings }: { settings: Settings }) {
  const [daily, setDaily] = useState<DaemonResult<{ daily: { date: string; totalTokens: number; totalCost: number }[]; totals: { totalTokens: number; totalCost: number } }> | null>(null);
  const [byProject, setByProject] = useState<DaemonResult<{ projects: Record<string, { totalTokens: number; totalCost: number }[]> }> | null>(null);
  const [byModel, setByModel] = useState<DaemonResult<{ models: { modelName: string; inputTokens: number; outputTokens: number; cost: number }[] }> | null>(null);

  useEffect(() => {
    const since = formatCcusageDate(new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000));
    void getDaemonDaily(settings, { since }).then(setDaily);
    void getDaemonByProject(settings, { since }).then(setByProject);
    void getDaemonByModel(settings, { since }).then(setByModel);
  }, [settings.daemonUrl, settings.daemonToken]);

  const allSnapshots = useLiveQuery(() => db.limitSnapshots.orderBy('capturedAt').toArray(), []) ?? [];
  const weeklyHistory = barHistory(allSnapshots, 'weekly');
  const reconciliation =
    daily?.ok ? estimateTokensPerPercent(weeklyHistory, daily.data.daily.map((d) => ({ date: d.date, totalTokens: d.totalTokens }))) : null;
  const wow = daily?.ok ? weekOverWeek(daily.data.daily) : null;
  // Reuses the same global tokensPerPercent ratio above rather than refitting one per week —
  // see estimateWeeklyCliSplit's own doc comment for why a single week's sample is too small to
  // refit reliably.
  const weeklySplit =
    reconciliation && daily?.ok
      ? estimateWeeklyCliSplit(weeklyHistory, daily.data.daily.map((d) => ({ date: d.date, totalTokens: d.totalTokens })), reconciliation.tokensPerPercent)
      : [];

  if (daily && !daily.ok) return <p className="error-text">{daily.message}</p>;

  const projectRows = byProject?.ok
    ? Object.entries(byProject.data.projects)
        .map(([project, days]) => ({
          project,
          tokens: days.reduce((sum, d) => sum + d.totalTokens, 0),
          cost: days.reduce((sum, d) => sum + d.totalCost, 0),
        }))
        .sort((a, b) => b.tokens - a.tokens)
    : [];
  const modelRows = byModel?.ok
    ? [...byModel.data.models].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    : [];

  return (
    <>
      {daily?.ok && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value">{formatTokens(daily.data.totals.totalTokens)}</div>
            <div className="stat-label">tokens</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">${daily.data.totals.totalCost.toFixed(2)}</div>
            <div className="stat-label">equivalent API cost</div>
          </div>
          {reconciliation && (
            <div className="stat-card">
              <div className="stat-value">~{formatTokens(Math.round(reconciliation.tokensPerPercent))}</div>
              <div className="stat-label">tokens / 1% weekly ({reconciliation.confidence})</div>
            </div>
          )}
          {wow && wow.deltaPercent !== null && (
            <div className="stat-card">
              <div className="stat-value">
                {wow.deltaPercent >= 0 ? '▲' : '▼'} {Math.round(Math.abs(wow.deltaPercent))}%
              </div>
              <div className="stat-label">vs last week</div>
            </div>
          )}
        </div>
      )}

      {reconciliation && (
        <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
          Rough estimate — assumes all weekly-bar movement in this window came from the CLI.
          claude.ai chat usage in the same window will skew this higher than reality.
        </p>
      )}

      {weeklySplit.length > 1 && (
        <>
          <p className="table-title">CLI share of weekly-bar usage</p>
          <WeeklyCliSplitChart data={weeklySplit} />
        </>
      )}

      {projectRows.length > 0 && (
        <>
          <div className="card-header">
            <p className="table-title">By project</p>
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadCsv(
                  'headroom-by-project.csv',
                  ['Project', 'Tokens', 'Cost', '% of week (est.)'],
                  projectRows.map(({ project, tokens, cost }) => {
                    const weekPercent = reconciliation ? tokens / reconciliation.tokensPerPercent : null;
                    return [project, tokens, cost.toFixed(2), weekPercent === null ? '' : weekPercent.toFixed(1)];
                  }),
                )
              }
            >
              Download CSV
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  {reconciliation && <th>% of week (est.)</th>}
                </tr>
              </thead>
              <tbody>
                {projectRows.map(({ project, tokens, cost }) => {
                  const weekPercent = reconciliation ? tokens / reconciliation.tokensPerPercent : null;
                  return (
                    <tr key={project}>
                      <td>{project}</td>
                      <td>{formatTokens(tokens)}</td>
                      <td>${cost.toFixed(2)}</td>
                      {reconciliation && <td>{weekPercent === null ? '—' : `~${formatPercentShare(weekPercent)}%`}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {modelRows.length > 0 && (
        <>
          <div className="card-header">
            <p className="table-title">By model</p>
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadCsv(
                  'headroom-by-model.csv',
                  ['Model', 'Input', 'Output', 'Cost', '% of tokens'],
                  modelRows.map((model) => [
                    model.modelName,
                    model.inputTokens,
                    model.outputTokens,
                    model.cost.toFixed(2),
                    formatPercentShare(modelTokenShare(model, modelRows)),
                  ]),
                )
              }
            >
              Download CSV
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cost</th>
                  <th>% of tokens</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map((model) => (
                  <tr key={model.modelName}>
                    <td>{model.modelName}</td>
                    <td>{formatTokens(model.inputTokens)}</td>
                    <td>{formatTokens(model.outputTokens)}</td>
                    <td>${model.cost.toFixed(2)}</td>
                    <td>{formatPercentShare(modelTokenShare(model, modelRows))}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {projectRows.length === 0 && modelRows.length === 0 && (!daily?.ok || daily.data.totals.totalTokens === 0) && (
        <p className="hint">No CLI usage recorded yet in the last {RECENT_DAYS} days.</p>
      )}
    </>
  );
}
