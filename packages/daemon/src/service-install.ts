import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const SERVICE_LABEL = 'com.headroom.claude-usage-daemon';

export interface InstallResult {
  platform: NodeJS.Platform;
  serviceFilePath: string;
  started: boolean;
  message: string;
}

/** Minimal shape of `child_process.execFileSync` this file needs — narrowed so tests can inject
 *  a spy instead of actually registering a real launchd/systemd/Task Scheduler service. */
type Exec = (file: string, args: string[]) => void;

export interface InstallServiceOptions {
  exec?: Exec;
  /** Overrides `os.homedir()` — tests point this at a temp dir so a test run never writes a
   *  real plist/unit file into the machine's actual home directory. */
  homeDir?: string;
  /** Overrides `os.platform()` — lets a single test suite exercise all three installers
   *  regardless of which platform actually runs the tests. */
  targetPlatform?: NodeJS.Platform;
}

/**
 * Reproduces however this process can actually be re-invoked later, by launchd/systemd/Task
 * Scheduler — an environment with no `pnpm`, no shell profile, and often a minimal PATH, so
 * anything relying on either is out. No build step exists yet: this source uses `.js`-suffixed
 * import specifiers pointing at not-yet-built `.ts` files, which only resolve under tsx's
 * loader — plain `node cli.ts` fails with `ERR_MODULE_NOT_FOUND` (it looks for a real `app.js`
 * next to `cli.ts` and there isn't one). So when the current script is itself a `.ts` file,
 * this resolves tsx's own CLI entry point by absolute path (same `createRequire` pattern
 * `adapters/ccusage.ts` uses for its binary) and invokes `node <tsx-cli> <cli.ts> start` — two
 * absolute paths, nothing PATH-dependent. Once a real build exists, `process.argv[1]` will
 * already point at compiled `.js`, and this falls through to reproducing that directly.
 */
function currentCommand(): { exec: string; args: string[] } {
  const scriptPath = process.argv[1]!;
  if (/\.(m|c)?ts$/.test(scriptPath)) {
    const tsxCli = require.resolve('tsx/cli');
    return { exec: process.execPath, args: [tsxCli, scriptPath, 'start'] };
  }
  return { exec: process.execPath, args: [scriptPath, 'start'] };
}

export function installService(options: InstallServiceOptions = {}): InstallResult {
  const exec = options.exec ?? ((file, args) => execFileSync(file, args, { stdio: 'ignore' }));
  const homeDir = options.homeDir ?? homedir();
  const os = options.targetPlatform ?? platform();

  if (os === 'darwin') return installLaunchd(exec, homeDir);
  if (os === 'linux') return installSystemd(exec, homeDir);
  if (os === 'win32') return installSchtasks(exec);
  return {
    platform: os,
    serviceFilePath: '',
    started: false,
    message: `No service installer for platform "${os}" yet — run "claude-usage-daemon start" manually (a terminal, tmux, or your own service manager).`,
  };
}

function installLaunchd(exec: Exec, homeDir: string): InstallResult {
  const { exec: nodeExec, args } = currentCommand();
  const dir = path.join(homeDir, 'Library', 'LaunchAgents');
  const logDir = path.join(homeDir, '.config', 'claude-usage');
  mkdirSync(dir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const plistPath = path.join(dir, `${SERVICE_LABEL}.plist`);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'daemon.error.log')}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist);

  try {
    exec('launchctl', ['load', '-w', plistPath]);
    return { platform: 'darwin', serviceFilePath: plistPath, started: true, message: `Registered and started via launchd: ${plistPath}` };
  } catch (error) {
    return {
      platform: 'darwin',
      serviceFilePath: plistPath,
      started: false,
      message: `Wrote ${plistPath} but "launchctl load -w" failed: ${String(error)}. Run that command yourself to finish.`,
    };
  }
}

function installSystemd(exec: Exec, homeDir: string): InstallResult {
  const { exec: nodeExec, args } = currentCommand();
  const dir = path.join(homeDir, '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const unitPath = path.join(dir, 'claude-usage-daemon.service');

  const unit = `[Unit]
Description=Claude Usage Companion daemon

[Service]
ExecStart=${nodeExec} ${args.map((a) => `"${a}"`).join(' ')}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit);

  try {
    exec('systemctl', ['--user', 'daemon-reload']);
    exec('systemctl', ['--user', 'enable', '--now', 'claude-usage-daemon.service']);
    return { platform: 'linux', serviceFilePath: unitPath, started: true, message: `Registered and started via systemd --user: ${unitPath}` };
  } catch (error) {
    return {
      platform: 'linux',
      serviceFilePath: unitPath,
      started: false,
      message: `Wrote ${unitPath} but "systemctl --user enable --now" failed: ${String(error)}. Needs a user systemd instance (and "loginctl enable-linger $USER" to survive logout) — run it yourself to finish.`,
    };
  }
}

function installSchtasks(exec: Exec): InstallResult {
  const { exec: nodeExec, args } = currentCommand();
  const taskName = 'ClaudeUsageDaemon';
  const command = `"${nodeExec}" ${args.map((a) => `"${a}"`).join(' ')}`;

  try {
    exec('schtasks', ['/create', '/tn', taskName, '/tr', command, '/sc', 'onlogon', '/rl', 'limited', '/f']);
    exec('schtasks', ['/run', '/tn', taskName]);
    return { platform: 'win32', serviceFilePath: taskName, started: true, message: `Registered Task Scheduler task "${taskName}" and started it.` };
  } catch (error) {
    return {
      platform: 'win32',
      serviceFilePath: taskName,
      started: false,
      message: `Could not register Task Scheduler task "${taskName}": ${String(error)}. Run it yourself to finish.`,
    };
  }
}
