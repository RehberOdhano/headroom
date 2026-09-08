import { useEffect, useState } from 'react';
import type { Settings } from '../../lib/protocol.js';
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
} as const;

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
type PairingUiState = 'checking' | 'connected' | 'waiting' | 'already_paired';

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [pairingUi, setPairingUi] = useState<PairingUiState>('waiting');

  useEffect(() => {
    void extensionMessenger.sendMessage('getSettings').then((next) => {
      setSettings(next);
      setPairingUi(next.daemonToken ? 'connected' : 'waiting');
    });
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
  );
}
