// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { KNOWN_RISKY_PATTERNS } from '@headroom/shared';
import backgroundDefinition from '../entrypoints/background.js';
import { NewProjectTab } from '../entrypoints/dashboard/NewProject.tsx';
import { getCustomStackTags } from '../lib/custom-stack-tags.js';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';
import { jsonResponse } from './helpers.js';

const EMPTY_LAYER = { path: '/x/.claude/settings.local.json', exists: true, defaultMode: null, allow: [], ask: [], deny: [] };

const EMPTY_DETECTION = { name: null, description: null };

// The "Stack" field's search/add input — matched by its current placeholder text.
const STACK_INPUT_PLACEHOLDER = /TypeScript, Python, React/;

/** Routes `/bootstrap` to `bootstrapResult`, `/bootstrap/detect` to `detection` (checked before
 *  the plainer `/bootstrap` match, since that substring also appears in this URL), every
 *  `/config/permissions` POST (the "apply recommended protections" loop) to a valid,
 *  always-successful layer response, and `/config/projects` (the known-directories datalist) to
 *  `projects` — defaults matching what most tests here don't care about specifically. */
function mockDaemon(
  bootstrapResult: Record<string, unknown>,
  projects: { path: string; lastActivity: string | null }[] = [],
  detection: Record<string, unknown> = EMPTY_DETECTION,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const requested = String(url);
    if (requested.includes('/config/permissions')) return jsonResponse(EMPTY_LAYER);
    if (requested.includes('/config/projects')) return jsonResponse({ projects });
    if (requested.includes('/bootstrap/detect')) return jsonResponse(detection);
    if (requested.includes('/bootstrap')) return jsonResponse(bootstrapResult);
    throw new Error(`unexpected fetch: ${requested}`);
  });
}

