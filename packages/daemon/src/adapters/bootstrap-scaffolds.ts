import type { BootstrapStack } from '@headroom/shared';

export interface ScaffoldFile {
  relativePath: string;
  content: string;
}

/** npm/PyPI/Go module names all reject spaces and most punctuation — one shared slug rule for
 *  every stack rather than a subtly-different regex per one. Falls back to a generic name rather
 *  than emitting an empty string when the project name is all punctuation/whitespace. */
function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'my-project';
}

/** A valid, safely-escaped JS/TS string literal for `name`/`description` values that land inside
 *  generated source files — `JSON.stringify` already produces exactly that. Java, Kotlin, and C#
 *  all use the same double-quoted string escaping for the plain ASCII content a project name or
 *  description realistically contains, so this is reused for those scaffolds too rather than
 *  writing three near-identical escapers. */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Escapes the five XML special characters for `name`/`description` values embedded in a
 *  generated `pom.xml` — order matters (`&` first, or escaping it would double-escape the
 *  ampersands just introduced by the other replacements). */
function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const NODE_CI_WORKFLOW = `name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm run test
`;

function nodeTypescriptScaffold(name: string, description: string): ScaffoldFile[] {
  const packageJson = {
    name: slugify(name),
    version: '0.1.0',
    description,
    type: 'module',
    scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run', build: 'tsc' },
    devDependencies: {
      '@eslint/js': '^9.9.0',
      '@types/node': '^22.0.0',
      eslint: '^9.9.0',
      typescript: '^5.5.0',
      'typescript-eslint': '^8.0.0',
      vitest: '^2.0.0',
    },
  };
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      declaration: true,
    },
    include: ['src', 'test'],
  };

  return [
    { relativePath: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { relativePath: 'tsconfig.json', content: `${JSON.stringify(tsconfig, null, 2)}\n` },
    {
      relativePath: 'eslint.config.js',
      content: `import js from '@eslint/js';\nimport tseslint from 'typescript-eslint';\n\nexport default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {\n  ignores: ['dist/**'],\n});\n`,
    },
    { relativePath: 'src/index.ts', content: `export function placeholder(): string {\n  return ${jsStringLiteral(name)};\n}\n` },
    {
      relativePath: 'test/index.test.ts',
      content: `import { describe, expect, it } from 'vitest';\nimport { placeholder } from '../src/index.js';\n\ndescribe('placeholder', () => {\n  it('returns the project name', () => {\n    expect(placeholder()).toBe(${jsStringLiteral(name)});\n  });\n});\n`,
    },
    { relativePath: '.gitignore', content: 'node_modules/\ndist/\n*.local\n' },
    { relativePath: 'README.md', content: `# ${name}\n\n${description}\n\n## Development\n\n\`\`\`sh\npnpm install\npnpm run test\n\`\`\`\n` },
    { relativePath: '.github/workflows/ci.yml', content: NODE_CI_WORKFLOW },
    // Recent pnpm versions refuse a dependency's postinstall script (vitest pulls in esbuild,
    // which has one) unless explicitly approved, failing the whole install with
    // "[ERR_PNPM_IGNORED_BUILDS]" otherwise — confirmed against a real pnpm 11.x install, not
    // guessed. Pre-approving it here means `pnpm install` just works on a fresh scaffold instead
    // of failing on step one; harmless on an older pnpm that has no such gate.
    {
      relativePath: 'pnpm-workspace.yaml',
      content: 'allowBuilds:\n  esbuild: true\nonlyBuiltDependencies:\n  - esbuild\n',
    },
  ];
}

const PYTHON_CI_WORKFLOW = `name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync
      - run: uv run ruff check .
      - run: uv run pytest
`;

