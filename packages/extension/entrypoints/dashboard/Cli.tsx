import { useEffect, useState } from 'react';
import { extensionMessenger } from '../../lib/messaging.js';
import type { Settings } from '../../lib/protocol.js';
import { CliAttributionPanel } from './cli/CliAttributionPanel.tsx';
import { RetentionWarnings } from './cli/RetentionWarnings.tsx';
import { SessionSearch } from './cli/SessionSearch.tsx';

/**
 * Fetches settings once and renders `children(settings)` once the daemon is configured, or a
 * tab-appropriate "connect the daemon" hint otherwise. Split out so the CLI attribution and
 * search tabs each get their own independent gate instead of sharing one combined card.
 */
export function DaemonGate({ hint, children }: { hint: string; children: (settings: Settings) => React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void extensionMessenger.sendMessage('getSettings').then(setSettings);
  }, []);

  if (!settings) return null;

  if (!settings.daemonUrl || !settings.daemonToken) {
    return (
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Connect the daemon</h2>
        </div>
        <p className="hint">{hint}</p>
      </section>
    );
  }

  return <>{children(settings)}</>;
}

/** CLI attribution + retention warnings, daemon-backed. Session search is its own tab
 *  (`SearchTab`, below) since it has its own pagination and can otherwise get long.
 *  Retention warnings sit outside the attribution panel, above it — they're a time-sensitive
 *  alert, not something to bury behind a sub-view someone might not click. */
export function CliTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to see Claude Code CLI usage and retention warnings here.">
      {(settings) => (
        <>
          <RetentionWarnings settings={settings} />
          <CliAttributionPanel settings={settings} />
        </>
      )}
    </DaemonGate>
  );
}

/** Full-text search across local Claude Code sessions — its own tab, not paired with CLI
 *  attribution, so paginated results have room to breathe. */
export function SearchTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to search your Claude Code CLI sessions here.">
      {(settings) => <SessionSearch settings={settings} />}
    </DaemonGate>
  );
}
