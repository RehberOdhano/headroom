import { extensionMessenger } from '../lib/messaging.js';
import { barColor } from '../lib/format.js';
import type { BadgeSnapshot } from '../lib/protocol.js';

const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log('[headroom:badge]', ...args);

const BADGE_ID = 'headroom-badge';

/**
 * Optional minimal on-page badge, on by default, behind a settings toggle. Deliberately not
 * anchored to any claude.ai DOM element — a self-contained fixed-position pill can't be broken
 * by a claude.ai frontend change at all.
 */
export default defineContentScript({
  matches: ['https://claude.ai/*'],
  main() {
    void mountBadge();
  },
});

async function mountBadge(): Promise<void> {
  const settings = await extensionMessenger.sendMessage('getSettings');
  if (!settings.badgeEnabled) {
    log('badge disabled in settings, not mounting');
    return;
  }

  const el = createBadgeElement();
  document.documentElement.appendChild(el);

  const snapshot = await extensionMessenger.sendMessage('getBadgeSnapshot');
  render(el, snapshot);

  extensionMessenger.onMessage('badgeUpdate', (message) => render(el, message.data));
  log('mounted');
}

function createBadgeElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.id = BADGE_ID;
  el.title = 'Claude usage — click to view history';
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    zIndex: '2147483647',
    padding: '4px 10px',
    borderRadius: '999px',
    color: 'white',
    font: '600 12px/1.4 system-ui, sans-serif',
    cursor: 'pointer',
    boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    userSelect: 'none',
    display: 'none',
  });
  el.addEventListener('click', () => {
    void extensionMessenger.sendMessage('openDashboard');
  });
  return el;
}

function render(el: HTMLDivElement, snapshot: BadgeSnapshot | null): void {
  const bar = snapshot?.weekly ?? snapshot?.session;
  if (!bar) {
    el.style.display = 'none';
    return;
  }
  const label = snapshot?.weekly ? 'weekly' : 'session';
  el.textContent = `Claude ${label} ${bar.percent}%`;
  el.style.background = barColor(bar.severity);
  el.style.display = 'block';
}
