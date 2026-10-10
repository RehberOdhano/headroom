// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatChanged } from '../entrypoints/dashboard/cli/WhatChanged.tsx';
import { db } from '../lib/db.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { jsonResponse, zeroTotals } from './helpers.js';

const SETTINGS = { ...DEFAULT_SETTINGS, daemonUrl: 'http://127.0.0.1:4317', daemonToken: 'test-token' };

describe('WhatChanged', () => {
  beforeEach(async () => {
    await db.limitSnapshots.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when there is no weekly snapshot at all', async () => {
    render(<WhatChanged settings={SETTINGS} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('What changed')).toBeNull();
  });

  it('renders nothing while the daemon reports no significant findings', async () => {
    await db.limitSnapshots.add({
      capturedAt: new Date().toISOString(),
      source: 'usage',
      session: null,
      weekly: { percent: 10, resetsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), severity: 'normal', isActive: true },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('by=day')) return jsonResponse({ daily: [], totals: zeroTotals });
      if (u.includes('by=project')) return jsonResponse({ projects: {}, totals: zeroTotals });
      if (u.includes('by=model')) return jsonResponse({ models: [] });
      if (u.includes('/sessions')) return jsonResponse({ sessions: [], totals: zeroTotals });
      throw new Error(`unexpected fetch: ${u}`);
    });

    render(<WhatChanged settings={SETTINGS} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('What changed')).toBeNull();
  });

  it('renders findings once the daemon reports a significant one', async () => {
    await db.limitSnapshots.add({
      capturedAt: new Date().toISOString(),
      source: 'usage',
      session: null,
      weekly: { percent: 10, resetsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), severity: 'normal', isActive: true },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('by=day')) return jsonResponse({ daily: [], totals: { ...zeroTotals, totalTokens: 1000 } });
      if (u.includes('by=project')) {
        return jsonResponse({
          projects: { 'payments-api': [{ date: '2026-08-01', totalTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, modelBreakdowns: [], modelsUsed: [], totalCost: 0 }] },
          totals: zeroTotals,
        });
      }
      if (u.includes('by=model')) return jsonResponse({ models: [] });
      if (u.includes('/sessions')) return jsonResponse({ sessions: [], totals: zeroTotals });
      throw new Error(`unexpected fetch: ${u}`);
    });

    render(<WhatChanged settings={SETTINGS} />);
    expect(await screen.findByText('What changed')).toBeTruthy();
    expect(await screen.findByText(/payments-api represents 50% of observed CLI activity this window/)).toBeTruthy();
  });
});
