import { useEffect, useState } from 'react';
import { findAnomalousSessions, medianSessionCost, type DaemonSessionsReport } from '@headroom/shared';
import { exportDaemonSession, getDaemonDaily, getDaemonSessions, type DaemonResult } from '../../../lib/daemon-client.js';
import { downloadMarkdown, resumeCommand } from '../../../lib/downloads.js';
import { formatCcusageDate, formatTokens } from '../../../lib/format.js';
import type { Settings } from '../../../lib/protocol.js';
import { RECENT_DAYS } from './CliOverview.tsx';

const TOP_N = 5;

/** Top sessions and top days by cost, over the same `RECENT_DAYS` window as `CliOverview` —
 *  pure client-side sort/slice of data the daemon already serves in full (`/sessions`,
 *  `/aggregate?by=day`), so no new daemon route. The "Top usage" sub-view of
 *  `CliAttributionPanel`. */
export function TopUsageContent({ settings }: { settings: Settings }) {
  const [sessions, setSessions] = useState<DaemonResult<DaemonSessionsReport> | null>(null);
  const [daily, setDaily] = useState<DaemonResult<{ daily: { date: string; totalTokens: number; totalCost: number }[] }> | null>(null);

  useEffect(() => {
    const since = formatCcusageDate(new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000));
    void getDaemonSessions(settings, { since }).then(setSessions);
    void getDaemonDaily(settings, { since }).then(setDaily);
  }, [settings.daemonUrl, settings.daemonToken]);

  const topSessions = sessions?.ok ? [...sessions.data.sessions].sort((a, b) => b.totalCost - a.totalCost).slice(0, TOP_N) : [];
  const topDays = daily?.ok ? [...daily.data.daily].sort((a, b) => b.totalCost - a.totalCost).slice(0, TOP_N) : [];
  // Anomaly baseline uses every session in the window, not just the top slice above — otherwise
  // the median would be computed from already-expensive sessions and nothing would ever flag.
  const typicalCost = sessions?.ok ? medianSessionCost(sessions.data.sessions) : 0;
  const anomalousSessionIds = new Set(sessions?.ok ? findAnomalousSessions(sessions.data.sessions).map((s) => s.sessionId) : []);

  if (topSessions.length === 0 && topDays.length === 0) {
    return <p className="hint">No CLI usage recorded yet in the last {RECENT_DAYS} days.</p>;
  }

  return (
    <>
      {topSessions.length > 0 && (
        <>
          <p className="table-title">Priciest sessions</p>
          {topSessions.map((session, index) => (
            <div key={session.sessionId} className="result-card">
              <p className="warning-title" style={{ fontFamily: 'inherit', fontWeight: 650 }}>
                <span className="hint" style={{ fontWeight: 500 }}>
                  #{index + 1}
                </span>{' '}
                {session.projectPath}
                {anomalousSessionIds.has(session.sessionId) && (
                  <span
                    className="anomaly-marker"
                    title={`This session cost $${session.totalCost.toFixed(2)}, vs. a typical $${typicalCost.toFixed(2)} for this window — often a sign an agent got stuck looping rather than doing unusually valuable work.`}
                  >
                    {' '}
                    ⚠ {typicalCost > 0 ? `${Math.round(session.totalCost / typicalCost)}×` : 'far more than'} a typical session
                  </span>
                )}
              </p>
              <p className="result-meta">
                ${session.totalCost.toFixed(2)} · {formatTokens(session.totalTokens)} tokens · last active{' '}
                {new Date(session.lastActivity).toLocaleDateString()}
              </p>
              <div className="result-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void navigator.clipboard.writeText(resumeCommand({ cwd: session.projectPath, sessionId: session.sessionId }))}
                >
                  Copy resume command
                </button>
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
            </div>
          ))}
        </>
      )}

      {topDays.length > 0 && (
        <>
          <p className="table-title">Priciest days</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {topDays.map((day) => (
                  <tr key={day.date}>
                    <td>{day.date}</td>
                    <td>{formatTokens(day.totalTokens)}</td>
                    <td>${day.totalCost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
