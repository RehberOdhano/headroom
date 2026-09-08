import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KNOWN_RISKY_PATTERNS,
  type ClaudeConfigSnapshot,
  type ClaudeMdFile,
  type HookEntry,
  type KnownProject,
  type PermissionEffect,
  type SettingsLayer,
} from '@headroom/shared';
import {
  addDaemonPermissionRule,
  getDaemonClaudeMdContent,
  getDaemonClaudeMdList,
  getDaemonConfig,
  getDaemonConfigProjects,
  removeDaemonPermissionRule,
  updateDaemonClaudeMdContent,
  type DaemonResult,
} from '../../lib/daemon-client.js';
import { renderMarkdownSafely } from '../../lib/markdown.js';
import type { Settings } from '../../lib/protocol.js';
import { DaemonGate } from './Cli.tsx';

const EFFECTS: PermissionEffect[] = ['allow', 'ask', 'deny'];

function effectLabel(effect: PermissionEffect): string {
  return effect === 'allow' ? 'Allow' : effect === 'ask' ? 'Ask' : 'Deny';
}

/** Small inline SVGs, not a new icon-library dependency, for the three override buttons in the
 *  known-risky-commands table — icon-only saves real width over "Override: Allow/Ask/Deny" ×3
 *  per row. Each consuming button still carries a text `title`/`aria-label`
 *  (`effectButtonLabel()` below), so this is a visual compaction, not an accessibility
 *  regression — `aria-hidden` here because the button itself already names the action. */
function AllowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AskIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M5.7 6.1a2.3 2.3 0 1 1 3.3 2.1c-.7.35-1.1.9-1.1 1.55v.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="12.2" r="0.95" fill="currentColor" />
    </svg>
  );
}

function DenyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function effectIcon(effect: PermissionEffect) {
  return effect === 'allow' ? <AllowIcon /> : effect === 'ask' ? <AskIcon /> : <DenyIcon />;
}

/** Case-insensitive substring match across any number of fields — an empty query matches
 *  everything. Shared by every filter box below (Permissions, known-risky commands, Hooks,
 *  Skills) rather than four ad-hoc copies. */
function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

type EffectiveLayer = 'local' | 'project' | 'global';

function findInLayer(layer: SettingsLayer | null, pattern: string): PermissionEffect | null {
  if (!layer) return null;
  if (layer.deny.includes(pattern)) return 'deny';
  if (layer.ask.includes(pattern)) return 'ask';
  if (layer.allow.includes(pattern)) return 'allow';
  return null;
}

/** More-specific layers win: local overrides project, which overrides global — same precedence
 *  Claude Code itself applies. Within one layer, deny > ask > allow, though in practice a
 *  well-formed file never lists the same pattern under two effects at once. */
function resolveEffective(
  snapshot: ClaudeConfigSnapshot,
  pattern: string,
): { effect: PermissionEffect; layer: EffectiveLayer } | null {
  const local = findInLayer(snapshot.local, pattern);
  if (local) return { effect: local, layer: 'local' };
  const project = findInLayer(snapshot.project, pattern);
  if (project) return { effect: project, layer: 'project' };
  const global = findInLayer(snapshot.global, pattern);
  if (global) return { effect: global, layer: 'global' };
  return null;
}

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
  const [customPattern, setCustomPattern] = useState('');
  const [customEffect, setCustomEffect] = useState<PermissionEffect>('deny');

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

  async function refreshSnapshot(forProjectDir: string | undefined): Promise<void> {
    latestRequestRef.current = forProjectDir;
    setSnapshotLoading(true);
    const result = await getDaemonConfig(settings, forProjectDir);
    if (latestRequestRef.current === forProjectDir) {
      setSnapshot(result);
      setSnapshotLoading(false);
    }
  }

  useEffect(() => {
    // Clear immediately (not just re-fetch) so a project switch never shows the *previous*
    // project's stale data while the new one loads — the loading indicator below only renders
    // when there's genuinely nothing to show yet, rather than looking like nothing happened.
    setSnapshot(null);
    void refreshSnapshot(projectDir);
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

  return (
    <>
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
          />
          <div>
            <HooksSection hooks={snapshot.data.hooks} />
            <SkillsSection skills={snapshot.data.skills} />
          </div>
        </div>
      )}

      {projectDir && <ClaudeMdSection settings={settings} projectDir={projectDir} />}
    </>
  );
}

