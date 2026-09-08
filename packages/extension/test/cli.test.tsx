// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import { CliTab, SearchTab } from '../entrypoints/dashboard/Cli.tsx';
import { db } from '../lib/db.js';
import { extensionMessenger } from '../lib/messaging.js';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('CliTab / SearchTab', () => {
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

  it('CliTab shows its own connect-the-daemon hint when not configured', async () => {
    render(<CliTab />);
    expect(await screen.findByText(/see Claude Code CLI usage and retention warnings here/)).toBeTruthy();
  });

  it('SearchTab shows a search-specific connect-the-daemon hint when not configured', async () => {
    render(<SearchTab />);
    expect(await screen.findByText(/search your Claude Code CLI sessions here/)).toBeTruthy();
  });

  describe('with the daemon configured', () => {
    beforeEach(async () => {
      await extensionMessenger.sendMessage('updateSettings', {
        daemonUrl: 'http://127.0.0.1:4317',
        daemonToken: 'test-token',
      });
    });

    it('loads more results on demand, appending rather than replacing the first page', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const requested = String(url);
        if (requested.includes('offset=0')) {
          return jsonResponse({
            matches: [{ sessionId: 'a', cwd: '/x', matchCount: 1, snippet: 'first result', lastActivity: null }],
            hasMore: true,
          });
        }
        return jsonResponse({
          matches: [{ sessionId: 'b', cwd: '/y', matchCount: 1, snippet: 'second result', lastActivity: null }],
          hasMore: false,
        });
      });

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.click(screen.getByText('Search'));

      await screen.findByText('first result');
      expect(screen.queryByText('Load more')).toBeTruthy();

      fireEvent.click(screen.getByText('Load more'));

      await screen.findByText('second result');
      expect(screen.getByText('first result')).toBeTruthy(); // appended, not replaced
      expect(screen.queryByText('Load more')).toBeNull(); // hasMore: false on the second page

      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset=0'), expect.anything());
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset=1'), expect.anything());
    });

    it('shows "No matches." for a query that finds nothing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ matches: [], hasMore: false }));

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'nothing' } });
      fireEvent.click(screen.getByText('Search'));

      expect(await screen.findByText('No matches.')).toBeTruthy();
      expect(screen.queryByText('Load more')).toBeNull();
    });

    it('surfaces an error instead of throwing when the daemon rejects the request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

      render(<SearchTab />);
      const input = await screen.findByPlaceholderText('Search session content…');
      fireEvent.change(input, { target: { value: 'hello' } });
      fireEvent.click(screen.getByText('Search'));

      expect(await screen.findByText(/Daemon returned 500/)).toBeTruthy();
    });
  });
});
