import { useEffect, useRef, useState } from 'react';
import { KNOWN_RISKY_PATTERNS, type ClaudeConfigSnapshot, type KnownProject, type KnownRiskyPattern, type PermissionEffect } from '@headroom/shared';
import {
  addDaemonPermissionRule,
  getDaemonConfig,
  getDaemonConfigProjects,
  removeDaemonPermissionRule,
  type DaemonResult,
} from '../../lib/daemon-client.js';
import { describeConfigDrift, diffConfigSummaries, fingerprintSnapshot, riskyDriftAdditions } from '../../lib/config-drift.js';
import { db } from '../../lib/db.js';
import { resolveEffective } from '../../lib/guardrails.js';
import type { Settings } from '../../lib/protocol.js';
import { DaemonGate } from './Cli.tsx';
import { AgentsSection } from './guardrails/AgentsSection.tsx';
import { ClaudeMdSection } from './guardrails/ClaudeMdSection.tsx';
import { HooksSection } from './guardrails/HooksSection.tsx';
import { ProjectHealthSection } from './guardrails/ProjectHealthSection.tsx';
import { PermissionsSection } from './guardrails/PermissionsSection.tsx';
import { ProjectPicker } from './guardrails/ProjectPicker.tsx';
import { ProjectUsageSection } from './guardrails/ProjectUsageSection.tsx';
import { SkillsSection } from './guardrails/SkillsSection.tsx';

/** Daemon-backed config visibility (permission rules, hooks, skills, CLAUDE.md docs) plus
 *  permission-rule overrides — writes go only to a project's `.claude/settings.local.json`, never
 *  the shared `settings.json` or the global one (packages/daemon/src/adapters/claude-config.ts). */
export function ConfigTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to see and manage Claude Code's permissions, hooks, skills, and CLAUDE.md docs here.">
      {(settings) => <ConfigContent settings={settings} />}
    </DaemonGate>
  );
}

