import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Claude Usage Companion',
    description:
      'See Claude usage across claude.ai and Claude Code in one place, with history and forecasting.',
    host_permissions: ['https://claude.ai/*', 'http://127.0.0.1:*/*'],
    // "alarms" backs the periodic /usage poll; "notifications" backs threshold alerts
    // (both in entrypoints/background.ts).
    permissions: ['storage', 'alarms', 'notifications'],
  },
});
