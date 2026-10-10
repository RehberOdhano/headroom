import { useEffect, useState } from 'react';
import { extensionMessenger } from '../../lib/messaging.js';
import type { Settings } from '../../lib/protocol.js';
import { ConnectDaemonCard } from './ConnectDaemon.tsx';
import { CliAttributionPanel } from './cli/CliAttributionPanel.tsx';
import { RetentionWarnings } from './cli/RetentionWarnings.tsx';
import { SessionSearch } from './cli/SessionSearch.tsx';
import { WhatChanged } from './cli/WhatChanged.tsx';

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
    return <ConnectDaemonCard hint={hint} />;
  }

  return <>{children(settings)}</>;
}

/** Project/model/session/subagent attribution + "what changed", daemon-backed — the Activity tab. */
export function CliTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to see Claude Code CLI usage here.">
      {(settings) => (
        <>
          <WhatChanged settings={settings} />
          <CliAttributionPanel settings={settings} />
        </>
      )}
    </DaemonGate>
  );
}

/** Search, drilldown, retention, export, resume — everything about a session's lifecycle lives
 *  in the Sessions tab. Retention warnings sit above search, not buried behind it — they're a
 *  time-sensitive alert, not something to bury behind a sub-view someone might not click. */
export function SearchTab() {
  return (
    <DaemonGate hint="Connect the local daemon in the extension's options page to search your Claude Code CLI sessions here.">
      {(settings) => (
        <>
          <RetentionWarnings settings={settings} />
          <SessionSearch settings={settings} />
        </>
      )}
    </DaemonGate>
  );
}