function ProjectPicker({
  projects,
  selectedProject,
  onSelectProject,
  manualProjectDir,
  onUseManualPath,
}: {
  projects: KnownProject[];
  selectedProject: string;
  onSelectProject: (value: string) => void;
  manualProjectDir: string;
  onUseManualPath: (value: string) => void;
}) {
  // Local draft, separate from the committed `manualProjectDir` — the path is only actually
  // applied (and only then triggers a daemon fetch) on submit, not on every keystroke. Typing an
  // in-progress path used to fire a fetch per character, almost all of them invalid, which is
  // exactly what produced "sometimes it takes a while, sometimes nothing happens": the *last*
  // keystroke's request wins, so the result depended entirely on typing speed vs. fetch latency.
  const [draft, setDraft] = useState(manualProjectDir);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    onUseManualPath(draft.trim());
  }

  function clear(): void {
    setDraft('');
    onUseManualPath('');
  }

  return (
    <section className="card compact-card">
      <div className="project-picker-row">
        <label className="project-picker-label" htmlFor="guardrails-project-select">
          Project
        </label>
        <div className="select-wrap">
          <select
            id="guardrails-project-select"
            className="search-input"
            value={selectedProject}
            disabled={Boolean(manualProjectDir)}
            onChange={(event) => onSelectProject(event.target.value)}
          >
            <option value="">Global only — no project selected</option>
            {projects.map((project) => (
              <option key={project.path} value={project.path}>
                {project.path}
              </option>
            ))}
          </select>
        </div>
        <details className="project-picker-advanced" open={Boolean(manualProjectDir)}>
          <summary className="hint">
            {manualProjectDir ? `Manual path active: ${manualProjectDir}` : 'Advanced: manual path'}
          </summary>
          <form className="manual-path-form" onSubmit={submit}>
            <input
              className="search-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="/absolute/path/to/project"
            />
            <button type="submit" className="btn">
              Use path
            </button>
            {manualProjectDir && (
              <button type="button" className="btn" onClick={clear}>
                Clear
              </button>
            )}
          </form>
          <p className="hint">Press Enter or click "Use path" to load it — nothing fetches while you type.</p>
        </details>
      </div>
    </section>
  );
}

