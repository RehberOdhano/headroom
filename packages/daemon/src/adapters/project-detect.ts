import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ProjectDetectionResult } from '@headroom/shared';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Directory names skipped when scanning for stack marker files below — vendored/generated trees
// (dependencies, build output, virtualenvs) that would otherwise be scanned for nothing (a
// vendored `node_modules/some-package/package.json` isn't this project's own stack) and, for a
// real project, can be enormous. Any dotfile/dot-directory (`.git`, `.venv`, `.next`, ...) is
// skipped unconditionally on top of this list; entries here are the common heavy directories that
// don't start with a dot.
const IGNORED_SCAN_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'bin',
  'obj',
  'venv',
  '__pycache__',
  'vendor',
  'coverage',
]);

const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_DIRS = 2000;

/**
 * Walks the folder tree up to `MAX_SCAN_DEPTH` levels below `rootDir` (the root itself is depth
 * 0), skipping dotfiles/dot-directories and `IGNORED_SCAN_DIR_NAMES`, so a real project's own
 * sub-projects (e.g. `android/app/build.gradle.kts` sitting next to a Python project's root
 * `pyproject.toml`) are found without scanning vendored or built code. Returns the absolute
 * directory paths that contain at least one file `matches` accepts — callers read the specific
 * file themselves. Fails soft on any unreadable directory (permissions, a symlink loop, ...) by
 * simply not descending into it, and stops early past `MAX_SCAN_DIRS` visited directories as a
 * defensive bound against a pathologically large or deep tree.
 */
function findDirsContaining(rootDir: string, matches: (fileName: string) => boolean, maxDepth: number = MAX_SCAN_DEPTH): string[] {
  const found: string[] = [];
  let visited = 0;

  function walk(dir: string, depth: number): void {
    if (visited >= MAX_SCAN_DIRS) return;
    visited++;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && matches(entry.name))) found.push(dir);
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_SCAN_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(rootDir, 0);
  return found;
}

/** Reverses `xmlEscape` (`bootstrap-scaffolds.ts`) so a `<name>`/`<description>` this same tool
 *  wrote into a `pom.xml`/`.csproj` on an earlier run comes back as the real text, not the
 *  escaped form — `&amp;` last, or it would wrongly re-collapse an entity like `&amp;lt;` that
 *  was itself just an escaped literal ampersand followed by "lt;". */
function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Best-effort, non-exhaustive maps from a real dependency/module name to one of the curated
// `TECH_TAG_CATEGORIES` labels (packages/shared/src/bootstrap/tech-tags.ts) — matching a handful
// of well-known names, never a claim of having read or understood the project's actual code.
// Deliberately excludes the base language/runtime itself (e.g. no "Node.js"/"TypeScript" entry
// here) since `detectExistingProject` already adds an implied runtime tag when a
// package.json/pyproject.toml/go.mod is found; these are the additive frameworks, libraries, and
// datastores a bare runtime tag can't represent.
const NODE_DEPENDENCY_TAGS: Record<string, string> = {
  react: 'React',
  'react-dom': 'React',
  'react-native': 'React Native',
  expo: 'Expo',
  next: 'Next.js',
  vue: 'Vue',
  svelte: 'Svelte',
  '@angular/core': 'Angular',
  nuxt: 'Nuxt',
  '@remix-run/react': 'Remix',
  astro: 'Astro',
  tailwindcss: 'Tailwind CSS',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  vitest: 'Vitest',
  jest: 'Jest',
  playwright: 'Playwright',
  '@playwright/test': 'Playwright',
  cypress: 'Cypress',
  pg: 'PostgreSQL',
  mysql: 'MySQL',
  mysql2: 'MySQL',
  mongoose: 'MongoDB',
  mongodb: 'MongoDB',
  redis: 'Redis',
  ioredis: 'Redis',
  'aws-sdk': 'AWS',
  '@aws-sdk/client-s3': 'AWS',
  firebase: 'Firebase',
  'firebase-admin': 'Firebase',
  '@supabase/supabase-js': 'Supabase',
};

