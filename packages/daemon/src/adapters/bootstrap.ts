import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inferStackFromTags, type BootstrapDocumentEncoding, type BootstrapMode, type BootstrapResult, type BootstrapStack, type BootstrapVerificationStep } from '@headroom/shared';
import { scaffoldFilesForStack, verifyCommandsForStack } from './bootstrap-scaffolds.js';

/**
 * "Create a new project" must never silently reuse or overwrite something that's already
 * there — an existing target means the caller almost certainly named the wrong path, not that
 * it's safe to treat as empty. Requires the parent directory to already exist too, so a typo'd
 * grandparent doesn't create an unexpected chain of new folders.
 */
export function canCreateNewProjectDir(targetDir: string): boolean {
  if (!path.isAbsolute(targetDir)) return false;
  if (existsSync(targetDir)) return false;
  return existsSync(path.dirname(targetDir));
}

/** Strips any directory component from a client-supplied filename before it's ever joined into a
 *  real path — the only thing standing between an uploaded document's name and writing outside
 *  `<targetDir>/docs/`. Falls back to a generic name for anything that resolves to nothing
 *  usable (empty, or exactly "." / ".."). */
function sanitizeFileName(filename: string): string {
  const base = path.basename(filename).trim();
  return base && base !== '.' && base !== '..' ? base : 'brief.txt';
}

/** Never overwrites a file that's already there — an "existing project" run only ever fills in
 *  what's missing, and re-running a "create" bootstrap on the same folder is naturally idempotent
 *  instead of clobbering anything a first run (or the user) already put there. Accepts a `Buffer`
 *  for a binary uploaded document (`.pdf`/`.doc`/`.docx`) alongside the plain-text case. */
function writeIfAbsent(filePath: string, content: string | Buffer, createdFiles: string[], skippedFiles: string[]): void {
  if (existsSync(filePath)) {
    skippedFiles.push(filePath);
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  createdFiles.push(filePath);
}

/** Ignores dotfiles/dot-directories (a bare `.git`, a `.gitignore`) — anything else present means
 *  the folder already has real content that a scaffold must never step on. Used only for
 *  `mode: 'existing'`; a `mode: 'create'` folder is guaranteed empty since it was just created. */
function isEffectivelyEmpty(dir: string): boolean {
  return readdirSync(dir).every((entry) => entry.startsWith('.'));
}

function buildClaudeMd(request: BootstrapRequest, stack: BootstrapStack, scaffoldRan: boolean): string {
  const lines = [`# ${request.name} — CLAUDE.md`, '', request.description || '_No description provided yet._'];

  if (request.technologies.length > 0) {
    lines.push('', `Tech stack: ${request.technologies.join(', ')}`);
  }

  if (stack === 'other') {
    lines.push('', 'No built-in scaffold template matches this stack yet — only CLAUDE.md and any attached document were generated.');
  }

  if (request.document) {
    lines.push('', `See \`docs/${sanitizeFileName(request.document.filename)}\` for the original brief this project was scoped from.`);
  }

  const commands = verifyCommandsForStack(stack);
  if (commands.length > 0) {
    if (!scaffoldRan) {
      lines.push(
        '',
        "This folder already had real content, so no scaffold files were generated — the commands below are this stack's defaults, not verified against what's actually set up here.",
      );
    }
    lines.push('', '## Commands', '', '```sh', ...commands, '```');
  }

  return `${lines.join('\n')}\n`;
}

/** `git init` only when there's no existing `.git` already — never re-initializes a real repo.
 *  Fails soft (git missing, or any other failure) the same way every adapter here treats a
 *  tool outside the daemon's own control: report it didn't happen, don't throw. */
function initGitRepo(targetDir: string): Promise<boolean> {
  if (existsSync(path.join(targetDir, '.git'))) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('git', ['init'], { cwd: targetDir }, (error) => resolve(!error));
  });
}

// Installing dependencies needs the network (npm/PyPI/Go module registries) — the one deliberate,
// explicit exception to this daemon's "zero network calls of its own" principle, and only ever
// runs when the caller opts in via `runVerification`. See root CLAUDE.md and this package's own
// CLAUDE.md for why that principle exists and why this specific carve-out was accepted anyway.
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const VERIFICATION_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * A daemon running as a launchd/systemd background service gets a bare-bones `PATH`
 * (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS, confirmed by actually running this against a real
 * launchd-managed daemon — `pnpm install` failed with `spawn pnpm ENOENT` even though `pnpm`
 * works fine in an interactive shell) — it never inherits the user's shell profile, so a tool
 * installed via nvm/Homebrew/etc. is invisible to `execFile` by bare name. Prepending the
 * directory this daemon's own Node binary lives in covers the common case where npm/npx/corepack
 * (and anything installed alongside them, e.g. corepack-enabled pnpm) sit right next to it;
 * prepending Homebrew's two standard bin directories covers most macOS installs of `uv`/`go`.
 * This is a targeted, standard-locations fix, not an attempt to search every possible install
 * location on earth.
 */
