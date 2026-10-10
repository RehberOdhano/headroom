import { Fragment, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { DaemonSessionsReport, DaemonSubagentSummary } from '@headroom/shared';
import { estimateTokensPerPercent, estimateWeeklyCliSplit } from '@headroom/shared';
import { db } from '../../../lib/db.js';
import {
  getDaemonByModel,
  getDaemonByProject,
  getDaemonDaily,
  getDaemonSessions,
  getDaemonSessionSubagents,
  type DaemonResult,
} from '../../../lib/daemon-client.js';
import { barHistory } from '../../../lib/history.js';
import { formatCcusageDate, formatLastActivity, formatTokens } from '../../../lib/format.js';
import { downloadCsv } from '../../../lib/downloads.js';
import { matchesQuery } from '../../../lib/filter.js';
import { PROVENANCE_LABEL } from '../../../lib/provenance.js';
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
  const [daily, setDaily] = useState<DaemonResult<{ daily: { date: string; totalTokens: number }[]; totals: { totalTokens: number } }> | null>(null);
  const [byProject, setByProject] = useState<DaemonResult<{ projects: Record<string, { totalTokens: number }[]> }> | null>(null);
  const [byModel, setByModel] = useState<DaemonResult<{ models: { modelName: string; inputTokens: number; outputTokens: number }[] }> | null>(null);
  const [sessions, setSessions] = useState<DaemonResult<DaemonSessionsReport> | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [subagentsBySession, setSubagentsBySession] = useState<Record<string, DaemonSubagentSummary[] | 'loading' | 'unavailable'>>({});

  // Lazy, per-session — a subagent lookup is its own daemon call, so it only happens once a
  // session row is actually expanded, never for the whole table up front.
  async function toggleSessionExpanded(sessionId: string) {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    if (subagentsBySession[sessionId]) return;
    setSubagentsBySession((current) => ({ ...current, [sessionId]: 'loading' }));
    const result = await getDaemonSessionSubagents(settings, sessionId);
    // A failed fetch (e.g. an older paired daemon that predates this route) must not collapse to
    // the same `[]` a genuinely zero-subagent session renders as — that would silently misreport
    // "confirmed no subagent activity" when the truth is "couldn't check."
    setSubagentsBySession((current) => ({ ...current, [sessionId]: result.ok ? result.data.subagents : 'unavailable' }));
  }

  useEffect(() => {
    const since = formatCcusageDate(new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000));
    void getDaemonDaily(settings, { since }).then(setDaily);
    void getDaemonByProject(settings, { since }).then(setByProject);
    void getDaemonByModel(settings, { since }).then(setByModel);
    void getDaemonSessions(settings, { since }).then(setSessions);
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
        }))
        .sort((a, b) => b.tokens - a.tokens)
    : [];
  const modelRows = byModel?.ok
    ? [...byModel.data.models].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    : [];
  const sessionRows = sessions?.ok ? [...sessions.data.sessions].sort((a, b) => b.totalTokens - a.totalTokens) : [];
  // Each table's own fetch can fail independently of the others — a failure must render as its
  // own section-level error, not silently fall back to the same empty table a genuinely-zero
  // result renders as. One section failing doesn't hide data the others loaded successfully.
  const byProjectFailed = byProject && !byProject.ok;
  const byModelFailed = byModel && !byModel.ok;
  const sessionsFailed = sessions && !sessions.ok;

  // Filtered down for both display and CSV export — a long table (many projects, or a heavy CLI
  // user's many sessions) is otherwise nothing but scrolling to find one entry. Models aren't
  // filtered: an account realistically only ever has a handful in play, never enough to need it.
  const filteredProjectRows = projectRows.filter((row) => matchesQuery(projectFilter, row.project));
  const filteredSessionRows = sessionRows.filter((session) => matchesQuery(sessionFilter, session.projectPath, session.sessionId));

  return (
    <>
      {daily?.ok && (
        <div className="stat-grid">
          <div className="stat-card" title={PROVENANCE_LABEL.local}>
            <div className="stat-value">{formatTokens(daily.data.totals.totalTokens)}</div>
            <div className="stat-label">tokens</div>
          </div>
          {reconciliation && (
            <div className="stat-card" title={PROVENANCE_LABEL.derived}>
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

      {byProjectFailed && <p className="error-text">{byProject.message}</p>}
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
                  ['Project', 'Tokens', '% of week (est.)'],
                  filteredProjectRows.map(({ project, tokens }) => {
                    const weekPercent = reconciliation ? tokens / reconciliation.tokensPerPercent : null;
                    return [project, tokens, weekPercent === null ? '' : weekPercent.toFixed(1)];
                  }),
                )
              }
            >
              Download CSV
            </button>
          </div>
          <input
            className="search-input filter-input"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            placeholder="Filter projects…"
          />
          {filteredProjectRows.length === 0 ? (
            <p className="hint">No projects match "{projectFilter}".</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Tokens</th>
                    {reconciliation && <th>% of week (est.)</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredProjectRows.map(({ project, tokens }) => {
                    const weekPercent = reconciliation ? tokens / reconciliation.tokensPerPercent : null;
                    return (
                      <tr key={project}>
                        <td>{project}</td>
                        <td>{formatTokens(tokens)}</td>
                        {reconciliation && <td>{weekPercent === null ? '—' : `~${formatPercentShare(weekPercent)}%`}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {byModelFailed && <p className="error-text">{byModel.message}</p>}
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
                  ['Model', 'Input', 'Output', '% of tokens'],
                  modelRows.map((model) => [
                    model.modelName,
                    model.inputTokens,
                    model.outputTokens,
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
                  <th>% of tokens</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map((model) => (
                  <tr key={model.modelName}>
                    <td>{model.modelName}</td>
                    <td>{formatTokens(model.inputTokens)}</td>
                    <td>{formatTokens(model.outputTokens)}</td>
                    <td>{formatPercentShare(modelTokenShare(model, modelRows))}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {sessionsFailed && <p className="error-text">{sessions.message}</p>}
      {sessionRows.length > 0 && (
        <>
          <div className="card-header">
            <p className="table-title">By session</p>
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadCsv(
                  'headroom-by-session.csv',
                  ['Project', 'Last active', 'Tokens'],
                  filteredSessionRows.map((session) => [session.projectPath, session.lastActivity, session.totalTokens]),
                )
              }
            >
              Download CSV
            </button>
          </div>
          <input
            className="search-input filter-input"
            value={sessionFilter}
            onChange={(event) => setSessionFilter(event.target.value)}
            placeholder="Filter sessions by project…"
          />
          {filteredSessionRows.length === 0 ? (
            <p className="hint">No sessions match "{sessionFilter}".</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Last active</th>
                    <th>Tokens</th>
                    <th>Agents</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessionRows.map((session) => {
                    const subagents = subagentsBySession[session.sessionId];
                    return (
                      <Fragment key={session.sessionId}>
                        <tr>
                          <td>{session.projectPath}</td>
                          <td>{formatLastActivity(session.lastActivity)}</td>
                          <td>{formatTokens(session.totalTokens)}</td>
                          <td>
                            <button type="button" className="btn" onClick={() => void toggleSessionExpanded(session.sessionId)}>
                              {expandedSessionId === session.sessionId ? 'Hide' : 'Show'}
                            </button>
                          </td>
                        </tr>
                        {expandedSessionId === session.sessionId && (
                          <tr>
                            <td colSpan={4}>
                              {subagents === undefined || subagents === 'loading' ? (
                                <p className="hint">Loading subagent activity…</p>
                              ) : subagents === 'unavailable' ? (
                                <p className="hint">
                                  Couldn&rsquo;t check subagent activity for this session — the paired daemon may be
                                  an older version that doesn&rsquo;t support it yet.
                                </p>
                              ) : subagents.length === 0 ? (
                                <p className="hint">No subagent activity observed for this session.</p>
                              ) : (
                                <>
                                  <p className="hint">
                                    Subagent activity, tracked separately from the session total above — never added to
                                    it (we can&rsquo;t confirm whether that total already includes it).
                                  </p>
                                  <ul>
                                    {subagents.map((agent) => (
                                      <li key={agent.agentId}>
                                        {agent.agentType ?? 'subagent'}
                                        {agent.description ? ` — ${agent.description}` : ''}: {formatTokens(agent.totalTokens)}
                                        {agent.model ? ` (${agent.model})` : ''}
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {projectRows.length === 0 &&
        modelRows.length === 0 &&
        sessionRows.length === 0 &&
        !byProjectFailed &&
        !byModelFailed &&
        !sessionsFailed &&
        (!daily?.ok || daily.data.totals.totalTokens === 0) && (
          <p className="hint">No CLI usage recorded yet in the last {RECENT_DAYS} days.</p>
        )}
    </>
  );
}
