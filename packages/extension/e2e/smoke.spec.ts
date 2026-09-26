import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(here, '../.output/chrome-mv3');
const FIXTURE = path.resolve(here, '../../../fixtures/claude-ai/usage.get.overage.json');

/** The real (anonymized) /usage capture, with the session bar pinned to a known percent and a
 *  reset a few hours out so the popup's headline is deterministic. */
function usageBody(percent: number): string {
  const body = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
    limits: { kind: string; percent: number; resets_at: string }[];
  };
  const session = body.limits.find((l) => l.kind === 'session')!;
  session.percent = percent;
  session.resets_at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  return JSON.stringify(body);
}

// The page fetches nothing on its own: the hook wraps window.fetch only once it is injected
// (document_idle), so the test triggers the request after seeing the hook report it is installed.
const USAGE_PAGE = '<!doctype html><title>stub</title><body>stub usage page</body>';
const USAGE_URL = '/api/organizations/00000000-0000-4000-8000-000000000000/usage';

/** A fresh install makes the extension open its own options page (first-install onboarding),
 *  which can interrupt a navigation the test starts at the same moment — retry rather than race. */
async function gotoExtensionPage(page: Page, file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`chrome-extension://${extensionId}/${file}`);
      return;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('interrupted by another navigation')) throw error;
      await page.waitForTimeout(500);
    }
  }
}

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'headroom-e2e-')), {
    channel: 'chromium', // full Chromium (new headless) — the headless shell can't load extensions
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  // Nothing in this suite may reach the real claude.ai: every request is fulfilled here.
  await context.route('https://claude.ai/**', (route) => {
    const url = route.request().url();
    if (/\/api\/organizations\/[^/]+\/usage/.test(url)) {
      return route.fulfill({ contentType: 'application/json', body: usageBody(50) });
    }
    return route.fulfill({ contentType: 'text/html', body: USAGE_PAGE });
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  // A fresh install makes the extension open its own options page (first-install onboarding).
  // Let that tab appear and close it before the tests drive pages, or its navigation races theirs.
  const isOnboardingTab = (url: string) => url.includes('options') && url.includes(extensionId);
  await expect
    .poll(() => context.pages().some((p) => isOnboardingTab(p.url())), { timeout: 8_000 })
    .toBe(true)
    .catch(() => undefined);
  for (const page of context.pages()) if (isOnboardingTab(page.url())) await page.close();
});

test.afterAll(async () => {
  await context?.close();
});

test('captures a claude.ai /usage response and shows it in the popup', async () => {
  const claude = await context.newPage();
  const hookInstalled = claude.waitForEvent('console', (msg) => msg.text().includes('[headroom:hook] installed'));
  await claude.goto('https://claude.ai/settings/usage');
  await hookInstalled;

  const popup = await context.newPage();
  await gotoExtensionPage(popup, 'popup.html');

  // Captured by the MAIN-world hook -> relay -> background -> Dexie -> popup's live query. The
  // background service worker can still be starting on the first run after a fresh build, and a
  // message sent before it listens is simply lost — so re-trigger the request until it lands.
  await expect(async () => {
    await claude.evaluate((url) => fetch(url).then((r) => r.json()), USAGE_URL);
    await expect(popup.getByRole('progressbar', { name: 'Session (5h)' })).toHaveAttribute('aria-valuenow', '50', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  // 50% used with a distant reset: nothing needs attention, so no headline banner.
  await expect(popup.getByRole('status')).toHaveCount(0);
  // Popup is the headline + bars only: no calendar export, no repeated per-bar forecast lines.
  await expect(popup.getByText('Add resets to calendar')).toHaveCount(0);
  await expect(popup.getByText(/At current pace/)).toHaveCount(0);
});

test('dashboard hides daemon-only tabs until the daemon is paired', async () => {
  const dashboard = await context.newPage();
  await gotoExtensionPage(dashboard, 'dashboard.html');

  await expect(dashboard.getByRole('tab', { name: 'Usage & Forecast' })).toBeVisible();
  await expect(dashboard.getByRole('tab', { name: 'CLI Attribution' })).toBeVisible();
  for (const name of ['Search', 'Guardrails', 'New Project']) {
    await expect(dashboard.getByRole('tab', { name })).toHaveCount(0);
  }
  // Snapshot captured by the previous test is on the chart, and the removed export buttons are gone.
  await expect(dashboard.getByText(/snapshots? stored locally/)).toBeVisible({ timeout: 20_000 });
  await expect(dashboard.getByRole('button', { name: /Export history/ })).toHaveCount(0);

  await dashboard.getByRole('tab', { name: 'CLI Attribution' }).click();
  await expect(dashboard.getByText(/npm install -g @rehberodhano\/claude-usage-companion-daemon/)).toBeVisible();
  // Heatmap sub-view is gone.
  await expect(dashboard.getByRole('button', { name: 'By time of day' })).toHaveCount(0);
});

test('options page offers the pace warning, off by default, and it persists', async () => {
  const options = await context.newPage();
  await gotoExtensionPage(options, 'options.html');

  const checkbox = options.getByLabel(/on pace to run out/);
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await options.reload();
  await expect(options.getByLabel(/on pace to run out/)).toBeChecked();
});
