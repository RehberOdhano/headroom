/**
 * MV3 builds (this project's Chrome/Edge target) expose the toolbar-badge API as
 * `browser.action`; MV2 builds (this project's `firefox-mv2` target) expose it as
 * `browser.browserAction` instead — there is no cross-version alias. Confirmed against the
 * actual `firefox-mv2` build output: `browser` there resolves to Firefox's own native global,
 * which has no `action` property at all, so calling `browser.action.setBadgeText` directly would
 * throw on every real Firefox install. Both namespaces exist in the ambient types (they cover
 * every target this project builds for), so this just picks whichever one is actually present at
 * runtime.
 */
interface BadgeApi {
  setBadgeText: (details: { text: string }) => Promise<void> | void;
  setBadgeBackgroundColor: (details: { color: string }) => Promise<void> | void;
}

function getBadgeApi(): BadgeApi | undefined {
  const anyBrowser = browser as unknown as { action?: BadgeApi; browserAction?: BadgeApi };
  return anyBrowser.action ?? anyBrowser.browserAction;
}

export async function setBadgeText(text: string): Promise<void> {
  await getBadgeApi()?.setBadgeText({ text });
}

export async function setBadgeBackgroundColor(color: string): Promise<void> {
  await getBadgeApi()?.setBadgeBackgroundColor({ color });
}
