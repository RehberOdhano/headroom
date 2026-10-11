import { useEffect, useState } from 'react';
import type { DaemonSessionsReport } from '@headroom/shared';
import { exportDaemonSession, getDaemonSessions, type DaemonResult } from '../../../lib/daemon-client.js';
import { downloadMarkdown } from '../../../lib/downloads.js';
import { formatLastActivity, formatTokens } from '../../../lib/format.js';
import { findRetentionWarnings, SESSION_RETENTION_DAYS } from '../../../lib/retention.js';
import type { Settings } from '../../../lib/protocol.js';

export function RetentionWarnings({ settings }: { settings: Settings }) {
  const [sessions, setSessions] = useState<DaemonResult<DaemonSessionsReport> | null>(null);
  const [includeToolCalls, setIncludeToolCalls] = useState(false);

  useEffect(() => {
    void getDaemonSessions(settings).then(setSessions);
  }, [settings.daemonUrl, settings.daemonToken]);

  if (sessions === null) return null;

  // A failed/unreachable sessions request must not collapse to the same `null` a genuinely
  // zero-warnings result renders as — that would silently misreport "nothing nearing cleanup"
  // when the truth is "couldn't check."
  if (!sessions.ok) return <p className="error-text">Couldn&rsquo;t check sessions nearing cleanup.</p>;

  const warnings = findRetentionWarnings(sessions.data.sessions);

  if (warnings.length === 0) return null;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Sessions nearing cleanup</h2>
      </div>
      <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
        Claude Code retains session logs for {SESSION_RETENTION_DAYS} days by default.
      </p>
      <label className="checkbox-row" style={{ marginBottom: 'var(--space-4)' }}>
        <input
          type="checkbox"
          checked={includeToolCalls}
          onChange={(event) => setIncludeToolCalls(event.target.checked)}
        />
        Include tool calls in export (as short summaries)
      </label>
      {warnings.map(({ session, daysLeft }) => {
        const roundedDays = Math.max(0, Math.round(daysLeft));
        return (
          <div key={session.sessionId} className="warning-card">
            <div className="warning-info">
              <p className="warning-title">{session.projectPath}</p>
              <p className="warning-meta">
                <span>Last active {formatLastActivity(session.lastActivity)}</span>
                <span className={roundedDays <= 1 ? 'warning-days warning-days-urgent' : 'warning-days'}>
                  {roundedDays} day{roundedDays === 1 ? '' : 's'} left
                </span>
                <span>{formatTokens(session.totalTokens)} tokens</span>
              </p>
            </div>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const exported = await exportDaemonSession(settings, session.sessionId, { includeToolCalls });
                if (exported.ok) downloadMarkdown(`${session.sessionId}.md`, exported.data);
              }}
            >
              Export markdown
            </button>
          </div>
        );
      })}
    </section>
  );
}
