import { describe, expect, it, vi } from 'vitest';
import { detachedEventStream } from '../src/detached-event-stream.js';

const encode = (value: string) => new TextEncoder().encode(value);

describe('detachable bounded SSE transport', () => {
  it('pulls one frame at a time and only cleans up its own observer on disconnect', async () => {
    const close = vi.fn();
    const next = vi.fn(async () => ({ done: false as const, value: 'next' }));
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stream = detachedEventStream(
      {
        initial: ['initial'],
        events: { [Symbol.asyncIterator]: () => ({ next, return: iteratorReturn }) },
        close,
      },
      new AbortController().signal,
      encode,
    );
    expect(next).not.toHaveBeenCalled();
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('initial');
    expect(next).not.toHaveBeenCalled();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('next');
    expect(next).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(close).toHaveBeenCalledTimes(1);
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending pull, releases the iterator and closes the reader', async () => {
    const abort = new AbortController();
    let pending: ((result: IteratorResult<string>) => void) | undefined;
    const close = vi.fn(() => pending?.({ done: true, value: undefined }));
    const stream = detachedEventStream(
      {
        initial: [],
        events: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<string>>((resolve) => {
                pending = resolve;
              }),
          }),
        },
        close,
      },
      abort.signal,
      encode,
    );
    const reader = stream.getReader();
    const read = reader.read();
    await Promise.resolve();
    abort.abort();
    expect(await read).toEqual({ done: true, value: undefined });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
