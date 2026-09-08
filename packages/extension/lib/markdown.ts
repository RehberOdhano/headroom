import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Renders CLAUDE.md content to sanitized HTML for the Guardrails tab's preview. Sanitizing isn't
 * optional here the way it might be for, say, a marketing site's own trusted copy — this renders
 * *local file content* inside a privileged extension page (`chrome-extension://` origin, with
 * `browser.runtime` access to the background worker). A `dangerouslySetInnerHTML` of raw
 * `marked()` output would let a crafted CLAUDE.md (e.g. from a compromised repo) run script in
 * that privileged context; DOMPurify strips anything script-capable before it ever reaches the
 * DOM. `marked()` runs synchronously here (no async extensions registered), so the cast is safe.
 */
export function renderMarkdownSafely(source: string): string {
  const html = marked(source, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html);
}
