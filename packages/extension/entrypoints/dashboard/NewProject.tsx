import { useEffect, useState } from 'react';
import {
  KNOWN_RISKY_PATTERNS,
  KNOWN_TECH_TAGS,
  inferStackFromTags,
  type BootstrapMode,
  type BootstrapResult,
  type BootstrapStack,
  type KnownProject,
} from '@headroom/shared';
import { addDaemonPermissionRule, getDaemonConfigProjects, getDaemonProjectDetection, runDaemonBootstrap } from '../../lib/daemon-client.js';
import { addCustomStackTag, getCustomStackTags } from '../../lib/custom-stack-tags.js';
import { documentEncodingForFilename } from '../../lib/document-upload.js';
import type { Settings } from '../../lib/protocol.js';
import { addTechTag, filterTechTagSuggestions, mergeDetectedTechTags } from '../../lib/tech-tags.js';
import { DaemonGate } from './Cli.tsx';

/** Only used to label `result.inferredStack` in the result panel — there's no dropdown of these
 *  any more; which one (if any) applies is inferred server-side from the "Stack" tags picked. */
const STACK_LABELS: Record<BootstrapStack, string> = {
  'node-typescript': 'Node + TypeScript',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  csharp: 'C#',
  other: 'other — no built-in template',
  none: 'none',
};

const STACKS_WITH_COMMANDS: Record<BootstrapStack, boolean> = {
  'node-typescript': true,
  python: true,
  go: true,
  java: true,
  kotlin: true,
  csharp: true,
  other: false,
  none: false,
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:<mime>;base64,AAAA..."
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

async function readDocument(file: File): Promise<{ filename: string; content: string; encoding: ReturnType<typeof documentEncodingForFilename> }> {
  const encoding = documentEncodingForFilename(file.name);
  const content = encoding === 'utf8' ? await file.text() : await readFileAsBase64(file);
  return { filename: file.name, content, encoding };
}

/** Denies every bundled known-risky pattern against the just-created project, one write at a
 *  time — same daemon route and the same "never `Promise.all`" rule as Guardrails' own "Apply
 *  recommended protections" (`writePermissionRule` does a read-modify-write of the whole
 *  `settings.local.json` per call; concurrent calls would clobber each other). Best-effort: a
 *  failed pattern is skipped, not treated as a reason to fail the whole setup that already
 *  otherwise succeeded. */
async function applyRecommendedProtections(settings: Settings, projectDir: string): Promise<number> {
  let applied = 0;
  for (const known of KNOWN_RISKY_PATTERNS) {
    const result = await addDaemonPermissionRule(settings, { projectDir, pattern: known.pattern, effect: 'deny' });
    if (result.ok) applied++;
  }
  return applied;
}

function VerificationResults({ steps }: { steps: BootstrapResult['verification'] }) {
  if (!steps) return null;
  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <p className="table-title">Verification</p>
      {steps.map((step, index) => (
        <details key={`${step.command}-${index}`} open={!step.ok}>
          <summary className={step.ok ? undefined : 'error-text'}>
            {step.ok ? '✓' : '✗'} {step.command}
          </summary>
          {step.output && <pre className="verification-output">{step.output}</pre>}
        </details>
      ))}
    </div>
  );
}

/**
 * The one "Stack" field: a free-form multi-select pill picker covering languages, frameworks,
 * databases, cloud/infra, and testing tools — not a single-choice dropdown, since a real project
 * is rarely just one thing ("React" + "PostgreSQL" + "AWS"). Every picked tag is recorded into the
 * generated CLAUDE.md; separately, the daemon infers which (if any) of its three real scaffold
 * templates applies from these same tags (`inferStackFromTags`) — most tags (a database, a cloud
 * provider, "Java") don't match a template and that's fine, they're still real, useful metadata.
 *
 * Typing something not in the curated catalog and pressing Enter adds it anyway — and that typed
 * tag is saved locally (`lib/custom-stack-tags.ts`) so it shows up as a real suggestion next time,
 * which is the actual mechanism behind "the stack list grows": growth is per-install, not a
 * shared catalog, and nothing here is sent anywhere until the user submits the form.
 */
