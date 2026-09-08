import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { forecastBurnRate, type ExtraCreditsInfo, type LimitBar } from '@headroom/shared';
import { db } from '../../lib/db.js';
import { extensionMessenger } from '../../lib/messaging.js';
import { barColor, describeForecast, describeSource, formatPercent, formatResetLabel } from '../../lib/format.js';
import { barHistory } from '../../lib/history.js';

const styles = {
  main: { fontFamily: 'system-ui, sans-serif', padding: '1rem', width: 260 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  heading: { fontSize: '1rem', margin: '0 0 0.75rem' },
  refreshButton: {
    fontSize: '0.75rem',
    background: 'none',
    border: 'none',
    color: '#3b82f6',
    cursor: 'pointer',
    padding: 0,
  } as const,
  label: { display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' },
  track: {
    background: '#e5e7eb',
    borderRadius: 4,
    height: 8,
    marginTop: 4,
    marginBottom: 12,
    overflow: 'hidden',
  } as const,
  empty: { fontSize: '0.85rem', color: '#666', lineHeight: 1.4 },
  updated: { fontSize: '0.75rem', color: '#999', marginTop: 4 },
  forecast: { fontSize: '0.75rem', marginTop: -8, marginBottom: 12 },
  forecastAtRisk: { color: '#b45309' },
  forecastOnTrack: { color: '#999' },
  historyLink: { fontSize: '0.75rem', marginTop: 4, display: 'inline-block' },
  extraCredits: { marginTop: 4, marginBottom: 12 },
  extraCreditsAmount: { fontSize: '0.75rem', color: '#999', margin: '2px 0 0' },
} as const;

function ExtraCreditsRow({ info }: { info: ExtraCreditsInfo }) {
  return (
    <div style={styles.extraCredits}>
      <div style={styles.label}>
        <span>Extra credits</span>
        <span>{info.percent !== null ? `${Math.round(info.percent)}%` : '—'}</span>
      </div>
      {info.usedAmount !== null && info.limitAmount !== null && (
        <p style={styles.extraCreditsAmount}>
          {info.currency ?? ''} {info.usedAmount.toFixed(2)} / {info.limitAmount.toFixed(2)}
        </p>
      )}
    </div>
  );
}

function Bar({ title, bar, history }: { title: string; bar: LimitBar; history: ReturnType<typeof barHistory> }) {
  const forecast = describeForecast(forecastBurnRate(history), bar.resetsAt);
  return (
    <div>
      <div style={styles.label}>
        <span>{title}</span>
        <span>
          {formatPercent(bar.percent)}% · resets {formatResetLabel(bar.resetsAt)}
        </span>
      </div>
      <div style={styles.track}>
        <div
          style={{
            width: `${Math.min(100, Math.max(0, bar.percent))}%`,
            height: '100%',
            background: barColor(bar.severity),
          }}
        />
      </div>
      {forecast && (
        <p style={{ ...styles.forecast, ...(forecast.atRisk ? styles.forecastAtRisk : styles.forecastOnTrack) }}>
          {forecast.atRisk ? '⚠ ' : ''}
          {forecast.message}
        </p>
      )}
    </div>
  );
}

// Cap how much history the popup pulls for its inline forecast — it only needs the current
// run (since the last reset), not the full 90-day retention window the dashboard charts.
const POPUP_HISTORY_LIMIT = 100;

export default function App() {
  const latest = useLiveQuery(() => db.limitSnapshots.orderBy('capturedAt').last(), []);
  const recentSnapshots = useLiveQuery(
    () => db.limitSnapshots.orderBy('capturedAt').reverse().limit(POPUP_HISTORY_LIMIT).toArray(),
    [],
  );
  const [refreshing, setRefreshing] = useState(false);

  // Ask the background worker for a fresh /usage snapshot every time the popup opens, rather
  // than showing whatever happened to be captured last (which, before the background poll
  // existed, meant only ever updating when you visited claude.ai's Settings > Usage page).
  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await extensionMessenger.sendMessage('refreshUsage');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.headerRow}>
        <h1 style={styles.heading}>Claude usage</h1>
        <button type="button" style={styles.refreshButton} onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {latest ? (
        <>
          {latest.session && (
            <Bar title="Session (5h)" bar={latest.session} history={barHistory(recentSnapshots ?? [], 'session')} />
          )}
          {latest.weekly && (
            <Bar title="Weekly" bar={latest.weekly} history={barHistory(recentSnapshots ?? [], 'weekly')} />
          )}
          {!latest.session && !latest.weekly && (
            <p style={styles.empty}>Captured data, but no session/weekly bars in it yet.</p>
          )}
          {latest.extraCredits && <ExtraCreditsRow info={latest.extraCredits} />}
          <p style={styles.updated}>
            Last updated: {new Date(latest.capturedAt).toLocaleString()} via {describeSource(latest.source)}
          </p>
          <a
            style={styles.historyLink}
            href={browser.runtime.getURL('/dashboard.html')}
            target="_blank"
            rel="noreferrer"
          >
            View history & forecast →
          </a>
        </>
      ) : (
        <p style={styles.empty}>
          No usage data yet. Visit any claude.ai page once so the extension can find your
          account, then reopen this popup — it polls automatically after that.
        </p>
      )}
    </main>
  );
}