function verificationEnv(): NodeJS.ProcessEnv {
  const extraDirs = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin'];
  return { ...process.env, PATH: [...extraDirs, process.env.PATH ?? ''].join(path.delimiter) };
}

export function runVerificationCommand(command: string, cwd: string): Promise<BootstrapVerificationStep> {
  const [bin, ...args] = command.split(' ');
  return new Promise((resolve) => {
    execFile(bin!, args, { cwd, env: verificationEnv(), timeout: VERIFICATION_TIMEOUT_MS, maxBuffer: VERIFICATION_MAX_BUFFER }, (error, stdout, stderr) => {
      const combined = `${stdout}${stderr}`.trim();
      // `execFile` reports a missing binary as a bare `spawn <bin> ENOENT` — accurate but
      // meaningless to someone who doesn't recognize that error shape. `verificationEnv()`
      // already widens PATH for the common install locations it knows about; this is what's
      // left once that hasn't found the tool either — it's just not installed at all.
      const message = error && error.code === 'ENOENT' ? `${bin} not found on this machine — install it first, then try Verify again.` : error?.message;
      resolve({ command, ok: !error, output: combined || message || '' });
    });
  });
}

/** Runs every command sequentially (not `Promise.all`'d) so output stays attributable to the
 *  command that produced it and a slow install doesn't race a fast typecheck for the same
 *  terminal. Each command still runs even if an earlier one failed — a failed install usually
 *  means everything after it fails too, but seeing that plainly (rather than a single command
 *  silently skipped) is more useful than guessing which failure was the real one. */
async function runVerification(targetDir: string, stack: BootstrapStack): Promise<BootstrapVerificationStep[]> {
  const steps: BootstrapVerificationStep[] = [];
  for (const command of verifyCommandsForStack(stack)) {
    steps.push(await runVerificationCommand(command, targetDir));
  }
  return steps;
}

export interface BootstrapRequest {
  targetDir: string;
  mode: BootstrapMode;
  name: string;
  description: string;
  /** Free-form "Stack" tags (e.g. "React", "PostgreSQL", "Java") — there's no separate stack
   *  enum in the request; which of the three real scaffold templates (if any) applies is inferred
   *  from these via `inferStackFromTags`, and every tag is also recorded into the generated
   *  CLAUDE.md for reference regardless of whether it matched a template. Not validated against
   *  `TECH_TAG_CATEGORIES` — a caller can send any string. */
  technologies: string[];
  document: { filename: string; content: string; encoding: BootstrapDocumentEncoding } | null;
  initGit: boolean;
  runVerification: boolean;
}

/**
 * Assumes the caller has already validated `targetDir` against `canCreateNewProjectDir`
 * (create mode) or an existing-directory check (existing mode) — this only ever runs once
 * those preconditions hold, the same "validate at the route, act unconditionally in the
 * adapter" split every other write in this file follows.
 *
 * Whether a scaffold gets written is decided from the folder's actual real state, never from
 * `mode` alone: a `create` folder is scaffolded unconditionally (it's guaranteed empty, having
 * just been created), and an `existing` folder is scaffolded only if it turns out to have no
 * real content yet either. A populated existing project's structure already exists and isn't
 * this feature's to redesign — see `.claude/skills/project-bootstrap/SKILL.md`'s own scaffolding
 * step for the same rule. Verification only ever runs against a scaffold this call actually just
 * wrote — never against a populated existing folder, whose real tooling was never confirmed.
 */
export async function runBootstrap(request: BootstrapRequest): Promise<BootstrapResult> {
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  const stack = inferStackFromTags(request.technologies);

  if (request.mode === 'create') {
    mkdirSync(request.targetDir, { recursive: true });
  }

  if (request.document) {
    const bytes = request.document.encoding === 'base64' ? Buffer.from(request.document.content, 'base64') : request.document.content;
    writeIfAbsent(path.join(request.targetDir, 'docs', sanitizeFileName(request.document.filename)), bytes, createdFiles, skippedFiles);
  }

  const scaffoldRan = request.mode === 'create' || isEffectivelyEmpty(request.targetDir);
  if (scaffoldRan) {
    for (const file of scaffoldFilesForStack(stack, request.name, request.description)) {
      writeIfAbsent(path.join(request.targetDir, file.relativePath), file.content, createdFiles, skippedFiles);
    }
  }

  writeIfAbsent(path.join(request.targetDir, 'CLAUDE.md'), buildClaudeMd(request, stack, scaffoldRan), createdFiles, skippedFiles);

  const gitInitialized = request.initGit ? await initGitRepo(request.targetDir) : false;

  const canVerify = scaffoldRan && verifyCommandsForStack(stack).length > 0;
  const verification = request.runVerification && canVerify ? await runVerification(request.targetDir, stack) : null;

  const scaffoldSkipped = !scaffoldRan && stack !== 'none' && stack !== 'other';
  return { createdFolder: request.mode === 'create', createdFiles, skippedFiles, scaffoldSkipped, gitInitialized, verification, inferredStack: stack };
}
