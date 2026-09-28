import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import type { ExtraCreditsInfo, LimitBar } from '@headroom/shared';
import { db } from '../../lib/db.js';
import { extensionMessenger } from '../../lib/messaging.js';
import { barColor, describeSource, formatPercent, formatResetLabel } from '../../lib/format.js';
import { barHistory } from '../../lib/history.js';
import { summarizeHeadroom, type Headline } from '../../lib/headline.js';

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
  empty: { fontSize: '0.85rem', color: '#4b5563', lineHeight: 1.4 },
  updated: { fontSize: '0.75rem', color: '#6b7280', marginTop: 4 },
  historyLink: { fontSize: '0.75rem', marginTop: 4, display: 'inline-block' },
  headline: { fontSize: '0.85rem', fontWeight: 600, lineHeight: 1.35, margin: '0 0 0.75rem', padding: '0.5rem 0.6rem', borderRadius: 6 } as const,
  extraCredits: { marginTop: 4, marginBottom: 12 },
  extraCreditsAmount: { fontSize: '0.75rem', color: '#6b7280', margin: '2px 0 0' },
  emptyButton: {
    display: 'inline-block',
    marginTop: 10,
    padding: '0.4rem 0.75rem',
    background: '#3b82f6',
    color: '#fff',
    borderRadius: 6,
    fontSize: '0.8rem',
    fontWeight: 600,
    textDecoration: 'none',
  } as const,
  ratingPrompt: { fontSize: '0.75rem', color: '#4b5563', margin: '0 0 0.75rem' },
} as const;

const USAGE_SETTINGS_URL = 'https://claude.ai/settings/usage';
const STORE_URL = 'https://chromewebstore.google.com/detail/chjbjdabpficejgogljohhlobfaehepl';
const RATING_PROMPT_KEY = 'ratingPromptShown';

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

// Never color-only: each tone also carries a leading symbol so it reads without color vision.
const HEADLINE_STYLES: Record<Headline['tone'], { symbol: string; background: string; color: string }> = {
  ok: { symbol: '✓ ', background: '#ecfdf5', color: '#065f46' },
  warn: { symbol: '⚠ ', background: '#fffbeb', color: '#92400e' },
  alert: { symbol: '⛔ ', background: '#fef2f2', color: '#991b1b' },
};

function HeadlineBanner({ headline }: { headline: Headline }) {
  const tone = HEADLINE_STYLES[headline.tone];
  return (
    <p role="status" style={{ ...styles.headline, background: tone.background, color: tone.color }}>
      {tone.symbol}
      {headline.text}
    </p>
  );
}

function Bar({ title, bar }: { title: string; bar: LimitBar }) {
  return (
    <div>
      <div style={styles.label}>
        <span>{title}</span>
        <span>
          {formatPercent(bar.percent)}% · resets {formatResetLabel(bar.resetsAt)}
        </span>
      </div>
      <div
        style={styles.track}
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bar.percent)}
      >
        <div
          style={{
            width: `${Math.min(100, Math.max(0, bar.percent))}%`,
            height: '100%',
            background: barColor(bar.severity),
          }}
        />
      </div>
    </div>
  );
}

// Cap how much history the popup pulls for its inline forecast — it only needs the current
// run (since the last reset), not the full 90-day retention window the dashboard charts.
const POPUP_HISTORY_LIMIT = 100;

export default function App() {
  const latest = useLiveQuery(() => db.limitSnapshots.orderBy('capturedAt').last(), []);
  // Same signal the options page's setup checklist uses for its "Opened Settings → Usage" step —
  // lets the empty state tell "haven't visited yet" apart from "account detected, first snapshot
  // just hasn't landed yet", instead of repeating the same instruction to someone who already
  // did it (confusing enough that it's read as the extension being stuck).
  const visitedClaudeAi = useLiveQuery(async () => Boolean(await db.meta.get('orgId')), []);
  const recentSnapshots = useLiveQuery(
    () => db.limitSnapshots.orderBy('capturedAt').reverse().limit(POPUP_HISTORY_LIMIT).toArray(),
    [],
  );
  const [refreshing, setRefreshing] = useState(false);
  const [showRating, setShowRating] = useState(false);
  const sessionHistory = barHistory(recentSnapshots ?? [], 'session');
  const weeklyHistory = barHistory(recentSnapshots ?? [], 'weekly');
  const headline = latest
    ? summarizeHeadroom([
        { title: 'Session', bar: latest.session, history: sessionHistory },
        { title: 'Weekly', bar: latest.weekly, history: weeklyHistory },
      ])
    : null;

  // Ask the background worker for a fresh /usage snapshot every time the popup opens, rather
  // than showing whatever happened to be captured last (which, before the background poll
  // existed, meant only ever updating when you visited claude.ai's Settings > Usage page).
  useEffect(() => {
    void refresh();
  }, []);

  // Ask for a rating right after the forecast has just proven itself useful — the first time it
  // warns of a limit before it's hit — rather than at a random moment. One-time: once fired, it's
  // marked seen immediately so it never appears again, whether or not the user clicks through.
  useEffect(() => {
    if (headline?.tone !== 'warn') return;
    void (async () => {
      if (await db.meta.get(RATING_PROMPT_KEY)) return;
      await db.meta.put({ key: RATING_PROMPT_KEY, value: 'true' });
      setShowRating(true);
    })();
  }, [headline?.tone]);

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
          {/* Only when something needs attention — "all clear" just repeats what the bars show. */}
          {headline && headline.tone !== 'ok' && <HeadlineBanner headline={headline} />}
          {showRating && (
            <p style={styles.ratingPrompt}>
              Glad this caught it early —{' '}
              <a href={STORE_URL} target="_blank" rel="noreferrer">
                rate headroom on the Chrome Web Store
              </a>
              ?
            </p>
          )}
          {latest.session && <Bar title="Session (5h)" bar={latest.session} />}
          {latest.weekly && <Bar title="Weekly" bar={latest.weekly} />}
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
      ) : visitedClaudeAi ? (
        <div>
          <p style={styles.empty}>
            Account detected — the first usage snapshot hasn't landed yet. This is usually quick;
            try Refresh above in a moment.
          </p>
          <p style={styles.updated}>
            <a href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
              Setup checklist
            </a>
          </p>
        </div>
      ) : (
        <div>
          <p style={styles.empty}>
            No usage data yet. Open claude.ai → Settings → Usage once to start tracking — the extension
            can't find your account until then.
          </p>
          <a style={styles.emptyButton} href={USAGE_SETTINGS_URL} target="_blank" rel="noreferrer">
            Open Settings → Usage
          </a>
          <p style={styles.updated}>
            <a href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
              Setup checklist
            </a>
          </p>
        </div>
      )}
    </main>
  );
}