const PYTHON_DEPENDENCY_TAGS: Record<string, string> = {
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  pytest: 'pytest',
  psycopg2: 'PostgreSQL',
  'psycopg2-binary': 'PostgreSQL',
  pymongo: 'MongoDB',
  redis: 'Redis',
  boto3: 'AWS',
  'google-cloud-storage': 'Google Cloud',
};

const GO_DEPENDENCY_TAGS: Record<string, string> = {
  'gin-gonic/gin': 'Gin',
  'labstack/echo': 'Echo',
  'lib/pq': 'PostgreSQL',
  'jackc/pgx': 'PostgreSQL',
  'go-redis/redis': 'Redis',
  'mongodb/mongo-driver': 'MongoDB',
  'aws/aws-sdk-go': 'AWS',
};

/** No pom.xml parser — a plain substring check for a well-known Maven coordinate is enough to
 *  flag Spring Boot without pretending to understand the rest of the dependency tree. */
const POM_XML_DEPENDENCY_TAGS: [string, string][] = [['spring-boot-starter', 'Spring Boot']];

function detectTechnologiesFromPomXml(rootDir: string): string[] {
  const tags: string[] = [];
  for (const dir of findDirsContaining(rootDir, (name) => name === 'pom.xml')) {
    try {
      const content = readFileSync(path.join(dir, 'pom.xml'), 'utf8');
      tags.push(...POM_XML_DEPENDENCY_TAGS.filter(([marker]) => content.includes(marker)).map(([, tag]) => tag));
    } catch {
      continue;
    }
  }
  return tags;
}

/** Config files whose mere presence implies a specific piece of infrastructure — checked
 *  independently of which stack (if any) was detected, since these aren't language-specific. */
const CONFIG_FILE_NAME_TAGS: [string, string][] = [
  ['Dockerfile', 'Docker'],
  ['docker-compose.yml', 'Docker'],
  ['vercel.json', 'Vercel'],
  ['netlify.toml', 'Netlify'],
];

function sortedUnique(tags: string[]): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

/** A more specific tag already implies a more generic one — a Next.js project necessarily depends
 *  on `react`/`react-dom` (so "Next.js" + "React" always appear together, never one without the
 *  other), and the bare "Node.js" tag (added purely from `package.json`'s existence) is implied
 *  by literally any recognized JS/TS-ecosystem framework. Showing every rung of that ladder is
 *  100% predictable, not new information, so the more specific tag wins and the implied one is
 *  dropped. Only ever removes a tag that was *added by* an implying tag also present in the same
 *  set — it can't remove something the caller passed in with nothing else implying it. */
const TAG_IMPLIES: [string, string[]][] = [
  ['Next.js', ['React', 'Node.js']],
  ['Remix', ['React', 'Node.js']],
  ['Nuxt', ['Vue', 'Node.js']],
  ['SvelteKit', ['Svelte', 'Node.js']],
  ['React', ['Node.js']],
  ['Vue', ['Node.js']],
  ['Svelte', ['Node.js']],
  ['Angular', ['Node.js']],
  ['Astro', ['Node.js']],
  ['Express', ['Node.js']],
  ['Fastify', ['Node.js']],
  ['NestJS', ['Node.js']],
  ['Tailwind CSS', ['Node.js']],
  ['Vitest', ['Node.js']],
  ['Django', ['Python']],
  ['Flask', ['Python']],
  ['FastAPI', ['Python']],
  ['Gin', ['Go']],
  ['Echo', ['Go']],
  // React Native/Expo and Flutter both generate a real, working native `android/` project
  // (Gradle, Kotlin or Java) as scaffolding for the app they wrap — the recursive scan in
  // `detectImpliedStackTags` genuinely finds it, but surfacing it as an independent "Kotlin"/
  // "Java" tag would misrepresent a generated wrapper as a second, deliberately-chosen stack.
  // Each rule lists the *full* transitive implication set (not just its immediate parent) so it
  // collapses correctly regardless of `TAG_IMPLIES` iteration order.
  ['React Native', ['React', 'Node.js', 'Kotlin', 'Java']],
  ['Expo', ['React Native', 'React', 'Node.js', 'Kotlin', 'Java']],
  ['Flutter', ['Kotlin', 'Java']],
];

