import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import type { ExtraCreditsInfo, LimitBar } from '@headroom/shared';
import { db } from '../../lib/db.js';
import { extensionMessenger } from '../../lib/messaging.js';
import { barColor, describeSource, formatPercent, formatResetLabel } from '../../lib/format.js';
import { barHistory } from '../../lib/history.js';
import { summarizeHeadroom, type Headline } from '../../lib/headline.js';
import { describeUsageAnomaly } from '../../lib/anomaly.js';
import { PROVENANCE_LABEL } from '../../lib/provenance.js';
import { AnomalyNotice } from '../components/AnomalyNotice.tsx';

const USAGE_SETTINGS_URL = 'https://claude.ai/settings/usage';
const STORE_URL = 'https://chromewebstore.google.com/detail/chjbjdabpficejgogljohhlobfaehepl';
const RATING_PROMPT_KEY = 'ratingPromptShown';

function ExtraCreditsRow({ info }: { info: ExtraCreditsInfo }) {
  return (
    <div className="popup-extra-credits">
      <div className="popup-bar-label-row">
        <span className="popup-bar-title">Extra credits</span>
        <span className="popup-bar-value">{info.percent !== null ? `${Math.round(info.percent)}%` : '—'}</span>
      </div>
      {info.usedAmount !== null && info.limitAmount !== null && (
        <p className="popup-extra-credits-amount">
          {info.currency ?? ''} {info.usedAmount.toFixed(2)} / {info.limitAmount.toFixed(2)}
        </p>
      )}
    </div>
  );
}

// Never color-only: each tone also carries a leading symbol so it reads without color vision.
// "ok" uses the operational-health green class (a forecast that's on track is a status readout,
// not an ordinary usage level) — doesn't affect the usage bars below, which stay blue/amber/red.
const HEADLINE_STYLES: Record<Headline['tone'], { symbol: string; className: string }> = {
  ok: { symbol: '✓ ', className: 'popup-banner-ok' },
  warn: { symbol: '⚠ ', className: 'popup-banner-warn' },
  alert: { symbol: '⛔ ', className: 'popup-banner-alert' },
};

function HeadlineBanner({ headline }: { headline: Headline }) {
  const tone = HEADLINE_STYLES[headline.tone];
  return (
    <p role="status" className={`popup-banner ${tone.className}`}>
      {tone.symbol}
      {headline.text}
    </p>
  );
}

function Bar({ title, bar }: { title: string; bar: LimitBar }) {
  return (
    <div className="popup-bar">
      <div className="popup-bar-label-row">
        <span className="popup-bar-title">{title}</span>
        <span className="popup-bar-value">
          {formatPercent(bar.percent)}% · resets {formatResetLabel(bar.resetsAt)}
        </span>
      </div>
      <div
        className="popup-bar-track"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bar.percent)}
      >
        <div
          className="popup-bar-fill"
          style={{
            width: `${Math.min(100, Math.max(0, bar.percent))}%`,
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
  // Set by background.ts when a real /usage response fails schema validation — tells a genuine
  // parse failure (claude.ai changed its response shape) apart from just not having captured
  // anything yet, which otherwise look identical from here.
  const usageParseError = useLiveQuery(() => db.meta.get('usageParseError'), []);
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
  // Independent of the forecast headline above — "is something unusual?" and "am I about to run
  // out?" are different questions, answered separately rather than folded into one sentence.
  // Pure function over already-loaded snapshot history; no daemon/network involved.
  const anomalyNote = latest
    ? describeUsageAnomaly([
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
    <main className="popup">
      <div className="popup-header">
        <div className="popup-header-left">
          <img className="popup-icon" src={browser.runtime.getURL('/icon/48.png')} alt="" />
          <h1 className="popup-title">Claude usage</h1>
        </div>
        <button type="button" className="popup-refresh" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {latest ? (
        <>
          {/* Only when something needs attention — "all clear" just repeats what the bars show. */}
          {headline && headline.tone !== 'ok' && <HeadlineBanner headline={headline} />}
          {anomalyNote && <AnomalyNotice headline={anomalyNote} title={PROVENANCE_LABEL.derived} />}
          {showRating && (
            <p className="popup-rating">
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
            <p className="popup-state">Captured data, but no session/weekly bars in it yet.</p>
          )}
          {latest.extraCredits && <ExtraCreditsRow info={latest.extraCredits} />}
          <p className="popup-updated">
            Last updated: {new Date(latest.capturedAt).toLocaleString()} via {describeSource(latest.source)}
          </p>
          <a className="popup-cta" href={browser.runtime.getURL('/dashboard.html')} target="_blank" rel="noreferrer">
            View history & forecast →
          </a>
        </>
      ) : visitedClaudeAi && usageParseError ? (
        <div>
          <p className="popup-state popup-state-error">
            Account detected, but the usage data couldn't be read — claude.ai may have changed its
            format. This has been logged; try again after the next extension update, or see the
            setup checklist.
          </p>
          <p className="popup-updated">
            <a className="popup-secondary-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
              Setup checklist
            </a>
          </p>
        </div>
      ) : visitedClaudeAi ? (
        <div>
          <p className="popup-state">
            Account detected — the first usage snapshot hasn't landed yet. This is usually quick;
            try Refresh above in a moment.
          </p>
          <p className="popup-updated">
            <a className="popup-secondary-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
              Setup checklist
            </a>
          </p>
        </div>
      ) : (
        <div>
          <p className="popup-state">
            No usage data yet. Open claude.ai → Settings → Usage once to start tracking — the extension
            can't find your account until then.
          </p>
          <a className="popup-state-cta" href={USAGE_SETTINGS_URL} target="_blank" rel="noreferrer">
            Open Settings → Usage
          </a>
          <p className="popup-updated">
            On the free plan? claude.ai may send you to a pricing page instead — tracking needs an
            active plan with usage limits.
          </p>
          <p className="popup-updated">
            <a className="popup-secondary-link" href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
              Setup checklist
            </a>
          </p>
        </div>
      )}
    </main>
  );
}
