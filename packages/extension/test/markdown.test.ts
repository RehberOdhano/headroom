// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdownSafely } from '../lib/markdown.js';

describe('renderMarkdownSafely', () => {
  it('renders headings, paragraphs, and lists to HTML', () => {
    const html = renderMarkdownSafely('# Title\n\nSome text.\n\n- one\n- two\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Some text.</p>');
    expect(html).toContain('<li>one</li>');
  });

  it('strips a raw <script> tag instead of rendering it', () => {
    const html = renderMarkdownSafely('Hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips an inline event-handler attribute', () => {
    const html = renderMarkdownSafely('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });
});