function collapseImpliedTags(tags: string[]): string[] {
  const set = new Set(tags);
  for (const [tag, implied] of TAG_IMPLIES) {
    if (!set.has(tag)) continue;
    for (const impliedTag of implied) set.delete(impliedTag);
  }
  return [...set];
}

function detectTechnologiesFromPackageJson(rootDir: string): string[] {
  const tags: string[] = [];
  for (const dir of findDirsContaining(rootDir, (name) => name === 'package.json')) {
    try {
      const json = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      const deps = { ...(json.dependencies as Record<string, unknown>), ...(json.devDependencies as Record<string, unknown>) };
      tags.push(...Object.keys(deps).map((name) => NODE_DEPENDENCY_TAGS[name]).filter((tag): tag is string => Boolean(tag)));
    } catch {
      continue;
    }
  }
  return tags;
}

/** Same simple line-based scan as `detectFromPyproject` — a `dependencies = [...]` array under
 *  `[project]`, one quoted requirement per entry, version specifiers stripped before matching. */
function detectTechnologiesFromPyproject(rootDir: string): string[] {
  const tags: string[] = [];
  for (const dir of findDirsContaining(rootDir, (name) => name === 'pyproject.toml')) {
    try {
      const content = readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
      const projectSection = content.split(/^\[/m).find((section) => section.startsWith('project]'));
      const dependenciesBlock = projectSection?.match(/dependencies\s*=\s*\[([^\]]*)\]/s)?.[1] ?? '';
      const requirements = [...dependenciesBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      tags.push(
        ...requirements
          .map((requirement) => requirement.split(/[<>=!~;\s]/)[0]!.toLowerCase())
          .map((name) => PYTHON_DEPENDENCY_TAGS[name])
          .filter((tag): tag is string => Boolean(tag)),
      );
    } catch {
      continue;
    }
  }
  return tags;
}

function detectTechnologiesFromGoMod(rootDir: string): string[] {
  const tags: string[] = [];
  for (const dir of findDirsContaining(rootDir, (name) => name === 'go.mod')) {
    try {
      const content = readFileSync(path.join(dir, 'go.mod'), 'utf8');
      const modulePaths = [...content.matchAll(/^\s*([\w.\-/]+)\s+v[\d.]+/gm)].map((match) => match[1]!);
      tags.push(
        ...Object.entries(GO_DEPENDENCY_TAGS)
          .filter(([knownPath]) => modulePaths.some((modulePath) => modulePath.includes(knownPath)))
          .map(([, tag]) => tag),
      );
    } catch {
      continue;
    }
  }
  return tags;
}

function detectTechnologiesFromConfigFiles(rootDir: string): string[] {
  const tags: string[] = [];
  for (const [fileName, tag] of CONFIG_FILE_NAME_TAGS) {
    if (findDirsContaining(rootDir, (name) => name === fileName).length > 0) tags.push(tag);
  }
  return tags;
}

/** Every recognized runtime/language tag ("Node.js"/"Python"/"Go"/"Java"/"Kotlin"/"C#") found
 *  *anywhere* in the tree, not just the root — a real project is often polyglot (a Python core
 *  with a Kotlin/Android app in a subfolder, say), and only ever checking the root directory
 *  meant a real, present stack was silently invisible to detection. Reuses the same per-directory
 *  classification `detectFromPomXml`/`detectFromGradle` already do for Java vs. Kotlin, just
 *  applied to every matching directory found rather than only the root. Unlike name/description
 *  (still root-only — a subproject's own identity isn't the overall project's), there's no
 *  meaningful "primary" runtime tag once several are found; all of them are real. */
function detectImpliedStackTags(rootDir: string): string[] {
  const tags = new Set<string>();
  if (findDirsContaining(rootDir, (name) => name === 'package.json').length > 0) tags.add('Node.js');
  if (findDirsContaining(rootDir, (name) => name === 'pyproject.toml').length > 0) tags.add('Python');
  if (findDirsContaining(rootDir, (name) => name === 'go.mod').length > 0) tags.add('Go');
  if (findDirsContaining(rootDir, (name) => name.endsWith('.csproj')).length > 0) tags.add('C#');
  for (const dir of findDirsContaining(rootDir, (name) => name === 'pom.xml')) {
    const detection = detectFromPomXml(dir);
    if (detection) tags.add(detection.impliedTag);
  }
  for (const dir of findDirsContaining(rootDir, (name) => name === 'build.gradle.kts' || name === 'build.gradle')) {
    const detection = detectFromGradle(dir);
    if (detection) tags.add(detection.impliedTag);
  }
  for (const dir of findDirsContaining(rootDir, (name) => name === 'pubspec.yaml')) {
    const detection = detectFromPubspec(dir);
    if (detection) tags.add(detection.impliedTag);
  }
  return [...tags];
}

interface StackFileDetection {
  /** The tag `detectExistingProject` folds into `technologies` for this stack file — a plain
   *  runtime signal ("Node.js"/"Python"/"Go"), not a claim about which frameworks are in use;
   *  those come from the dependency maps above. Matches one of `inferStackFromTags`'s own
   *  trigger tags so a re-submitted detection round-trips to the same inferred scaffold. */
  impliedTag: string;
  name: string | null;
  description: string | null;
}

/** Fails soft on anything (missing file, invalid JSON, permission denied) — same "reads a file a
 *  human hand-edits, never throws" philosophy as every other adapter in this package. */
function detectFromPackageJson(dir: string): StackFileDetection | null {
  const filePath = path.join(dir, 'package.json');
  if (!existsSync(filePath)) return null;
  try {
    const json = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    return { impliedTag: 'Node.js', name: stringField(json.name), description: stringField(json.description) };
  } catch {
    return null;
  }
}

/** No TOML dependency — `pyproject.toml`'s `[project]` table is simple enough that a line-based
 *  scan for `name = "..."` / `description = "..."` within that section is safe. Anything more
 *  exotic (multi-line strings, dynamic fields) just isn't detected, which fails soft to `null`
 *  fields rather than misparsing. */
function detectFromPyproject(dir: string): StackFileDetection | null {
  const filePath = path.join(dir, 'pyproject.toml');
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const projectSection = content.split(/^\[/m).find((section) => section.startsWith('project]'));
    const nameMatch = projectSection?.match(/^\s*name\s*=\s*"([^"]*)"/m);
    const descriptionMatch = projectSection?.match(/^\s*description\s*=\s*"([^"]*)"/m);
    return { impliedTag: 'Python', name: stringField(nameMatch?.[1]), description: stringField(descriptionMatch?.[1]) };
  } catch {
    return null;
  }
}

