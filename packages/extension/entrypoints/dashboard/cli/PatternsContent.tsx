import { useEffect, useState } from 'react';
import type { UsagePatterns } from '@headroom/shared';
import { getDaemonUsagePatterns, type DaemonResult } from '../../../lib/daemon-client.js';
import { formatTokens } from '../../../lib/format.js';
import type { Settings } from '../../../lib/protocol.js';
import { RECENT_DAYS } from './CliOverview.tsx';

function NamedCountTable({ rows }: { rows: { name: string; count: number }[] }) {
  return (
    <div className="table-wrap" style={{ marginBottom: 'var(--space-4)' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Uses</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Skills, slash commands, and subagents actually used — counted server-side from raw session
 *  transcripts (packages/daemon/src/adapters/usage-patterns.ts), never conversation content.
 *  The "Patterns" sub-view of `CliAttributionPanel`. Unlike the other two sub-views this isn't
 *  windowed to `RECENT_DAYS` — `/usage/patterns` has no `?since` support (it scans every session
 *  file) — flagged explicitly rather than implying the same 30-day scope as its siblings. */
export function PatternsContent({ settings }: { settings: Settings }) {
  const [patterns, setPatterns] = useState<DaemonResult<UsagePatterns> | null>(null);

  useEffect(() => {
    void getDaemonUsagePatterns(settings).then(setPatterns);
  }, [settings.daemonUrl, settings.daemonToken]);

  if (!patterns?.ok) return null;
  const { skills, commands, agents, mcpServers } = patterns.data;
  if (skills.length === 0 && commands.length === 0 && agents.length === 0 && mcpServers.length === 0) {
    return <p className="hint">No skill, slash-command, subagent, or MCP usage recorded yet.</p>;
  }

  return (
    <>
      <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
        All-time — not limited to the last {RECENT_DAYS} days like the other tabs here.
      </p>

      {skills.length > 0 && (
        <>
          <p className="table-title">Skills</p>
          <NamedCountTable rows={skills} />
        </>
      )}

      {commands.length > 0 && (
        <>
          <p className="table-title">Slash commands</p>
          <NamedCountTable rows={commands} />
        </>
      )}

      {mcpServers.length > 0 && (
        <>
          <p className="table-title">MCP servers</p>
          <NamedCountTable rows={mcpServers} />
        </>
      )}

      {agents.length > 0 && (
        <>
          <p className="table-title">Subagents (tokens only — no per-agent cost, see hint below)</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Subagent type</th>
                  <th>Invocations</th>
                  <th>Input tokens</th>
                  <th>Output tokens</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.subagentType}>
                    <td>{agent.subagentType}</td>
                    <td>{agent.count}</td>
                    <td>{formatTokens(agent.inputTokens)}</td>
                    <td>{formatTokens(agent.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            No dollar cost shown here — per-model pricing lives inside ccusage, which this table
            doesn't depend on, so it stays tokens-only rather than guessing at pricing.
          </p>
        </>
      )}
    </>
  );
}
