import { homedir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { generateToken, readOrCreateToken, TOKEN_PATH } from './auth.js';
import { installService } from './service-install.js';
import { watchSessionLogs } from './watcher.js';

const port = Number(process.env.PORT ?? 4317);
const command = process.argv[2] ?? 'start';

switch (command) {
  case 'start':
    startDaemon();
    break;
  case 'install':
    runInstall();
    break;
  case 'token':
    console.log(readOrCreateToken());
    break;
  default:
    console.error(`Unknown command "${command}". Usage: claude-usage-daemon [start|install|token]`);
    process.exit(1);
}

function startDaemon(): void {
  const token = readOrCreateToken();
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  const watcher = watchSessionLogs(claudeConfigDir);
  const app = createApp({ token, watcher });

  serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
    console.log(`daemon listening on http://127.0.0.1:${info.port}`);
    console.log(`token file: ${TOKEN_PATH}`);
    console.log('the extension pairs automatically — open its options page and it connects on its own.');
  });
}

/** Generates a fresh token, prints it once, and registers a per-platform background service
 *  that runs `claude-usage-daemon start` on login. */
function runInstall(): void {
  generateToken();
  console.log(`Generated a new token at ${TOKEN_PATH}.`);
  console.log("Open the extension's options page next — it pairs with the daemon automatically, nothing to paste.\n");
  const result = installService();
  console.log(result.message);
}
