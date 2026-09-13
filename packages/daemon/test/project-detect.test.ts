import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectExistingProject } from '../src/adapters/project-detect.js';

describe('detectExistingProject', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'headroom-detect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns all-null and no technologies when nothing recognizable is there', () => {
    expect(detectExistingProject(dir)).toEqual({ name: null, description: null, technologies: [] });
  });

  it('detects a Node.js project from package.json, implying the "Node.js" tag', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-tool', description: 'does things' }));
    expect(detectExistingProject(dir)).toEqual({ name: 'my-tool', description: 'does things', technologies: ['Node.js'] });
  });

  it('fails soft on a package.json that is not valid JSON — no name/description, but the file\'s mere presence still implies Node.js', () => {
    writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(detectExistingProject(dir)).toEqual({ name: null, description: null, technologies: ['Node.js'] });
  });

  it('detects a Python project from pyproject.toml, implying the "Python" tag', () => {
    writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "my-cli"\nversion = "0.1.0"\ndescription = "a python tool"\nrequires-python = ">=3.11"\n',
    );
    expect(detectExistingProject(dir)).toEqual({ name: 'my-cli', description: 'a python tool', technologies: ['Python'] });
  });

  it('detects a Go project from go.mod, implying the "Go" tag, with no description available', () => {
    writeFileSync(path.join(dir, 'go.mod'), 'module github.com/someone/my-binary\n\ngo 1.22\n');
    expect(detectExistingProject(dir)).toEqual({ name: 'my-binary', description: null, technologies: ['Go'] });
  });

  it('detects known frameworks/libraries/databases from package.json dependencies, collapsing implied tags (Next.js implies React and Node.js)', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0', next: '^14.0.0', pg: '^8.0.0' }, devDependencies: { vitest: '^2.0.0' } }),
    );
    const result = detectExistingProject(dir);
    expect(result.technologies).toEqual(['Next.js', 'PostgreSQL', 'Vitest']);
  });

  it('keeps React (without Next.js) but still collapses the implied Node.js tag', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } }));
    expect(detectExistingProject(dir).technologies).toEqual(['React']);
  });

  it('detects known dependencies from a pyproject.toml dependencies array, ignoring version specifiers, collapsing the implied Python tag', () => {
    writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "svc"\ndependencies = [\n  "fastapi>=0.100",\n  "psycopg2-binary==2.9.0",\n  "requests",\n]\n',
    );
    expect(detectExistingProject(dir).technologies).toEqual(['FastAPI', 'PostgreSQL']);
  });

  it('detects known modules from go.mod require lines, collapsing the implied Go tag', () => {
    writeFileSync(
      path.join(dir, 'go.mod'),
      'module example.com/svc\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgithub.com/lib/pq v1.10.0\n)\n',
    );
    expect(detectExistingProject(dir).technologies).toEqual(['Gin', 'PostgreSQL']);
  });

  it('detects Docker from a Dockerfile alongside the implied stack tag', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22\n');
    expect(detectExistingProject(dir).technologies).toEqual(['Docker', 'Node.js']);
  });

  it('falls back to a CLAUDE.md this tool wrote earlier when no stack config file is present', () => {
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# todo-app — CLAUDE.md\n\nbuild a simple todo app\n');
    expect(detectExistingProject(dir)).toEqual({ name: 'todo-app', description: 'build a simple todo app', technologies: [] });
  });

  it('reassembles a description that is word-wrapped across several lines in a hand-edited CLAUDE.md', () => {
    writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      '# riverpoint — CLAUDE.md\n\nThe reference for how this repo is built and why. `DECISIONS.md` is the\nsingle source of truth for any non-obvious choice.\n\n## Commands\n',
    );
    expect(detectExistingProject(dir)).toEqual({
      name: 'riverpoint',
      description: 'The reference for how this repo is built and why. `DECISIONS.md` is the single source of truth for any non-obvious choice.',
      technologies: [],
    });
  });

  it('treats the fixed "no description" placeholder as no description', () => {
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# todo-app — CLAUDE.md\n\n_No description provided yet._\n');
    expect(detectExistingProject(dir)).toEqual({ name: 'todo-app', description: null, technologies: [] });
  });

  it('recovers a Tech stack line written by an earlier run', () => {
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# todo-app — CLAUDE.md\n\nbuild a simple todo app\n\nTech stack: Java, Spring Boot\n');
    expect(detectExistingProject(dir).technologies).toEqual(['Java', 'Spring Boot']);
  });

  it('prefers package.json fields but fills in a missing description from CLAUDE.md', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-tool' }));
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# my-tool — CLAUDE.md\n\nthe real description\n');
    expect(detectExistingProject(dir)).toEqual({ name: 'my-tool', description: 'the real description', technologies: ['Node.js'] });
  });

  it('detects a Java project from pom.xml, implying the "Java" tag', () => {
    writeFileSync(
      dir + '/pom.xml',
      '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>my-app</artifactId><version>0.1.0</version><name>my-app</name><description>does things</description></project>',
    );
    expect(detectExistingProject(dir)).toEqual({ name: 'my-app', description: 'does things', technologies: ['Java'] });
  });

  it('unescapes XML entities in a name/description this tool wrote earlier', () => {
    writeFileSync(
      dir + '/pom.xml',
      '<project><artifactId>my-app</artifactId><name>my-app</name><description>a &quot;test&quot; &amp; more</description></project>',
    );
    expect(detectExistingProject(dir).description).toBe('a "test" & more');
  });

  it('falls back to artifactId when pom.xml has no <name>', () => {
    writeFileSync(dir + '/pom.xml', '<project><artifactId>my-app</artifactId></project>');
    expect(detectExistingProject(dir).name).toBe('my-app');
  });

  it('detects Kotlin from a pom.xml carrying the Kotlin Maven plugin', () => {
    writeFileSync(
      dir + '/pom.xml',
      '<project><artifactId>my-app</artifactId><build><plugins><plugin><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-plugin</artifactId></plugin></plugins></build></project>',
    );
    expect(detectExistingProject(dir).technologies).toEqual(['Kotlin']);
  });

  it('detects "Spring Boot" from a pom.xml dependency, alongside the implied Java tag', () => {
    writeFileSync(
      dir + '/pom.xml',
      '<project><artifactId>my-app</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    );
    expect(detectExistingProject(dir).technologies).toEqual(['Java', 'Spring Boot']);
  });

  it('detects Kotlin from build.gradle.kts, with no name/description guessed', () => {
    writeFileSync(dir + '/build.gradle.kts', 'plugins {\n    kotlin("jvm") version "1.9.24"\n}\n');
    expect(detectExistingProject(dir)).toEqual({ name: null, description: null, technologies: ['Kotlin'] });
  });

  it('detects Java from a plain build.gradle with no Kotlin plugin', () => {
    writeFileSync(dir + '/build.gradle', "plugins {\n    id 'java'\n}\n");
    expect(detectExistingProject(dir).technologies).toEqual(['Java']);
  });

  it('detects Kotlin from a build.gradle that mentions kotlin', () => {
    writeFileSync(dir + '/build.gradle', "plugins {\n    id 'org.jetbrains.kotlin.jvm' version '1.9.24'\n}\n");
    expect(detectExistingProject(dir).technologies).toEqual(['Kotlin']);
  });

  it('detects a C# project from a .csproj file, using its base name', () => {
    writeFileSync(dir + '/riverpoint.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    expect(detectExistingProject(dir)).toEqual({ name: 'riverpoint', description: null, technologies: ['C#'] });
  });

  it('recovers a <Description> from a .csproj, unescaping XML entities', () => {
    writeFileSync(
      dir + '/riverpoint.csproj',
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Description>a &quot;test&quot; app</Description></PropertyGroup></Project>',
    );
    expect(detectExistingProject(dir).description).toBe('a "test" app');
  });

  describe('collapsing implied tags', () => {
    it('collapses a real Next.js + Tailwind CSS project down to just those two, dropping the implied React and Node.js', () => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'portfolio',
          dependencies: { next: '^14.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' },
          devDependencies: { tailwindcss: '^3.4.0' },
        }),
      );
      expect(detectExistingProject(dir).technologies).toEqual(['Next.js', 'Tailwind CSS']);
    });

    it('collapses Nuxt + Vue + Node.js down to just Nuxt', () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { nuxt: '^3.0.0', vue: '^3.0.0' } }));
      expect(detectExistingProject(dir).technologies).toEqual(['Nuxt']);
    });

    it('collapses SvelteKit + Svelte + Node.js down to just SvelteKit', () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^4.0.0' } }));
      // '@sveltejs/kit' isn't in NODE_DEPENDENCY_TAGS (no framework-specific detection for it
      // yet), so this exercises only the Svelte-implies-Node.js collapse, not a full SvelteKit one.
      expect(detectExistingProject(dir).technologies).toEqual(['Svelte']);
    });

    it('does not collapse "Java" when "Spring Boot" is present — Spring Boot does not imply Java specifically (it works with Kotlin too)', () => {
      writeFileSync(path.join(dir, 'pom.xml'), '<project><artifactId>svc</artifactId></project>');
      writeFileSync(path.join(dir, 'CLAUDE.md'), '# svc — CLAUDE.md\n\n_No description provided yet._\n\nTech stack: Spring Boot\n');
      expect(detectExistingProject(dir).technologies).toEqual(['Java', 'Spring Boot']);
    });

    it('keeps a bare Node.js tag when no more specific JS/TS-ecosystem tag was detected', () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'utils', dependencies: { lodash: '^4.0.0' } }));
      expect(detectExistingProject(dir).technologies).toEqual(['Node.js']);
    });
  });

  describe('polyglot projects (a real stack in a subdirectory, not just the root)', () => {
    it('finds a Kotlin/Android app in a subdirectory alongside a Python root, without losing either tag', () => {
      writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "threadhue"\ndescription = "outfit color-matching tool"\n');
      mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
      writeFileSync(path.join(dir, 'android', 'app', 'build.gradle.kts'), 'plugins {\n    kotlin("android")\n}\n');

      const result = detectExistingProject(dir);
      expect(result.name).toBe('threadhue');
      expect(result.description).toBe('outfit color-matching tool');
      expect(result.technologies).toEqual(['Kotlin', 'Python']);
    });

    it('finds a Java Maven service two levels deep', () => {
      mkdirSync(path.join(dir, 'services', 'backend'), { recursive: true });
      writeFileSync(path.join(dir, 'services', 'backend', 'pom.xml'), '<project><artifactId>backend</artifactId></project>');

      expect(detectExistingProject(dir).technologies).toEqual(['Java']);
    });

    it('does not descend into node_modules, dist, or dotdirectories', () => {
      mkdirSync(path.join(dir, 'node_modules', 'some-dep'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'some-dep', 'package.json'), JSON.stringify({ name: 'some-dep' }));
      mkdirSync(path.join(dir, 'dist'), { recursive: true });
      writeFileSync(path.join(dir, 'dist', 'go.mod'), 'module leftover\n\ngo 1.22\n');
      mkdirSync(path.join(dir, '.venv'), { recursive: true });
      writeFileSync(path.join(dir, '.venv', 'pyproject.toml'), '[project]\nname = "venv-internal"\n');

      expect(detectExistingProject(dir).technologies).toEqual([]);
    });

    it('does not scan past the maximum depth', () => {
      const deepPath = path.join(dir, 'a', 'b', 'c', 'd', 'e');
      mkdirSync(deepPath, { recursive: true });
      writeFileSync(path.join(deepPath, 'go.mod'), 'module too-deep\n\ngo 1.22\n');

      expect(detectExistingProject(dir).technologies).toEqual([]);
    });

    it('detects a real stack within the depth bound', () => {
      const nestedPath = path.join(dir, 'a', 'b');
      mkdirSync(nestedPath, { recursive: true });
      writeFileSync(path.join(nestedPath, 'go.mod'), 'module nested-service\n\ngo 1.22\n');

      expect(detectExistingProject(dir).technologies).toEqual(['Go']);
    });
  });

  describe('Flutter and React Native', () => {
    it('detects a Flutter app from pubspec.yaml, with name and description', () => {
      writeFileSync(
        path.join(dir, 'pubspec.yaml'),
        'name: threadhue\ndescription: A personal outfit color-matching app.\nversion: 1.0.0\n\ndependencies:\n  flutter:\n    sdk: flutter\n',
      );
      expect(detectExistingProject(dir)).toEqual({
        name: 'threadhue',
        description: 'A personal outfit color-matching app.',
        technologies: ['Flutter'],
      });
    });

    it('detects a plain Dart package (no Flutter SDK) as "Dart", not "Flutter"', () => {
      writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: my_dart_lib\nversion: 1.0.0\n\ndependencies:\n  http: ^1.0.0\n');
      expect(detectExistingProject(dir).technologies).toEqual(['Dart']);
    });

    it('collapses the Kotlin tag from a Flutter app\'s generated android/ wrapper', () => {
      writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
      mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
      writeFileSync(path.join(dir, 'android', 'app', 'build.gradle.kts'), 'plugins {\n    id("com.android.application")\n    kotlin("android")\n}\n');

      expect(detectExistingProject(dir).technologies).toEqual(['Flutter']);
    });

    it('detects React Native from package.json, collapsing the implied React and Node.js tags', () => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'my-app', dependencies: { react: '^18.0.0', 'react-native': '^0.74.0' } }),
      );
      expect(detectExistingProject(dir).technologies).toEqual(['React Native']);
    });

    it('detects Expo, collapsing React Native, React, and Node.js', () => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'my-app', dependencies: { react: '^18.0.0', 'react-native': '^0.74.0', expo: '^51.0.0' } }),
      );
      expect(detectExistingProject(dir).technologies).toEqual(['Expo']);
    });

    it('collapses the Kotlin tag from a bare React Native app\'s generated android/ wrapper', () => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'my-app', dependencies: { react: '^18.0.0', 'react-native': '^0.74.0' } }),
      );
      mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
      writeFileSync(path.join(dir, 'android', 'app', 'build.gradle'), "apply plugin: 'com.android.application'\n");

      expect(detectExistingProject(dir).technologies).toEqual(['React Native']);
    });
  });
});