function detectFromGoMod(dir: string): StackFileDetection | null {
  const filePath = path.join(dir, 'go.mod');
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const modulePath = content.match(/^module\s+(\S+)/m)?.[1] ?? null;
    return { impliedTag: 'Go', name: stringField(modulePath?.split('/').pop()), description: null };
  } catch {
    return null;
  }
}

/** A `pom.xml` backs both the Java and Kotlin scaffolds — distinguished by the presence of the
 *  Kotlin Maven plugin/stdlib coordinate, the same marker a real Kotlin-on-Maven project would
 *  also carry. `<name>`/`<description>` are read the same best-effort way as `pyproject.toml`'s
 *  fields above (first top-level match, not a real XML parse), unescaped since this tool's own
 *  `xmlEscape` may have written entities into them on an earlier run. Falls back to `artifactId`
 *  for the name when no `<name>` element is present, since that's the one field every real Maven
 *  project actually has. */
function detectFromPomXml(dir: string): StackFileDetection | null {
  const filePath = path.join(dir, 'pom.xml');
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const isKotlin = content.includes('org.jetbrains.kotlin') || content.includes('kotlin-maven-plugin');
    const name = content.match(/<name>([^<]*)<\/name>/)?.[1] ?? content.match(/<artifactId>([^<]*)<\/artifactId>/)?.[1];
    const description = content.match(/<description>([^<]*)<\/description>/)?.[1];
    return {
      impliedTag: isKotlin ? 'Kotlin' : 'Java',
      name: stringField(name ? xmlUnescape(name) : null),
      description: stringField(description ? xmlUnescape(description) : null),
    };
  } catch {
    return null;
  }
}