function pythonScaffold(name: string, description: string): ScaffoldFile[] {
  const packageName = slugify(name).replace(/-/g, '_');
  return [
    {
      relativePath: 'pyproject.toml',
      content: `[project]\nname = "${slugify(name)}"\nversion = "0.1.0"\ndescription = ${JSON.stringify(description)}\nrequires-python = ">=3.11"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
    },
    { relativePath: `src/${packageName}/__init__.py`, content: `"""${description || name}"""\n` },
    { relativePath: 'tests/test_placeholder.py', content: 'def test_placeholder() -> None:\n    assert True\n' },
    { relativePath: '.gitignore', content: '__pycache__/\n.venv/\n*.pyc\n' },
    { relativePath: 'README.md', content: `# ${name}\n\n${description}\n\n## Development\n\n\`\`\`sh\nuv sync\nuv run pytest\n\`\`\`\n` },
    { relativePath: '.github/workflows/ci.yml', content: PYTHON_CI_WORKFLOW },
  ];
}

const GO_CI_WORKFLOW = `name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: go build ./...
      - run: go vet ./...
      - run: go test ./...
`;

function goScaffold(name: string, description: string): ScaffoldFile[] {
  const binaryName = slugify(name);
  return [
    { relativePath: 'go.mod', content: `module ${binaryName}\n\ngo 1.22\n` },
    { relativePath: `cmd/${binaryName}/main.go`, content: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(${jsStringLiteral(name)})\n}\n` },
    { relativePath: '.gitignore', content: '/bin/\n*.test\n' },
    {
      relativePath: 'README.md',
      content: `# ${name}\n\n${description}\n\n> \`go.mod\`'s module path (\`${binaryName}\`) is a placeholder — update it to this repository's real import path before publishing.\n\n## Development\n\n\`\`\`sh\ngo build ./...\ngo test ./...\n\`\`\`\n`,
    },
    { relativePath: '.github/workflows/ci.yml', content: GO_CI_WORKFLOW },
  ];
}

const JAVA_CI_WORKFLOW = `name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: mvn -B compile
      - run: mvn -B test
`;

/** A plain, single-module Maven project — Maven's own `pom.xml` needs no wrapper binary the way
 *  a Gradle scaffold would (`gradlew` ships as a committed jar, which isn't something this
 *  deterministic file-writer can honestly generate), so `mvn` on the caller's own PATH is all
 *  `runVerification` needs, matching every other stack's "assume the tool is installed" contract. */
function javaScaffold(name: string, description: string): ScaffoldFile[] {
  const artifactId = slugify(name);
  const pomXml = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>0.1.0</version>
  <name>${xmlEscape(name)}</name>
  <description>${xmlEscape(description)}</description>

  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`;

  return [
    { relativePath: 'pom.xml', content: pomXml },
    {
      relativePath: 'src/main/java/App.java',
      content: `public class App {\n    public static String placeholder() {\n        return ${jsStringLiteral(name)};\n    }\n\n    public static void main(String[] args) {\n        System.out.println(placeholder());\n    }\n}\n`,
    },
    {
      relativePath: 'src/test/java/AppTest.java',
      content: `import static org.junit.jupiter.api.Assertions.assertEquals;\n\nimport org.junit.jupiter.api.Test;\n\nclass AppTest {\n    @Test\n    void returnsTheProjectName() {\n        assertEquals(${jsStringLiteral(name)}, App.placeholder());\n    }\n}\n`,
    },
    { relativePath: '.gitignore', content: 'target/\n*.class\n' },
    { relativePath: 'README.md', content: `# ${name}\n\n${description}\n\n## Development\n\n\`\`\`sh\nmvn compile\nmvn test\n\`\`\`\n` },
    { relativePath: '.github/workflows/ci.yml', content: JAVA_CI_WORKFLOW },
  ];
}

const KOTLIN_CI_WORKFLOW = `name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: mvn -B compile
      - run: mvn -B test
`;

/** Kotlin via the Kotlin Maven plugin, not Gradle, for the same reason as `javaScaffold` — no
 *  wrapper binary to fake. `kotlin.test` (the JUnit5-backed variant) is used for the test file
 *  since it's the standard Kotlin-idiomatic assertion API, backed by the same JUnit 5 engine as
 *  the Java scaffold. */
function kotlinScaffold(name: string, description: string): ScaffoldFile[] {
  const artifactId = slugify(name);
  const pomXml = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>0.1.0</version>
  <name>${xmlEscape(name)}</name>
  <description>${xmlEscape(description)}</description>

  <properties>
    <kotlin.version>1.9.24</kotlin.version>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-stdlib</artifactId>
      <version>\${kotlin.version}</version>
    </dependency>
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-test-junit5</artifactId>
      <version>\${kotlin.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-engine</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <sourceDirectory>src/main/kotlin</sourceDirectory>
    <testSourceDirectory>src/test/kotlin</testSourceDirectory>
    <plugins>
      <plugin>
        <groupId>org.jetbrains.kotlin</groupId>
        <artifactId>kotlin-maven-plugin</artifactId>
        <version>\${kotlin.version}</version>
        <executions>
          <execution>
            <id>compile</id>
            <goals>
              <goal>compile</goal>
            </goals>
          </execution>
          <execution>
            <id>test-compile</id>
            <goals>
              <goal>test-compile</goal>
            </goals>
          </execution>
        </executions>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`;

  return [
    { relativePath: 'pom.xml', content: pomXml },
    {
      relativePath: 'src/main/kotlin/App.kt',
      content: `fun placeholder(): String = ${jsStringLiteral(name)}\n\nfun main() {\n    println(placeholder())\n}\n`,
    },
    {
      relativePath: 'src/test/kotlin/AppTest.kt',
      content: `import kotlin.test.Test\nimport kotlin.test.assertEquals\n\nclass AppTest {\n    @Test\n    fun returnsTheProjectName() {\n        assertEquals(${jsStringLiteral(name)}, placeholder())\n    }\n}\n`,
    },
    { relativePath: '.gitignore', content: 'target/\n*.class\n' },
    { relativePath: 'README.md', content: `# ${name}\n\n${description}\n\n## Development\n\n\`\`\`sh\nmvn compile\nmvn test\n\`\`\`\n` },
    { relativePath: '.github/workflows/ci.yml', content: KOTLIN_CI_WORKFLOW },
  ];
}

