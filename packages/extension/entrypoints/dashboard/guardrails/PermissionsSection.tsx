import { useState } from 'react';
import { KNOWN_RISKY_PATTERNS, type ClaudeConfigSnapshot, type PermissionEffect, type SettingsLayer } from '@headroom/shared';
import { findInLayer, matchesQuery, resolveEffective } from '../../../lib/guardrails.js';
import { effectIcon, effectLabel, EFFECTS } from './effect-ui.tsx';

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

export function PermissionsSection({
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
  unprotectedCount,
  bulkApplying,
  onApplyAllRecommended,
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
  unprotectedCount: number;
  bulkApplying: boolean;
  onApplyAllRecommended: () => void;
}) {
  const [ruleFilter, setRuleFilter] = useState('');
  const [knownFilter, setKnownFilter] = useState('');
  const knownMatches = KNOWN_RISKY_PATTERNS.filter((known) => matchesQuery(knownFilter, known.label, known.pattern, known.description));
  const bulkDisabled = bulkApplying || Boolean(busyPattern) || unprotectedCount === 0;

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

      <div className="card-header">
        <p className="table-title" style={{ margin: 0 }}>
          Known risky commands
        </p>
        {projectDir && (
          <button type="button" className="btn" disabled={bulkDisabled} onClick={onApplyAllRecommended}>
            {bulkApplying ? 'Applying…' : `Apply recommended protections${unprotectedCount > 0 ? ` (${unprotectedCount})` : ''}`}
          </button>
        )}
      </div>

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
            <button type="submit" className="btn btn-primary" disabled={bulkApplying}>
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
                const isBusy = busyPattern === known.pattern || bulkApplying;
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
