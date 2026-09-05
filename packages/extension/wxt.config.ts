import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Claude Usage Companion',
    description:
      'See Claude usage across claude.ai and Claude Code in one place, with history and forecasting.',
    // Chrome Web Store's manifest validator rejects a wildcard port (`:*`) even though Chrome
    // itself accepts it when loaded unpacked — pinned to the daemon's actual default port
    // (lib/settings.ts) instead. A daemon run with a custom PORT env var, paired with a custom
    // daemonUrl in the options page, is not covered by this and its requests will fail; that
    // combination isn't documented or exposed anywhere as a supported flow today.
    host_permissions: ['https://claude.ai/*', 'http://127.0.0.1:4317/*'],
    // "alarms" backs the periodic /usage poll; "notifications" backs threshold alerts
    // (both in entrypoints/background.ts).
    permissions: ['storage', 'alarms', 'notifications'],
  },
});
