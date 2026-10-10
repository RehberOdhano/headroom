import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useState } from 'react';
import { computeSafePace, detectBurnRateAnomaly, forecastBurnRate, type TimedPercent } from '@headroom/shared';
import { db, type LimitSnapshotRecord } from '../../lib/db.js';
import {
  barColor,
  describeForecast,
  describeSafePace,
  describeSource,
  formatPercent,
  formatResetLabel,
} from '../../lib/format.js';
import { sparklinePointsAttr, toSparklinePoints } from '../../lib/chart.js';
import { barHistory, withinWindow, type BarKey } from '../../lib/history.js';
import { formatUpdatedAgo, PROVENANCE_LABEL } from '../../lib/provenance.js';
import { DEFAULT_SETTINGS, getSettings } from '../../lib/settings.js';
import { formatUsageInspectorFindings, loadUsageInspector } from '../../lib/usage-inspector.js';
import type { Settings } from '../../lib/protocol.js';
import { CliTab, SearchTab } from './Cli.tsx';
import { ReleaseNotesBanner } from './UsageExtras.tsx';

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const;
type WindowKey = keyof typeof WINDOWS;

// Labels reflect the user's own mental model (Overview / Activity / Sessions) rather than
// implementation history (`charts`/`cli`/`search` as literal tab keys, kept as-is since they're
// also DOM ids and test selectors — only the user-visible label changed). Usage Inspector's
// trigger-and-result stays inside Overview rather than splitting across Overview/Activity as a
// first pass at this IA sketched — a self-contained "click Inspect, see the answer right there"
// beat passing state between tabs for a result that's only ever about one specific bar.
// Guardrails and New Project (Claude Code configuration management / project scaffolding) were
// removed from this product in the 0.3.0 split — Headroom is usage-observability only now; see
// git history for that implementation if it's ever extracted into its own product.
const TABS = [
  { key: 'charts', label: 'Overview', needsDaemon: false },
  { key: 'cli', label: 'Activity', needsDaemon: false },
  { key: 'search', label: 'Sessions', needsDaemon: true },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function formatAxisDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Sparkline({ series, thresholds }: { series: TimedPercent[]; thresholds: number[] }) {
  if (series.length < 2) {
    return <p className="chart-empty">Not enough history yet in this window — keep the extension open over time.</p>;
  }
  const points = toSparklinePoints(series);
  const linePoints = sparklinePointsAttr(points);
  const areaPoints = `0,100 ${linePoints} 100,100`;
  const gradientId = 'headroom-chart-fill';

  return (
    <>
      <div className="chart-row">
        <div className="chart-y-labels">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div className="chart-svg-wrap">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="chart-svg">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line x1="0" y1="0" x2="100" y2="0" className="chart-gridline" />
            <line x1="0" y1="25" x2="100" y2="25" className="chart-gridline" />
            <line x1="0" y1="50" x2="100" y2="50" className="chart-gridline" />
            <line x1="0" y1="75" x2="100" y2="75" className="chart-gridline" />
            <line x1="0" y1="100" x2="100" y2="100" className="chart-gridline" />
            {thresholds
              .filter((t) => t > 0 && t < 100)
              .map((t) => (
                <line key={t} x1="0" y1={100 - t} x2="100" y2={100 - t} className="chart-threshold" />
              ))}
            <polygon points={areaPoints} fill={`url(#${gradientId})`} stroke="none" />
            <polyline
              points={linePoints}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.75"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>
      <div className="chart-x-labels">
        <span>{formatAxisDate(series[0]!.capturedAt)}</span>
        <span>{formatAxisDate(series[series.length - 1]!.capturedAt)}</span>
      </div>
    </>
  );
}

/** claude.ai's own "Usage credits" spend (`/usage`'s `extra_usage`) — pay-as-you-go spend this
 *  month against a monthly $ limit. Hidden entirely for accounts that don't have it enabled. */
function UsageCreditsSection({ snapshots }: { snapshots: LimitSnapshotRecord[] }) {
  // No captured snapshot has extra-credits info at all -> most accounts don't have pay-as-you-go
  // credits enabled. Its fields can otherwise be individually null even when present, so the
  // render below branches on which ones are actually populated.
  const info = [...snapshots].reverse().find((s) => s.extraCredits)?.extraCredits;
  if (!info) return null;

  const hasAmounts = info != null && info.usedAmount !== null && info.limitAmount !== null;
  const amountsText = hasAmounts ? `${info.currency ?? ''} ${info.usedAmount!.toFixed(2)} / ${info.limitAmount!.toFixed(2)}` : null;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Usage credits</h2>
      </div>

      {info && (
        <>
          <p className="table-title">Spent this month</p>
          {info.percent !== null ? (
            <div className="progress-row">
              <span className="progress-percent">{formatPercent(info.percent)}%</span>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, info.percent))}%`, background: 'var(--color-accent)' }}
                />
              </div>
              {amountsText && <span className="progress-meta">{amountsText}</span>}
            </div>
          ) : amountsText ? (
            <p className="hint">{amountsText} spent — percent not reported yet.</p>
          ) : (
            <p className="hint">Enabled on your plan, but no usage reported yet.</p>
          )}
        </>
      )}

    </section>
  );
}

/**
 * Loaded on demand (click "Inspect →"), never automatically — this is the one place the Usage &
 * Forecast tab reaches the daemon at all, and only when both an anomaly fired AND someone asked
 * to see why. Window is the anomalous run's own start (`anomaly.runStartedAt`) through now.
 */
function UsageInspectorPanel({ windowStart, settings }: { windowStart: string; settings: Settings }) {
  const [expanded, setExpanded] = useState(false);
  // A fetch failure (daemon unreachable, token rejected, etc.) is kept distinct from a loaded,
  // genuinely-empty result — both coercing to `[]` would render the same silent, blank panel,
  // indistinguishable from the inspector simply being broken.
  const [lines, setLines] = useState<string[] | 'loading' | 'unavailable'>('loading');

  async function inspect() {
    setExpanded(true);
    const result = await loadUsageInspector(settings, windowStart, new Date().toISOString());
    setLines(result ? formatUsageInspectorFindings(result) : 'unavailable');
  }

  if (!expanded) {
    return (
      <button type="button" className="btn" onClick={() => void inspect()}>
        Inspect →
      </button>
    );
  }

  return (
    <div title={PROVENANCE_LABEL.derived}>
      {lines === 'loading' ? (
        <p className="hint">Looking at local activity since {new Date(windowStart).toLocaleString()}…</p>
      ) : lines === 'unavailable' ? (
        <p className="hint">Couldn&rsquo;t reach the daemon to look up local activity for this period.</p>
      ) : (
        lines.map((line) => (
          <p key={line} className="hint">
            {line}
          </p>
        ))
      )}
    </div>
  );
}

function BarSection({
  title,
  barKey,
  snapshots,
  thresholds,
  settings,
}: {
  title: string;
  barKey: BarKey;
  snapshots: LimitSnapshotRecord[];
  thresholds: number[];
  settings: Settings | undefined;
}) {
  const series = barHistory(snapshots, barKey);
  const latestSnapshot = [...snapshots].reverse().find((s) => s[barKey]) ?? null;
  const latestBar = latestSnapshot?.[barKey] ?? null;
  const burnRate = forecastBurnRate(series);
  const forecast = latestBar ? describeForecast(burnRate, latestBar.resetsAt, latestBar.percent) : null;
  const safePaceText = latestBar ? describeSafePace(computeSafePace(latestBar.percent, latestBar.resetsAt, burnRate)) : null;
  const anomaly = latestBar ? detectBurnRateAnomaly(series, new Date(), latestBar.resetsAt) : null;
  const low = series.length > 0 ? Math.min(...series.map((p) => p.percent)) : null;
  const high = series.length > 0 ? Math.max(...series.map((p) => p.percent)) : null;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
        {low !== null && high !== null && (
          <span className="card-stat">
            low {formatPercent(low)}% · high {formatPercent(high)}%
          </span>
        )}
      </div>

      {latestBar && (
        <div className="progress-row">
          <span className="progress-percent" title={PROVENANCE_LABEL.server} style={{ color: barColor(latestBar.severity) }}>
            {formatPercent(latestBar.percent)}%
          </span>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${Math.min(100, Math.max(0, latestBar.percent))}%`,
                background: barColor(latestBar.severity),
              }}
            />
          </div>
          <span className="progress-meta">
            resets {formatResetLabel(latestBar.resetsAt)}
            {latestSnapshot && ` · via ${describeSource(latestSnapshot.source)}`}
          </span>
        </div>
      )}

      {latestSnapshot && <p className="hint">Updated {formatUpdatedAgo(latestSnapshot.capturedAt)}</p>}

      <Sparkline series={series} thresholds={thresholds} />

      {latestBar && (
        <p className={`forecast-line ${forecast?.atRisk ? 'at-risk' : 'on-track'}`} title={PROVENANCE_LABEL.derived}>
          {forecast ? (
            <>
              {forecast.atRisk ? '⚠ ' : ''}
              {forecast.message}
            </>
          ) : (
            'Not enough recent data to forecast yet.'
          )}
        </p>
      )}

      {safePaceText && (
        <p className="hint" title={PROVENANCE_LABEL.derived}>
          {safePaceText}
        </p>
      )}

      {anomaly?.isAnomalous && (
        <>
          <p className="forecast-line at-risk" title={PROVENANCE_LABEL.derived}>
            ⚠ Usage is rising faster than its recent pattern.
            {anomaly.baselineMaturity === 'preliminary' ? ' (early pattern — based on limited history)' : ''}
          </p>
          {settings?.daemonUrl && settings?.daemonToken && (
            <UsageInspectorPanel windowStart={anomaly.runStartedAt} settings={settings} />
          )}
        </>
      )}
    </section>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('charts');
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  // Live (Dexie broadcasts writes across extension contexts), so a daemon that pairs while this
  // page is open reveals the CLI tabs without a reload.
  const settings = useLiveQuery(() => getSettings(), []);
  const alertThresholds = settings?.alertThresholds ?? DEFAULT_SETTINGS.alertThresholds;
  const daemonConnected = Boolean(settings?.daemonUrl && settings?.daemonToken);
  // Progressive disclosure: until the daemon is connected, only the tabs that work without it
  // (plus "CLI Attribution", which doubles as the install prompt) are shown.
  const visibleTabs = TABS.filter((tab) => daemonConnected || !tab.needsDaemon);
  const allSnapshots = useLiveQuery(() => db.limitSnapshots.orderBy('capturedAt').toArray(), []);

  // WAI-ARIA tabs: arrow keys move between tabs (roving tabindex), Home/End jump to the ends.
  function onTabKeyDown(event: React.KeyboardEvent) {
    const keys = visibleTabs.map((t) => t.key as TabKey);
    const current = keys.indexOf(activeTab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % keys.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + keys.length) % keys.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = keys.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(keys[next]!);
    document.getElementById(`tab-${keys[next]}`)?.focus();
  }

  const windowed = allSnapshots ? withinWindow(allSnapshots, new Date(Date.now() - WINDOWS[windowKey])) : [];

  return (
    <main className="page">
      <div className="page-header">
        <img className="page-icon" src={browser.runtime.getURL('/icon/48.png')} alt="" />
        <h1 className="page-title">Claude usage dashboard</h1>
      </div>
      <p className="page-subtitle">
        Session/weekly limits, CLI attribution, and session search — all from local data, nothing leaves this machine.
      </p>

      {/* All three panels stay mounted, toggled via `hidden` rather than conditionally rendered,
          so switching tabs doesn't lose the search box's query/results or refetch daemon data
          every time you glance at another tab. */}
      <ReleaseNotesBanner />

      <nav className="tabs" role="tablist" aria-label="Dashboard sections" onKeyDown={onTabKeyDown}>
        {visibleTabs.map((tab) => (
          <Fragment key={tab.key}>
            <button
              type="button"
              role="tab"
              id={`tab-${tab.key}`}
              aria-controls={`panel-${tab.key}`}
              aria-selected={activeTab === tab.key}
              tabIndex={activeTab === tab.key ? 0 : -1}
              className="tab-button"
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          </Fragment>
        ))}
      </nav>

      <div hidden={activeTab !== 'charts'} role="tabpanel" id="panel-charts" aria-labelledby="tab-charts">
        {allSnapshots === undefined ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <div className="segmented" role="group" aria-label="History window">
              {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
                <button key={key} type="button" aria-pressed={key === windowKey} onClick={() => setWindowKey(key)}>
                  {key}
                </button>
              ))}
            </div>

            {windowed.length === 0 ? (
              <p className="hint">No snapshots captured in this window yet.</p>
            ) : (
              <div className="grid-2">
                <BarSection title="Session (5h)" barKey="session" snapshots={windowed} thresholds={alertThresholds} settings={settings} />
                <BarSection title="Weekly" barKey="weekly" snapshots={windowed} thresholds={alertThresholds} settings={settings} />
              </div>
            )}

            <UsageCreditsSection snapshots={allSnapshots} />

            <p className="page-footer">
              {allSnapshots.length} snapshot{allSnapshots.length === 1 ? '' : 's'} stored locally
              {allSnapshots[0] && `, oldest from ${new Date(allSnapshots[0].capturedAt).toLocaleString()}`}. Forecasts are a
              simple linear projection over the current run since the last reset — treat them as a rough heads-up, not a
              guarantee.
            </p>
          </>
        )}
      </div>

      <div hidden={activeTab !== 'cli'} role="tabpanel" id="panel-cli" aria-labelledby="tab-cli">
        <CliTab key={String(daemonConnected)} />
      </div>

      {daemonConnected && (
        <div hidden={activeTab !== 'search'} role="tabpanel" id="panel-search" aria-labelledby="tab-search">
          <SearchTab />
        </div>
      )}
    </main>
  );
}
