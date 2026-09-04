import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { estimateTokensPerPercent, type DaemonSearchMatch, type DaemonSessionsReport } from '@headroom/shared';
import { db } from '../../lib/db.js';
import { extensionMessenger } from '../../lib/messaging.js';
import {
  exportDaemonSession,
  getDaemonByModel,
  getDaemonByProject,
  getDaemonDaily,
  getDaemonSessions,
  searchDaemonSessions,
  type DaemonResult,
} from '../../lib/daemon-client.js';
import { barHistory } from '../../lib/history.js';
import { formatCcusageDate } from '../../lib/format.js';
import type { Settings } from '../../lib/protocol.js';

const RECENT_DAYS = 30;
const SESSION_RETENTION_DAYS = 30;
const RETENTION_WARNING_DAYS = 5;

function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function resumeCommand(match: { cwd: string | null; sessionId: string }): string {
  return match.cwd ? `cd ${match.cwd} && claude --resume ${match.sessionId}` : `claude --resume ${match.sessionId}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Fetches settings once and renders `children(settings)` once the daemon is configured, or a
 * tab-appropriate "connect the daemon" hint otherwise. Split out so the CLI attribution and
 * search tabs each get their own independent gate instead of sharing one combined card.
 */
function DaemonGate({ hint, children }: { hint: string; children: (settings: Settings) => React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void extensionMessenger.sendMessage('getSettings').then(setSettings);
  }, []);

  if (!settings) return null;

  if (!settings.daemonUrl || !settings.daemonToken) {
    return (
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Connect the daemon</h2>
        </div>
        <p className="hint">{hint}</p>
      </section>
    );
  }

  return <>{children(settings)}</>;
}

/** CLI attribution + retention warnings, daemon-backed. Session search is its own tab
 *  (`SearchTab`, below) since it has its own pagination and can otherwise get long. */
export function CliTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to see Claude Code CLI usage and retention warnings here.">
      {(settings) => (
        <>
          <CliTotals settings={settings} />
          <RetentionWarnings settings={settings} />
        </>
      )}
    </DaemonGate>
  );
}

/** Full-text search across local Claude Code sessions — its own tab, not paired with CLI
 *  attribution, so paginated results have room to breathe. */
export function SearchTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to search your Claude Code CLI sessions here.">
      {(settings) => <SessionSearch settings={settings} />}
    </DaemonGate>
  );
}

function CliTotals({ settings }: { settings: Settings }) {
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

  if (daily && !daily.ok) {
    return (
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">CLI attribution</h2>
        </div>
        <p className="error-text">{daily.message}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">CLI attribution</h2>
        <span className="card-stat">last {RECENT_DAYS} days</span>
      </div>

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
        </div>
      )}

      {reconciliation && (
        <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
          Rough estimate — assumes all weekly-bar movement in this window came from the CLI.
          claude.ai chat usage in the same window will skew this higher than reality.
        </p>
      )}

      {byProject?.ok && Object.keys(byProject.data.projects).length > 0 && (
        <>
          <p className="table-title">By project</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(byProject.data.projects).map(([project, days]) => (
                  <tr key={project}>
                    <td>{project}</td>
                    <td>{formatTokens(days.reduce((sum, d) => sum + d.totalTokens, 0))}</td>
                    <td>${days.reduce((sum, d) => sum + d.totalCost, 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {byModel?.ok && byModel.data.models.length > 0 && (
        <>
          <p className="table-title">By model</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {byModel.data.models.map((model) => (
                  <tr key={model.modelName}>
                    <td>{model.modelName}</td>
                    <td>{formatTokens(model.inputTokens)}</td>
                    <td>{formatTokens(model.outputTokens)}</td>
                    <td>${model.cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const SEARCH_PAGE_SIZE = 10;

function SessionSearch({ settings }: { settings: Settings }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<DaemonSearchMatch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function runSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setSearched(true);
    setError(null);
    const result = await searchDaemonSessions(settings, trimmed, { limit: SEARCH_PAGE_SIZE, offset: 0 });
    if (!result.ok) {
      setError(result.message);
      setMatches([]);
      setHasMore(false);
      return;
    }
    setMatches(result.data.matches);
    setHasMore(result.data.hasMore);
  }

  async function loadMore(): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoadingMore(true);
    try {
      const result = await searchDaemonSessions(settings, trimmed, { limit: SEARCH_PAGE_SIZE, offset: matches.length });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Appends rather than replaces — this is a "load more" page, not a fresh search. A
      // duplicate could in principle appear if a session's lastActivity changed between the two
      // fetches and reordered it across the page boundary; sessionId as the list key means a
      // duplicate would just be a rendering no-op, not a crash.
      setMatches((current) => [...current, ...result.data.matches]);
      setHasMore(result.data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  async function copyResumeCommand(match: DaemonSearchMatch): Promise<void> {
    await navigator.clipboard.writeText(resumeCommand(match));
    setCopiedId(match.sessionId);
    setTimeout(() => setCopiedId((current) => (current === match.sessionId ? null : current)), 2000);
  }

  async function exportMatch(match: DaemonSearchMatch): Promise<void> {
    const exported = await exportDaemonSession(settings, match.sessionId);
    if (exported.ok) downloadMarkdown(`${match.sessionId}.md`, exported.data);
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Search CLI sessions</h2>
      </div>
      <form className="search-form" onSubmit={runSearch}>
        <input
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search session content…"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {searched && !error && matches.length === 0 && <p className="hint">No matches.</p>}
      {matches.map((match) => (
        <div key={match.sessionId} className="result-card">
          <p className="result-snippet">{match.snippet}</p>
          <p className="result-meta">
            {match.cwd ?? 'unknown directory'} · {match.matchCount} match{match.matchCount === 1 ? '' : 'es'}
            {match.lastActivity && ` · last active ${new Date(match.lastActivity).toLocaleDateString()}`}
          </p>
          <div className="result-actions">
            <button type="button" className="btn" onClick={() => void copyResumeCommand(match)}>
              {copiedId === match.sessionId ? 'Copied!' : 'Copy resume command'}
            </button>
            <button type="button" className="btn" onClick={() => void exportMatch(match)}>
              Export markdown
            </button>
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="search-pagination">
          <button type="button" className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}

function RetentionWarnings({ settings }: { settings: Settings }) {
  const [sessions, setSessions] = useState<DaemonResult<DaemonSessionsReport> | null>(null);

  useEffect(() => {
    void getDaemonSessions(settings).then(setSessions);
  }, [settings.daemonUrl, settings.daemonToken]);

  if (!sessions?.ok) return null;

  const now = Date.now();
  const warnings = sessions.data.sessions
    .map((session) => ({
      session,
      daysLeft: SESSION_RETENTION_DAYS - (now - new Date(session.lastActivity).getTime()) / (24 * 60 * 60 * 1000),
    }))
    .filter((w) => w.daysLeft > 0 && w.daysLeft <= RETENTION_WARNING_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (warnings.length === 0) return null;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Sessions nearing cleanup</h2>
      </div>
      <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
        Claude Code retains session logs for {SESSION_RETENTION_DAYS} days by default.
      </p>
      {warnings.map(({ session, daysLeft }) => (
        <div key={session.sessionId} className="warning-card">
          <div className="warning-info">
            <p className="warning-title">{session.projectPath}</p>
            <p className="warning-meta">
              {Math.max(0, Math.round(daysLeft))} day{Math.round(daysLeft) === 1 ? '' : 's'} left ·{' '}
              {formatTokens(session.totalTokens)} tokens
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const exported = await exportDaemonSession(settings, session.sessionId);
              if (exported.ok) downloadMarkdown(`${session.sessionId}.md`, exported.data);
            }}
          >
            Export markdown
          </button>
        </div>
      ))}
    </section>
  );
}
