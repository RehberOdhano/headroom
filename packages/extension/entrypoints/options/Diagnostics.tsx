import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db.js';
import { getDaemonConfigProjects, getDaemonSessions } from '../../lib/daemon-client.js';
import { buildDiagnosticsReport, formatDiagnosticsText, type DiagnosticsInput } from '../../lib/diagnostics.js';
import type { DaemonHealth, Settings } from '../../lib/protocol.js';

interface ParsedUsageError {
  capturedAt?: unknown;
}

/**
 * Settings → Diagnostics. Everything shown here flows through `buildDiagnosticsReport`'s own
 * narrow `DiagnosticsInput` type (see lib/diagnostics.ts) — this component's only job is pulling
 * each allowed field out of its real source (Dexie, `Settings`, `DaemonHealth`, a couple of
 * on-demand daemon routes) one at a time. It must never spread or pass `settings`/`daemonHealth`
 * through wholesale; a field this component doesn't name here cannot reach the report at all.
 *
 * Project/session counts are fetched lazily, only once this section is actually opened — they
 * cost the daemon a real ccusage shell-out, which shouldn't happen just because Settings loaded.
 */
export function Diagnostics({ settings, daemonHealth }: { settings: Settings; daemonHealth: DaemonHealth | null }) {
  const [opened, setOpened] = useState(false);
  const [counts, setCounts] = useState<{ projectCount: number | null; sessionCount: number | null }>({
    projectCount: null,
    sessionCount: null,
  });
  const [copied, setCopied] = useState(false);

  const snapshotCount = useLiveQuery(() => db.limitSnapshots.count(), []) ?? 0;
  const lastSnapshot = useLiveQuery(() => db.limitSnapshots.orderBy('capturedAt').last(), []);
  const usageParseError = useLiveQuery(() => db.meta.get('usageParseError'), []);

  async function loadCounts() {
    if (!settings.daemonUrl || !settings.daemonToken) return;
    const [projects, sessions] = await Promise.all([getDaemonConfigProjects(settings), getDaemonSessions(settings)]);
    setCounts({
      projectCount: projects.ok ? projects.data.projects.length : null,
      sessionCount: sessions.ok ? sessions.data.sessions.length : null,
    });
  }

  function onToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    const isOpen = event.currentTarget.open;
    setOpened(isOpen);
    if (isOpen) void loadCounts();
  }

  let lastParseFailureAt: string | null = null;
  if (usageParseError) {
    try {
      const parsed = JSON.parse(usageParseError.value) as ParsedUsageError;
      if (typeof parsed.capturedAt === 'string') lastParseFailureAt = parsed.capturedAt;
    } catch {
      // Malformed breadcrumb — treat as "no failure recorded" rather than throwing.
    }
  }

  // `runtime.getManifest()` is read only once this section is actually opened, not on every
  // Settings render — `fake-browser` doesn't implement it at all (see extension CLAUDE.md), and
  // nothing about this section is needed until someone asks to see it anyway.
  let report = null as ReturnType<typeof buildDiagnosticsReport> | null;
  if (opened) {
    const manifest = browser.runtime.getManifest() as { version: string; manifest_version?: number };
    const input: DiagnosticsInput = {
      extensionVersion: manifest.version,
      manifestVersion: manifest.manifest_version ?? 0,
      lastCaptureAt: lastSnapshot?.capturedAt ?? null,
      snapshotCount,
      hasParseFailure: Boolean(usageParseError),
      lastParseFailureAt,
      daemonConfigured: Boolean(settings.daemonUrl && settings.daemonToken),
      daemonUrl: settings.daemonUrl || null,
      daemonConnected: daemonHealth?.ok === true,
      daemonVersion: daemonHealth?.version ?? null,
      daemonLastCheckedAt: daemonHealth?.checkedAt ?? null,
      projectCount: counts.projectCount,
      sessionCount: counts.sessionCount,
    };
    report = buildDiagnosticsReport(input);
  }
  const text = report ? formatDiagnosticsText(report) : '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the text is still visible below to select by hand.
    }
  }

  // Presentational only — green marks an already-healthy value the report computed (no schema
  // errors, daemon connected); it never changes which fields are shown or their text.
  const schemaHealthy = report?.schemaFailure === 'none';
  const daemonHealthy = report?.daemon.startsWith('connected') ?? false;
  const daemonUnreachable = report?.daemon === 'configured but unreachable';

  return (
    <section className="card">
      <details onToggle={onToggle}>
        <summary className="card-summary">
          Diagnostics
          <svg className="card-summary-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.5 1.5l4 3.5-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        {report && (
          <div className="card-summary-body">
            <dl className="kv-grid">
              <dt className="kv-key">Extension</dt>
              <dd className="kv-value">
                {report.extensionVersion} ({report.browserFamily})
              </dd>
              <dt className="kv-key">Last capture</dt>
              <dd className="kv-value">{report.lastCapture}</dd>
              <dt className="kv-key">Snapshots</dt>
              <dd className="kv-value">{report.snapshotCount}</dd>
              <dt className="kv-key">Schema errors</dt>
              <dd className={`kv-value ${schemaHealthy ? 'status-text-success' : ''}`}>{report.schemaFailure}</dd>
              <dt className="kv-key">Daemon</dt>
              <dd className={`kv-value ${daemonHealthy ? 'status-text-success' : daemonUnreachable ? 'status-text-error' : ''}`}>
                {report.daemon}
              </dd>
              {report.daemonUrl && (
                <>
                  <dt className="kv-key">Daemon URL</dt>
                  <dd className="kv-value">{report.daemonUrl}</dd>
                </>
              )}
              {report.daemonLastChecked && (
                <>
                  <dt className="kv-key">Daemon last checked</dt>
                  <dd className="kv-value">{report.daemonLastChecked}</dd>
                </>
              )}
              <dt className="kv-key">Projects</dt>
              <dd className="kv-value">{report.projectCount}</dd>
              <dt className="kv-key">Sessions</dt>
              <dd className="kv-value">{report.sessionCount}</dd>
            </dl>
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied ? 'Copied!' : 'Copy diagnostics'}
            </button>
            <p className="hint" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
              Never includes your bearer token, account id, prompts, responses, or file paths — only the
              fields shown above.
            </p>
          </div>
        )}
      </details>
    </section>
  );
}
