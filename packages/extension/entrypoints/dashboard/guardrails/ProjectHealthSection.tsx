import { useEffect, useState } from 'react';
import type { KnownProject } from '@headroom/shared';
import { getDaemonClaudeMdList, getDaemonConfig } from '../../../lib/daemon-client.js';
import { matchesQuery } from '../../../lib/guardrails.js';
import type { Settings } from '../../../lib/protocol.js';

interface ProjectHealthRow {
  hasClaudeMd: boolean | null;
  hasProjectSettings: boolean | null;
  hasLocalOverrides: boolean | null;
  hookCount: number | null;
  skillCount: number | null;
}

function healthCell(value: boolean | null | undefined): string {
  if (value === undefined) return '…';
  if (value === null) return '—';
  return value ? '✓' : '✗';
}

/**
 * Cross-project checklist: does each project the daemon has seen have a CLAUDE.md, a project
 * `settings.json`, any hooks/skills, any local overrides? Pure composition of routes the daemon
 * already serves (`getDaemonConfig`, `getDaemonClaudeMdList`) — one pair of calls per known
 * project, run in parallel since these are cheap local filesystem reads. Local overrides are
 * shown as information, not a red flag — they're a supported, expected thing
 * (`.claude/settings.local.json`), not a misconfiguration.
 */
export function ProjectHealthSection({
  settings,
  projects,
  onSelectProject,
}: {
  settings: Settings;
  projects: KnownProject[];
  onSelectProject: (path: string) => void;
}) {
  const [rows, setRows] = useState<Record<string, ProjectHealthRow>>({});
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRows({});
    for (const project of projects) {
      void Promise.all([getDaemonConfig(settings, project.path), getDaemonClaudeMdList(settings, project.path)]).then(
        ([snapshot, mdList]) => {
          if (cancelled) return;
          setRows((current) => ({
            ...current,
            [project.path]: {
              hasClaudeMd: mdList.ok ? mdList.data.files.length > 0 : null,
              hasProjectSettings: snapshot.ok ? Boolean(snapshot.data.project?.exists) : null,
              hasLocalOverrides: snapshot.ok ? Boolean(snapshot.data.local?.exists) : null,
              hookCount: snapshot.ok ? snapshot.data.hooks.length : null,
              skillCount: snapshot.ok ? snapshot.data.skills.length : null,
            },
          }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.daemonUrl, settings.daemonToken, projects]);

  if (projects.length === 0) return null;

  const matches = projects.filter((project) => matchesQuery(filter, project.path));

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Project health</h2>
        <span className="card-stat">
          {projects.length} known project{projects.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="hint">Claude Code setup across every project this daemon has seen local session activity for.</p>
      {projects.length > 1 && (
        <input
          className="search-input filter-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by project path…"
        />
      )}
      {matches.length === 0 ? (
        <p className="hint">No projects match "{filter}".</p>
      ) : (
        <div className="table-wrap project-health-scroll scroll-box">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>CLAUDE.md</th>
                <th>Project settings</th>
                <th>Hooks</th>
                <th>Skills</th>
                <th>Local overrides</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((project) => {
                const row = rows[project.path];
                return (
                  <tr key={project.path}>
                    <td>
                      <button type="button" className="btn" onClick={() => onSelectProject(project.path)}>
                        {project.path}
                      </button>
                    </td>
                    <td>{healthCell(row?.hasClaudeMd)}</td>
                    <td>{healthCell(row?.hasProjectSettings)}</td>
                    <td>{row ? (row.hookCount ?? '—') : '…'}</td>
                    <td>{row ? (row.skillCount ?? '—') : '…'}</td>
                    <td>{row ? (row.hasLocalOverrides ? 'yes' : '—') : '…'}</td>
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