/** Gradle build files (`build.gradle.kts`/`build.gradle`) are at least as common as Maven for a
 *  real Java/Kotlin project, but this tool only ever *generates* a Maven scaffold (no Gradle
 *  wrapper binary to honestly write) — this only implies the language tag for an existing
 *  project, it never claims a Gradle project came from here. No name/description extraction:
 *  Gradle's Groovy/Kotlin-DSL build scripts aren't a simple key-value format the way
 *  `pyproject.toml`'s `[project]` table is, so guessing at one risks misparsing more than it's
 *  worth — same "no description available" precedent as `detectFromGoMod`. */
function detectFromGradle(dir: string): StackFileDetection | null {
  const ktsPath = path.join(dir, 'build.gradle.kts');
  if (existsSync(ktsPath)) return { impliedTag: 'Kotlin', name: null, description: null };
  const groovyPath = path.join(dir, 'build.gradle');
  if (!existsSync(groovyPath)) return null;
  try {
    const content = readFileSync(groovyPath, 'utf8');
    return { impliedTag: content.includes('kotlin') ? 'Kotlin' : 'Java', name: null, description: null };
  } catch {
    return { impliedTag: 'Java', name: null, description: null };
  }
}

/** A `.csproj` has no conventional "project name" field of its own — the file's own base name
 *  (what `dotnet new` names it after the containing folder) is the closest real signal, the same
 *  way a Go module's binary name comes from its own path segment in `detectFromGoMod`. Only reads
 *  the first `.csproj` found at the folder's top level; a multi-project solution's other projects
 *  aren't this function's concern. */
function detectFromCsproj(dir: string): StackFileDetection | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const csprojName = entries.find((entry) => entry.endsWith('.csproj'));
  if (!csprojName) return null;
  try {
    const content = readFileSync(path.join(dir, csprojName), 'utf8');
    const description = content.match(/<Description>([^<]*)<\/Description>/)?.[1];
    return {
      impliedTag: 'C#',
      name: stringField(csprojName.slice(0, -'.csproj'.length)),
      description: stringField(description ? xmlUnescape(description) : null),
    };
  } catch {
    return null;
  }
}

/** A real Flutter app's `pubspec.yaml` declares its `flutter` dependency as `sdk: flutter`; a
 *  plain Dart package (no Flutter) has a `pubspec.yaml` too, just without that line — the same
 *  simple substring-based distinction `detectFromPomXml` makes between Java and Kotlin.
 *  `name:`/`description:` are plain top-level YAML keys, read the same line-based way as
 *  `pyproject.toml`'s fields (no real YAML parser) — a multi-line block-scalar description
 *  (`description: >` / `description: |`) just isn't detected, which fails soft to `null` rather
 *  than capturing the block-scalar marker itself as if it were the text. */
