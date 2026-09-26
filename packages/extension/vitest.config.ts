import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  // e2e/ holds Playwright specs (`pnpm run test:e2e`), which vitest must not try to run.
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
