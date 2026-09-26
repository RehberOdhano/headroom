import { defineConfig } from '@playwright/test';

// Drives the *built* extension (`pnpm run build` first) in a real Chromium against a stubbed
// claude.ai — no network, no real account. Extensions only load in a persistent, non-legacy
// headless context, which the spec sets up itself.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
});
