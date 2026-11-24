import { describe, expect, it } from 'vitest';

import { readSseStream, SseProtocolError, type ReadSseStreamOptions } from '../src/lib/sse.js';

const limits = { maxFrameChars: 1024, maxBufferChars: 1024 };
const encoder = new TextEncoder();

function response(
  chunks: readonly (string | Uint8Array)[],
  options: { readonly contentType?: string | null; readonly onCancel?: () => void } = {},
): Response {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set('Content-Type', options.contentType ?? 'text/event-stream');
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    { headers },
  );
}

async function collect(
  source: Response,
  options: Partial<ReadSseStreamOptions> = {},
): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of readSseStream(source, { ...limits, ...options })) frames.push(frame);
  return frames;
}

describe('readSseStream', () => {
  it('reassembles frames split across chunks', async () => {
    const frames = await collect(response(['event: a\nda', 'ta: 1\n', '\nevent: b\ndata: 2\n\n']));
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('handles CRLF delimiters and the id field', async () => {
    const frames = await collect(response(['id: 7\r\nevent: a\r\ndata: x\r\n\r\n']));
    expect(frames).toEqual([{ event: 'a', data: 'x', id: '7' }]);
  });

  it('ignores comment frames', async () => {
    const frames = await collect(response([': ping\n\nevent: a\ndata: 1\n\n: tail\n\n']));
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
  });

  it('decodes a UTF-8 character split between chunks', async () => {
    const bytes = encoder.encode('event: a\ndata: 你好\n\n');
    const split = bytes.indexOf(0xe4) + 1;
    const frames = await collect(response([bytes.slice(0, split), bytes.slice(split)]));
    expect(frames).toEqual([{ event: 'a', data: '你好' }]);
  });

  it('drops an unterminated trailing frame unless flushing is requested', async () => {
    const body = ['event: a\ndata: 1\n\nevent: b\ndata: 2'];
    expect(await collect(response(body))).toEqual([{ event: 'a', data: '1' }]);
    expect(await collect(response(body), { flushTrailingFrame: true })).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('rejects a frame above the frame limit', async () => {
    const big = `event: a\ndata: ${'x'.repeat(2000)}\n\n`;
    await expect(collect(response([big]))).rejects.toMatchObject({ reason: 'frame-too-large' });
  });

  it('rejects an unterminated buffer above the buffer limit', async () => {
    await expect(collect(response(['data: ' + 'x'.repeat(2000)]))).rejects.toMatchObject({
      reason: 'buffer-too-large',
    });
  });

  it('rejects a wrong Content-Type before iteration and maps errors', () => {
    expect(() => readSseStream(response([], { contentType: 'application/json' }), limits)).toThrow(
      SseProtocolError,
    );
    expect(() =>
      readSseStream(response([], { contentType: null }), {
        ...limits,
        createError: () => new RangeError('mapped'),
      }),
    ).toThrow(RangeError);
  });

  it('stops and cancels the stream on abort', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encoder.encode('event: a\ndata: 1\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const frame of readSseStream(source, { ...limits, signal: controller.signal })) {
          seen.push(frame);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it('cancels the stream when the consumer stops early', async () => {
    let cancelled = false;
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encoder.encode('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    for await (const frame of readSseStream(source, limits)) {
      expect(frame.event).toBe('a');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
