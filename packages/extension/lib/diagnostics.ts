import { formatUpdatedAgo } from './provenance.js';

/**
 * Everything the diagnostics view is allowed to know — deliberately its own narrow interface,
 * never `Settings`/`DaemonHealth` reused directly as a parameter type. The caller must pull each
 * field out by hand; a field added to `Settings` or `DaemonHealth` later (a bearer token, an org
 * id, a real path) cannot reach this report just by existing — it has to be deliberately added
 * here first. This is the actual security boundary, not the formatter below.
 */
export interface DiagnosticsInput {
  extensionVersion: string;
  /** From `runtime.getManifest().manifest_version` — 3 on this project's Chrome/Edge build, 2 on
   *  its Firefox build. Used only for a coarse, non-identifying browser-family label — never the
   *  raw user agent string. */
  manifestVersion: number;
  lastCaptureAt: string | null;
  snapshotCount: number;
  hasParseFailure: boolean;
  lastParseFailureAt: string | null;
  daemonConfigured: boolean;
  /** A loopback URL (`http://127.0.0.1:<port>`), never the bearer token — useful for spotting a
   *  port misconfiguration, not a secret. */
  daemonUrl: string | null;
  daemonConnected: boolean;
  daemonVersion: string | null;
  daemonLastCheckedAt: string | null;
  /** null means "couldn't be fetched" (daemon unreachable) — distinct from a real 0. */
  projectCount: number | null;
  sessionCount: number | null;
}

export interface DiagnosticsReport {
  extensionVersion: string;
  browserFamily: string;
  lastCapture: string;
  snapshotCount: number;
  schemaFailure: string;
  daemon: string;
  daemonUrl: string | null;
  daemonLastChecked: string | null;
  projectCount: string;
  sessionCount: string;
}

function describeBrowserFamily(manifestVersion: number): string {
  if (manifestVersion === 3) return 'Chrome/Edge (MV3)';
  if (manifestVersion === 2) return 'Firefox (MV2)';
  return 'unknown';
}

export function buildDiagnosticsReport(input: DiagnosticsInput, now: Date = new Date()): DiagnosticsReport {
  const daemon = !input.daemonConfigured
    ? 'not configured'
    : input.daemonConnected
      ? `connected${input.daemonVersion ? `, v${input.daemonVersion}` : ''}`
      : 'configured but unreachable';

  return {
    extensionVersion: input.extensionVersion,
    browserFamily: describeBrowserFamily(input.manifestVersion),
    lastCapture: input.lastCaptureAt ? formatUpdatedAgo(input.lastCaptureAt, now) : 'never',
    snapshotCount: input.snapshotCount,
    schemaFailure:
      input.hasParseFailure && input.lastParseFailureAt ? `last failure ${formatUpdatedAgo(input.lastParseFailureAt, now)}` : 'none',
    daemon,
    daemonUrl: input.daemonConfigured ? input.daemonUrl : null,
    daemonLastChecked: input.daemonLastCheckedAt ? formatUpdatedAgo(input.daemonLastCheckedAt, now) : null,
    projectCount: input.projectCount === null ? 'unavailable' : String(input.projectCount),
    sessionCount: input.sessionCount === null ? 'unavailable' : String(input.sessionCount),
  };
}

/** The literal allowlist for the copyable text: a fixed, hand-written field list, not
 *  `Object.entries`/`JSON.stringify`. A field added to `DiagnosticsReport` later must be
 *  deliberately added to this list too before it can appear in copied output — this is what
 *  makes the allowlist real rather than aspirational. */
const DIAGNOSTICS_FIELD_ORDER: ReadonlyArray<readonly [keyof DiagnosticsReport, string]> = [
  ['extensionVersion', 'extension'],
  ['browserFamily', 'browser'],
  ['lastCapture', 'last capture'],
  ['snapshotCount', 'snapshots stored'],
  ['schemaFailure', 'schema errors'],
  ['daemon', 'daemon'],
  ['daemonUrl', 'daemon url'],
  ['daemonLastChecked', 'daemon last checked'],
  ['projectCount', 'projects'],
  ['sessionCount', 'sessions'],
];

export function formatDiagnosticsText(report: DiagnosticsReport): string {
  const lines = ['Headroom diagnostics'];
  for (const [key, label] of DIAGNOSTICS_FIELD_ORDER) {
    const value = report[key];
    if (value === null || value === undefined) continue;
    lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}
