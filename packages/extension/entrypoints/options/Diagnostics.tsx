import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db.js';
import { getDaemonConfigProjects, getDaemonSessions } from '../../lib/daemon-client.js';
import { buildDiagnosticsReport, formatDiagnosticsText, type DiagnosticsInput } from '../../lib/diagnostics.js';
import type { DaemonHealth, Settings } from '../../lib/protocol.js';
import { styles } from './styles.ts';

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

  return (
    <details style={styles.advanced} onToggle={onToggle}>
      <summary style={styles.advancedSummary}>Diagnostics</summary>
      {report && (
        <>
          <ul style={styles.checklist}>
            <li style={styles.checklistItem}>extension: {report.extensionVersion} ({report.browserFamily})</li>
            <li style={styles.checklistItem}>last capture: {report.lastCapture}</li>
            <li style={styles.checklistItem}>snapshots stored: {report.snapshotCount}</li>
            <li style={styles.checklistItem}>schema errors: {report.schemaFailure}</li>
            <li style={styles.checklistItem}>daemon: {report.daemon}</li>
            {report.daemonUrl && <li style={styles.checklistItem}>daemon url: {report.daemonUrl}</li>}
            {report.daemonLastChecked && <li style={styles.checklistItem}>daemon last checked: {report.daemonLastChecked}</li>}
            <li style={styles.checklistItem}>projects: {report.projectCount}</li>
            <li style={styles.checklistItem}>sessions: {report.sessionCount}</li>
          </ul>
          <button type="button" onClick={() => void copy()}>
            {copied ? 'Copied!' : 'Copy diagnostics'}
          </button>
          <p style={styles.hint}>
            Never includes your bearer token, account id, prompts, responses, or file paths — only the
            fields shown above.
          </p>
        </>
      )}
    </details>
  );
}
