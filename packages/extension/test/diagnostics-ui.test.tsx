// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import App from '../entrypoints/options/App.tsx';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';

const SECRET_TOKEN = 'super-secret-daemon-token-xyz';
const SECRET_ORG_ID = 'org-should-never-appear';
const ABSOLUTE_PATH = '/Users/alice/secret-project';

describe('Diagnostics', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    await db.configFingerprints.clear();
    extensionMessenger.removeAllListeners();
    backgroundDefinition.main();
    fakeBrowser.runtime.getManifest = vi.fn(() => ({ version: '0.2.2', manifest_version: 3 })) as never;

    // A real clipboard isn't available in jsdom by default.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    cleanup();
  });

  it('is collapsed by default and does not call getManifest until opened', async () => {
    const getManifest = vi.fn(() => ({ version: '0.2.2', manifest_version: 3 }));
    fakeBrowser.runtime.getManifest = getManifest as never;

    render(<App />);
    await screen.findByText('Settings');

    expect(screen.queryByText(/extension: 0\.2\.2/)).toBeNull();
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('shows the plain diagnostics fields once opened, on an empty/unconfigured install', async () => {
    render(<App />);
    await screen.findByText('Settings');

    fireEvent.click(screen.getByText('Diagnostics'));

    expect(await screen.findByText(/extension: 0\.2\.2 \(Chrome\/Edge \(MV3\)\)/)).toBeTruthy();
    expect(screen.getByText(/last capture: never/)).toBeTruthy();
    expect(screen.getByText(/snapshots stored: 0/)).toBeTruthy();
    expect(screen.getByText(/schema errors: none/)).toBeTruthy();
    expect(screen.getByText(/daemon: not configured/)).toBeTruthy();
  });

  it('shows a schema-validation failure when one has been recorded', async () => {
    await db.meta.put({
      key: 'usageParseError',
      value: JSON.stringify({ capturedAt: new Date().toISOString(), path: 'limits.0.percent', message: 'Expected number' }),
    });

    render(<App />);
    await screen.findByText('Settings');
    fireEvent.click(screen.getByText('Diagnostics'));

    expect(await screen.findByText(/schema errors: last failure/)).toBeTruthy();
  });

  describe('security: copied/rendered diagnostics never leak sensitive data', () => {
    async function setUpSensitiveState() {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonToken: SECRET_TOKEN,
        daemonUrl: 'http://127.0.0.1:4317',
      });
      await db.meta.put({ key: 'orgId', value: SECRET_ORG_ID });
      await db.meta.put({ key: 'daemonHealth', value: JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), version: '0.2.1' }) });
      // A worst-case stand-in: if a project path were ever threaded through, this must still
      // never reach rendered/copied diagnostics — the allowlist (lib/diagnostics.ts) has no
      // field for it at all, so this only proves the UI layer doesn't invent one either.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('/config/projects')) {
          return { ok: true, status: 200, json: async () => ({ projects: [{ path: ABSOLUTE_PATH, lastActivity: null }] }) } as Response;
        }
        if (requested.includes('/sessions')) {
          return { ok: true, status: 200, json: async () => ({ sessions: [], totals: { totalTokens: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } }) } as Response;
        }
        throw new Error(`unexpected fetch: ${requested}`);
      });
    }

    it('never renders the bearer token, org id, or an absolute path on screen', async () => {
      await setUpSensitiveState();
      render(<App />);
      await screen.findByText('Settings');
      fireEvent.click(screen.getByText('Diagnostics'));
      await screen.findByText(/daemon: connected/);

      const rendered = document.body.textContent ?? '';
      expect(rendered).not.toContain(SECRET_TOKEN);
      expect(rendered).not.toContain(SECRET_ORG_ID);
      expect(rendered).not.toContain(ABSOLUTE_PATH);
    });

    it('never includes the bearer token, org id, or an absolute path in the copied text', async () => {
      await setUpSensitiveState();
      render(<App />);
      await screen.findByText('Settings');
      fireEvent.click(screen.getByText('Diagnostics'));
      await screen.findByText(/daemon: connected/);

      fireEvent.click(screen.getByText('Copy diagnostics'));

      await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
      const copiedText = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;

      expect(copiedText).not.toContain(SECRET_TOKEN);
      expect(copiedText).not.toContain(SECRET_ORG_ID);
      expect(copiedText).not.toContain(ABSOLUTE_PATH);
      expect(copiedText).not.toMatch(/token/i);
      expect(copiedText).not.toMatch(/org/i);
      // The real, expected contents are still present — this isn't just an empty/broken report.
      expect(copiedText).toContain('daemon: connected');
      expect(copiedText).toContain('daemon url: http://127.0.0.1:4317');
    });
  });
});
