import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installService } from '../src/service-install.js';

// Every test injects homeDir (a temp dir) and exec (a spy) — real launchctl/systemctl/schtasks
// calls, and real writes into the machine's actual home directory, must never happen from a
// test run. See src/service-install.ts's InstallServiceOptions doc.
let homeDir: string;

describe('installService', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'headroom-service-install-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('writes a launchd plist and calls launchctl load on darwin', () => {
    const exec = vi.fn();
    const result = installService({ homeDir, exec, targetPlatform: 'darwin' });

    expect(result.started).toBe(true);
    expect(result.platform).toBe('darwin');
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.headroom.claude-usage-daemon.plist');
    expect(result.serviceFilePath).toBe(plistPath);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, 'utf-8')).toContain('<key>Label</key>');
    expect(exec).toHaveBeenCalledWith('launchctl', ['load', '-w', plistPath]);
  });

  it('reports a non-fatal failure if launchctl load itself fails', () => {
    const exec = vi.fn(() => {
      throw new Error('boom');
    });
    const result = installService({ homeDir, exec, targetPlatform: 'darwin' });

    expect(result.started).toBe(false);
    expect(result.message).toContain('boom');
    // The plist is still written even though loading it failed — the user can retry manually.
    expect(existsSync(result.serviceFilePath)).toBe(true);
  });

  it('writes a systemd user unit and enables it on linux', () => {
    const exec = vi.fn();
    const result = installService({ homeDir, exec, targetPlatform: 'linux' });

    expect(result.started).toBe(true);
    const unitPath = path.join(homeDir, '.config', 'systemd', 'user', 'claude-usage-daemon.service');
    expect(result.serviceFilePath).toBe(unitPath);
    expect(readFileSync(unitPath, 'utf-8')).toContain('[Unit]');
    expect(exec).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'claude-usage-daemon.service']);
  });

  it('registers a Task Scheduler task on win32', () => {
    const exec = vi.fn();
    const result = installService({ homeDir, exec, targetPlatform: 'win32' });

    expect(result.started).toBe(true);
    expect(result.serviceFilePath).toBe('ClaudeUsageDaemon');
    expect(exec).toHaveBeenCalledWith('schtasks', expect.arrayContaining(['/create', '/tn', 'ClaudeUsageDaemon']));
  });

  it('returns a manual-instructions result for an unsupported platform', () => {
    const exec = vi.fn();
    const result = installService({ homeDir, exec, targetPlatform: 'freebsd' });

    expect(result.started).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(result.message).toContain('manually');
  });
});
