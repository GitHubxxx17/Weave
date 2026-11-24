/** One parsed Server-Sent Events frame. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

/** Why `readSseStream` rejected a response. */
export type SseProtocolReason = 'content-type' | 'no-body' | 'frame-too-large' | 'buffer-too-large';

/** Default failure raised by `readSseStream`; callers may map it with `createError`. */
export class SseProtocolError extends Error {
  readonly reason: SseProtocolReason;

  constructor(reason: SseProtocolReason) {
    super(`SSE protocol error: ${reason}`);
    this.name = 'SseProtocolError';
    this.reason = reason;
  }
}

export interface ReadSseStreamOptions {
  /** Largest accepted single frame, in UTF-16 code units of the decoded text. */
  readonly maxFrameChars: number;
  /** Largest accepted unterminated buffer, in UTF-16 code units of the decoded text. */
  readonly maxBufferChars: number;
  readonly signal?: AbortSignal | undefined;
  /** Dispatch a final frame that lacks its terminating blank line when the stream ends cleanly. */
  readonly flushTrailingFrame?: boolean;
  /** Maps a protocol failure to the caller's own error type. */
  readonly createError?: (reason: SseProtocolReason) => Error;
}

/**
 * Parses one complete SSE frame. Data fields follow the SSE rule of joining
 * multiple lines with a newline; comments and unsupported fields are ignored.
 */
export function parseSseFrame(frame: string): SseFrame | null {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of frame.split(/\r\n|\n/)) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1
        ? ''
        : line.slice(separator + 1).startsWith(' ')
          ? line.slice(separator + 2)
          : line.slice(separator + 1);

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id') {
      id = value;
    }
  }

  if (event === undefined || dataLines.length === 0) {
    return null;
  }

  return id === undefined
    ? { event, data: dataLines.join('\n') }
    : { event, data: dataLines.join('\n'), id };
}

/**
 * Reads a `text/event-stream` response as an async iterator of frames.
 *
 * It validates the Content-Type and body, decodes UTF-8 incrementally, splits
 * frames on blank lines, enforces the caller's size limits and skips comment
 * frames. Reconnection, cursors and termination rules belong to the caller.
 * The underlying reader is cancelled when iteration ends, fails or is aborted.
 * Header and body checks run when this function is called, before iteration.
 */
export function readSseStream(
  response: Response,
  options: ReadSseStreamOptions,
): AsyncGenerator<SseFrame, void, undefined> {
  const fail = (reason: SseProtocolReason): Error =>
    options.createError?.(reason) ?? new SseProtocolError(reason);
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw fail('content-type');
  }
  if (response.body === null) {
    throw fail('no-body');
  }
  return generate(response.body.getReader(), options, fail);
}

async function* generate(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ReadSseStreamOptions,
  fail: (reason: SseProtocolReason) => Error,
): AsyncGenerator<SseFrame, void, undefined> {
  const { signal } = options;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    signal?.throwIfAborted();
    for (;;) {
      const result = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match !== null) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (raw.length > options.maxFrameChars) throw fail('frame-too-large');
        const frame = parseSseFrame(raw);
        if (frame !== null) yield frame;
        match = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > options.maxBufferChars) throw fail('buffer-too-large');
      if (result.done) break;
    }
    if (options.flushTrailingFrame === true && buffer.trim() !== '') {
      const frame = parseSseFrame(buffer);
      if (frame !== null) yield frame;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
