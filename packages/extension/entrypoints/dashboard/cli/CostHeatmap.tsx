import { useEffect, useState } from 'react';
import type { DaemonSessionsReport } from '@headroom/shared';
import { getDaemonSessions, type DaemonResult } from '../../../lib/daemon-client.js';
import { formatCcusageDate } from '../../../lib/format.js';
import { buildCostHeatmap, busiestHeatmapCell, DAY_LABELS, heatmapCell, maxHeatmapCost } from '../../../lib/heatmap.js';
import type { Settings } from '../../../lib/protocol.js';
import { RECENT_DAYS } from './CliOverview.tsx';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
// Every 3 hours, in 12-hour clock form — labeling all 24 columns would be unreadable at this
// cell size, same "endpoints/sparse labels only" call the Sparkline x-axis already makes.
const HOUR_LABEL_INTERVAL = 3;

function formatHourLabel(hour: number): string {
  const period = hour < 12 ? 'a' : 'p';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}${period}`;
}

/** Opacity for one cell's fill: a floor so even a small nonzero cost is still visibly a cell
 *  (not indistinguishable from empty), scaled linearly up to the busiest bucket. */
function cellOpacity(cost: number, max: number): number {
  if (max <= 0) return 0;
  return 0.15 + 0.8 * (cost / max);
}

/**
 * When do costly CLI sessions actually happen? A day-of-week × hour-of-day grid of CLI spend,
 * bucketed in the viewer's own local time (see `lib/heatmap.ts`'s doc comment on why this
 * attributes a whole session's cost to a single hour). The "By time of day" sub-view of
 * `CliAttributionPanel`, alongside Overview/Top usage/Patterns.
 */
export function CostHeatmap({ settings }: { settings: Settings }) {
  const [sessions, setSessions] = useState<DaemonResult<DaemonSessionsReport> | null>(null);

  useEffect(() => {
    const since = formatCcusageDate(new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000));
    void getDaemonSessions(settings, { since }).then(setSessions);
  }, [settings.daemonUrl, settings.daemonToken]);

  if (sessions && !sessions.ok) return <p className="error-text">{sessions.message}</p>;

  const cells = sessions?.ok ? buildCostHeatmap(sessions.data.sessions) : [];
  const max = maxHeatmapCost(cells);
  const busiest = busiestHeatmapCell(cells);

  if (sessions?.ok && cells.length === 0) {
    return <p className="hint">No CLI usage recorded yet in the last {RECENT_DAYS} days.</p>;
  }

  return (
    <>
      {busiest && (
        <p className="table-title">
          Priciest: {DAY_LABELS[busiest.dayOfWeek]} around {formatHourLabel(busiest.hour)} (${busiest.cost.toFixed(2)} across{' '}
          {busiest.sessionCount} session{busiest.sessionCount === 1 ? '' : 's'})
        </p>
      )}

      <div className="heatmap-wrap">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th scope="col" />
              {HOURS.map((hour) => (
                <th key={hour} scope="col" className="heatmap-hour-label">
                  {hour % HOUR_LABEL_INTERVAL === 0 ? formatHourLabel(hour) : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((label, dayOfWeek) => (
              <tr key={label}>
                <th scope="row" className="heatmap-day-label">
                  {label}
                </th>
                {HOURS.map((hour) => {
                  const cell = heatmapCell(cells, dayOfWeek, hour);
                  return (
                    <td
                      key={hour}
                      className="heatmap-cell"
                      style={cell ? { backgroundColor: 'var(--color-accent)', opacity: cellOpacity(cell.cost, max) } : undefined}
                      title={cell ? `${label} ${formatHourLabel(hour)} — $${cell.cost.toFixed(2)} across ${cell.sessionCount} session${cell.sessionCount === 1 ? '' : 's'}` : `${label} ${formatHourLabel(hour)} — no sessions`}
                      aria-label={cell ? `${label} ${formatHourLabel(hour)}, $${cell.cost.toFixed(2)}` : `${label} ${formatHourLabel(hour)}, no sessions`}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="heatmap-legend">
        <span>Less</span>
        {[0.15, 0.35, 0.55, 0.75, 0.95].map((opacity) => (
          <span key={opacity} className="heatmap-legend-swatch" style={{ backgroundColor: 'var(--color-accent)', opacity }} />
        ))}
        <span>More</span>
      </div>

      <p className="hint">
        Each session's full cost is attributed to the hour of its last activity — a rough proxy for when you tend to run
        costly sessions, not exact minute-by-minute attribution. Times shown are your local time zone.
      </p>
    </>
  );
}
