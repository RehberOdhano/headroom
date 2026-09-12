import { useState } from 'react';
import type { Settings } from '../../../lib/protocol.js';
import { CliOverview, RECENT_DAYS } from './CliOverview.tsx';
import { PatternsContent } from './PatternsContent.tsx';
import { TopUsageContent } from './TopUsageContent.tsx';

type CliSubView = 'overview' | 'top' | 'patterns';
const CLI_SUBVIEWS: { key: CliSubView; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'top', label: 'Top usage' },
  { key: 'patterns', label: 'Patterns' },
];

/**
 * One card, one header, one segmented sub-nav (same pattern as the History window selector on
 * the Usage & Forecast tab) — replaces three separately-headed, always-stacked cards
 * (totals+tables, leaderboards, skill/command/subagent patterns) that had grown tall enough to
 * bury each other in scroll. All three sub-views stay mounted and are toggled via `hidden`, the
 * same "don't lose state / don't refetch on switch" approach the top-level tabs already use.
 */
export function CliAttributionPanel({ settings }: { settings: Settings }) {
  const [view, setView] = useState<CliSubView>('overview');

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">CLI attribution</h2>
        <span className="card-stat">last {RECENT_DAYS} days</span>
      </div>

      <div className="segmented" role="group" aria-label="CLI attribution view">
        {CLI_SUBVIEWS.map((subview) => (
          <button
            key={subview.key}
            type="button"
            aria-pressed={view === subview.key}
            onClick={() => setView(subview.key)}
          >
            {subview.label}
          </button>
        ))}
      </div>

      <div hidden={view !== 'overview'}>
        <CliOverview settings={settings} />
      </div>
      <div hidden={view !== 'top'}>
        <TopUsageContent settings={settings} />
      </div>
      <div hidden={view !== 'patterns'}>
        <PatternsContent settings={settings} />
      </div>
    </section>
  );
}
