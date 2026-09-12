// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import { ConfigTab } from '../entrypoints/dashboard/Config.tsx';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';
import { jsonResponse, zeroTotals } from './helpers.js';

const emptyLayer = (path: string) => ({ path, exists: false, defaultMode: null, allow: [], ask: [], deny: [] });

describe('ConfigTab', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.configFingerprints.clear();
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
            agents: [],
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
            agents: [],
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
            agents: [],
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

    it('shows tokens/cost-per-commit once a project has both git and CLI activity', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config/git-activity')) return jsonResponse({ isGitRepo: true, commitCount: 4 });
        if (requested.includes('/aggregate?by=project')) {
          return jsonResponse({
            projects: { '-Users-you-app': [{ ...zeroTotals, totalCost: 20, date: '2026-08-01', modelBreakdowns: [], modelsUsed: [] }] },
            totals: zeroTotals,
          });
        }
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByText('No hooks configured in any layer.');
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(screen.getByDisplayValue('Global only — no project selected'), { target: { value: '/Users/you/app' } });

      expect(await screen.findByText(/\$5\.00 \/ commit this month/)).toBeTruthy();
      expect(screen.getByText(/4 commits, \$20\.00 total/)).toBeTruthy();
    });

    it('hides the per-commit stat when the project is not a git repo', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config/git-activity')) return jsonResponse({ isGitRepo: false, commitCount: 0 });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: {} });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByText('No hooks configured in any layer.');
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(screen.getByDisplayValue('Global only — no project selected'), { target: { value: '/Users/you/app' } });

      await screen.findByText('Project usage');
      expect(screen.queryByText(/\/ commit this month/)).toBeNull();
    });

    it('saves a per-project CLI budget on blur, and clearing it removes the entry', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config/git-activity')) return jsonResponse({ isGitRepo: false, commitCount: 0 });
        if (requested.includes('/aggregate?by=project')) return jsonResponse({ projects: {}, totals: {} });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByText('No hooks configured in any layer.');
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(screen.getByDisplayValue('Global only — no project selected'), { target: { value: '/Users/you/app' } });

      const budgetInput = await screen.findByLabelText(/Set monthly spend limit/);
      fireEvent.change(budgetInput, { target: { value: '30' } });
      fireEvent.blur(budgetInput);

      await waitFor(async () => {
        const settings = await extensionMessenger.sendMessage('getSettings');
        expect(settings.perProjectCliBudgets).toEqual([{ projectDir: '/Users/you/app', monthlyBudget: 30 }]);
      });

      fireEvent.change(budgetInput, { target: { value: '' } });
      fireEvent.blur(budgetInput);

      await waitFor(async () => {
        const settings = await extensionMessenger.sendMessage('getSettings');
        expect(settings.perProjectCliBudgets).toEqual([]);
      });
    });

    it('shows a project-health checklist across every known project, and jumps into Guardrails on click', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({
            projects: [
              { path: '/Users/you/healthy-app', lastActivity: null },
              { path: '/Users/you/bare-app', lastActivity: null },
            ],
          });
        }
        if (requested.includes('/config/claude-md') && !requested.includes('content')) {
          return jsonResponse({
            files: requested.includes('healthy-app') ? [{ path: '/Users/you/healthy-app/CLAUDE.md', relativePath: 'CLAUDE.md' }] : [],
          });
        }
        if (requested.includes('/config')) {
          const isHealthy = requested.includes('healthy-app');
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: isHealthy ? { ...emptyLayer('/Users/you/healthy-app/.claude/settings.json'), exists: true } : null,
            local: null,
            hooks: isHealthy ? [{ event: 'Stop', matcher: null, command: 'echo hi', timeout: null, statusMessage: null, source: 'x' }] : [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);

      await screen.findByText('Project health');
      expect(await screen.findByText('2 known projects')).toBeTruthy();

      // Row-per-project checkmarks resolve asynchronously as each project's two calls settle.
      await waitFor(() => {
        const rows = screen.getAllByRole('row');
        const healthyRow = rows.find((row) => row.textContent?.includes('healthy-app'))!;
        const bareRow = rows.find((row) => row.textContent?.includes('bare-app'))!;
        expect(healthyRow.textContent).toContain('✓');
        expect(bareRow.textContent).toContain('✗');
      });

      // Clicking a project's name in the health table selects it in the Guardrails picker below.
      fireEvent.click(screen.getByRole('button', { name: '/Users/you/healthy-app' }));
      await waitFor(() => {
        expect(screen.getByDisplayValue('/Users/you/healthy-app')).toBeTruthy();
      });
    });

    it('filters the project-health list, and caps it in a scrollable box instead of growing the page unbounded', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({
            projects: [
              { path: '/Users/you/app-one', lastActivity: null },
              { path: '/Users/you/app-two', lastActivity: null },
            ],
          });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: null,
            local: null,
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      const { container } = render(<ConfigTab />);
      await screen.findByText('Project health');

      // Capped-height scroll box, not an unbounded list — the same "scroll, don't grow the
      // page" treatment already used for permission rules, hooks, and skills below it.
      expect(container.querySelector('.project-health-scroll')).toBeTruthy();

      // Both project paths also appear as <option> text in the Guardrails picker below — use
      // getAllByText/queryAllByText throughout, not the singular form, to avoid ambiguity.
      await screen.findAllByText('/Users/you/app-two');
      fireEvent.change(screen.getByPlaceholderText('Filter by project path…'), { target: { value: 'app-one' } });

      expect(screen.getAllByText('/Users/you/app-one').length).toBeGreaterThan(0);
      // The Project Health button for app-two is gone; only the (still-unfiltered) picker
      // <option> remains — so "gone" means "no longer a button", not "no longer anywhere".
      expect(screen.queryByRole('button', { name: '/Users/you/app-two' })).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('Filter by project path…'), { target: { value: 'no-such-project' } });
      expect(screen.getByText(/No projects match/)).toBeTruthy();
    });

    it('applies all recommended protections one write at a time, never concurrently', async () => {
      // Concurrent writes would each read the same starting settings.local.json and clobber all
      // but the last to finish — this test fails if applyAllRecommended ever fires more than one
      // POST /config/permissions in flight at once.
      let inFlight = 0;
      let maxInFlight = 0;
      const appliedPatterns: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config/permissions') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { pattern: string };
          appliedPatterns.push(body.pattern);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return jsonResponse({ ...emptyLayer('/Users/you/app/.claude/settings.local.json'), exists: true, deny: [body.pattern] });
        }
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      const select = await screen.findByDisplayValue('Global only — no project selected');
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(select, { target: { value: '/Users/you/app' } });

      const applyButton = await screen.findByRole('button', { name: /Apply recommended protections \(8\)/ });
      fireEvent.click(applyButton);

      await waitFor(() => expect(appliedPatterns).toHaveLength(8));
      expect(maxInFlight).toBe(1);
      expect(new Set(appliedPatterns).size).toBe(8); // every known-risky pattern applied exactly once
    });

    it('flags a project whose permissions/hooks/skills changed since the last time it was viewed', async () => {
      // A plain flag, not a call-counter — the Project Health section (above) independently
      // fetches every known project's config too, so a counter tied to fetch invocations would
      // conflate its calls with ConfigContent's own project-switch fetch.
      let changed = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config')) {
          const isProjectFetch = requested.includes('projectDir=');
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: isProjectFetch ? emptyLayer('/Users/you/app/.claude/settings.json') : null,
            local: isProjectFetch ? emptyLayer('/Users/you/app/.claude/settings.local.json') : null,
            hooks:
              isProjectFetch && changed
                ? [{ event: 'Stop', matcher: null, command: 'echo new-hook', timeout: null, statusMessage: null, source: 'x' }]
                : [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByRole('option', { name: '/Users/you/app' });

      const select = screen.getByDisplayValue('Global only — no project selected');
      fireEvent.change(select, { target: { value: '/Users/you/app' } });
      await screen.findByText('No hooks configured in any layer.');
      // First time viewing this project — nothing to compare against yet.
      expect(screen.queryByText(/changed here since you last viewed/)).toBeNull();

      // Switch away, simulate an external edit to the project's settings.json, then switch back
      // — refreshSnapshot's project-switch effect re-fetches and re-checks against the
      // fingerprint stored from the first view above.
      fireEvent.change(select, { target: { value: '' } });
      await waitFor(() => expect(screen.getByDisplayValue('Global only — no project selected')).toBeTruthy());
      changed = true;
      fireEvent.change(select, { target: { value: '/Users/you/app' } });

      // Specific detail, not just "something changed" — the whole point of this feature.
      expect(await screen.findByText(/1 new hook changed here since you last viewed/)).toBeTruthy();

      fireEvent.click(screen.getByText('Dismiss'));
      expect(screen.queryByText(/changed here since you last viewed/)).toBeNull();
    });

    it('escalates the drift badge when a newly-allowed rule matches a known-risky pattern', async () => {
      let riskyAllowed = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config')) {
          const isProjectFetch = requested.includes('projectDir=');
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project:
              isProjectFetch && riskyAllowed
                ? { ...emptyLayer('/Users/you/app/.claude/settings.json'), exists: true, allow: ['Bash(rm -rf *)'] }
                : isProjectFetch
                  ? emptyLayer('/Users/you/app/.claude/settings.json')
                  : null,
            local: isProjectFetch ? emptyLayer('/Users/you/app/.claude/settings.local.json') : null,
            hooks: [],
            skills: [],
            agents: [],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      await screen.findByRole('option', { name: '/Users/you/app' });

      const select = screen.getByDisplayValue('Global only — no project selected');
      fireEvent.change(select, { target: { value: '/Users/you/app' } });
      await screen.findByText('No hooks configured in any layer.');

      fireEvent.change(select, { target: { value: '' } });
      await waitFor(() => expect(screen.getByDisplayValue('Global only — no project selected')).toBeTruthy());
      riskyAllowed = true;
      fireEvent.change(select, { target: { value: '/Users/you/app' } });

      const warning = await screen.findByText(/Newly allowed: Bash\(rm -rf \*\) \(Force-delete files\)/);
      expect(warning).toBeTruthy();
      expect(warning.className).toBe('error-text');
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
            agents: [],
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

    it('routes a project subagent to a different model, and shows global agents as read-only', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return jsonResponse({ projects: [{ path: '/Users/you/app', lastActivity: null }] });
        }
        if (requested.includes('/config/claude-md')) return jsonResponse({ files: [] });
        if (requested.includes('/config/agents/model') && init?.method === 'PUT') {
          return jsonResponse({
            name: 'reviewer',
            description: 'Reviews a diff.',
            model: 'haiku',
            path: '/Users/you/app/.claude/agents/reviewer.md',
            scope: 'project',
          });
        }
        if (requested.includes('/config')) {
          return jsonResponse({
            global: emptyLayer('/home/.claude/settings.json'),
            project: emptyLayer('/Users/you/app/.claude/settings.json'),
            local: emptyLayer('/Users/you/app/.claude/settings.local.json'),
            hooks: [],
            skills: [],
            agents: [
              { name: 'reviewer', description: 'Reviews a diff.', model: 'inherit', path: '/Users/you/app/.claude/agents/reviewer.md', scope: 'project' },
              { name: 'personal-helper', description: 'A global helper.', model: 'haiku', path: '/home/.claude/agents/personal-helper.md', scope: 'global' },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });

      render(<ConfigTab />);
      const select = await screen.findByDisplayValue('Global only — no project selected');
      await screen.findByRole('option', { name: '/Users/you/app' });
      fireEvent.change(select, { target: { value: '/Users/you/app' } });

      await screen.findByText('reviewer');
      // Global agent is read-only — its model shows as plain text, no <select> for it.
      expect(screen.getByText('personal-helper')).toBeTruthy();
      expect(screen.getByText(/global — read-only/)).toBeTruthy();
      expect(screen.getByText('Model: haiku')).toBeTruthy();

      const modelSelect = screen.getByDisplayValue('inherit') as HTMLSelectElement;
      fireEvent.change(modelSelect, { target: { value: 'haiku' } });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:4317/config/agents/model',
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ projectDir: '/Users/you/app', path: '/Users/you/app/.claude/agents/reviewer.md', model: 'haiku' }),
          }),
        );
      });
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
            agents: [],
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
            agents: [],
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
          agents: [],
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
          agents: [],
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
