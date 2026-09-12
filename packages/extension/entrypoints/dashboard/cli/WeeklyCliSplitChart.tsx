function formatWeekLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One bar per calendar week: CLI-estimated share (bottom, accent) vs. remainder — chat usage
 *  plus estimation noise (top, muted) — of that week's total weekly-bar movement. Same "rough
 *  estimate" framing as the existing reconciliation stat, just sliced by week instead of
 *  aggregated over the whole window. */
export function WeeklyCliSplitChart({ data }: { data: { weekStart: string; totalPercentDelta: number; cliPercent: number }[] }) {
  const maxTotal = Math.max(...data.map((w) => w.totalPercentDelta), 1);

  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div className="stacked-bar-chart">
        {data.map((week) => {
          const cliHeight = (week.cliPercent / maxTotal) * 100;
          const otherPercent = Math.max(0, week.totalPercentDelta - week.cliPercent);
          const otherHeight = (otherPercent / maxTotal) * 100;
          return (
            <div
              key={week.weekStart}
              className="stacked-bar-col"
              title={`Week of ${week.weekStart}: ~${Math.round(week.cliPercent)}% CLI, ~${Math.round(otherPercent)}% chat/other of ${Math.round(week.totalPercentDelta)}% total`}
            >
              <div className="stacked-bar">
                <div className="stacked-bar-segment stacked-bar-other" style={{ height: `${otherHeight}%` }} />
                <div className="stacked-bar-segment stacked-bar-cli" style={{ height: `${cliHeight}%` }} />
              </div>
              <span className="stacked-bar-label">{formatWeekLabel(week.weekStart)}</span>
            </div>
          );
        })}
      </div>
      <div className="stacked-bar-legend">
        <span>
          <span className="legend-swatch legend-swatch-cli" /> CLI (est.)
        </span>
        <span>
          <span className="legend-swatch legend-swatch-other" /> Chat + other
        </span>
      </div>
    </div>
  );
}
