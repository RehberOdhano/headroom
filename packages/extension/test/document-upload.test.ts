import { describe, expect, it } from 'vitest';
import { documentEncodingForFilename } from '../lib/document-upload.js';

describe('documentEncodingForFilename', () => {
  it('treats markdown and plain text as utf8', () => {
    expect(documentEncodingForFilename('brief.md')).toBe('utf8');
    expect(documentEncodingForFilename('notes.txt')).toBe('utf8');
    expect(documentEncodingForFilename('NOTES.TXT')).toBe('utf8');
  });

  it('treats pdf, doc, and docx as base64', () => {
    expect(documentEncodingForFilename('proposal.pdf')).toBe('base64');
    expect(documentEncodingForFilename('requirements.doc')).toBe('base64');
    expect(documentEncodingForFilename('handoff.docx')).toBe('base64');
  });

  it('defaults an unrecognized extension to base64, the safer assumption', () => {
    expect(documentEncodingForFilename('brief.rtf')).toBe('base64');
  });
});
