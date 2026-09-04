import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const DEFAULT_FIXTURE_SOURCE = path.join(FIXTURES_ROOT, 'claude-dir');

/**
 * ccusage@20.0.20 mis-parses project/session identity when CLAUDE_CONFIG_DIR's ancestor
 * path contains a literal "/projects/" path segment — as this repo's own checkout path
 * does (`.../projects/headroom/...`), since ccusage naively looks for the *first*
 * "/projects/" segment rather than treating CLAUDE_CONFIG_DIR as the root. Copying the
 * fixture into an OS temp dir for each test sidesteps this.
 *
 * `session-log.ts`'s own file-reading doesn't have this bug (it never decodes the ancestor
 * path), but tests still copy to a temp dir for isolation and to keep this one helper shared.
 * Pass `fixtureName` to use a fixture other than the default `fixtures/claude-dir` — e.g.
 * `session-log-dir` for search/export tests, which need distinct multi-session content the
 * ccusage contract tests' exact-number assertions can't tolerate changing.
 */
export function withFixtureClaudeDir<T>(
  run: (claudeConfigDir: string) => Promise<T>,
  fixtureName = 'claude-dir',
): Promise<T> {
  const source = fixtureName === 'claude-dir' ? DEFAULT_FIXTURE_SOURCE : path.join(FIXTURES_ROOT, fixtureName);
  const dir = mkdtempSync(path.join(tmpdir(), 'headroom-ccusage-fixture-'));
  cpSync(source, dir, { recursive: true });
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
