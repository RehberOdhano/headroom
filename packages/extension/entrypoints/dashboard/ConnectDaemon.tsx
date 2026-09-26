import { useState } from 'react';
import { copyInstallCommand, DAEMON_INSTALL_COMMANDS } from '../../lib/daemon-install.js';

/**
 * Shown wherever a daemon-backed feature has nothing to show yet: the exact install command
 * with a copy button, so a non-developer never has to hunt for it in a README. Pairing is
 * automatic after that (options page shows status), so there's nothing further to do here.
 */
export function ConnectDaemonCard({ hint }: { hint: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!(await copyInstallCommand())) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Connect the daemon</h2>
      </div>
      <p className="hint">{hint}</p>
      <p className="hint">
        The daemon is optional and runs only on your machine (Node.js 20+). Run this once in a terminal — the extension
        pairs with it automatically within about a minute:
      </p>
      <div className="install-command">
        <code>{DAEMON_INSTALL_COMMANDS}</code>
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="hint">
        <a href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
          Check connection status in Settings →
        </a>
      </p>
    </section>
  );
}
