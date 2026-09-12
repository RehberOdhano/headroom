import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { setBadgeBackgroundColor, setBadgeText } from '../lib/action-badge.js';

// `browser` in the extension code (bare identifier, WXT's auto-import) and `fakeBrowser` here are
// the same underlying object — mutating fakeBrowser's own properties is how a test simulates a
// manifest shape where one of `action`/`browserAction` genuinely doesn't exist, since stubbing
// `globalThis.browser` separately would not affect the binding the code actually uses.
const realAction = fakeBrowser.action;

describe('action-badge', () => {
  afterEach(() => {
    fakeBrowser.reset();
    (fakeBrowser as unknown as { action?: unknown }).action = realAction;
    delete (fakeBrowser as unknown as { browserAction?: unknown }).browserAction;
  });

  it('uses browser.action when present (MV3 — this project\'s Chrome/Edge build)', async () => {
    await setBadgeText('3');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('3');
  });

  it(
    'falls back to browser.browserAction when action is absent — the real shape of this ' +
      "project's firefox-mv2 build, where `browser` is Firefox's own native global with no " +
      '`action` property at all',
    async () => {
      const calls: { text?: string; color?: string } = {};
      (fakeBrowser as unknown as { action?: unknown }).action = undefined;
      (fakeBrowser as unknown as { browserAction?: unknown }).browserAction = {
        setBadgeText: (details: { text: string }) => {
          calls.text = details.text;
        },
        setBadgeBackgroundColor: (details: { color: string }) => {
          calls.color = details.color;
        },
      };

      await setBadgeText('5');
      await setBadgeBackgroundColor('#d64545');

      expect(calls).toEqual({ text: '5', color: '#d64545' });
    },
  );

  it('does not throw when neither action nor browserAction exists', async () => {
    (fakeBrowser as unknown as { action?: unknown }).action = undefined;
    await expect(setBadgeText('1')).resolves.toBeUndefined();
    await expect(setBadgeBackgroundColor('#fff')).resolves.toBeUndefined();
  });
});
