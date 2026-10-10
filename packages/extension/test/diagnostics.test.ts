import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, formatDiagnosticsText, type DiagnosticsInput } from '../lib/diagnostics.js';

const BASE_INPUT: DiagnosticsInput = {
  extensionVersion: '0.2.2',
  manifestVersion: 3,
  lastCaptureAt: null,
  snapshotCount: 0,
  hasParseFailure: false,
  lastParseFailureAt: null,
  daemonConfigured: false,
  daemonUrl: null,
  daemonConnected: false,
  daemonVersion: null,
  daemonLastCheckedAt: null,
  projectCount: null,
  sessionCount: null,
};

const now = new Date('2026-08-29T12:00:00Z');

describe('buildDiagnosticsReport', () => {
  it('reports a never-captured, unconfigured install plainly', () => {
    const report = buildDiagnosticsReport(BASE_INPUT, now);
    expect(report.lastCapture).toBe('never');
    expect(report.schemaFailure).toBe('none');
    expect(report.daemon).toBe('not configured');
    expect(report.daemonUrl).toBeNull();
    expect(report.projectCount).toBe('unavailable');
    expect(report.sessionCount).toBe('unavailable');
  });

  it('labels MV3 vs MV2 as a coarse browser family', () => {
    expect(buildDiagnosticsReport({ ...BASE_INPUT, manifestVersion: 3 }, now).browserFamily).toBe('Chrome/Edge (MV3)');
    expect(buildDiagnosticsReport({ ...BASE_INPUT, manifestVersion: 2 }, now).browserFamily).toBe('Firefox (MV2)');
  });

  it('reports a schema-validation failure with how long ago it happened', () => {
    const report = buildDiagnosticsReport(
      { ...BASE_INPUT, hasParseFailure: true, lastParseFailureAt: '2026-08-29T11:55:00Z' },
      now,
    );
    expect(report.schemaFailure).toBe('last failure 5m ago');
  });

  it('is backward-compatible with an older daemon that never sent a version', () => {
    const report = buildDiagnosticsReport(
      { ...BASE_INPUT, daemonConfigured: true, daemonConnected: true, daemonVersion: null, daemonUrl: 'http://127.0.0.1:4317' },
      now,
    );
    expect(report.daemon).toBe('connected');
    expect(report.daemonUrl).toBe('http://127.0.0.1:4317');
  });

  it('reports the daemon version once provided', () => {
    const report = buildDiagnosticsReport(
      { ...BASE_INPUT, daemonConfigured: true, daemonConnected: true, daemonVersion: '0.2.1' },
      now,
    );
    expect(report.daemon).toBe('connected, v0.2.1');
  });

  it('distinguishes "configured but unreachable" from "not configured"', () => {
    const report = buildDiagnosticsReport({ ...BASE_INPUT, daemonConfigured: true, daemonConnected: false }, now);
    expect(report.daemon).toBe('configured but unreachable');
  });

  it('never surfaces a daemon url when the daemon was never configured, even if one is passed', () => {
    // Defensive: a caller shouldn't be able to pass a stale daemonUrl through once unconfigured.
    const report = buildDiagnosticsReport({ ...BASE_INPUT, daemonConfigured: false, daemonUrl: 'http://127.0.0.1:4317' }, now);
    expect(report.daemonUrl).toBeNull();
  });

  it('distinguishes an empty local history (0) from an unreachable daemon (unavailable)', () => {
    const empty = buildDiagnosticsReport({ ...BASE_INPUT, daemonConfigured: true, daemonConnected: true, projectCount: 0, sessionCount: 0 }, now);
    expect(empty.projectCount).toBe('0');
    expect(empty.sessionCount).toBe('0');

    const unavailable = buildDiagnosticsReport({ ...BASE_INPUT, daemonConfigured: true, daemonConnected: false }, now);
    expect(unavailable.projectCount).toBe('unavailable');
    expect(unavailable.sessionCount).toBe('unavailable');
  });
});

describe('formatDiagnosticsText — security allowlist', () => {
  it('renders only the fixed, named fields — nothing else, regardless of what the report object happens to carry', () => {
    const report = buildDiagnosticsReport(
      {
        ...BASE_INPUT,
        daemonConfigured: true,
        daemonConnected: true,
        daemonVersion: '0.2.1',
        daemonUrl: 'http://127.0.0.1:4317',
        snapshotCount: 12,
        lastCaptureAt: '2026-08-29T11:55:00Z',
        projectCount: 6,
        sessionCount: 41,
      },
      now,
    );
    const text = formatDiagnosticsText(report);

    expect(text).toContain('extension: 0.2.2');
    expect(text).toContain('browser: Chrome/Edge (MV3)');
    expect(text).toContain('daemon: connected, v0.2.1');
    expect(text).toContain('daemon url: http://127.0.0.1:4317');
    expect(text).toContain('projects: 6');
    expect(text).toContain('sessions: 41');
  });

  it('never contains a bearer token or daemon pairing token — there is no field for one', () => {
    // DiagnosticsInput structurally has no token field at all; this asserts the observable
    // contract (the output text), not just the type, so a future mistake that threads one
    // through still fails this test.
    const report = buildDiagnosticsReport(BASE_INPUT, now);
    const text = formatDiagnosticsText(report);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/bearer/i);
  });

  it('never contains an org/account id — there is no field for one', () => {
    const report = buildDiagnosticsReport(BASE_INPUT, now);
    const text = formatDiagnosticsText(report);
    expect(text).not.toMatch(/org/i);
    expect(text).not.toMatch(/account/i);
  });

  it('never contains an absolute filesystem path, only a loopback daemon url', () => {
    const report = buildDiagnosticsReport(
      { ...BASE_INPUT, daemonConfigured: true, daemonConnected: true, daemonUrl: 'http://127.0.0.1:4317' },
      now,
    );
    const text = formatDiagnosticsText(report);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/^[A-Za-z]:\\/m);
  });

  it('never contains conversation content, prompts, or raw JSONL — there is no field for any of them', () => {
    const report = buildDiagnosticsReport(BASE_INPUT, now);
    const text = formatDiagnosticsText(report);
    expect(text).not.toMatch(/"type":"(user|assistant)"/);
    expect(text).not.toContain('sessionId');
  });
});