function ConfigContent({ settings }: { settings: Settings }) {
  const [projects, setProjects] = useState<KnownProject[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [manualProjectDir, setManualProjectDir] = useState('');
  const [snapshot, setSnapshot] = useState<DaemonResult<ClaudeConfigSnapshot> | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [busyPattern, setBusyPattern] = useState<string | null>(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [customPattern, setCustomPattern] = useState('');
  const [customEffect, setCustomEffect] = useState<PermissionEffect>('deny');
  const [driftMessage, setDriftMessage] = useState<string | null>(null);
  const [driftRisky, setDriftRisky] = useState<KnownRiskyPattern[]>([]);

  const projectDir = manualProjectDir || selectedProject || undefined;
  // Guards against an in-flight request for a since-abandoned projectDir resolving after a
  // newer one and clobbering it with stale data — e.g. quickly switching projects, or (as this
  // component's own test caught) selecting a project before the initial global-only fetch has
  // even resolved.
  const latestRequestRef = useRef<string | undefined>(undefined);

  // Dropdown and manual-path selection are mutually exclusive — picking one clears the other, so
  // there's never a case where the visible dropdown value and the actually-active project
  // disagree (previously the dropdown could sit on "Global only" while a manual path was live).
  function selectFromDropdown(path: string): void {
    setSelectedProject(path);
    setManualProjectDir('');
  }

  function useManualPath(path: string): void {
    setManualProjectDir(path);
    setSelectedProject('');
  }

  useEffect(() => {
    void getDaemonConfigProjects(settings).then((result) => {
      if (result.ok) setProjects(result.data.projects);
    });
  }, [settings.daemonUrl, settings.daemonToken]);

  /** `checkDrift` is only ever true from the project-switch effect below, never from a
   *  permission-edit's own refresh — the user just made that change themselves, so re-flagging
   *  it as "changed since you last viewed" would be confusing noise, not a useful signal. */
  async function refreshSnapshot(forProjectDir: string | undefined, checkDrift = false): Promise<void> {
    latestRequestRef.current = forProjectDir;
    setSnapshotLoading(true);
    const result = await getDaemonConfig(settings, forProjectDir);
    if (latestRequestRef.current !== forProjectDir) return;
    setSnapshot(result);
    setSnapshotLoading(false);
    if (!checkDrift) return;

    if (result.ok && forProjectDir) {
      const { hash, summary } = fingerprintSnapshot(result.data);
      const prior = await db.configFingerprints.get(forProjectDir);
      if (prior && prior.fingerprint !== hash) {
        if (prior.summary) {
          const drift = diffConfigSummaries(prior.summary, summary);
          setDriftMessage(describeConfigDrift(drift));
          setDriftRisky(riskyDriftAdditions(drift));
        } else {
          // A record from before `summary` existed — still worth flagging, just without detail.
          setDriftMessage('Something');
          setDriftRisky([]);
        }
      } else {
        setDriftMessage(null);
        setDriftRisky([]);
      }
      await db.configFingerprints.put({ projectDir: forProjectDir, fingerprint: hash, summary, checkedAt: new Date().toISOString() });
    } else {
      setDriftMessage(null);
      setDriftRisky([]);
    }
  }

  useEffect(() => {
    // Clear immediately (not just re-fetch) so a project switch never shows the *previous*
    // project's stale data while the new one loads — the loading indicator below only renders
    // when there's genuinely nothing to show yet, rather than looking like nothing happened.
    setSnapshot(null);
    setDriftMessage(null);
    setDriftRisky([]);
    void refreshSnapshot(projectDir, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.daemonUrl, settings.daemonToken, projectDir]);

  async function applyOverride(pattern: string, effect: PermissionEffect): Promise<void> {
    if (!projectDir) return;
    setBusyPattern(pattern);
    try {
      await addDaemonPermissionRule(settings, { projectDir, pattern, effect });
      await refreshSnapshot(projectDir);
    } finally {
      setBusyPattern(null);
    }
  }

  async function removeLocalRule(pattern: string, effect: PermissionEffect): Promise<void> {
    if (!projectDir) return;
    setBusyPattern(pattern);
    try {
      await removeDaemonPermissionRule(settings, { projectDir, pattern, effect });
      await refreshSnapshot(projectDir);
    } finally {
      setBusyPattern(null);
    }
  }

  async function addCustomRule(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const pattern = customPattern.trim();
    if (!pattern || !projectDir) return;
    await applyOverride(pattern, customEffect);
    setCustomPattern('');
  }

  const unprotectedRiskyPatterns =
    snapshot?.ok && projectDir
      ? KNOWN_RISKY_PATTERNS.filter((known) => resolveEffective(snapshot.data, known.pattern)?.effect !== 'deny')
      : [];

  /**
   * Denies every bundled known-risky pattern not already denied, in one click. Writes go one at
   * a time, not `Promise.all`'d: `writePermissionRule` (daemon) does a read-modify-write of the
   * whole `settings.local.json` file per call, so concurrent writes would each read the same
   * starting file and clobber all but the last one to finish. A single `refreshSnapshot` at the
   * end (not per-pattern) picks up the final state; `checkDrift` stays false, same as
   * `applyOverride` — this is the user's own change, not an external edit worth flagging.
   */
  async function applyAllRecommended(): Promise<void> {
    if (!projectDir || unprotectedRiskyPatterns.length === 0) return;
    setBulkApplying(true);
    try {
      for (const known of unprotectedRiskyPatterns) {
        await addDaemonPermissionRule(settings, { projectDir, pattern: known.pattern, effect: 'deny' });
      }
      await refreshSnapshot(projectDir);
    } finally {
      setBulkApplying(false);
    }
  }

  return (
    <>
      <ProjectHealthSection settings={settings} projects={projects} onSelectProject={selectFromDropdown} />

      <ProjectPicker
        projects={projects}
        selectedProject={selectedProject}
        onSelectProject={selectFromDropdown}
        manualProjectDir={manualProjectDir}
        onUseManualPath={useManualPath}
      />

      {snapshotLoading && !snapshot && (
        <section className="card">
          <p className="hint">
            <span className="spinner" aria-hidden="true" />
            Loading configuration…
          </p>
        </section>
      )}

      {snapshot && !snapshot.ok && (
        <section className="card">
          <p className="error-text">{snapshot.message}</p>
        </section>
      )}

      {driftMessage && snapshot?.ok && (
        <section className="card compact-card">
          <p className={driftRisky.length > 0 ? 'error-text' : 'hint'}>
            {driftRisky.length > 0 && '⚠ '}
            {driftMessage} changed here since you last viewed this project.
            {driftRisky.length > 0 && (
              <>
                {' '}
                Newly allowed: {driftRisky.map((risky) => `${risky.pattern} (${risky.label})`).join(', ')}.
              </>
            )}{' '}
            <button type="button" className="btn" onClick={() => setDriftMessage(null)}>
              Dismiss
            </button>
          </p>
        </section>
      )}

      {snapshot?.ok && (
        <div className="grid-2">
          <PermissionsSection
            snapshot={snapshot.data}
            projectDir={projectDir}
            busyPattern={busyPattern}
            onOverride={applyOverride}
            onRemoveLocal={removeLocalRule}
            customPattern={customPattern}
            onCustomPatternChange={setCustomPattern}
            customEffect={customEffect}
            onCustomEffectChange={setCustomEffect}
            onAddCustomRule={addCustomRule}
            unprotectedCount={unprotectedRiskyPatterns.length}
            bulkApplying={bulkApplying}
            onApplyAllRecommended={applyAllRecommended}
          />
          <div>
            <HooksSection hooks={snapshot.data.hooks} />
            <SkillsSection skills={snapshot.data.skills} />
            <AgentsSection
              agents={snapshot.data.agents}
              projectDir={projectDir}
              settings={settings}
              onUpdated={() => refreshSnapshot(projectDir)}
            />
          </div>
        </div>
      )}

      {projectDir && <ProjectUsageSection settings={settings} projectDir={projectDir} />}

      {projectDir && <ClaudeMdSection settings={settings} projectDir={projectDir} />}
    </>
  );
}

