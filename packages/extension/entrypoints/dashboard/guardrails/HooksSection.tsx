import { useState } from 'react';
import type { HookEntry } from '@headroom/shared';
import { matchesQuery } from '../../../lib/guardrails.js';

export function HooksSection({ hooks }: { hooks: HookEntry[] }) {
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
