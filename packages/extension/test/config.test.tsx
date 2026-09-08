// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import { ConfigTab } from '../entrypoints/dashboard/Config.tsx';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const emptyLayer = (path: string) => ({ path, exists: false, defaultMode: null, allow: [], ask: [], deny: [] });

describe('ConfigTab', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    backgroundDefinition.main();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows its own connect-the-daemon hint when not configured', async () => {
    render(<ConfigTab />);
    expect(await screen.findByText(/manage Claude Code's permissions, hooks, skills/)).toBeTruthy();
  });

  describe('with the daemon configured', () => {
    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
    });

    it('renders global-only layers, hooks, and skills with no project selected', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: { ...emptyLayer('/home/.claude/settings.json'), exists: true, allow: ['WebFetch'] },
            project: null,
            local: null,
            hooks: [{ event: 'Stop', matcher: null, command: 'echo hi', timeout: null, statusMessage: null, source: '/home/.claude/settings.json' }],
            skills: [{ name: 'demo', description: 'A demo skill.', argumentHint: null, allowedTools: null, path: '/home/.claude/skills/demo/SKILL.md' }],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);

      expect(await screen.findByText('WebFetch')).toBeTruthy();
      expect(await screen.findByText('echo hi')).toBeTruthy();
      expect(await screen.findByText('demo')).toBeTruthy();
      // No project selected -> known-risky overrides are read-only. Override buttons are
      // icon-only now (title="Override: Deny"), not visible text, hence queryByTitle.
      expect(screen.queryByTitle('Override: Deny')).toBeNull();
    });

    it('filters permission-rule badges, known-risky commands, hooks, and skills as you type', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: { ...emptyLayer('/home/.claude/settings.json'), exists: true, allow: ['WebFetch', 'Bash(git commit *)'] },
            project: null,
            local: null,
            hooks: [
              { event: 'Stop', matcher: null, command: 'echo stop-hook', timeout: null, statusMessage: null, source: '/home/.claude/settings.json' },
              { event: 'PreToolUse', matcher: 'Edit', command: 'echo pre-edit', timeout: null, statusMessage: null, source: '/home/.claude/settings.json' },
            ],
            skills: [
              { name: 'adr', description: 'Record an architecture decision.', argumentHint: null, allowedTools: null, path: '/x/adr/SKILL.md' },
              { name: 'review', description: 'Do a code review.', argumentHint: null, allowedTools: null, path: '/x/review/SKILL.md' },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByText('WebFetch');

      fireEvent.change(screen.getByPlaceholderText('Filter rules by pattern…'), { target: { value: 'git commit' } });
      expect(screen.queryByText('WebFetch')).toBeNull();
      expect(screen.getByText('Bash(git commit *)')).toBeTruthy();

      fireEvent.change(screen.getByPlaceholderText('Filter known commands…'), { target: { value: 'force-delete' } });
      expect(screen.getByText('Force-delete files')).toBeTruthy();
      expect(screen.queryByText('Force-push')).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('Filter by event, matcher, or command…'), { target: { value: 'pre-edit' } });
      expect(screen.getByText('echo pre-edit')).toBeTruthy();
      expect(screen.queryByText('echo stop-hook')).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('Filter by name or description…'), { target: { value: 'review' } });
      expect(screen.getByText('review')).toBeTruthy();
      expect(screen.queryByText('adr')).toBeNull();
    });

    it('offers overrides once a project is selected, and posts a local override', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config/permissions') && init?.method === 'POST') {
          return jsonResponse({ ...emptyLayer('/Users/you/app/.claude/settings.local.json'), exists: true, deny: ['Bash(rm -rf *)'] });
        }
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);

      // Waits for the initial global-only /config fetch to settle before switching projects —
      // otherwise this exercises the exact stale-response race Config.tsx's `latestRequestRef`
      // guards against (an in-flight request for the old projectDir resolving after the new
      // one), which is real but not what this test is checking.
      await screen.findByText('No hooks configured in any layer.');

      const select = screen.getByDisplayValue('Global only — no project selected');
      // The real bug this guards against: getDaemonConfigProjects (which populates the
      // <option> list) is a separate, independently-timed fetch from the /config one waited
      // for above. Firing the change event before the '/Users/you/app' <option> actually
      // exists in the DOM is a silent no-op in jsdom (a native <select> ignores assigning a
      // value with no matching option), so selectedProject would just stay '' — intermittent,
      // and this repo's own component test caught it, not a hypothetical.
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(select, { target: { value: '/Users/you/app' } });

      // Override buttons are icon-only (title="Override: Deny", a unique aria-label per row) —
      // getAllByTitle matches on the literal title attribute across every row regardless of the
      // per-row accessible name.
      const denyButtons = await screen.findAllByTitle('Override: Deny');
      fireEvent.click(denyButtons[0]!);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:4317/config/permissions',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ projectDir: '/Users/you/app', pattern: 'Bash(rm -rf *)', effect: 'deny' }),
          }),
        );
      });
    });

    it('previews CLAUDE.md as rendered markdown, and lets you edit + save the source', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md/content') && init?.method === 'PUT') {
          return jsonResponse({ content: '# Edited\n' });
        }
        if (requested.includes('/config/claude-md/content')) {
          return jsonResponse({ content: '# Hello\n\nSome body text.\n' });
        }
        if (requested.includes('/config/claude-md')) {
          return jsonResponse({ files: [{ path: '/Users/you/app/CLAUDE.md', relativePath: 'CLAUDE.md' }] });
        }
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      // jsdom doesn't implement navigator.clipboard by default.
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { container } = render(<ConfigTab />);

      const select = await screen.findByDisplayValue('Global only — no project selected');
      // Wait for the '/Users/you/app' <option> to actually exist before selecting it — see the
      // matching comment in the "offers overrides" test above for why this isn't optional.
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(select, { target: { value: '/Users/you/app' } });

      // findByRole, not findByText — the section's own <h2>CLAUDE.md</h2> title shares the same
      // text as the file button (relativePath "CLAUDE.md"), and only the button has a role.
      fireEvent.click(await screen.findByRole('button', { name: 'CLAUDE.md' }));

      // Preview mode renders actual markdown, not the raw '# Hello' syntax.
      expect(await screen.findByRole('heading', { name: 'Hello', level: 1 })).toBeTruthy();
      expect(screen.queryByText('# Hello')).toBeNull();

      fireEvent.click(screen.getByText('Copy preview'));
      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Hello'));
      });

      fireEvent.click(screen.getByText('Source (.md)'));
      // Not getByRole('textbox') — the "add a custom pattern" text input in PermissionsSection
      // is also a textbox once a project is selected.
      const textarea = container.querySelector<HTMLTextAreaElement>('.md-editor')!;
      expect(textarea.value).toBe('# Hello\n\nSome body text.\n');

      fireEvent.change(textarea, { target: { value: '# Edited\n' } });
      expect(await screen.findByText(/Unsaved changes/)).toBeTruthy();

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:4317/config/claude-md/content',
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ projectDir: '/Users/you/app', path: '/Users/you/app/CLAUDE.md', content: '# Edited\n' }),
          }),
        );
      });
      expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    });

    it('surfaces an error instead of throwing when the daemon rejects /config', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        return { ok: false, status: 500 } as Response;
      });

      render(<ConfigTab />);

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
    });

    it('surfaces the daemon\'s own error message instead of a bare status code', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_query', message: '?projectDir must be an existing absolute directory' }) } as Response;
      });

      render(<ConfigTab />);

      expect(await screen.findByText('?projectDir must be an existing absolute directory')).toBeTruthy();
      expect(screen.queryByText(/Daemon returned 400/)).toBeNull();
    });

    it('does not fetch on every keystroke in the manual path field, only on explicit submit', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [] });
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: requested.includes('projectDir') ? emptyLayer('/Users/you/app/.claude/settings.json') : null,
            local: requested.includes('projectDir') ? emptyLayer('/Users/you/app/.claude/settings.local.json') : null,
            hooks: [],
            skills: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByText('No hooks configured in any layer.');
      fetchMock.mockClear();

      fireEvent.click(screen.getByText('Advanced: manual path'));
      const input = await screen.findByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(input, { target: { value: '/Users/you/app' } });

      // Typing alone must not trigger a request — this is the exact bug reported: firing a
      // fetch per keystroke against mostly-invalid intermediate paths.
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('projectDir'), expect.anything());

      fireEvent.click(screen.getByText('Use path'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining(`projectDir=${encodeURIComponent('/Users/you/app')}`),
          expect.anything(),
        );
      });
    });

    it('shows a loading indicator while switching projects, never stale or blank content', async () => {
      let resolveConfig!: (value: Response) => void;
      const pendingConfig = new Promise<Response>((resolve) => {
        resolveConfig = resolve;
      });

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config?projectDir=')) return pendingConfig;
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: null,
            local: null,
            hooks: [],
            skills: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });
      void fetchMock;

      render(<ConfigTab />);
      await screen.findByText('No hooks configured in any layer.');
      await screen.findByRole('option', { name: '/Users/you/app' });

      fireEvent.change(screen.getByDisplayValue('Global only — no project selected'), {
        target: { value: '/Users/you/app' },
      });

      expect(await screen.findByText('Loading configuration…')).toBeTruthy();
      // The previous (global-only) content must be gone immediately, not left showing stale
      // data while the new project's config is still in flight.
      expect(screen.queryByText('No hooks configured in any layer.')).toBeNull();

      resolveConfig(
        jsonResponse({
          global: emptyLayer('/home/.claude/settings.json'),
          project: emptyLayer('/Users/you/app/.claude/settings.json'),
          local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
          hooks: [],
          skills: [],
        }),
      );

      await screen.findByText('No hooks configured in any layer.');
      expect(screen.queryByText('Loading configuration…')).toBeNull();
    });

    it('selecting from the dropdown clears an active manual path, and vice versa', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/dropdown-app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        return jsonResponse({
          global: emptyLayer('/home/.claude/settings.json'),
          project: null,
          local: null,
          hooks: [],
          skills: [],
        });
      });

      render(<ConfigTab />);
      await screen.findByText('No hooks configured in any layer.');

      fireEvent.click(screen.getByText('Advanced: manual path'));
      const input = await screen.findByPlaceholderText('/absolute/path/to/project');
      fireEvent.change(input, { target: { value: '/Users/you/manual-app' } });
      fireEvent.click(screen.getByText('Use path'));

      expect(await screen.findByText(/Manual path active: \/Users\/you\/manual-app/)).toBeTruthy();
      const select = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
      expect(select.disabled).toBe(true);

      fireEvent.click(screen.getByText('Clear'));
      expect(await screen.findByText('Advanced: manual path')).toBeTruthy();
      expect(select.disabled).toBe(false);
    });
  });
});
