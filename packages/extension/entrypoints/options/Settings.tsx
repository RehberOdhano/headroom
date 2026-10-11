import { useEffect, useState } from 'react';
import type { DaemonHealth, Settings } from '../../lib/protocol.js';
import { extensionMessenger } from '../../lib/messaging.js';
import { copyInstallCommand, DAEMON_INSTALL_COMMANDS } from '../../lib/daemon-install.js';
import { BackupRestoreSection } from './BackupRestore.tsx';
import { Diagnostics } from './Diagnostics.tsx';
import { SetupChecklist } from './SetupChecklist.tsx';

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

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Settings</h2>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.badgeEnabled}
            onChange={(event) => void update({ badgeEnabled: event.target.checked })}
          />
          Show a small usage badge on claude.ai
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.paceAlertEnabled}
            onChange={(event) => void update({ paceAlertEnabled: event.target.checked })}
          />
          Warn me when I'm on pace to run out before a limit resets
        </label>

        <label className="field">
          Keep usage history for (days)
          <input
            type="number"
            min={1}
            className="field-input"
            value={settings.snapshotRetentionDays}
            onChange={(event) => {
              const days = Number(event.target.value);
              if (Number.isFinite(days) && days >= 1) void update({ snapshotRetentionDays: days });
            }}
          />
        </label>

        <p className="hint">Notify me when a bar reaches:</p>
        <div className="threshold-row">
          <label className="field threshold-field">
            Warn at (%)
            <input
              type="number"
              min={1}
              max={100}
              className="field-input"
              value={settings.alertThresholds[0] ?? ''}
              onChange={(event) => void updateThreshold(0, event.target.value)}
            />
          </label>
          <label className="field threshold-field">
            Alert at (%)
            <input
              type="number"
              min={1}
              max={100}
              className="field-input"
              value={settings.alertThresholds[1] ?? ''}
              onChange={(event) => void updateThreshold(1, event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Local daemon</h2>
        </div>
        <p className="hint">
          Optional — unlocks CLI attribution, session search, retention warnings. Run this once in a
          terminal — the extension pairs with it automatically after that, nothing to copy or paste.
        </p>
        <div className="install-command">
          <code>{DAEMON_INSTALL_COMMANDS}</code>
          <button type="button" className="btn" onClick={() => void copyInstallCommand()}>
            Copy command
          </button>
        </div>

        <div className="status-row">
          {pairingUi === 'connected' && (
            <>
              <span className="status-dot status-dot-success" />
              <span className="status-text-success">Connected automatically</span>
            </>
          )}
          {pairingUi === 'waiting' && (
            <>
              <span className="status-dot status-dot-muted" />
              <span>Waiting for the daemon…</span>
            </>
          )}
          {pairingUi === 'checking' && (
            <>
              <span className="status-dot status-dot-muted" />
              <span>Checking…</span>
            </>
          )}
          {pairingUi === 'already_paired' && (
            <>
              <span className="status-dot status-dot-error" />
              <span className="status-text-error">
                Already paired with another extension — run <code>claude-usage-daemon install</code> again to
                reconnect this one.
              </span>
            </>
          )}
          <button type="button" className="btn" onClick={checkPairingNow} disabled={pairingUi === 'checking'}>
            Check now
          </button>
        </div>

        {pairingUi === 'connected' && daemonHealth && (
          <div className="status-row">
            <span className={`status-dot ${daemonHealth.ok ? 'status-dot-success' : 'status-dot-error'}`} />
            <span className={daemonHealth.ok ? 'status-text-success' : 'status-text-error'}>
              {daemonHealth.ok
                ? `Daemon reachable, checked ${timeAgo(daemonHealth.checkedAt)}`
                : `Daemon unreachable — last checked ${timeAgo(daemonHealth.checkedAt)}`}
            </span>
          </div>
        )}

        <details className="advanced">
          <summary className="advanced-summary">Advanced: manual token</summary>
          <label className="field">
            Token
            <input
              type="password"
              className="field-input"
              value={settings.daemonToken}
              onChange={(event) => void update({ daemonToken: event.target.value })}
            />
          </label>
          <div className="status-row">
            <button type="button" className="btn" onClick={testConnection} disabled={testStatus === 'testing'}>
              {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            {testStatus === 'ok' && <span className="ok-text">Connected</span>}
            {testStatus === 'error' && <span className="error-text">Could not connect</span>}
          </div>
        </details>
      </section>

      <BackupRestoreSection settings={settings} onSettingsRestored={setSettings} />
      <Diagnostics settings={settings} daemonHealth={daemonHealth} />
    </>
  );
}
