/** The one-liner that installs and registers the daemon — shared by the dashboard's connect card
 *  and the options page so the command can't drift between them. */
export const DAEMON_INSTALL_COMMANDS =
  'npm install -g @rehberodhano/claude-usage-companion-daemon && claude-usage-daemon install';

/** Copies the install command; resolves false (rather than throwing) when the clipboard is
 *  unavailable, so callers can leave the visible command to be selected by hand. */
export async function copyInstallCommand(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(DAEMON_INSTALL_COMMANDS);
    return true;
  } catch {
    return false;
  }
}