const CSHARP_CI_WORKFLOW = `name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'
      - run: dotnet build
      - run: dotnet test
`;

/** A single project rather than the more idiomatic app-plus-separate-test-project .NET layout —
 *  a second project would need a `.sln` tying them together, and this scaffold otherwise follows
 *  every other stack's "one project, tests live alongside it" shape. `dotnet build`/`dotnet test`
 *  both work unambiguously against a single `.csproj` with no solution file present. */
function csharpScaffold(name: string, description: string): ScaffoldFile[] {
  const projectName = slugify(name);
  const csproj = `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
    <Description>${xmlEscape(description)}</Description>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
    <PackageReference Include="xunit" Version="2.7.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.5.7" />
  </ItemGroup>

</Project>
`;

  return [
    { relativePath: `${projectName}.csproj`, content: csproj },
    {
      relativePath: 'Program.cs',
      content: `public class Program\n{\n    public static string Placeholder() => ${jsStringLiteral(name)};\n\n    public static void Main()\n    {\n        System.Console.WriteLine(Placeholder());\n    }\n}\n`,
    },
    {
      relativePath: 'ProgramTests.cs',
      content: `using Xunit;\n\npublic class ProgramTests\n{\n    [Fact]\n    public void ReturnsTheProjectName()\n    {\n        Assert.Equal(${jsStringLiteral(name)}, Program.Placeholder());\n    }\n}\n`,
    },
    { relativePath: '.gitignore', content: 'bin/\nobj/\n' },
    { relativePath: 'README.md', content: `# ${name}\n\n${description}\n\n## Development\n\n\`\`\`sh\ndotnet build\ndotnet test\n\`\`\`\n` },
    { relativePath: '.github/workflows/ci.yml', content: CSHARP_CI_WORKFLOW },
  ];
}

/** Deterministic, no-LLM scaffold per stack — the same defaults documented in
 *  `.claude/skills/project-bootstrap/examples/*.md`, generated as real files instead of
 *  instructions. `'none'` and `'other'` both return no scaffold files — `'none'` because there's
 *  no stack at all, `'other'` because there's a stack but no template built for it yet — only the
 *  CLAUDE.md and any uploaded document get written in either case. */
export function scaffoldFilesForStack(stack: BootstrapStack, name: string, description: string): ScaffoldFile[] {
  switch (stack) {
    case 'node-typescript':
      return nodeTypescriptScaffold(name, description);
    case 'python':
      return pythonScaffold(name, description);
    case 'go':
      return goScaffold(name, description);
    case 'java':
      return javaScaffold(name, description);
    case 'kotlin':
      return kotlinScaffold(name, description);
    case 'csharp':
      return csharpScaffold(name, description);
    case 'other':
    case 'none':
      return [];
  }
}

/** The actual install/verify commands for each stack — surfaced in the generated `CLAUDE.md` so
 *  the next step is never "figure out the tooling," matching every other command list in this
 *  codebase's own CLAUDE.md files. Empty for 'other' too — there's nothing real to suggest for a
 *  stack with no template. */
export function verifyCommandsForStack(stack: BootstrapStack): string[] {
  switch (stack) {
    case 'node-typescript':
      return ['pnpm install', 'pnpm run typecheck', 'pnpm run lint', 'pnpm run test'];
    case 'python':
      return ['uv sync', 'uv run ruff check .', 'uv run pytest'];
    case 'go':
      return ['go build ./...', 'go vet ./...', 'go test ./...'];
    case 'java':
    case 'kotlin':
      return ['mvn compile', 'mvn test'];
    case 'csharp':
      return ['dotnet build', 'dotnet test'];
    case 'other':
    case 'none':
      return [];
  }
}
