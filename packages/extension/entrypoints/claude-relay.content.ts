import { pageMessenger, extensionMessenger } from '../lib/messaging.js';

// See claude-hook.content.ts — same debug toggle, flip off before shipping.
const DEBUG = true;
// console.log, not console.debug — Chrome's DevTools hides "Verbose" (debug) messages under
// "Default levels" unless the user opts in, which made this invisible during testing.
const log = (...args: unknown[]) => DEBUG && console.log('[headroom:relay]', ...args);

/**
 * ISOLATED world (default) — has access to `browser.runtime`, unlike the MAIN-world hook.
 * Pure relay: receives a captured payload over window.postMessage from claude-hook.content.ts
 * and forwards it to the background service worker. No parsing, no storage here.
 */
export default defineContentScript({
  matches: ['https://claude.ai/*'],
  main() {
    log('installed — listening for captures from the page hook');
    pageMessenger.onMessage('captured', (message) => {
      log('relaying to background:', message.data.endpoint);
      extensionMessenger.sendMessage('captured', message.data).then(
        () => log('background acked:', message.data.endpoint),
        (error) => log('background not reachable (dropped):', message.data.endpoint, error),
      );
    });
  },
});