function TechTagPicker({ selected, onChange }: { selected: string[]; onChange: (next: string[]) => void }) {
  const [query, setQuery] = useState('');
  const [customTags, setCustomTags] = useState<string[]>([]);

  useEffect(() => {
    void getCustomStackTags().then(setCustomTags);
  }, []);

  const suggestions = filterTechTagSuggestions(query, selected, [...KNOWN_TECH_TAGS, ...customTags]);

  function commit(tag: string): void {
    const trimmed = tag.trim();
    onChange(addTechTag(selected, trimmed));
    setQuery('');
    if (trimmed && !suggestions.some((suggestion) => suggestion.toLowerCase() === trimmed.toLowerCase())) {
      void addCustomStackTag(trimmed).then(() => getCustomStackTags()).then(setCustomTags);
    }
  }

  return (
    <div className="form-field">
      <label className="form-field-title" htmlFor="new-project-stack-input">
        Stack
      </label>
      {selected.length > 0 && (
        <div className="tech-tag-list">
          {selected.map((tag) => (
            <span key={tag} className="tech-tag">
              {tag}
              <button type="button" aria-label={`Remove ${tag}`} onClick={() => onChange(selected.filter((existing) => existing !== tag))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id="new-project-stack-input"
        className="form-field-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit(suggestions[0]?.toLowerCase() === query.trim().toLowerCase() ? suggestions[0] : query);
        }}
        placeholder="TypeScript, Python, React, PostgreSQL… type and press Enter"
      />
      {suggestions.length > 0 && (
        <div className="tech-tag-suggestions">
          {suggestions.map((tag) => (
            <button key={tag} type="button" className="tech-tag-suggestion" onClick={() => commit(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}
      <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
        A tag not in the list gets added and remembered for next time. Only TypeScript/JavaScript,
        Python, Go, Java, Kotlin, or C# (and a handful of their frameworks) trigger a real
        generated scaffold — anything else is recorded in CLAUDE.md for reference only.
      </p>
    </div>
  );
}

/**
 * A deterministic, no-LLM project setup: create (or point at) a folder, optionally attach a
 * proposal/requirements/handoff document, pick a stack, and the daemon writes a real scaffold
 * plus a CLAUDE.md — see packages/daemon/src/adapters/bootstrap.ts. Nothing here reads or
 * understands the document's content; that step still needs an actual Claude Code session,
 * which is exactly what `.claude/skills/project-bootstrap` is for once this has run.
 */
function NewProjectForm({ settings, onProjectReady }: { settings: Settings; onProjectReady: (targetDir: string) => void }) {
  const [mode, setMode] = useState<BootstrapMode>('create');
  const [targetDir, setTargetDir] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [technologies, setTechnologies] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [applyProtections, setApplyProtections] = useState(true);
  const [initGit, setInitGit] = useState(true);
  const [runVerification, setRunVerification] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState<'setup' | 'protections' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [protectionsApplied, setProtectionsApplied] = useState<number | null>(null);
  // Captured at submit time, separate from the (still-editable) `targetDir` field — the "Go to
  // Guardrails" button below must always point at the folder that was actually just set up, even
  // if the user edits the path field afterward without resubmitting.
  const [completedTargetDir, setCompletedTargetDir] = useState<string | null>(null);
  const [knownProjects, setKnownProjects] = useState<KnownProject[]>([]);
  const [autofillNote, setAutofillNote] = useState<string | null>(null);

  // Same known-project-directories list Guardrails' own picker uses, offered here as a
  // `<datalist>` so an "Existing folder" path can be picked instead of hand-typed — reduces the
  // most common paper cut (a typo in a long absolute path).
  useEffect(() => {
    void getDaemonConfigProjects(settings).then((result) => {
      if (result.ok) setKnownProjects(result.data.projects);
    });
  }, [settings.daemonUrl, settings.daemonToken]);

  // A completed run's result panel is only meaningful until the user starts configuring
  // something new — this fires on every field edit (including toggling Create/Existing) so a
  // stale "Folder created…" panel never lingers next to a form the user has moved on from. A
  // plain tab switch (e.g. the "Go to Guardrails" round trip) never calls this, so returning
  // without touching anything still shows the just-completed project, as intended.
  function clearStaleOutcome(): void {
    if (result || error) {
      setResult(null);
      setError(null);
      setProtectionsApplied(null);
      setCompletedTargetDir(null);
    }
  }

  // Only meaningful for "Use existing folder" — a folder about to be created can't have any info
  // in it yet.
  //
  // `autofillNote` doubles as "have name/description/technologies been touched since the last
  // autofill" (every manual edit to one of them clears it) — when it's still set, the current
  // values are known to be pure leftovers from whichever folder was detected last, never
  // something the user actually typed, so this folder's real values fully replace them, blank
  // fields included. That's the fix for a real bug: picking folder A, then folder B, used to
  // leave B's form showing a mix of A's and B's data, since a null/empty detected field never
  // overwrote whatever was already there. If the user *has* edited something manually since the
  // last autofill, fall back to the conservative rule instead — only ever add information (a
  // present field overwrites, technologies merge), never erase something they wrote themselves.
  async function detectAndFillProjectInfo(dir: string): Promise<void> {
    const response = await getDaemonProjectDetection(settings, dir);
    if (!response.ok) return;
    const { name: detectedName, description: detectedDescription, technologies: detectedTechnologies } = response.data;

    if (autofillNote !== null) {
      setName(detectedName ?? '');
      setDescription(detectedDescription ?? '');
      setTechnologies(detectedTechnologies);
    } else {
      if (detectedName) setName(detectedName);
      if (detectedDescription) setDescription(detectedDescription);
      if (detectedTechnologies.length > 0) setTechnologies((current) => mergeDetectedTechTags(current, detectedTechnologies));
    }

    setAutofillNote(detectedName || detectedDescription || detectedTechnologies.length > 0 ? 'Filled in from the existing folder — feel free to edit.' : null);
  }

  // Debounced rather than blur-triggered — picking a suggestion from the path field's
  // `<datalist>` doesn't reliably fire a blur event (the field commonly stays focused), which
  // used to mean detection silently never ran until the user happened to click away afterward,
  // indistinguishable from "nothing was detected" for that folder. A short pause after any change
  // (typed, pasted, or picked) is the same "commit, don't fetch per character" rule ProjectPicker's
  // own manual-path field follows — just not gated on blur specifically, which was the real
  // friction point blur-only triggering had.
  useEffect(() => {
    if (mode !== 'existing') return;
    const trimmed = targetDir.trim();
    if (!trimmed) return;
    const timeout = setTimeout(() => void detectAndFillProjectInfo(trimmed), 300);
    return () => clearTimeout(timeout);
    // Deliberately keyed on the raw values that should trigger a re-check, not on
    // `detectAndFillProjectInfo` itself (a new function identity every render) — including it
    // would reset this debounce on every unrelated re-render (e.g. toggling a checkbox) while the
    // path sits unchanged, re-running detection for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetDir, mode]);

  // Switching Create/Existing means starting over for a different folder — the previous mode's
  // path, name, description, stack tags, document, and any completed result all belong to a
  // folder that's no longer the one in play, so a full reset (not just clearing the stale result)
  // avoids carrying stale values into a mode they were never entered for. A no-op re-click of the
  // already-active mode changes nothing.
  function switchMode(newMode: BootstrapMode): void {
    if (newMode === mode) return;
    resetForm();
    setMode(newMode);
  }

  function resetForm(): void {
    setMode('create');
    setTargetDir('');
    setName('');
    setDescription('');
    setTechnologies([]);
    setFile(null);
    setFileInputKey((key) => key + 1); // file inputs aren't React-controlled — force a remount
    setApplyProtections(true);
    setInitGit(true);
    setRunVerification(false);
    setError(null);
    setResult(null);
    setProtectionsApplied(null);
    setCompletedTargetDir(null);
    setAutofillNote(null);
  }

  // Recomputed on every render from the current tag selection — there's no stored `stack` state
  // to keep in sync with it, so this is always exactly what the daemon will also infer on submit.
  const currentStack = inferStackFromTags(technologies);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setResult(null);
    setProtectionsApplied(null);

    const trimmedDir = targetDir.trim();
    const trimmedName = name.trim();
    if (!trimmedDir || !trimmedName) {
      setError('A folder path and a project name are required.');
      return;
    }

    setSubmitting(true);
    setSubmitStage('setup');
    try {
      const document = file ? await readDocument(file) : null;
      const response = await runDaemonBootstrap(settings, {
        targetDir: trimmedDir,
        mode,
        name: trimmedName,
        description: description.trim(),
        technologies,
        document,
        initGit,
        runVerification: runVerification && STACKS_WITH_COMMANDS[currentStack],
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }

      if (applyProtections) {
        setSubmitStage('protections');
        setProtectionsApplied(await applyRecommendedProtections(settings, trimmedDir));
      }

      setResult(response.data);
      setCompletedTargetDir(trimmedDir);
    } finally {
      setSubmitting(false);
      setSubmitStage(null);
    }
  }

  const submitLabel =
    submitStage === 'protections'
      ? 'Applying protections…'
      : submitStage === 'setup' && runVerification && STACKS_WITH_COMMANDS[currentStack]
        ? 'Setting up… (installing dependencies, this can take a minute)'
        : submitting
          ? 'Setting up…'
          : 'Set up project';

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">New project</h2>
      </div>
      <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
        Sets up a folder with a CLAUDE.md, a deterministic scaffold for the stack you pick, and
        any document you attach — no AI reads or interprets it, just files written to disk.
      </p>

      <form onSubmit={submit}>
        <div className="segmented" role="group" aria-label="Project mode" style={{ marginBottom: 'var(--space-4)' }}>
          <button type="button" aria-pressed={mode === 'create'} onClick={() => switchMode('create')}>
            Create new folder
          </button>
          <button type="button" aria-pressed={mode === 'existing'} onClick={() => switchMode('existing')}>
            Use existing folder
          </button>
        </div>

        <div className="form-field">
          <label className="form-field-title" htmlFor="new-project-target-dir">
            {mode === 'create' ? 'Folder path to create (must not already exist)' : 'Existing folder path'}
          </label>
          <input
            id="new-project-target-dir"
            className="form-field-input"
            value={targetDir}
            onChange={(event) => {
              clearStaleOutcome();
              setTargetDir(event.target.value);
            }}
            placeholder="/absolute/path/to/project"
            list={mode === 'existing' ? 'new-project-known-dirs' : undefined}
          />
          {mode === 'existing' && (
            <datalist id="new-project-known-dirs">
              {knownProjects.map((project) => (
                <option key={project.path} value={project.path} />
              ))}
            </datalist>
          )}
        </div>

        <div className="form-field">
          <label className="form-field-title" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            className="form-field-input"
            value={name}
            onChange={(event) => {
              clearStaleOutcome();
              setAutofillNote(null);
              setName(event.target.value);
            }}
            placeholder="my-project"
          />
        </div>

        <div className="form-field">
          <label className="form-field-title" htmlFor="new-project-description">
            One-line description (optional)
          </label>
          <input
            id="new-project-description"
            className="form-field-input"
            value={description}
            onChange={(event) => {
              clearStaleOutcome();
              setAutofillNote(null);
              setDescription(event.target.value);
            }}
          />
        </div>

        {autofillNote && <p className="hint">{autofillNote}</p>}

        <TechTagPicker
          selected={technologies}
          onChange={(next) => {
            clearStaleOutcome();
            setAutofillNote(null);
            setTechnologies(next);
          }}
        />

        <div className="form-field">
          <label className="form-field-title" htmlFor="new-project-document">
            Proposal / requirements / handoff document (optional)
          </label>
          <input
            key={fileInputKey}
            id="new-project-document"
            type="file"
            accept=".md,.txt,.pdf,.doc,.docx"
            onChange={(event) => {
              clearStaleOutcome();
              setFile(event.target.files?.[0] ?? null);
            }}
          />
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={applyProtections}
            onChange={(event) => {
              clearStaleOutcome();
              setApplyProtections(event.target.checked);
            }}
          />
          Deny every known-risky command pattern by default (same as Guardrails' "Apply recommended protections")
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={initGit}
            onChange={(event) => {
              clearStaleOutcome();
              setInitGit(event.target.checked);
            }}
          />
          Initialize a git repository (skipped if one already exists)
        </label>

        {STACKS_WITH_COMMANDS[currentStack] && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={runVerification}
              onChange={(event) => {
                clearStaleOutcome();
                setRunVerification(event.target.checked);
              }}
            />
            Verify the scaffold by installing dependencies and running typecheck/lint/test — reaches the network, and can take a minute
          </label>
        )}

        {error && <p className="error-text">{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting && <span className="spinner" aria-hidden="true" />}
            {submitLabel}
          </button>
          {(result || error) && (
            <button type="button" className="btn" onClick={resetForm} disabled={submitting}>
              Start another project
            </button>
          )}
        </div>
      </form>

      {result && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          {result.inferredStack !== 'none' && (
            <p className="hint" style={{ marginBottom: 'var(--space-2)' }}>
              Stack: {STACK_LABELS[result.inferredStack]}.
            </p>
          )}
          {result.scaffoldSkipped && (
            <p className="hint" style={{ marginBottom: 'var(--space-2)' }}>
              This folder already had real content, so no scaffold files were generated for it —
              only CLAUDE.md and any attached document. Its existing structure was left alone.
            </p>
          )}
          <p className="hint">
            {result.createdFolder && 'Folder created. '}
            {result.createdFiles.length} file{result.createdFiles.length === 1 ? '' : 's'} written
            {result.skippedFiles.length > 0
              ? `, ${result.skippedFiles.length} already existed and were left untouched.`
              : '.'}
            {result.gitInitialized && ' Git repository initialized.'}
            {protectionsApplied !== null && ` ${protectionsApplied} known-risky command pattern${protectionsApplied === 1 ? '' : 's'} denied.`}
          </p>
          {result.createdFiles.length > 0 && (
            <ul>
              {result.createdFiles.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
          <VerificationResults steps={result.verification} />
          {completedTargetDir && (
            <button
              type="button"
              className="btn"
              style={{ marginTop: 'var(--space-3)' }}
              onClick={() => onProjectReady(completedTargetDir)}
            >
              Go to Guardrails →
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function NewProjectTab({ onProjectReady }: { onProjectReady: (targetDir: string) => void }) {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to set up a new project folder here.">
      {(settings) => <NewProjectForm settings={settings} onProjectReady={onProjectReady} />}
    </DaemonGate>
  );
}
