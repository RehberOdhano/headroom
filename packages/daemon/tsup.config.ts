import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Everything else (hono, ccusage, chokidar, zod, node builtins) stays a real, separately
  // resolved dependency — ccusage in particular spawns its own per-platform native binary via
  // `require.resolve('ccusage/package.json')` (see adapters/ccusage.ts) and must stay a genuine
  // node_modules install, never inlined. `@headroom/shared` is the one exception: it's a
  // workspace-only package that's never published to npm on its own (see root CLAUDE.md), so it
  // has to be bundled directly into this output — a published
  // `@rehberodhano/claude-usage-companion-daemon` otherwise ships an unresolvable `workspace:*`
  // dependency.
  noExternal: ['@headroom/shared'],
});
