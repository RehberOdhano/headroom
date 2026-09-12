import { useState } from 'react';
import type { AgentDefinition } from '@headroom/shared';
import { updateDaemonAgentModel } from '../../../lib/daemon-client.js';
import { matchesQuery } from '../../../lib/guardrails.js';
import type { Settings } from '../../../lib/protocol.js';

const MODEL_PRESETS = ['inherit', 'opus', 'sonnet', 'haiku'];

function presetOrCustom(model: string | null): string {
  return model && MODEL_PRESETS.includes(model) ? model : 'custom';
}

/**
 * Subagent model routing — the concrete answer to "opus for planning, sonnet for most things,
 * haiku for quick tasks": each subagent type's `model:` frontmatter field
 * (`packages/daemon/src/adapters/claude-config.ts`'s `readAgentDefinitions`/`writeAgentModel`).
 * Only project-scope agents are editable — global ones (`scope: 'global'`) are shown read-only,
 * the same restraint already applied to permission overrides (this daemon never writes to
 * config outside the one project it's been told about). Deliberately doesn't show per-agent
 * cost here — that lives in CLI Attribution's "Skills, commands & subagents" table, which
 * aggregates usage across *every* project rather than just this one, so merging the two would
 * mean reconciling two different scopes; a pointer is enough.
 */
export function AgentsSection({
  agents,
  projectDir,
  settings,
  onUpdated,
}: {
  agents: AgentDefinition[];
  projectDir: string | undefined;
  settings: Settings;
  onUpdated: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [customModelPath, setCustomModelPath] = useState<string | null>(null);
  const [customModelDraft, setCustomModelDraft] = useState('');

  const matches = agents.filter((agent) => matchesQuery(filter, agent.name, agent.description, agent.model));

  async function applyModel(agent: AgentDefinition, model: string): Promise<void> {
    const trimmed = model.trim();
    if (!projectDir || !trimmed) return;
    setBusyPath(agent.path);
    try {
      await updateDaemonAgentModel(settings, { projectDir, path: agent.path, model: trimmed });
      onUpdated();
    } finally {
      setBusyPath(null);
      setCustomModelPath(null);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Subagents</h2>
        {agents.length > 0 && <span className="card-stat">{agents.length}</span>}
      </div>
      {agents.length === 0 ? (
        <p className="hint">No subagents found for this project or your global config.</p>
      ) : (
        <>
          <input
            className="search-input filter-input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name, description, or model…"
          />
          {matches.length === 0 ? (
            <p className="hint">No subagents match "{filter}".</p>
          ) : (
            <div className="skills-scroll scroll-box">
              {matches.map((agent) => {
                const editable = agent.scope === 'project' && Boolean(projectDir);
                const isBusy = busyPath === agent.path;
                return (
                  <div key={agent.path} className="result-card">
                    <p className="warning-title" style={{ fontFamily: 'inherit', fontWeight: 650 }}>
                      {agent.name} {agent.scope === 'global' && <span className="hint">(global — read-only)</span>}
                    </p>
                    <p className="result-meta">{agent.description}</p>
                    {!editable ? (
                      <p className="result-meta">Model: {agent.model ?? 'default'}</p>
                    ) : (
                      <div className="result-actions">
                        <div className="select-wrap" style={{ flex: '0 0 140px' }}>
                          <select
                            className="search-input"
                            value={presetOrCustom(agent.model)}
                            disabled={isBusy}
                            onChange={(event) => {
                              const value = event.target.value;
                              if (value === 'custom') {
                                setCustomModelPath(agent.path);
                                setCustomModelDraft(agent.model ?? '');
                              } else {
                                void applyModel(agent, value);
                              }
                            }}
                          >
                            {MODEL_PRESETS.map((preset) => (
                              <option key={preset} value={preset}>
                                {preset}
                              </option>
                            ))}
                            <option value="custom">Custom…</option>
                          </select>
                        </div>
                        {customModelPath === agent.path && (
                          <form
                            className="search-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void applyModel(agent, customModelDraft);
                            }}
                          >
                            <input
                              className="search-input"
                              value={customModelDraft}
                              onChange={(event) => setCustomModelDraft(event.target.value)}
                              placeholder="e.g. claude-opus-4-6"
                            />
                            <button type="submit" className="btn btn-primary" disabled={isBusy || !customModelDraft.trim()}>
                              Set
                            </button>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
        See CLI Attribution → "Skills, commands &amp; subagents" for how much each subagent type
        has actually cost you, across every project.
      </p>
    </section>
  );
}
