import { useEffect, useState } from 'react';
import type { DaemonSessionsReport } from '@headroom/shared';
import { exportDaemonSession, getDaemonSessions, type DaemonResult } from '../../../lib/daemon-client.js';
import { downloadMarkdown } from '../../../lib/downloads.js';
import { formatTokens } from '../../../lib/format.js';
import { findRetentionWarnings, SESSION_RETENTION_DAYS } from '../../../lib/retention.js';
import type { Settings } from '../../../lib/protocol.js';

export function RetentionWarnings({ settings }: { settings: Settings }) {
  const [sessions, setSessions] = useState<DaemonResult<DaemonSessionsReport> | null>(null);

  useEffect(() => {
    void getDaemonSessions(settings).then(setSessions);
  }, [settings.daemonUrl, settings.daemonToken]);

  if (!sessions?.ok) return null;

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