function detectFromPubspec(dir: string): StackFileDetection | null {
  const filePath = path.join(dir, 'pubspec.yaml');
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const isFlutter = /sdk:\s*flutter\b/.test(content);
    const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const rawDescription = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    const description = rawDescription && !rawDescription.startsWith('>') && !rawDescription.startsWith('|') ? rawDescription.replace(/^["']|["']$/g, '') : null;
    return { impliedTag: isFlutter ? 'Flutter' : 'Dart', name: stringField(name), description: stringField(description) };
  } catch {
    return null;
  }
}

/** Falls back to a CLAUDE.md this same tool wrote on an earlier run — `buildClaudeMd` in
 *  `bootstrap.ts` always emits `# <name> — CLAUDE.md` as the first line and either the real
 *  description or a fixed placeholder as the next paragraph, so re-selecting the same existing
 *  folder later recovers what was typed the first time instead of starting blank. Only fills in
 *  whatever a stack-specific config file above didn't already provide.
 *
 *  The description is read as a whole paragraph (every non-blank line up to the next blank line
 *  or heading), not just the first physical line — a hand-edited CLAUDE.md commonly word-wraps a
 *  description across several lines, and taking only the first one used to cut it off mid-
 *  sentence. Also recovers a `Tech stack: X, Y, Z` line (written by `buildClaudeMd` when
 *  `technologies` was non-empty) so tags typed on an earlier run come back too, not just
 *  name/description. */
function detectFromClaudeMd(dir: string): { name: string | null; description: string | null; technologies: string[] } | null {
  const filePath = path.join(dir, 'CLAUDE.md');
  if (!existsSync(filePath)) return null;
  try {
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim());
    const name = stringField(lines[0]?.match(/^#\s*(.+?)\s*—\s*CLAUDE\.md$/)?.[1]);

    const bodyLines = lines.slice(1);
    const paragraphStart = bodyLines.findIndex((line) => line.length > 0);
    const paragraphLines: string[] = [];
    if (paragraphStart !== -1) {
      for (const line of bodyLines.slice(paragraphStart)) {
        if (line.length === 0 || line.startsWith('#')) break;
        paragraphLines.push(line);
      }
    }
    const paragraph = paragraphLines.join(' ');
    const description = paragraph && paragraph !== '_No description provided yet._' ? paragraph : null;

    const techStackLine = bodyLines.find((line) => line.startsWith('Tech stack:'));
    const technologies = techStackLine
      ? techStackLine
          .slice('Tech stack:'.length)
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0)
      : [];

    return { name, description, technologies };
  } catch {
    return null;
  }
}

/**
 * Deterministic, no-LLM detection of an *existing* folder's already-there project info, so
 * picking a real "Use existing folder" path can prefill name/description/Stack instead of
 * starting blank — never reads or interprets anything beyond a handful of well-known config file
 * shapes. Assumes the caller has already validated `targetDir` via `isValidProjectDir`.
 *
 * Name/description come from the *root* directory only, via a priority chain — a subproject
 * found deeper in the tree isn't the overall project's identity. Every recognized runtime/
 * language tag, though, is collected from the *whole* tree (`detectImpliedStackTags`, bounded
 * depth), since a real project is often polyglot and only checking the root previously made a
 * real, present stack (e.g. a Kotlin/Android app in a subfolder next to a Python root) silently
 * invisible. There's no separate "detected stack" field either way: every implied tag folds into
 * the same `technologies` list everything else flows through, so the UI's one "Stack" tag picker
 * shows it like any other detected tag, and `inferStackFromTags` recovers a scaffold choice from
 * it on submit (from whichever of those tags, if any, matches a built-in template).
 */
export function detectExistingProject(targetDir: string): ProjectDetectionResult {
  const stackFile =
    detectFromPackageJson(targetDir) ??
    detectFromPyproject(targetDir) ??
    detectFromGoMod(targetDir) ??
    detectFromPomXml(targetDir) ??
    detectFromGradle(targetDir) ??
    detectFromCsproj(targetDir) ??
    detectFromPubspec(targetDir);
  const claudeMd = detectFromClaudeMd(targetDir);
  const technologies = sortedUnique(
    collapseImpliedTags([
      ...detectImpliedStackTags(targetDir),
      ...detectTechnologiesFromPackageJson(targetDir),
      ...detectTechnologiesFromPyproject(targetDir),
      ...detectTechnologiesFromGoMod(targetDir),
      ...detectTechnologiesFromPomXml(targetDir),
      ...detectTechnologiesFromConfigFiles(targetDir),
      ...(claudeMd?.technologies ?? []),
    ]),
  );
  return {
    name: stackFile?.name ?? claudeMd?.name ?? null,
    description: stackFile?.description ?? claudeMd?.description ?? null,
    technologies,
  };
}
