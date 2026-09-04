import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SseFrameBuffer } from '../lib/sse.js';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claude-ai/message_limit.overage.sse.txt',
);

function loadFixtureSse(): string {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  // Strip the leading `# ...` metadata comment block documented in fixtures/claude-ai/README.md.
  return raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/^\n+/, '');
}

function toChunks(text: string, sizes: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = sizes[i % sizes.length] ?? 1;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
    i++;
  }
  return chunks;
}

describe('SseFrameBuffer', () => {
  it('parses every event in the real captured message_limit stream delivered in one chunk', () => {
    const text = loadFixtureSse();
    const buffer = new SseFrameBuffer();
    const frames = [...buffer.push(new TextEncoder().encode(text)), ...buffer.flush()];

    const events = frames.map((f) => f.event);
    expect(events).toEqual([
      'conversation_ready',
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_limit',
      'message_stop',
    ]);

    const limitFrame = frames.find((f) => f.event === 'message_limit');
    const parsed = JSON.parse(limitFrame!.data);
    expect(parsed.message_limit.representativeClaim).toBe('overage');
    expect(parsed.message_limit.overageInUse).toBe(true);
  });

  it('reassembles frames split across arbitrary chunk boundaries, including mid-frame', () => {
    const text = loadFixtureSse();
    const buffer = new SseFrameBuffer();
    const frames: ReturnType<SseFrameBuffer['push']> = [];
    // Odd, small, mutually-prime-ish sizes to force splits mid-line and mid-frame.
    for (const chunk of toChunks(text, [1, 3, 7, 13, 29])) {
      frames.push(...buffer.push(chunk));
    }
    frames.push(...buffer.flush());

    expect(frames.map((f) => f.event)).toEqual([
      'conversation_ready',
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_limit',
      'message_stop',
    ]);
  });

  it('reassembles a multi-byte UTF-8 character split across a chunk boundary', () => {
    const text = 'event: greeting\ndata: {"text":"café 😀"}\n\n';
    const bytes = new TextEncoder().encode(text);
    const buffer = new SseFrameBuffer();
    const frames = [
      ...buffer.push(bytes.slice(0, 12)),
      ...buffer.push(bytes.slice(12, 13)), // splits inside a multi-byte character
      ...buffer.push(bytes.slice(13)),
      ...buffer.flush(),
    ];

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data)).toEqual({ text: 'café 😀' });
  });
});
