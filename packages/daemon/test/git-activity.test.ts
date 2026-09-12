import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGitActivity } from '../src/adapters/git-activity.js';

const execFileAsync = promisify(execFile);

describe('getGitActivity', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'headroom-git-activity-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves isGitRepo: false with no commits for a plain, non-git directory', async () => {
    const result = await getGitActivity(dir, '2020-01-01');
    expect(result).toEqual({ isGitRepo: false, commitCount: 0 });
  });

  it('counts commits since a given date in a real git repo', async () => {
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    writeFileSync(path.join(dir, 'a.txt'), 'a');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'first'], { cwd: dir });

    writeFileSync(path.join(dir, 'b.txt'), 'b');
    await execFileAsync('git', ['add', 'b.txt'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'second'], { cwd: dir });

    const result = await getGitActivity(dir, '2020-01-01');
    expect(result).toEqual({ isGitRepo: true, commitCount: 2 });
  });

  it('resolves isGitRepo: true with commitCount: 0 when `since` excludes every commit', async () => {
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(path.join(dir, 'a.txt'), 'a');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'first'], { cwd: dir });

    const result = await getGitActivity(dir, '2099-01-01');
    expect(result).toEqual({ isGitRepo: true, commitCount: 0 });
  });
});
