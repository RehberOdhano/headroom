import { describe, expect, it } from 'vitest';
import { redact } from '../lib/redact.js';

describe('redact', () => {
  it('strips id-like and content-like leaf strings, keeps structural values', () => {
    const input = {
      sessionId: '00000000-0000-4000-8000-000000000001',
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      org_id: 'e88918b9-64f9-473a-9bd7-33201a0d992c',
      utilization: 39.0,
      resets_at: '2026-08-26T19:00:00.121042+00:00',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'Hello, ready when you are.' }],
      },
      notice: {
        title: 'Now using usage credits',
        text: null,
        cta: null,
        is_dismissible: true,
      },
    };

    const output = redact(input) as Record<string, unknown>;

    expect(output.sessionId).toBe('[redacted:id]');
    expect(output.uuid).toBe('[redacted:id]');
    expect(output.org_id).toBe('[redacted:id]');
    expect(output.utilization).toBe(39.0);
    expect(output.resets_at).toBe('2026-08-26T19:00:00.121042+00:00');

    const message = output.message as Record<string, unknown>;
    expect(message.role).toBe('assistant');
    expect(message.model).toBe('claude-sonnet-5');
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe('[redacted:content]');

    const notice = output.notice as Record<string, unknown>;
    expect(notice.title).toBe('[redacted:content]');
    expect(notice.text).toBeNull();
    expect(notice.is_dismissible).toBe(true);
  });

  it('recurses into arrays', () => {
    const input = [{ sessionId: 'abc', value: 1 }, { sessionId: 'def', value: 2 }];
    const output = redact(input) as Array<Record<string, unknown>>;
    expect(output[0]?.sessionId).toBe('[redacted:id]');
    expect(output[0]?.value).toBe(1);
    expect(output[1]?.sessionId).toBe('[redacted:id]');
  });

  it('passes through primitives untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(true)).toBe(true);
  });
});
