import { useState } from 'react';
import type { ClaudeConfigSnapshot } from '@headroom/shared';
import { matchesQuery } from '../../../lib/guardrails.js';

export function SkillsSection({ skills }: { skills: ClaudeConfigSnapshot['skills'] }) {
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
