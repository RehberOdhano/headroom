import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { DaemonHealth, Settings } from '../../lib/protocol.js';
import { db } from '../../lib/db.js';
import { extensionMessenger } from '../../lib/messaging.js';

const styles = {
  section: { marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid #e5e7eb', maxWidth: 480 },
  heading: { fontSize: '1rem' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' },
  daemonBlock: { marginTop: '1rem' },
  hint: { fontSize: '0.85rem', color: '#666', marginBottom: 8 },
  fieldLabel: { display: 'block', fontSize: '0.85rem', marginBottom: 8 },
  input: { display: 'block', width: '100%', marginTop: 2, boxSizing: 'border-box' } as const,
  thresholdRow: { display: 'flex', gap: '1rem' },
  thresholdField: { flex: 1, display: 'block', fontSize: '0.85rem' },
  ok: { color: '#16a34a', marginLeft: 8, fontSize: '0.85rem' },
  error: { color: '#dc2626', marginLeft: 8, fontSize: '0.85rem' },
  pairingRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', marginBottom: 4 },
  pairingDot: { fontSize: '0.7rem' },
  advanced: { marginTop: '0.75rem' },
  advancedSummary: { fontSize: '0.85rem', color: '#666', cursor: 'pointer' },
  checklist: { listStyle: 'none', padding: 0, margin: '0.5rem 0 0' },
  checklistItem: { fontSize: '0.85rem', marginBottom: 4 },
  checklistDone: { color: '#16a34a' },
  checklistPending: { color: '#999' },
} as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:00 ${period}`;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
type PairingUiState = 'checking' | 'connected' | 'waiting' | 'already_paired';

/** "just now" / "3m ago" / "2h ago" — the daemon health check's own timestamp is at most a
 *  `PAIR_INTERVAL_MINUTES` (1 minute) old in practice, but this reads fine at any age. */
function timeAgo(iso: string, now = Date.now()): string {
  const diffMinutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  return `${Math.round(diffMinutes / 60)}h ago`;
}

interface ChecklistItem {
  label: string;
  done: boolean;
  shown: boolean;
}

/**
 * A partially-set-up install today just shows empty tabs with no unifying explanation —
 * `background.ts`'s `pollUsage()` already has a doc comment flagging "no org id known yet
 * (visit claude.ai once)" as a real, currently-invisible gap. This surfaces that (and the other
 * silent prerequisites) as a plain checklist, informational only — never a blocking gate — and
 * disappears once everything is done so it doesn't linger as clutter for an already-working
 * install.
 */
function SetupChecklist({ settings, daemonHealth }: { settings: Settings; daemonHealth: DaemonHealth | null }) {
  // Resolved to a boolean inside the query itself, not left as the raw `get()`/`count()` result
  // — `db.meta.get()` on a genuinely-missing key resolves to `undefined`, the same value
  // `useLiveQuery` uses to mean "hasn't resolved yet", so checking the raw result for
  // `=== undefined` could never tell "not visited yet" apart from "still loading" and would
  // permanently hide this section for the exact case it exists to flag.
  const visitedClaudeAi = useLiveQuery(async () => Boolean(await db.meta.get('orgId')), []);
  const capturedSnapshot = useLiveQuery(async () => (await db.limitSnapshots.count()) > 0, []);

  const daemonPaired = Boolean(settings.daemonToken);

  const items: ChecklistItem[] = [
    { label: 'Visited claude.ai once, so headroom can detect your account', done: visitedClaudeAi === true, shown: true },
    { label: 'First usage snapshot captured', done: capturedSnapshot === true, shown: true },
    { label: 'Local daemon paired (optional — unlocks CLI attribution & search)', done: daemonPaired, shown: true },
    { label: 'Daemon reachable right now', done: daemonHealth?.ok === true, shown: daemonPaired },
  ];
  const visible = items.filter((item) => item.shown);
  const doneCount = visible.filter((item) => item.done).length;

  if (visitedClaudeAi === undefined || capturedSnapshot === undefined) return null; // still loading
  if (doneCount === visible.length) return null; // fully set up — nothing to flag

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>
        Setup status ({doneCount}/{visible.length})
      </h2>
      <ul style={styles.checklist}>
        {visible.map((item) => (
          <li key={item.label} style={styles.checklistItem}>
            <span style={item.done ? styles.checklistDone : styles.checklistPending}>{item.done ? '✓' : '○'}</span>{' '}
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [pairingUi, setPairingUi] = useState<PairingUiState>('waiting');
  const [daemonHealth, setDaemonHealth] = useState<DaemonHealth | null>(null);

  useEffect(() => {
    void extensionMessenger.sendMessage('getSettings').then((next) => {
      setSettings(next);
      setPairingUi(next.daemonToken ? 'connected' : 'waiting');
    });
    void extensionMessenger.sendMessage('getDaemonHealth').then(setDaemonHealth);
  }, []);

  async function checkPairingNow() {
    setPairingUi('checking');
    const result = await extensionMessenger.sendMessage('attemptPairing');
    if (result.paired) {
      setSettings(await extensionMessenger.sendMessage('getSettings'));
      setPairingUi('connected');
    } else {
      setPairingUi(result.reason === 'already_paired' ? 'already_paired' : 'waiting');
    }
    setDaemonHealth(await extensionMessenger.sendMessage('getDaemonHealth'));
  }

  async function update(partial: Partial<Settings>) {
    const next = await extensionMessenger.sendMessage('updateSettings', partial);
    setSettings(next);
    setTestStatus('idle');
  }

  async function updateThreshold(index: 0 | 1, rawValue: string) {
    const value = Number(rawValue);
    if (!settings || !Number.isFinite(value) || value < 1 || value > 100) return;
    const next = [...settings.alertThresholds];
    next[index] = value;
    await update({ alertThresholds: next.filter((n) => Number.isFinite(n)).sort((a, b) => a - b) });
  }

  async function testConnection() {
    if (!settings) return;
    setTestStatus('testing');
    try {
      // /health deliberately skips auth (src/auth.ts), so it can't tell "wrong token" apart
      // from "daemon not running" — hit an authed route instead to actually validate the token.
      const response = await fetch(`${settings.daemonUrl}/sessions`, {
        headers: settings.daemonToken ? { Authorization: `Bearer ${settings.daemonToken}` } : {},
      });
      setTestStatus(response.ok ? 'ok' : 'error');
    } catch {
      setTestStatus('error');
    }
  }

  if (!settings) return null;

  return (
    <>
      <SetupChecklist settings={settings} daemonHealth={daemonHealth} />
      <section style={styles.section}>
        <h2 style={styles.heading}>Settings</h2>

      <label style={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={settings.badgeEnabled}
          onChange={(event) => void update({ badgeEnabled: event.target.checked })}
        />
        Show a small usage badge on claude.ai
      </label>

      <label style={{ ...styles.checkboxRow, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={settings.weeklyDigestEnabled}
          onChange={(event) => void update({ weeklyDigestEnabled: event.target.checked })}
        />
        Send me a weekly usage digest
      </label>

      <div style={styles.daemonBlock}>
        <label style={styles.fieldLabel}>
          Keep usage history for (days)
          <input
            type="number"
            min={1}
            value={settings.snapshotRetentionDays}
            onChange={(event) => {
              const days = Number(event.target.value);
              if (Number.isFinite(days) && days >= 1) void update({ snapshotRetentionDays: days });
            }}
            style={styles.input}
          />
        </label>
        <p style={styles.hint}>Notify me when a bar reaches:</p>
        <div style={styles.thresholdRow}>
          <label style={styles.thresholdField}>
            Warn at (%)
            <input
              type="number"
              min={1}
              max={100}
              value={settings.alertThresholds[0] ?? ''}
              onChange={(event) => void updateThreshold(0, event.target.value)}
              style={styles.input}
            />
          </label>
          <label style={styles.thresholdField}>
            Alert at (%)
            <input
              type="number"
              min={1}
              max={100}
              value={settings.alertThresholds[1] ?? ''}
              onChange={(event) => void updateThreshold(1, event.target.value)}
              style={styles.input}
            />
          </label>
        </div>

        <label style={{ ...styles.checkboxRow, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.quietHoursEnabled}
            onChange={(event) => void update({ quietHoursEnabled: event.target.checked })}
          />
          Don't notify me during quiet hours
        </label>
        {settings.quietHoursEnabled && (
          <div style={{ ...styles.thresholdRow, marginTop: 8 }}>
            <label style={styles.thresholdField}>
              From
              <select
                value={settings.quietHoursStart}
                onChange={(event) => void update({ quietHoursStart: Number(event.target.value) })}
                style={styles.input}
              >
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.thresholdField}>
              Until
              <select
                value={settings.quietHoursEnd}
                onChange={(event) => void update({ quietHoursEnd: Number(event.target.value) })}
                style={styles.input}
              >
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      <div style={styles.daemonBlock}>
        <p style={styles.hint}>
          Local daemon (optional — unlocks CLI attribution, session search, retention warnings).
          Run <code>pnpm --filter @headroom/daemon exec tsx src/cli.ts install</code> once in a
          terminal (no npm package published yet) — the extension pairs with it automatically
          after that, nothing to copy or paste.
        </p>

        <div style={styles.pairingRow}>
          {pairingUi === 'connected' && (
            <span style={styles.ok}>
              <span style={styles.pairingDot}>●</span> Connected automatically
            </span>
          )}
          {pairingUi === 'waiting' && <span>Waiting for the daemon…</span>}
          {pairingUi === 'checking' && <span>Checking…</span>}
          {pairingUi === 'already_paired' && (
            <span style={styles.error}>
              Already paired with another extension — run <code>daemon install</code> again to
              reconnect this one.
            </span>
          )}
          <button type="button" onClick={checkPairingNow} disabled={pairingUi === 'checking'}>
            Check now
          </button>
        </div>

        {pairingUi === 'connected' && daemonHealth && (
          <p style={daemonHealth.ok ? styles.ok : styles.error}>
            <span style={styles.pairingDot}>●</span>{' '}
            {daemonHealth.ok ? `Daemon reachable, checked ${timeAgo(daemonHealth.checkedAt)}` : `Daemon unreachable — last checked ${timeAgo(daemonHealth.checkedAt)}`}
          </p>
        )}

        <label style={styles.fieldLabel}>
          Alert me if CLI spend this month exceeds ($, blank to disable)
          <input
            type="number"
            min={0}
            step="0.01"
            value={settings.cliMonthlyBudget ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                void update({ cliMonthlyBudget: null });
                return;
              }
              const value = Number(raw);
              if (Number.isFinite(value) && value >= 0) void update({ cliMonthlyBudget: value });
            }}
            style={styles.input}
          />
        </label>

        <details style={styles.advanced}>
          <summary style={styles.advancedSummary}>Advanced: daemon URL / manual token</summary>
          <label style={styles.fieldLabel}>
            Daemon URL
            <input
              type="text"
              value={settings.daemonUrl}
              onChange={(event) => void update({ daemonUrl: event.target.value })}
              style={styles.input}
            />
          </label>
          <label style={styles.fieldLabel}>
            Token
            <input
              type="password"
              value={settings.daemonToken}
              onChange={(event) => void update({ daemonToken: event.target.value })}
              style={styles.input}
            />
          </label>
          <button type="button" onClick={testConnection} disabled={testStatus === 'testing'}>
            {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {testStatus === 'ok' && <span style={styles.ok}>Connected</span>}
          {testStatus === 'error' && <span style={styles.error}>Could not connect</span>}
        </details>
      </div>
      </section>
    </>
  );
}