function LayerRules({
  title,
  subtitle,
  layer,
  filter,
}: {
  title: string;
  subtitle: string;
  layer: SettingsLayer | null;
  filter: string;
}) {
  const total = layer ? layer.allow.length + layer.ask.length + layer.deny.length : 0;
  const filtered = layer && {
    allow: layer.allow.filter((pattern) => matchesQuery(filter, pattern)),
    ask: layer.ask.filter((pattern) => matchesQuery(filter, pattern)),
    deny: layer.deny.filter((pattern) => matchesQuery(filter, pattern)),
  };
  const filteredTotal = filtered ? filtered.allow.length + filtered.ask.length + filtered.deny.length : 0;

  return (
    <div className="layer-card">
      <p className="layer-title" title={layer?.path}>
        {title}
      </p>
      <p className="layer-subtitle">{subtitle}</p>
      {!layer?.exists ? (
        <p className="hint">No settings file found.</p>
      ) : total === 0 ? (
        <p className="hint">No permission rules set.</p>
      ) : filteredTotal === 0 ? (
        <p className="hint">No rules match "{filter}".</p>
      ) : (
        <>
          <p className="layer-count">
            {filter ? `${filteredTotal} of ${total}` : total} rule{total === 1 ? '' : 's'}
          </p>
          {/* Capped height + scroll, not pagination — a real project's settings.json can easily
              carry 20+ rules (confirmed against a real one during testing), and this keeps the
              three-up layer grid from dominating the whole page while still showing everything
              on demand, the same pattern the CLAUDE.md preview below already uses. */}
          <div className="layer-rules-scroll scroll-box">
            {EFFECTS.map(
              (effect) =>
                filtered![effect].length > 0 && (
                  <div key={effect} className="layer-effect-row">
                    {filtered![effect].map((pattern) => (
                      <span key={pattern} className={`effect-badge effect-${effect}`}>
                        {pattern}
                      </span>
                    ))}
                  </div>
                ),
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PermissionsSection({
  snapshot,
  projectDir,
  busyPattern,
  onOverride,
  onRemoveLocal,
  customPattern,
  onCustomPatternChange,
  customEffect,
  onCustomEffectChange,
  onAddCustomRule,
}: {
  snapshot: ClaudeConfigSnapshot;
  projectDir: string | undefined;
  busyPattern: string | null;
  onOverride: (pattern: string, effect: PermissionEffect) => void;
  onRemoveLocal: (pattern: string, effect: PermissionEffect) => void;
  customPattern: string;
  onCustomPatternChange: (value: string) => void;
  customEffect: PermissionEffect;
  onCustomEffectChange: (value: PermissionEffect) => void;
  onAddCustomRule: (event: React.FormEvent) => void;
}) {
  const [ruleFilter, setRuleFilter] = useState('');
  const [knownFilter, setKnownFilter] = useState('');
  const knownMatches = KNOWN_RISKY_PATTERNS.filter((known) => matchesQuery(knownFilter, known.label, known.pattern, known.description));

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Permissions</h2>
      </div>

      <input
        className="search-input filter-input"
        value={ruleFilter}
        onChange={(event) => setRuleFilter(event.target.value)}
        placeholder="Filter rules by pattern…"
      />
      <div className="grid-3" style={{ marginBottom: 'var(--space-4)' }}>
        <LayerRules title="Global" subtitle="~/.claude/settings.json" layer={snapshot.global} filter={ruleFilter} />
        <LayerRules title="Project" subtitle=".claude/settings.json" layer={snapshot.project} filter={ruleFilter} />
        <LayerRules title="Local override" subtitle=".claude/settings.local.json" layer={snapshot.local} filter={ruleFilter} />
      </div>

      <p className="table-title">Known risky commands</p>

      <div className="add-rule-block">
        <p className="table-subtitle">Add a custom rule</p>
        {projectDir ? (
          <form className="search-form" onSubmit={onAddCustomRule}>
            <input
              className="search-input"
              value={customPattern}
              onChange={(event) => onCustomPatternChange(event.target.value)}
              placeholder="Custom pattern, e.g. Bash(docker rm *)"
            />
            <div className="select-wrap" style={{ flex: '0 0 130px' }}>
              <select
                className="search-input"
                value={customEffect}
                onChange={(event) => onCustomEffectChange(event.target.value as PermissionEffect)}
              >
                {EFFECTS.map((effect) => (
                  <option key={effect} value={effect}>
                    {effectLabel(effect)}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary">
              Add local rule
            </button>
          </form>
        ) : (
          <p className="hint">Select a project above to add or override rules — global-only view is read-only.</p>
        )}
      </div>

      <input
        className="search-input filter-input"
        value={knownFilter}
        onChange={(event) => setKnownFilter(event.target.value)}
        placeholder="Filter known commands…"
      />
      {knownMatches.length === 0 ? (
        <p className="hint">No commands match "{knownFilter}".</p>
      ) : (
        <div className="table-wrap rules-scroll scroll-box">
          <table className="data-table rules-table">
            <thead>
              <tr>
                <th>Command</th>
                <th>Current</th>
                {projectDir && <th>Set to</th>}
              </tr>
            </thead>
            <tbody>
              {knownMatches.map((known) => {
                const resolved = resolveEffective(snapshot, known.pattern);
                const isBusy = busyPattern === known.pattern;
                const localEffect = findInLayer(snapshot.local, known.pattern);
                return (
                  <tr key={known.pattern}>
                    <td title={known.description}>
                      <span className="rule-label">{known.label}</span>
                      <span className="rule-pattern">{known.pattern}</span>
                    </td>
                    <td>
                      {resolved ? (
                        <span className={`effect-badge effect-${resolved.effect}`}>
                          {effectLabel(resolved.effect)} · {resolved.layer}
                        </span>
                      ) : (
                        <span className="hint">No rule set</span>
                      )}
                    </td>
                    {projectDir && (
                      <td>
                        <div className="rule-actions">
                          {/* A nested nowrap group, not flat siblings of "Remove" in one wrapping
                              flex container — flex-wrap breaks between top-level items, so three
                              flat buttons wrapped at 2-then-1 instead of staying together. Grouped
                              like this, the trio moves to a new line as one unit if it must, but
                              never splits apart. */}
                          <div className="rule-actions-icons">
                            {EFFECTS.map((effect) => (
                              <button
                                key={effect}
                                type="button"
                                className={`btn btn-icon effect-btn-${effect}`}
                                title={`Override: ${effectLabel(effect)}`}
                                aria-label={`Override ${known.label}: ${effectLabel(effect)}`}
                                disabled={isBusy || (resolved?.layer === 'local' && resolved.effect === effect)}
                                onClick={() => onOverride(known.pattern, effect)}
                              >
                                {effectIcon(effect)}
                              </button>
                            ))}
                          </div>
                          {localEffect && (
                            <button
                              type="button"
                              className="btn"
                              title="Remove local override"
                              disabled={isBusy}
                              onClick={() => onRemoveLocal(known.pattern, localEffect)}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HooksSection({ hooks }: { hooks: HookEntry[] }) {
  const [filter, setFilter] = useState('');
  const matches = hooks.filter((hook) => matchesQuery(filter, hook.event, hook.matcher, hook.command, hook.source));

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Hooks</h2>
        {hooks.length > 0 && <span className="card-stat">{hooks.length}</span>}
      </div>
      {hooks.length === 0 ? (
        <p className="hint">No hooks configured in any layer.</p>
      ) : (
        <>
          <input
            className="search-input filter-input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by event, matcher, or command…"
          />
          {matches.length === 0 ? (
            <p className="hint">No hooks match "{filter}".</p>
          ) : (
            <div className="hook-list scroll-box">
              {matches.map((hook, index) => (
                <div key={`${hook.source}-${index}`} className="hook-card">
                  <div className="hook-meta">
                    <span className="hook-event-badge">{hook.event}</span>
                    {hook.matcher && <span className="hook-matcher">{hook.matcher}</span>}
                  </div>
                  <p className="hook-command">{hook.command}</p>
                  <p className="hook-source">{hook.source}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SkillsSection({ skills }: { skills: ClaudeConfigSnapshot['skills'] }) {
  const [filter, setFilter] = useState('');
  const matches = skills.filter((skill) => matchesQuery(filter, skill.name, skill.description));

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Skills</h2>
        {skills.length > 0 && <span className="card-stat">{skills.length}</span>}
      </div>
      {skills.length === 0 ? (
        <p className="hint">No skills found for this project or your global config.</p>
      ) : (
        <>
          <input
            className="search-input filter-input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or description…"
          />
          {matches.length === 0 ? (
            <p className="hint">No skills match "{filter}".</p>
          ) : (
            <div className="skills-scroll scroll-box">
              {matches.map((skill) => (
                <div key={skill.path} className="result-card">
                  <p className="warning-title" style={{ fontFamily: 'inherit', fontWeight: 650 }}>
                    {skill.name}
                  </p>
                  <p className="result-meta">{skill.description}</p>
                  <p className="result-meta">{skill.path}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

type ViewMode = 'preview' | 'source';

function ClaudeMdSection({ settings, projectDir }: { settings: Settings; projectDir: string }) {
  const [files, setFiles] = useState<DaemonResult<{ files: ClaudeMdFile[] }> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<DaemonResult<{ content: string }> | null>(null);
  const [draft, setDraft] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(null);
    setLoaded(null);
    setDraft('');
    setSaveError(null);
    void getDaemonClaudeMdList(settings, projectDir).then(setFiles);
  }, [settings.daemonUrl, settings.daemonToken, projectDir]);

  const dirty = loaded?.ok ? draft !== loaded.data.content : false;
  const renderedHtml = useMemo(() => renderMarkdownSafely(draft), [draft]);

  async function open(filePath: string): Promise<void> {
    setSelected(filePath);
    setSaveError(null);
    setViewMode('preview');
    const result = await getDaemonClaudeMdContent(settings, projectDir, filePath);
    setLoaded(result);
    setDraft(result.ok ? result.data.content : '');
  }

  async function save(): Promise<void> {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateDaemonClaudeMdContent(settings, projectDir, selected, draft);
      if (result.ok) setLoaded(result);
      else setSaveError(result.message);
    } finally {
      setSaving(false);
    }
  }

  function revert(): void {
    if (loaded?.ok) setDraft(loaded.data.content);
  }

  async function copyCurrent(): Promise<void> {
    const text = viewMode === 'source' ? draft : (previewRef.current?.textContent ?? draft);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">CLAUDE.md</h2>
      </div>
      {files === null && (
        <p className="hint">
          <span className="spinner" aria-hidden="true" />
          Looking for CLAUDE.md files…
        </p>
      )}
      {files && !files.ok && <p className="error-text">{files.message}</p>}
      {files?.ok && files.data.files.length === 0 && <p className="hint">No CLAUDE.md files found in this project.</p>}
      {files?.ok && files.data.files.length > 0 && (
        <div className="result-actions" style={{ marginBottom: 'var(--space-3)' }}>
          {files.data.files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="btn"
              disabled={selected === file.path}
              onClick={() => void open(file.path)}
            >
              {file.relativePath}
            </button>
          ))}
        </div>
      )}
      {loaded && !loaded.ok && <p className="error-text">{loaded.message}</p>}
      {loaded?.ok && (
        <>
          <div className="md-toolbar">
            <div className="segmented" role="group" aria-label="View mode">
              <button type="button" aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}>
                Preview
              </button>
              <button type="button" aria-pressed={viewMode === 'source'} onClick={() => setViewMode('source')}>
                Source (.md)
              </button>
            </div>
            <div className="result-actions">
              <button type="button" className="btn" onClick={() => void copyCurrent()}>
                {copied ? 'Copied!' : `Copy ${viewMode === 'source' ? '.md' : 'preview'}`}
              </button>
              {viewMode === 'source' && (
                <>
                  <button type="button" className="btn" disabled={!dirty} onClick={revert}>
                    Revert
                  </button>
                  <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </div>
          </div>
          {saveError && <p className="error-text">{saveError}</p>}
          {dirty && viewMode === 'source' && <p className="hint">Unsaved changes — Save writes directly to the file on disk.</p>}
          {viewMode === 'preview' ? (
            <div ref={previewRef} className="claude-md-preview markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          ) : (
            <textarea
              className="md-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
            />
          )}
        </>
      )}
    </section>
  );
}
