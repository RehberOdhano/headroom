import { defineExtensionMessaging } from '@webext-core/messaging';
import { defineWindowMessaging } from '@webext-core/messaging/page';
import type { CaptureProtocolMap, ExtensionProtocolMap } from './protocol.js';

/** MAIN world (page hook) <-> ISOLATED world (relay content script), via window.postMessage. */
export const pageMessenger = defineWindowMessaging<CaptureProtocolMap>({
  namespace: 'headroom-capture',
});

/** Relay / popup / options <-> background service worker, via browser.runtime. */
export const extensionMessenger = defineExtensionMessaging<ExtensionProtocolMap>();

/**
 * Sends one `ExtensionProtocolMap` message to a specific tab, tolerating "no content script
 * listening there" as an expected, silent outcome — for `background.ts`'s badge-update fan-out,
 * where some open claude.ai tabs legitimately won't have a badge mounted (disabled in settings,
 * still loading, or the tab closed between `tabs.query` and this call).
 *
 * Deliberately bypasses `extensionMessenger.sendMessage(type, data, tabId)` for this one case:
 * `@webext-core/messaging@4.0.0`'s tab-targeted path calls the raw `chrome.tabs.sendMessage(...)`
 * with the Promise's own `resolve` as the callback, and never reads `chrome.runtime.lastError`
 * inside it. Chrome requires that read to happen inside that exact callback, or it logs an
 * "Unchecked runtime.lastError" entry to the extension's Errors page — independently of whether
 * the resulting rejected promise is caught downstream, which doesn't retroactively mark the
 * native callback's `lastError` as read.
 *
 * `browser.tabs.sendMessage` (WXT's polyfilled global, used everywhere else in this codebase)
 * reads `lastError` inside its own internal callback before turning it into a real rejected
 * Promise, so nothing is left unread at the point Chrome checks. The envelope shape below
 * (`{id, type, data, timestamp}`) matches what the library's own generic messaging constructs
 * internally, so the receiving side's `extensionMessenger.onMessage` still understands it
 * unmodified. Delete this workaround once a `@webext-core/messaging` release fixes the gap
 * upstream — check its tab-targeted `sendMessage` for a `lastError` read.
 */
export function sendToTabIgnoringMissingReceiver<T>(type: string, data: T, tabId: number): void {
  const envelope = { id: Math.floor(Math.random() * 1e4), type, data, timestamp: Date.now() };
  browser.tabs.sendMessage(tabId, envelope).catch(() => {
    // No listener in that tab — expected and harmless, see doc comment above.
  });
}
