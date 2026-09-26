import type { Settings } from '../../../lib/protocol.js';
import { CliOverview, RECENT_DAYS } from './CliOverview.tsx';

/** One card: token totals, per-project and per-model tables, and the CLI-vs-chat split. */
export function CliAttributionPanel({ settings }: { settings: Settings }) {
  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">CLI attribution</h2>
        <span className="card-stat">last {RECENT_DAYS} days</span>
      </div>

      <CliOverview settings={settings} />
    </section>
  );
}
