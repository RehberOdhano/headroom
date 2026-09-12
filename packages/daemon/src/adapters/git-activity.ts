import { execFile } from 'node:child_process';
import type { GitActivityResponse } from '@headroom/shared';

/**
 * Commit count for a project directory since a given date — backs the "tokens/cost per commit"
 * stat in Guardrails. `projectDir` is only ever a real, `isValidProjectDir`-checked path by the
 * time this is called (see `app.ts`'s `/config/git-activity` route), and every argument is
 * passed to `execFile` as a separate array element, never interpolated into a shell string, so a
 * project path containing shell metacharacters can't do anything but fail to match a directory.
 *
 * Fails soft — not a git repo, git not installed, or any other `git log` failure all resolve to
 * `{ isGitRepo: false, commitCount: 0 }` rather than throwing, matching every other adapter in
 * this package that reads something outside the daemon's own control.
 */
export function getGitActivity(projectDir: string, since: string): Promise<GitActivityResponse> {
  return new Promise((resolve) => {
    execFile('git', ['-C', projectDir, 'log', `--since=${since}`, '--oneline'], (error, stdout) => {
      if (error) {
        resolve({ isGitRepo: false, commitCount: 0 });
        return;
      }
      const commitCount = stdout.split('\n').filter((line) => line.trim().length > 0).length;
      resolve({ isGitRepo: true, commitCount });
    });
  });
}
