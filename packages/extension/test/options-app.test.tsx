// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import backgroundDefinition from '../entrypoints/background.js';
import App from '../entrypoints/options/App.tsx';
import { db } from '../lib/db.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { extensionMessenger } from '../lib/messaging.js';

describe('options App', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await db.rawRecords.clear();
    await db.limitSnapshots.clear();
    await db.meta.clear();
    extensionMessenger.removeAllListeners();
    backgroundDefinition.main();

    // jsdom doesn't implement the Blob-download APIs the export button uses — stub just
    // enough that clicking it doesn't throw, without pretending jsdom can verify a real
    // browser download.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows zero captures and a disabled export button with nothing stored', async () => {
    render(<App />);

    expect(await screen.findByText(/0 raw captures stored locally/)).toBeTruthy();
    const button = screen.getByText('Export fixtures') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows the capture count breakdown and enables export once records exist', async () => {
    await db.rawRecords.bulkAdd([
      { endpoint: 'usage', capturedAt: '2026-08-29T10:00:00Z', raw: { five_hour: { utilization: 39 } } },
      { endpoint: 'usage', capturedAt: '2026-08-29T11:00:00Z', raw: {} },
      { endpoint: 'message_limit', capturedAt: '2026-08-29T11:05:00Z', raw: {} },
    ]);

    render(<App />);

    expect(await screen.findByText(/3 raw captures stored locally/)).toBeTruthy();
    expect(await screen.findByText(/usage: 2/)).toBeTruthy();
    expect(await screen.findByText(/message_limit: 1/)).toBeTruthy();
    expect(await screen.findByText(/Last capture: 2026-08-29T11:05:00Z/)).toBeTruthy();

    const button = screen.getByText('Export fixtures') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('clicking export builds a redacted JSON blob without throwing', async () => {
    await db.rawRecords.add({
      endpoint: 'usage',
      capturedAt: '2026-08-29T10:00:00Z',
      raw: { session_id: 'should-be-redacted', five_hour: { utilization: 39 } },
    });

    render(<App />);
    const button = await screen.findByText('Export fixtures');

    // jsdom's Blob doesn't implement .text()/.arrayBuffer(), so read the content back the only
    // way available here: capture the parts passed to the real Blob constructor.
    const RealBlob = globalThis.Blob;
    let capturedParts: BlobPart[] = [];
    globalThis.Blob = class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        capturedParts = parts;
      }
    } as typeof Blob;

    try {
      fireEvent.click(button);
    } finally {
      globalThis.Blob = RealBlob;
    }

    const content = capturedParts.join('');
    expect(content).toContain('"endpoint": "usage"');
    expect(content).not.toContain('should-be-redacted');
  });

  it('shows a setup checklist flagging what is still missing on a fresh install', async () => {
    render(<App />);

    expect(await screen.findByText(/Setup status \(0\/3\)/)).toBeTruthy();
    expect(screen.getByText(/Visited claude.ai once/)).toBeTruthy();
    expect(screen.getByText(/First usage snapshot captured/)).toBeTruthy();
    expect(screen.getByText(/Local daemon paired/)).toBeTruthy();
    // Not paired yet, so "Daemon reachable right now" shouldn't even be listed.
    expect(screen.queryByText(/Daemon reachable right now/)).toBeNull();
  });

  it('hides the setup checklist entirely once everything is done', async () => {
    await db.meta.put({ key: 'orgId', value: 'org-1' });
    await db.limitSnapshots.add({
      capturedAt: '2026-08-26T17:20:00Z',
      source: 'usage',
      session: { percent: 10, resetsAt: '2026-08-27T00:00:00Z', severity: 'normal', isActive: true },
      weekly: { percent: 10, resetsAt: '2026-09-01T00:00:00Z', severity: 'normal', isActive: true },
    });
    await extensionMessenger.sendMessage('updateSettings', { daemonToken: 'existing-token', daemonUrl: 'http://127.0.0.1:4317' });
    await db.meta.put({ key: 'daemonHealth', value: JSON.stringify({ ok: true, checkedAt: new Date().toISOString() }) });

    render(<App />);

    await screen.findByText('Settings');
    expect(screen.queryByText(/Setup status/)).toBeNull();
  });

  it('shows default settings values', async () => {
    render(<App />);

    const badgeCheckbox = (await screen.findByLabelText(/Show a small usage badge/)) as HTMLInputElement;
    expect(badgeCheckbox.checked).toBe(true);

    const retentionInput = (await screen.findByLabelText(/Keep usage history for/)) as HTMLInputElement;
    expect(retentionInput.value).toBe(String(DEFAULT_SETTINGS.snapshotRetentionDays));

    expect((await screen.findByLabelText(/Warn at/)).getAttribute('value')).toBe(String(DEFAULT_SETTINGS.alertThresholds[0]));
    expect((await screen.findByLabelText(/Alert at/)).getAttribute('value')).toBe(String(DEFAULT_SETTINGS.alertThresholds[1]));

    const daemonUrlInput = (await screen.findByLabelText(/Daemon URL/)) as HTMLInputElement;
    expect(daemonUrlInput.value).toBe(DEFAULT_SETTINGS.daemonUrl);
  });

  it('toggling the badge checkbox persists the change', async () => {
    render(<App />);
    const checkbox = (await screen.findByLabelText(/Show a small usage badge/)) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);

    await vi.waitFor(() => expect(checkbox.checked).toBe(false));
    expect((await extensionMessenger.sendMessage('getSettings')).badgeEnabled).toBe(false);
  });

  it('changing the retention field persists the new value', async () => {
    render(<App />);
    const input = await screen.findByLabelText(/Keep usage history for/);

    fireEvent.change(input, { target: { value: '30' } });

    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).snapshotRetentionDays).toBe(30);
    });
  });

  it('toggling the weekly digest checkbox persists the change', async () => {
    render(<App />);
    const checkbox = (await screen.findByLabelText(/Send me a weekly usage digest/)) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).weeklyDigestEnabled).toBe(true);
    });
  });

  it('setting a CLI monthly budget persists it, and clearing the field disables it again', async () => {
    render(<App />);
    const input = await screen.findByLabelText(/Alert me if CLI spend this month exceeds/);

    fireEvent.change(input, { target: { value: '25' } });
    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).cliMonthlyBudget).toBe(25);
    });

    fireEvent.change(input, { target: { value: '' } });
    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).cliMonthlyBudget).toBeNull();
    });
  });

  it('enabling quiet hours reveals the from/until fields, hidden by default, and persists changes to them', async () => {
    render(<App />);
    const checkbox = (await screen.findByLabelText(/Don't notify me during quiet hours/)) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByLabelText('From')).toBeNull();

    fireEvent.click(checkbox);
    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).quietHoursEnabled).toBe(true);
    });

    const fromSelect = (await screen.findByLabelText('From')) as HTMLSelectElement;
    const untilSelect = (await screen.findByLabelText('Until')) as HTMLSelectElement;
    fireEvent.change(fromSelect, { target: { value: '23' } });
    fireEvent.change(untilSelect, { target: { value: '7' } });

    await vi.waitFor(async () => {
      const settings = await extensionMessenger.sendMessage('getSettings');
      expect(settings.quietHoursStart).toBe(23);
      expect(settings.quietHoursEnd).toBe(7);
    });
  });

  it('changing both threshold fields persists them sorted', async () => {
    render(<App />);
    const warnInput = await screen.findByLabelText(/Warn at/);
    const alertInput = await screen.findByLabelText(/Alert at/);

    fireEvent.change(warnInput, { target: { value: '50' } });
    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).alertThresholds).toEqual([50, 95]);
    });

    fireEvent.change(alertInput, { target: { value: '90' } });
    await vi.waitFor(async () => {
      expect((await extensionMessenger.sendMessage('getSettings')).alertThresholds).toEqual([50, 90]);
    });
  });

  it('changing the daemon URL/token persists them', async () => {
    render(<App />);
    const urlInput = await screen.findByLabelText(/Daemon URL/);
    const tokenInput = await screen.findByLabelText(/Token/);

    fireEvent.change(urlInput, { target: { value: 'http://127.0.0.1:9999' } });
    fireEvent.change(tokenInput, { target: { value: 'my-token' } });

    await vi.waitFor(async () => {
      const settings = await extensionMessenger.sendMessage('getSettings');
      expect(settings.daemonUrl).toBe('http://127.0.0.1:9999');
      expect(settings.daemonToken).toBe('my-token');
    });
  });

  it('test connection shows Connected on a successful authed response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

    render(<App />);
    fireEvent.click(await screen.findByText('Test connection'));

    expect(await screen.findByText('Connected')).toBeTruthy();
  });

  it('test connection shows an error when the daemon rejects it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    render(<App />);
    fireEvent.click(await screen.findByText('Test connection'));

    expect(await screen.findByText('Could not connect')).toBeTruthy();
  });

  it('shows "Waiting for the daemon…" with no token configured yet', async () => {
    render(<App />);

    expect(await screen.findByText('Waiting for the daemon…')).toBeTruthy();
  });

  it('clicking "Check now" auto-pairs and shows Connected automatically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'auto-paired-token' }),
    } as Response);

    render(<App />);
    fireEvent.click(await screen.findByText('Check now'));

    expect(await screen.findByText('Connected automatically')).toBeTruthy();
    expect((await extensionMessenger.sendMessage('getSettings')).daemonToken).toBe('auto-paired-token');
  });

  it('shows the daemon liveness status once paired and a health check has run', async () => {
    await extensionMessenger.sendMessage('updateSettings', { daemonToken: 'existing-token', daemonUrl: 'http://127.0.0.1:4317' });
    await db.meta.put({ key: 'daemonHealth', value: JSON.stringify({ ok: true, checkedAt: new Date().toISOString() }) });

    render(<App />);

    expect(await screen.findByText(/Daemon reachable, checked/)).toBeTruthy();
  });

  it('shows the daemon as unreachable when the last background health check failed', async () => {
    await extensionMessenger.sendMessage('updateSettings', { daemonToken: 'existing-token', daemonUrl: 'http://127.0.0.1:4317' });
    await db.meta.put({ key: 'daemonHealth', value: JSON.stringify({ ok: false, checkedAt: new Date().toISOString() }) });

    render(<App />);

    expect(await screen.findByText(/Daemon unreachable/)).toBeTruthy();
  });

  it('clicking "Check now" shows the already-paired hint when the daemon rejects it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'already_paired' }),
    } as Response);

    render(<App />);
    fireEvent.click(await screen.findByText('Check now'));

    expect(await screen.findByText(/Already paired with another extension/)).toBeTruthy();
  });
});
