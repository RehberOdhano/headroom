export interface SseFrame {
  event?: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

/**
 * Buffers `fetch()` body chunks and yields complete SSE frames (`event:`/`data:` blocks
 * separated by a blank line). A `ReadableStream` chunk can split a frame — or even a
 * multi-byte UTF-8 character — at any byte offset, so both the string buffer and the
 * `TextDecoder` (via `{ stream: true }`) must carry state across `push()` calls.
 */
export class SseFrameBuffer {
  #decoder = new TextDecoder();
  #buffer = '';

  push(chunk: Uint8Array): SseFrame[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain();
  }

  /** Call once the stream ends, in case the last frame had no trailing blank line. */
  flush(): SseFrame[] {
    this.#buffer += this.#decoder.decode();
    const frames = this.#drain();
    if (this.#buffer.trim().length > 0) {
      const frame = parseFrame(this.#buffer);
      this.#buffer = '';
      if (frame) frames.push(frame);
    }
    return frames;
  }

  #drain(): SseFrame[] {
    const frames: SseFrame[] = [];
    let boundary: number;
    while ((boundary = this.#buffer.indexOf('\n\n')) !== -1) {
      const raw = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}
