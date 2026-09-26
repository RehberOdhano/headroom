import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { DaemonHealth, Settings } from '../../lib/protocol.js';
import { extensionMessenger } from '../../lib/messaging.js';
import { copyInstallCommand, DAEMON_INSTALL_COMMANDS } from '../../lib/daemon-install.js';
import { BackupRestoreSection } from './BackupRestore.tsx';
import { SetupChecklist } from './SetupChecklist.tsx';
import { styles } from './styles.ts';

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
          checked={settings.paceAlertEnabled}
          onChange={(event) => void update({ paceAlertEnabled: event.target.checked })}
        />
        Warn me when I'm on pace to run out before a limit resets
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
          Run <code>{DAEMON_INSTALL_COMMANDS}</code> once in a terminal — the extension pairs with it
          automatically after that, nothing to copy or paste.{' '}
          <button type="button" onClick={() => void copyInstallCommand()}>
            Copy command
          </button>
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
              Already paired with another extension — run <code>claude-usage-daemon install</code> again to
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

        <details style={styles.advanced}>
          <summary style={styles.advancedSummary}>Advanced: manual token</summary>
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

      <BackupRestoreSection settings={settings} onSettingsRestored={setSettings} />
      </section>
    </>
  );
}
