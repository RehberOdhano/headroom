import { pageMessenger } from '../lib/messaging.js';
import { SseFrameBuffer, type SseFrame } from '../lib/sse.js';
import { pickFreshRateLimitEvent, type CodeEventEnvelope } from '../lib/code-events.js';
import type { CapturedPayload } from '../lib/protocol.js';

/**
 * Runs in the MAIN world (the actual claude.ai page realm), so it can wrap the page's own
 * `window.fetch`. An ISOLATED-world content script (claude-relay.content.ts) cannot see or
 * intercept the page's fetch calls — only this one can.
 *
 * Capture-mode only: this never touches the DOM and never alters what the page receives —
 * every response is cloned before being read, so a bug here can drop a capture but must
 * never break claude.ai itself.
 */
// Toggle for local testing. Flip off before shipping.
const DEBUG = true;
// console.log, not console.debug — Chrome's DevTools hides "Verbose" (debug) messages under
// "Default levels" unless the user opts in, which made this invisible during testing.
const log = (...args: unknown[]) => DEBUG && console.log('[headroom:hook]', ...args);

const ORG_ID_PATTERN = /\/api\/organizations\/([^/]+)\//;

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  world: 'MAIN',
  main() {
    log('installed — wrapping window.fetch');
    const originalFetch = window.fetch.bind(window);
    // See captureCodeEvents below — tracks the latest rate_limit_event `created_at` forwarded
    // so far, across *all* /events requests for the page's lifetime, not just within one.
    let lastForwardedRateLimitEventAt: string | null = null;

    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      try {
        void handleResponse(response.clone(), getRequestUrl(args[0]));
      } catch (error) {
        // Never let a capture bug affect the page's real fetch.
        log('handleResponse threw synchronously, ignoring', error);
      }
      return response;
    };

    function getRequestUrl(input: Parameters<typeof fetch>[0]): string {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      return input.url;
    }

    async function handleResponse(response: Response, url: string): Promise<void> {
      const orgId = url.match(ORG_ID_PATTERN)?.[1];
      if (/\/api\/organizations\/[^/]+\/usage(?:[/?]|$)/.test(url)) {
        log('matched /usage response', url);
        await captureUsage(response, orgId).catch((error) => log('captureUsage failed', error));
      } else if (/\/chat_conversations\/[^/]+\/completion/.test(url)) {
        log('matched completion stream response', url);
        await captureCompletionStream(response, orgId).catch((error) =>
          log('captureCompletionStream failed', error),
        );
      } else if (/\/v1\/code\/sessions\/[^/]+\/events(?:[/?]|$)/.test(url)) {
        log('matched claude.ai/code events response', url);
        await captureCodeEvents(response).catch((error) => log('captureCodeEvents failed', error));
      }
    }

    async function captureUsage(response: Response, orgId: string | undefined): Promise<void> {
      const raw = await response.json();
      log('captured usage payload');
      send({ endpoint: 'usage', capturedAt: new Date().toISOString(), raw, orgId });
    }

    async function captureCompletionStream(
      response: Response,
      orgId: string | undefined,
    ): Promise<void> {
      const body = response.body;
      if (!body) return;
      const reader = body.getReader();
      const sse = new SseFrameBuffer();

      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          for (const frame of sse.push(value)) handleFrame(frame, orgId);
        }
        if (done) {
          for (const frame of sse.flush()) handleFrame(frame, orgId);
          return;
        }
      }
    }

    /**
     * `GET /v1/code/sessions/{id}/events` is a plain JSON REST response — `{data: [...],
     * resume_cursor}`. Most `event_type` values (`user`/`assistant`/`system`/`control_*`) carry
     * real conversation content, so only `rate_limit_event` entries are forwarded, filtered
     * before anything leaves the page.
     *
     * A page load fires several of these requests, each covering a different slice of history,
     * so "latest event in this response" isn't globally latest — an older slice can return
     * something newer than what a later slice already sent. `pickFreshRateLimitEvent` tracks the
     * latest `created_at` forwarded across all requests and only forwards a strictly newer one.
     * `capturedAt` uses the event's own `created_at`, not `Date.now()`, so a late-arriving old
     * event can't outrank a fresher one already stored.
     */
    async function captureCodeEvents(response: Response): Promise<void> {
      const body: unknown = await response.json();
      const data = (body as { data?: unknown }).data;
      if (!Array.isArray(data)) return;

      const picked = pickFreshRateLimitEvent(data as CodeEventEnvelope[], lastForwardedRateLimitEventAt);
      if (!picked) return;
      lastForwardedRateLimitEventAt = picked.created_at;

      log('captured rate_limit_event from claude.ai/code');
      send({ endpoint: 'rate_limit_event', capturedAt: picked.created_at, raw: picked });
    }

    function handleFrame(frame: SseFrame, orgId: string | undefined): void {
      if (frame.event !== 'message_limit') return;
      try {
        const raw = JSON.parse(frame.data);
        log('captured message_limit event');
        send({ endpoint: 'message_limit', capturedAt: new Date().toISOString(), raw, orgId });
      } catch (error) {
        // Malformed frame data — drop it, don't throw inside the stream reader loop.
        log('failed to parse message_limit frame data', error);
      }
    }

    function send(payload: CapturedPayload): void {
      pageMessenger.sendMessage('captured', payload).then(
        () => log('sent to relay:', payload.endpoint),
        (error) => log('no relay listening (dropped):', payload.endpoint, error),
      );
    }
  },
});
