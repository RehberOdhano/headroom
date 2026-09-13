import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canCreateNewProjectDir, runBootstrap } from '../src/adapters/bootstrap.js';

describe('canCreateNewProjectDir', () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(path.join(tmpdir(), 'headroom-bootstrap-'));
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('accepts an absolute path whose parent exists and which does not exist yet', () => {
    expect(canCreateNewProjectDir(path.join(parent, 'new-project'))).toBe(true);
  });

  it('rejects a path that already exists', () => {
    expect(canCreateNewProjectDir(parent)).toBe(false);
  });

  it('rejects a relative path', () => {
    expect(canCreateNewProjectDir('new-project')).toBe(false);
  });

  it('rejects a path whose parent directory does not exist', () => {
    expect(canCreateNewProjectDir(path.join(parent, 'missing-parent', 'new-project'))).toBe(false);
  });
});

describe('runBootstrap', () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(path.join(tmpdir(), 'headroom-bootstrap-'));
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('creates the folder and writes a CLAUDE.md when mode is create', async () => {
    const targetDir = path.join(parent, 'new-project');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'My Project',
      description: 'A test project.',
      technologies: [],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(result.createdFolder).toBe(true);
    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8')).toContain('My Project');
    expect(result.createdFiles).toContain(path.join(targetDir, 'CLAUDE.md'));
    expect(result.inferredStack).toBe('none');
  });

  it('writes the uploaded document under docs/, sanitizing a path-traversal filename', async () => {
    const targetDir = path.join(parent, 'new-project');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'My Project',
      description: '',
      technologies: [],
      document: { filename: '../../etc/passwd', content: 'brief content', encoding: 'utf8' },
      initGit: false,
      runVerification: false,
    });

    const docPath = path.join(targetDir, 'docs', 'passwd');
    expect(existsSync(docPath)).toBe(true);
    expect(readFileSync(docPath, 'utf-8')).toBe('brief content');
    expect(result.createdFiles).toContain(docPath);
  });

  it('decodes a base64 document (e.g. a PDF) into real binary content', async () => {
    const targetDir = path.join(parent, 'new-project');
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'My Project',
      description: '',
      technologies: [],
      document: { filename: 'brief.pdf', content: binary.toString('base64'), encoding: 'base64' },
      initGit: false,
      runVerification: false,
    });

    const docPath = path.join(targetDir, 'docs', 'brief.pdf');
    expect(readFileSync(docPath)).toEqual(binary);
    expect(result.createdFiles).toContain(docPath);
  });

  it('infers node-typescript from a JS/TS-side tag and generates a full scaffold', async () => {
    const targetDir = path.join(parent, 'cmdtable');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'cmdtable',
      description: 'A CLI.',
      technologies: ['TypeScript'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    for (const expected of ['package.json', 'tsconfig.json', 'eslint.config.js', 'src/index.ts', 'test/index.test.ts', '.gitignore', 'pnpm-workspace.yaml']) {
      expect(existsSync(path.join(targetDir, expected))).toBe(true);
    }
    const packageJson = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
    expect(packageJson.name).toBe('cmdtable');
    expect(result.createdFiles.length).toBeGreaterThan(5);
    expect(result.inferredStack).toBe('node-typescript');
  });

  it('infers java from "Java" and generates a full Maven scaffold', async () => {
    const targetDir = path.join(parent, 'java-app');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'java-app',
      description: 'A CLI.',
      technologies: ['Java'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    for (const expected of ['pom.xml', 'src/main/java/App.java', 'src/test/java/AppTest.java', '.gitignore']) {
      expect(existsSync(path.join(targetDir, expected))).toBe(true);
    }
    const pomXml = readFileSync(path.join(targetDir, 'pom.xml'), 'utf-8');
    expect(pomXml).toContain('<artifactId>java-app</artifactId>');
    expect(result.inferredStack).toBe('java');
  });

  it('infers kotlin from "Kotlin" and generates a full Maven+Kotlin scaffold', async () => {
    const targetDir = path.join(parent, 'kotlin-app');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'kotlin-app',
      description: 'A CLI.',
      technologies: ['Kotlin'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    for (const expected of ['pom.xml', 'src/main/kotlin/App.kt', 'src/test/kotlin/AppTest.kt', '.gitignore']) {
      expect(existsSync(path.join(targetDir, expected))).toBe(true);
    }
    const pomXml = readFileSync(path.join(targetDir, 'pom.xml'), 'utf-8');
    expect(pomXml).toContain('kotlin-maven-plugin');
    expect(result.inferredStack).toBe('kotlin');
  });

  it('infers csharp from "C#" and generates a full .NET scaffold', async () => {
    const targetDir = path.join(parent, 'csharp-app');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'csharp-app',
      description: 'A CLI.',
      technologies: ['C#'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    for (const expected of ['csharp-app.csproj', 'Program.cs', 'ProgramTests.cs', '.gitignore']) {
      expect(existsSync(path.join(targetDir, expected))).toBe(true);
    }
    const csproj = readFileSync(path.join(targetDir, 'csharp-app.csproj'), 'utf-8');
    expect(csproj).toContain('<TargetFramework>net8.0</TargetFramework>');
    expect(result.inferredStack).toBe('csharp');
  });

  it('generates no scaffold files when no tags are picked ("none")', async () => {
    const targetDir = path.join(parent, 'existing-notes');
    mkdirSync(targetDir);
    const result = await runBootstrap({
      targetDir,
      mode: 'existing',
      name: 'existing-notes',
      description: '',
      technologies: [],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(existsSync(path.join(targetDir, 'package.json'))).toBe(false);
    expect(result.createdFolder).toBe(false);
    expect(result.createdFiles).toEqual([path.join(targetDir, 'CLAUDE.md')]);
    expect(result.inferredStack).toBe('none');
  });

  it('records unmatched tags in CLAUDE.md but generates no scaffold files ("other")', async () => {
    const targetDir = path.join(parent, 'rust-project');
    const result = await runBootstrap({
      targetDir,
      mode: 'create',
      name: 'rust-project',
      description: '',
      technologies: ['Rust'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(existsSync(path.join(targetDir, 'Cargo.toml'))).toBe(false);
    expect(result.createdFiles).toEqual([path.join(targetDir, 'CLAUDE.md')]);
    const claudeMd = readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('Tech stack: Rust');
    expect(claudeMd).toContain('No built-in scaffold template matches this stack yet');
    expect(result.inferredStack).toBe('other');
  });

  it('never overwrites a file that already exists in an existing project', async () => {
    const targetDir = path.join(parent, 'existing-project');
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, 'CLAUDE.md'), 'hand-written content, do not touch');

    const result = await runBootstrap({
      targetDir,
      mode: 'existing',
      name: 'existing-project',
      description: 'new description',
      technologies: [],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('hand-written content, do not touch');
    expect(result.skippedFiles).toContain(path.join(targetDir, 'CLAUDE.md'));
    expect(result.createdFiles).toEqual([]);
  });

  it('scaffolds an existing-but-empty folder exactly like a freshly created one', async () => {
    const targetDir = path.join(parent, 'empty-existing');
    mkdirSync(targetDir);

    const result = await runBootstrap({
      targetDir,
      mode: 'existing',
      name: 'empty-existing',
      description: '',
      technologies: ['TypeScript'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(existsSync(path.join(targetDir, 'package.json'))).toBe(true);
    expect(result.scaffoldSkipped).toBe(false);
  });

  it('ignores dotfiles like .git when deciding whether an existing folder is empty', async () => {
    const targetDir = path.join(parent, 'fresh-clone');
    mkdirSync(path.join(targetDir, '.git'), { recursive: true });

    const result = await runBootstrap({
      targetDir,
      mode: 'existing',
      name: 'fresh-clone',
      description: '',
      technologies: ['TypeScript'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(existsSync(path.join(targetDir, 'package.json'))).toBe(true);
    expect(result.scaffoldSkipped).toBe(false);
  });

  it('skips scaffolding a populated existing folder and reports scaffoldSkipped, but still writes CLAUDE.md', async () => {
    const targetDir = path.join(parent, 'real-python-project');
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, 'pyproject.toml'), '[project]\nname = "real"\n');

    const result = await runBootstrap({
      targetDir,
      mode: 'existing',
      name: 'real-python-project',
      description: '',
      technologies: ['TypeScript'],
      document: null,
      initGit: false,
      runVerification: false,
    });

    expect(existsSync(path.join(targetDir, 'package.json'))).toBe(false);
    expect(existsSync(path.join(targetDir, 'src', 'index.ts'))).toBe(false);
    expect(result.scaffoldSkipped).toBe(true);
    expect(result.createdFiles).toEqual([path.join(targetDir, 'CLAUDE.md')]);
    expect(readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8')).toContain('no scaffold files were generated');
  });

  it('never sets scaffoldSkipped when no tags were picked ("none"), even on a populated folder', async () => {
    const targetDir = path.join(parent, 'notes-project');
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, 'notes.txt'), 'existing notes');

    const noneResult = await runBootstrap({
      targetDir,
      mode: 'existing',
      name: 'notes-project',
      description: '',
      technologies: [],
      document: null,
      initGit: false,
      runVerification: false,
    });
    expect(noneResult.scaffoldSkipped).toBe(false);
  });

  it('is idempotent — running the same create-mode scaffold again via existing mode changes nothing further', async () => {
    const targetDir = path.join(parent, 'twice');
    const request = {
      targetDir,
      mode: 'create' as const,
      name: 'twice',
      description: '',
      technologies: ['TypeScript'],
      document: null,
      initGit: false,
      runVerification: false,
    };

    const first = await runBootstrap(request);
    const second = await runBootstrap({ ...request, mode: 'existing' as const });

    expect(first.createdFiles.length).toBeGreaterThan(0);
    // The folder is no longer empty after the first run, so the second run correctly skips
    // scaffolding rather than re-attempting (and skipping) every individual file — only
    // CLAUDE.md, the one file always attempted regardless of scaffold state, shows up here.
    expect(second.scaffoldSkipped).toBe(true);
    expect(second.createdFiles).toEqual([]);
    expect(second.skippedFiles).toEqual([path.join(targetDir, 'CLAUDE.md')]);
  });

  describe('initGit', () => {
    it('initializes a real git repo when requested and none exists yet', async () => {
      const targetDir = path.join(parent, 'git-project');
      const result = await runBootstrap({
        targetDir,
        mode: 'create',
        name: 'git-project',
        description: '',
        technologies: [],
        document: null,
        initGit: true,
        runVerification: false,
      });

      expect(result.gitInitialized).toBe(true);
      expect(existsSync(path.join(targetDir, '.git'))).toBe(true);
    });

    it('does not touch git when initGit is false', async () => {
      const targetDir = path.join(parent, 'no-git-project');
      const result = await runBootstrap({
        targetDir,
        mode: 'create',
        name: 'no-git-project',
        description: '',
        technologies: [],
        document: null,
        initGit: false,
        runVerification: false,
      });

      expect(result.gitInitialized).toBe(false);
      expect(existsSync(path.join(targetDir, '.git'))).toBe(false);
    });

    it('reports gitInitialized: false, and never re-initializes, when a .git already exists', async () => {
      const targetDir = path.join(parent, 'already-a-repo');
      mkdirSync(path.join(targetDir, '.git'), { recursive: true });
      writeFileSync(path.join(targetDir, '.git', 'marker'), 'do not touch');

      const result = await runBootstrap({
        targetDir,
        mode: 'existing',
        name: 'already-a-repo',
        description: '',
        technologies: [],
        document: null,
        initGit: true,
        runVerification: false,
      });

      expect(result.gitInitialized).toBe(false);
      expect(readFileSync(path.join(targetDir, '.git', 'marker'), 'utf-8')).toBe('do not touch');
    });
  });

  describe('runVerification gating', () => {
    it('is null when verification was not requested', async () => {
      const targetDir = path.join(parent, 'no-verify');
      const result = await runBootstrap({
        targetDir,
        mode: 'create',
        name: 'no-verify',
        description: '',
        technologies: ['TypeScript'],
        document: null,
        initGit: false,
        runVerification: false,
      });
      expect(result.verification).toBeNull();
    });

    it('is null when no tags were picked ("none"), even when requested', async () => {
      const targetDir = path.join(parent, 'none-verify');
      const result = await runBootstrap({
        targetDir,
        mode: 'create',
        name: 'none-verify',
        description: '',
        technologies: [],
        document: null,
        initGit: false,
        runVerification: true,
      });
      expect(result.verification).toBeNull();
    });

    it('is null when the scaffold was skipped for a populated existing folder, even when requested', async () => {
      const targetDir = path.join(parent, 'populated-verify');
      mkdirSync(targetDir);
      writeFileSync(path.join(targetDir, 'existing.txt'), 'real content');

      const result = await runBootstrap({
        targetDir,
        mode: 'existing',
        name: 'populated-verify',
        description: '',
        technologies: ['TypeScript'],
        document: null,
        initGit: false,
        runVerification: true,
      });
      expect(result.verification).toBeNull();
    });
  });
});
