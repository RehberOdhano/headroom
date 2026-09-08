import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  dailyReportSchema,
  projectDailyReportSchema,
  sessionsReportSchema,
  type DailyReport,
  type ProjectDailyReport,
  type Session,
  type SessionsReport,
} from './ccusage.schemas.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * ccusage@20.0.20 publishes no importable API — its package.json `files` only lists
 * `src/cli.js` (a launcher that spawns a per-platform native binary) and a schema JSON.
 * There is nothing to `import`, so the adapter always spawns the CLI and parses `--json`
 * stdout.
 */
function resolveCcusageBin(): string {
  const pkgJsonPath = require.resolve('ccusage/package.json');
  const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ccusage;
  if (!binRel) {
    throw new Error('ccusage package.json has no bin entry; adapter needs updating');
  }
  return path.join(path.dirname(pkgJsonPath), binRel);
}

export interface CcusageOptions {
  /** Overrides CLAUDE_CONFIG_DIR for the spawned process. Used by tests to point at fixtures. */
  claudeConfigDir?: string;
  /** `-s/--since`, YYYYMMDD — confirmed against `ccusage claude daily --help` / `session --help`. */
  since?: string;
  /** `-u/--until`, YYYYMMDD. */
  until?: string;
}

function dateRangeArgs(options: CcusageOptions): string[] {
  const args: string[] = [];
  if (options.since) args.push('--since', options.since);
  if (options.until) args.push('--until', options.until);
  return args;
}

async function runCcusageJson(args: string[], options: CcusageOptions = {}): Promise<unknown> {
  const bin = resolveCcusageBin();
  // --offline: the daemon must never make its own network calls. Without it, ccusage fetches
  // model pricing from the network on every call.
  const fullArgs = [bin, ...args, ...dateRangeArgs(options), '--json', '--offline'];
  const env = {
    ...process.env,
    ...(options.claudeConfigDir ? { CLAUDE_CONFIG_DIR: options.claudeConfigDir } : {}),
  };
  const { stdout } = await execFileAsync(process.execPath, fullArgs, { env });
  return JSON.parse(stdout);
}

export async function getSessions(options: CcusageOptions = {}): Promise<SessionsReport> {
  const raw = await runCcusageJson(['claude', 'session'], options);
  return sessionsReportSchema.parse(raw);
}

/**
 * Single-session lookup — used by the daemon's `GET /sessions/:id`. Deliberately does NOT use
 * ccusage's own `-i/--id` flag: it returns an entirely different, sparser shape
 * (`{entries, sessionId, totalCost, totalTokens}`, no `projectPath`/`firstActivity`/
 * `modelBreakdowns`) than the plain session-list command, which would need a second schema for
 * strictly less information. Filtering the already-validated full list client-side is simpler,
 * reuses one schema, and returns the same richer `Session` shape everywhere.
 */
export async function getSession(id: string, options: CcusageOptions = {}): Promise<Session | null> {
  const report = await getSessions(options);
  return report.sessions.find((session) => session.sessionId === id) ?? null;
}

export async function getDaily(options: CcusageOptions = {}): Promise<DailyReport> {
  const raw = await runCcusageJson(['claude', 'daily'], options);
  return dailyReportSchema.parse(raw);
}

export async function getDailyByProject(
  options: CcusageOptions = {},
): Promise<ProjectDailyReport> {
  const raw = await runCcusageJson(['claude', 'daily', '--instances'], options);
  return projectDailyReportSchema.parse(raw);
}