describe('NewProjectTab', () => {
  const onProjectReady = vi.fn();

  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    backgroundDefinition.main();
    onProjectReady.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a connect-the-daemon hint when not configured', async () => {
    render(<NewProjectTab onProjectReady={onProjectReady} />);
    expect(await screen.findByText(/set up a new project folder here/)).toBeTruthy();
  });

  describe('with the daemon configured', () => {
    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
    });

    it('refuses to submit without a folder path and a name', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Set up project'));

      expect(await screen.findByText(/folder path and a project name are required/)).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalledWith('http://127.0.0.1:4317/bootstrap', expect.anything());
    });

    it('submits the form and shows the created files', async () => {
      const fetchMock = mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md', '/tmp/x/package.json'], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));

      expect(await screen.findByText(/2 files written/)).toBeTruthy();
      expect(screen.getByText('/tmp/x/CLAUDE.md')).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/bootstrap',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            targetDir: '/tmp/x',
            mode: 'create',
            name: 'x',
            description: '',
            technologies: [],
            document: null,
            initGit: true,
            runVerification: false,
          }),
        }),
      );
    });

    it('calls onProjectReady with the submitted target dir when "Go to Guardrails" is clicked', async () => {
      mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));
      await screen.findByText(/1 file written/);

      fireEvent.click(screen.getByText('Go to Guardrails →'));

      expect(onProjectReady).toHaveBeenCalledWith('/tmp/x');
    });

    it('editing the path field after a successful setup clears the stale result instead of leaving it pointed at a new value', async () => {
      mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));
      await screen.findByText(/1 file written/);

      // Editing anything after a completed run means the shown result is stale — it disappears
      // rather than sitting next to a form the user has since changed.
      fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/somewhere-else' } });

      expect(screen.queryByText('Go to Guardrails →')).toBeNull();
      expect(screen.queryByText(/1 file written/)).toBeNull();
    });

    describe('recommended protections', () => {
      it('denies every known-risky pattern by default after a successful setup', async () => {
        const fetchMock = mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        expect(await screen.findByText(new RegExp(`${KNOWN_RISKY_PATTERNS.length} known-risky command patterns denied`))).toBeTruthy();
        for (const known of KNOWN_RISKY_PATTERNS) {
          expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:4317/config/permissions',
            expect.objectContaining({ body: JSON.stringify({ projectDir: '/tmp/x', pattern: known.pattern, effect: 'deny' }) }),
          );
        }
      });

      it('skips applying protections when the checkbox is unchecked', async () => {
        const fetchMock = mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.click(await screen.findByText(/Deny every known-risky command pattern by default/));
        fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        await screen.findByText(/1 file written/);
        expect(screen.queryByText(/known-risky command patterns denied/)).toBeNull();
        expect(fetchMock).not.toHaveBeenCalledWith('http://127.0.0.1:4317/config/permissions', expect.anything());
      });
    });

    describe('git init', () => {
      it('sends initGit: true by default and reports it in the result', async () => {
        mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [], gitInitialized: true });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        expect(await screen.findByText(/Git repository initialized/)).toBeTruthy();
      });

      it('sends initGit: false when unchecked', async () => {
        const fetchMock = mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.click(await screen.findByText('Initialize a git repository (skipped if one already exists)'));
        fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        await screen.findByText(/1 file written/);
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:4317/bootstrap',
          expect.objectContaining({ body: expect.stringContaining('"initGit":false') }),
        );
      });
    });

    describe('verification', () => {
      it('does not show the verify checkbox when no "Stack" tag is picked ("none")', async () => {
        render(<NewProjectTab onProjectReady={onProjectReady} />);
        await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        expect(screen.queryByText(/Verify the scaffold/)).toBeNull();
      });

      it('shows the verify checkbox once a tag that infers a real scaffold is picked', async () => {
        render(<NewProjectTab onProjectReady={onProjectReady} />);
        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'TypeScript' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });

        expect(await screen.findByText(/Verify the scaffold/)).toBeTruthy();
      });

      it('sends runVerification: true only when the checkbox is checked, for a real stack', async () => {
        const fetchMock = mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'TypeScript' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });

        fireEvent.click(await screen.findByText(/Verify the scaffold by installing dependencies/));
        fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        await screen.findByText(/1 file written/);
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:4317/bootstrap',
          expect.objectContaining({ body: expect.stringContaining('"runVerification":true') }),
        );
      });

      it('shows each verification step with a pass/fail indicator and its output', async () => {
        mockDaemon({
          createdFolder: true,
          createdFiles: ['/tmp/x/CLAUDE.md'],
          skippedFiles: [],
          verification: [
            { command: 'pnpm install', ok: true, output: 'added 1 package' },
            { command: 'pnpm run typecheck', ok: false, output: 'src/index.ts(1,1): error TS1005' },
          ],
        });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        expect(await screen.findByText(/✓ pnpm install/)).toBeTruthy();
        expect(await screen.findByText(/✗ pnpm run typecheck/)).toBeTruthy();
        expect(screen.getByText('added 1 package')).toBeTruthy();
        expect(screen.getByText(/error TS1005/)).toBeTruthy();
      });
    });

    describe('a "Stack" tag matching no built-in template ("other")', () => {
      it('submits successfully and reports the inferred stack in the result', async () => {
        mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [], inferredStack: 'other' });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        const techInput = screen.getByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'Rust' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });
        fireEvent.click(screen.getByText('Set up project'));

        await screen.findByText(/1 file written/);
        expect(screen.getByText(/other — no built-in template/)).toBeTruthy();
      });

      it('sends the tag as part of technologies, with no separate stack field', async () => {
        const fetchMock = mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        const techInput = screen.getByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'Rust' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });
        fireEvent.click(screen.getByText('Set up project'));

        await screen.findByText(/1 file written/);
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:4317/bootstrap',
          expect.objectContaining({ body: expect.stringContaining('"technologies":["Rust"]') }),
        );
      });
    });

    describe('newer stack tags (Java, Kotlin, C#)', () => {
      it.each([
        ['Java', 'java', 'Java'],
        ['Kotlin', 'kotlin', 'Kotlin'],
        ['C#', 'csharp', 'C#'],
      ])('picking "%s" shows the verify checkbox and reports the inferred stack', async (tag, inferredStack, label) => {
        mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [], inferredStack });
        render(<NewProjectTab onProjectReady={onProjectReady} />);

        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: tag } });
        fireEvent.keyDown(techInput, { key: 'Enter' });
        expect(await screen.findByText(/Verify the scaffold/)).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
        fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
        fireEvent.click(screen.getByText('Set up project'));

        await screen.findByText(/1 file written/);
        expect(screen.getByText(`Stack: ${label}.`)).toBeTruthy();
      });
    });

    it('shows a note when the daemon reports the scaffold was skipped for a populated existing folder', async () => {
      mockDaemon({ createdFolder: false, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [], scaffoldSkipped: true });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));

      expect(await screen.findByText(/no scaffold files were generated for it/)).toBeTruthy();
    });

    it('switches to existing-folder mode and sends mode: "existing"', async () => {
      const fetchMock = mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/existing' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'existing' } });
      fireEvent.click(screen.getByText('Set up project'));

      await screen.findByText(/0 files written/);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/bootstrap',
        expect.objectContaining({ body: expect.stringContaining('"mode":"existing"') }),
      );
    });

    it('offers known project directories as datalist suggestions only in existing-folder mode', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] }, [{ path: '/Users/x/projects/headroom', lastActivity: null }]);
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      const pathInput = (await screen.findByPlaceholderText('/absolute/path/to/project')) as HTMLInputElement;
      expect(pathInput.getAttribute('list')).toBeNull();

      fireEvent.click(screen.getByText('Use existing folder'));

      expect(pathInput.getAttribute('list')).toBe('new-project-known-dirs');
      await vi.waitFor(() => {
        expect(document.querySelector('#new-project-known-dirs option[value="/Users/x/projects/headroom"]')).toBeTruthy();
      });
    });

    it('fills in name, description, and a stack tag from a detected existing project after a short pause', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] }, [], {
        name: 'my-cli',
        description: 'a python tool',
        technologies: ['Python'],
      });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(pathInput, { target: { value: '/tmp/existing' } });

      expect(await screen.findByDisplayValue('my-cli')).toBeTruthy();
      expect(screen.getByDisplayValue('a python tool')).toBeTruthy();
      expect(screen.getByText('Python')).toBeTruthy();
      expect(screen.getByText('Filled in from the existing folder — feel free to edit.')).toBeTruthy();
    });

    it('detects without ever blurring the field — a native <datalist> pick commonly leaves it focused', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] }, [], { name: 'my-cli', description: null, technologies: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');
      pathInput.focus();
      fireEvent.change(pathInput, { target: { value: '/tmp/existing' } });

      expect(await screen.findByDisplayValue('my-cli')).toBeTruthy();
      expect(document.activeElement).toBe(pathInput);
    });

    it('replaces stale data from a previously selected existing folder when switching to a different one', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/permissions')) return jsonResponse(EMPTY_LAYER);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        if (requested.includes(encodeURIComponent('/tmp/headroom'))) {
          return jsonResponse({ name: 'headroom', description: 'a monorepo', technologies: ['Node.js', 'Next.js', 'Tailwind CSS'] });
        }
        if (requested.includes(encodeURIComponent('/tmp/portfolio'))) {
          return jsonResponse({ name: 'portfolio', description: null, technologies: ['Next.js', 'Tailwind CSS'] });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');

      fireEvent.change(pathInput, { target: { value: '/tmp/headroom' } });
      await screen.findByDisplayValue('headroom');
      expect(screen.getByDisplayValue('a monorepo')).toBeTruthy();
      expect(screen.getByText('Node.js')).toBeTruthy();

      // Switching to a different existing folder that has less info (no description, one fewer
      // tag) must fully replace the form, not leave "headroom" leftovers mixed into "portfolio"'s
      // own data — the exact bug this test guards against.
      fireEvent.change(pathInput, { target: { value: '/tmp/portfolio' } });

      expect(await screen.findByDisplayValue('portfolio')).toBeTruthy();
      expect(screen.queryByDisplayValue('a monorepo')).toBeNull();
      expect(screen.queryByText('Node.js')).toBeNull();
      expect(screen.getByText('Next.js')).toBeTruthy();
      expect(screen.getByText('Tailwind CSS')).toBeTruthy();
    });

    it('does not run detection in "Create new folder" mode', async () => {
      const fetchMock = mockDaemon({ createdFolder: true, createdFiles: [], skippedFiles: [] }, [], {
        name: 'my-cli',
        description: 'a python tool',
        technologies: ['Python'],
      });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      const pathInput = await screen.findByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(pathInput, { target: { value: '/tmp/new-thing' } });

      // Wait past the debounce window to prove detection truly never fires in this mode, not
      // just that it hadn't fired yet by the time this assertion ran.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/bootstrap/detect'), expect.anything());
    });

    it('leaves an untouched field alone when detection has no value for it', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] }, [], { name: null, description: null, technologies: ['Go'] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'kept-name' } });
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(pathInput, { target: { value: '/tmp/existing' } });

      expect(await screen.findByText('Go')).toBeTruthy();
      expect((screen.getByPlaceholderText('my-project') as HTMLInputElement).value).toBe('kept-name');
    });

    it('editing the name after an autofill clears the autofill note', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] }, [], { name: 'my-cli', description: null, technologies: ['Python'] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(pathInput, { target: { value: '/tmp/existing' } });
      await screen.findByText('Filled in from the existing folder — feel free to edit.');

      fireEvent.change(screen.getByDisplayValue('my-cli'), { target: { value: 'renamed' } });

      expect(screen.queryByText('Filled in from the existing folder — feel free to edit.')).toBeNull();
    });

    it('preserves a name edited manually after autofill when a later, different folder has no name of its own to offer', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/permissions')) return jsonResponse(EMPTY_LAYER);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        if (requested.includes(encodeURIComponent('/tmp/first'))) {
          return jsonResponse({ name: 'first-project', description: null, technologies: [] });
        }
        if (requested.includes(encodeURIComponent('/tmp/second'))) {
          return jsonResponse({ name: null, description: null, technologies: [] });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(pathInput, { target: { value: '/tmp/first' } });
      await screen.findByDisplayValue('first-project');

      // A manual edit right after autofill signals intent — this is no longer a "leftover"
      // autofill value, so a later path change (to a folder with nothing of its own to offer for
      // this field) must not silently discard it the way it would an untouched leftover.
      fireEvent.change(screen.getByDisplayValue('first-project'), { target: { value: 'my-custom-name' } });
      fireEvent.change(pathInput, { target: { value: '/tmp/second' } });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent('/tmp/second')), expect.anything());
      });
      expect(screen.getByDisplayValue('my-custom-name')).toBeTruthy();
    });

    it('merges detected technologies into the current selection without dropping a manually added one', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] }, [], {
        name: null,
        description: null,
        technologies: ['React', 'PostgreSQL'],
      });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.click(await screen.findByText('Use existing folder'));
      const techInput = screen.getByPlaceholderText(STACK_INPUT_PLACEHOLDER);
      fireEvent.change(techInput, { target: { value: 'MyInternalFramework' } });
      fireEvent.keyDown(techInput, { key: 'Enter' });
      expect(screen.getByText('MyInternalFramework')).toBeTruthy();

      const pathInput = screen.getByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(pathInput, { target: { value: '/tmp/existing' } });

      await screen.findByText('React');
      expect(screen.getByText('PostgreSQL')).toBeTruthy();
      expect(screen.getByText('MyInternalFramework')).toBeTruthy();
    });

    it('sends selected technologies in the bootstrap request body', async () => {
      const fetchMock = mockDaemon({ createdFolder: true, createdFiles: [], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      const techInput = screen.getByPlaceholderText(STACK_INPUT_PLACEHOLDER);
      fireEvent.change(techInput, { target: { value: 'React' } });
      fireEvent.keyDown(techInput, { key: 'Enter' });
      fireEvent.click(screen.getByText('Set up project'));

      await screen.findByText(/0 files written/);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/bootstrap',
        expect.objectContaining({ body: expect.stringContaining('"technologies":["React"]') }),
      );
    });

    describe('Stack tag picker', () => {
      it('adds a suggestion on click and clears the search text', async () => {
        render(<NewProjectTab onProjectReady={onProjectReady} />);
        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);

        fireEvent.change(techInput, { target: { value: 'reac' } });
        fireEvent.click(screen.getByText('React'));

        expect((techInput as HTMLInputElement).value).toBe('');
        expect(screen.getByLabelText('Remove React')).toBeTruthy();
      });

      it('adds a typed tag not in the catalog on Enter', async () => {
        render(<NewProjectTab onProjectReady={onProjectReady} />);
        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);

        fireEvent.change(techInput, { target: { value: 'MyInternalFramework' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });

        expect(screen.getByText('MyInternalFramework')).toBeTruthy();
      });

      it('removes a pill via its remove button', async () => {
        render(<NewProjectTab onProjectReady={onProjectReady} />);
        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'React' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });

        fireEvent.click(screen.getByLabelText('Remove React'));

        expect(screen.queryByText('React')).toBeNull();
      });

      it('does not add a duplicate tag', async () => {
        render(<NewProjectTab onProjectReady={onProjectReady} />);
        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'React' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });
        fireEvent.change(techInput, { target: { value: 'react' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });

        expect(screen.getAllByText('React')).toHaveLength(1);
      });

      it('remembers a custom tag as a suggestion on a fresh render, not just within the same session', async () => {
        const { unmount } = render(<NewProjectTab onProjectReady={onProjectReady} />);
        const techInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(techInput, { target: { value: 'Elixir' } });
        fireEvent.keyDown(techInput, { key: 'Enter' });

        await vi.waitFor(async () => {
          expect(await getCustomStackTags()).toContain('Elixir');
        });
        unmount();

        render(<NewProjectTab onProjectReady={onProjectReady} />);
        const freshTechInput = await screen.findByPlaceholderText(STACK_INPUT_PLACEHOLDER);
        fireEvent.change(freshTechInput, { target: { value: 'elix' } });

        expect(await screen.findByText('Elixir')).toBeTruthy();
      });
    });

    it('switching modes fully resets the form, not just the stale result', async () => {
      mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));
      await screen.findByText(/1 file written/);

      fireEvent.click(screen.getByText('Use existing folder'));

      expect(screen.queryByText('Go to Guardrails →')).toBeNull();
      expect(screen.queryByText(/1 file written/)).toBeNull();
      expect((screen.getByPlaceholderText('/absolute/path/to/project') as HTMLInputElement).value).toBe('');
      expect((screen.getByPlaceholderText('my-project') as HTMLInputElement).value).toBe('');
    });

    it('re-clicking the already-active mode does not reset anything', async () => {
      mockDaemon({ createdFolder: false, createdFiles: [], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.click(screen.getByText('Create new folder'));

      expect((screen.getByPlaceholderText('/absolute/path/to/project') as HTMLInputElement).value).toBe('/tmp/x');
    });

    it('shows the daemon error message when the request is rejected', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_body', message: 'targetDir must be an absolute path that does not already exist, with an existing parent directory' }),
      } as Response);
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));

      expect(await screen.findByText(/does not already exist/)).toBeTruthy();
    });

    it('"Start another project" resets the form and clears the result', async () => {
      mockDaemon({ createdFolder: true, createdFiles: ['/tmp/x/CLAUDE.md'], skippedFiles: [] });
      render(<NewProjectTab onProjectReady={onProjectReady} />);

      fireEvent.change(await screen.findByPlaceholderText('/absolute/path/to/project'), { target: { value: '/tmp/x' } });
      fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Set up project'));
      await screen.findByText(/1 file written/);

      fireEvent.click(screen.getByText('Start another project'));

      expect(screen.queryByText(/1 file written/)).toBeNull();
      expect(screen.queryByText('Go to Guardrails →')).toBeNull();
      expect((screen.getByPlaceholderText('/absolute/path/to/project') as HTMLInputElement).value).toBe('');
      expect((screen.getByPlaceholderText('my-project') as HTMLInputElement).value).toBe('');
    });
  });
});
