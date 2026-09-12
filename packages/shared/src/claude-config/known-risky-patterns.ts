/**
 * A small, bundled, offline list of common risky Claude Code permission patterns — surfaced in
 * the extension's Guardrails tab as quick-toggle suggestions. Deliberately not sourced from the
 * internet at runtime: neither package makes external network calls. Pattern syntax
 * (`Tool(subpattern)` / bare tool name) matches a real project's `permissions.allow/ask/deny`
 * arrays.
 */

export interface KnownRiskyPattern {
  pattern: string;
  label: string;
  description: string;
}

export const KNOWN_RISKY_PATTERNS: KnownRiskyPattern[] = [
  {
    pattern: 'Bash(rm -rf *)',
    label: 'Force-delete files',
    description: 'Recursively deletes files/directories without confirmation.',
  },
  {
    pattern: 'Bash(git push --force *)',
    label: 'Force-push',
    description: 'Overwrites remote history — can discard commits others already pulled.',
  },
  {
    pattern: 'Bash(git reset --hard *)',
    label: 'Hard reset',
    description: 'Discards uncommitted local changes irreversibly.',
  },
  {
    pattern: 'Bash(kill *)',
    label: 'Kill processes',
    description: 'Terminates running processes by PID or name.',
  },
  {
    pattern: 'Bash(sudo *)',
    label: 'Run as root',
    description: 'Escalates privileges for the wrapped command.',
  },
  {
    pattern: 'Bash(npm publish *)',
    label: 'Publish a package',
    description: 'Pushes a new version of a package to a registry — hard to undo.',
  },
  {
    pattern: 'Read(.env)',
    label: 'Read .env',
    description: 'Reads a file that commonly holds secrets/credentials.',
  },
  {
    pattern: 'Read(**/*.pem)',
    label: 'Read private key files',
    description: 'Reads certificate/private-key files anywhere in the project.',
  },
];
