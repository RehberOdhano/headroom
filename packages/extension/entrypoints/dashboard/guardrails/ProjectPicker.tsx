import { useState } from 'react';
import type { KnownProject } from '@headroom/shared';

export function ProjectPicker({
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
