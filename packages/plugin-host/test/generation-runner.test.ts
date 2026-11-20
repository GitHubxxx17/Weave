import { describe, expect, it } from 'vitest';

import {
  createGenerationRunner,
  type GenerationRequest,
  type RunnerGeneration,
} from '../src/generation-runner.js';

type Request = GenerationRequest & { readonly value: string };
type Event = string;

function generation(
  id: number,
  run: (request: Request) => AsyncIterable<Event>,
  dispose: () => unknown = () => undefined,
): RunnerGeneration<Request, Event, { readonly id: number }> {
  return {
    id,
    runner: { run },
    resources: { id },
    dispose: async () => {
      await dispose();
    },
  };
}

function source(values: string[], gate?: { wait: Promise<void> }): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (gate && index === 0) await gate.wait;
          return index < values.length
            ? { done: false as const, value: values[index++]! }
            : { done: true as const, value: undefined };
        },
      };
    },
  };
}

async function collect(iterable: AsyncIterable<Event>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe('createGenerationRunner', () => {
  it('starts lazily and pins a generation when a session turn starts', async () => {
    const starts: string[] = [];
    const disposed: number[] = [];
    const controller = createGenerationRunner(
      generation(
        1,
        (request) => {
          starts.push(`g1:${request.value}`);
          return source(['one']);
        },
        () => disposed.push(1),
      ),
    );

    const result = controller.runner.run({ sessionId: 's', value: 'a' });
    expect(starts).toEqual([]);
    expect(await collect(result)).toEqual(['one']);
    expect(starts).toEqual(['g1:a']);

    await controller.replace(
      generation(
        2,
        (request) => {
          starts.push(`g2:${request.value}`);
          return source(['two']);
        },
        () => disposed.push(2),
      ),
    );
    expect(disposed).toEqual([1]);
    expect(await collect(controller.runner.run({ sessionId: 's', value: 'b' }))).toEqual(['two']);
    await controller.dispose();
    expect(disposed).toEqual([1, 2]);
  });

  it('serializes one session while running other sessions concurrently and switches queued turns', async () => {
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const starts: string[] = [];
    const controller = createGenerationRunner(
      generation(1, (request) => {
        starts.push(`g1:${request.sessionId}:${request.value}`);
        return source(
          [`${request.value}:done`],
          request.value === 'a' ? { wait: aGate } : undefined,
        );
      }),
    );

    const a = controller.runner.run({ sessionId: 's', value: 'a' });
    const b = controller.runner.run({ sessionId: 's', value: 'b' });
    const c = controller.runner.run({ sessionId: 'other', value: 'c' });
    const aResult = a[Symbol.asyncIterator]().next();
    const bResult = collect(b);
    const cResult = collect(c);
    await tick();
    expect(starts).toEqual(['g1:s:a', 'g1:other:c']);

    await controller.replace(
      generation(2, (request) => {
        starts.push(`g2:${request.sessionId}:${request.value}`);
        return source([`${request.value}:done`]);
      }),
    );
    releaseA();
    expect(await aResult).toEqual({ done: false, value: 'a:done' });
    expect(await bResult).toEqual(['b:done']);
    expect(await cResult).toEqual(['c:done']);
    expect(starts).toEqual(['g1:s:a', 'g1:other:c', 'g2:s:b']);
    await controller.dispose();
  });

  it('drains production and retires a generation even when buffered events are unread', async () => {
    const disposed: number[] = [];
    const controller = createGenerationRunner(
      generation(
        1,
        () => source(['a', 'b']),
        () => disposed.push(1),
      ),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 'a' });
    await controller.replace(
      generation(
        2,
        () => source(['new']),
        () => disposed.push(2),
      ),
    );
    await tick();
    expect(disposed).toEqual([1]);
    expect(await iterator.next()).toEqual({ done: false, value: 'b' });
    await iterator.return?.();
    await controller.dispose();
    expect(disposed).toEqual([1, 2]);
  });

  it('cancels a queued request without waiting for an earlier turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createGenerationRunner(
      generation(1, (request) =>
        source([request.value], request.value === 'a' ? { wait: gate } : undefined),
      ),
    );
    const first = controller.runner.run({ sessionId: 's', value: 'a' });
    const abort = new AbortController();
    const second = controller.runner.run({ sessionId: 's', value: 'b', signal: abort.signal });
    const firstNext = first[Symbol.asyncIterator]().next();
    await tick();
    const secondIterator = second[Symbol.asyncIterator]();
    const secondNext = secondIterator.next();
    abort.abort();
    await expect(secondNext).resolves.toEqual({ done: true, value: undefined });
    release();
    await expect(firstNext).resolves.toEqual({ done: false, value: 'a' });
    await controller.dispose();
  });

  it('reports retirement disposal failures only at final close and never rolls back replacement', async () => {
    const controller = createGenerationRunner(
      generation(
        1,
        () => source([]),
        () => {
          throw new Error('retire failed');
        },
      ),
    );
    await controller.replace(generation(2, () => source(['new'])));
    expect(controller.current().id).toBe(2);
    expect(await collect(controller.runner.run({ sessionId: 's', value: 'a' }))).toEqual(['new']);
    const close = controller.dispose();
    await expect(close).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'retire failed' })],
    });
    expect(controller.dispose()).toBe(close);
  });

  it('rejects reused or non-monotonic generation ids and restores blocked runs after replace', async () => {
    const controller = createGenerationRunner(generation(10, () => source(['ok'])));
    expect(() => controller.blockNewRuns(new Error('blocked'))).not.toThrow();
    const blocked = controller.runner.run({ sessionId: 's', value: 'x' })[Symbol.asyncIterator]();
    await expect(blocked.next()).rejects.toThrow('blocked');
    await expect(controller.replace(generation(10, () => source([])))).rejects.toThrow();
    await expect(controller.replace(generation(9, () => source([])))).rejects.toThrow();
    await controller.replace(generation(11, () => source(['ok'])));
    expect(await collect(controller.runner.run({ sessionId: 's', value: 'x' }))).toEqual(['ok']);
    await controller.dispose();
  });
});

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A blocked producer that observes abort, then waits for cleanup before ending. */
function cancellableSource(
  request: Request,
  stopped: ReturnType<typeof gate>,
  cleanup?: Promise<void>,
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (cleanup) await cleanup;
        yield 'cancelled';
      } finally {
        stopped.resolve();
      }
    },
  };
}

describe('generation cancellation and lifetime', () => {
  it('return before the first next never enqueues or starts a turn', async () => {
    const starts: string[] = [];
    const controller = createGenerationRunner(
      generation(1, (request) => {
        starts.push(request.value);
        return source([]);
      }),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(starts).toEqual([]);
    await controller.dispose();
  });

  it('an already aborted request never invokes the generation runner', async () => {
    const starts: string[] = [];
    const controller = createGenerationRunner(
      generation(1, (request) => {
        starts.push(request.value);
        return source([]);
      }),
    );
    const abort = new AbortController();
    abort.abort();
    expect(
      await collect(controller.runner.run({ sessionId: 's', value: 'a', signal: abort.signal })),
    ).toEqual([]);
    expect(starts).toEqual([]);
    await controller.dispose();
  });

  it('return interrupts blocked next but waits for producer cleanup before starting the next turn', async () => {
    const started = gate();
    const stopped = gate();
    const cleanup = gate();
    const starts: string[] = [];
    const controller = createGenerationRunner(
      generation(1, (request) => {
        starts.push(request.value);
        if (request.value === 'a') {
          started.resolve();
          return cancellableSource(request, stopped, cleanup.promise);
        }
        return source(['b']);
      }),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started.promise;
    const second = collect(controller.runner.run({ sessionId: 's', value: 'b' }));
    const returning = iterator.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(starts).toEqual(['a']);
    cleanup.resolve();
    await returning;
    await stopped.promise;
    expect(await second).toEqual(['b']);
    expect(starts).toEqual(['a', 'b']);
    await iterator.return?.();
    await controller.dispose();
  });

  it('calls inner return once to unblock a custom iterator pending next', async () => {
    const waiting = gate();
    const releaseNext = gate<IteratorResult<string>>();
    let returns = 0;
    const controller = createGenerationRunner(
      generation(1, () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              waiting.resolve();
              return releaseNext.promise;
            },
            async return() {
              returns += 1;
              releaseNext.resolve({ done: true, value: undefined });
              return { done: true as const, value: undefined };
            },
          };
        },
      })),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await waiting.promise;
    await iterator.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
    await iterator.return?.();
    await controller.dispose();
    expect(returns).toBe(1);
  });

  it.each(['shutdown', 'immediate', 'request'] as const)(
    '%s cancellation closes a return-only iterator exactly once',
    async (mode) => {
      const waiting = gate();
      const next = gate<IteratorResult<string>>();
      const disposed = gate();
      const abort = new AbortController();
      let returns = 0;
      let disposals = 0;
      const controller = createGenerationRunner(
        generation(
          1,
          () => ({
            [Symbol.asyncIterator]() {
              return {
                next() {
                  waiting.resolve();
                  return next.promise;
                },
                async return() {
                  returns += 1;
                  next.resolve({ done: true, value: undefined });
                  return { done: true as const, value: undefined };
                },
              };
            },
          }),
          () => {
            disposals += 1;
            disposed.resolve();
          },
        ),
      );
      const output = collect(
        controller.runner.run({ sessionId: 's', value: 'a', signal: abort.signal }),
      );
      await waiting.promise;
      if (mode === 'shutdown') await controller.dispose();
      else if (mode === 'immediate') {
        await controller.replace(
          generation(2, () => source([])),
          { immediate: true },
        );
        await disposed.promise;
      } else {
        abort.abort();
      }
      expect(await output).toEqual([]);
      await controller.dispose();
      expect(returns).toBe(1);
      expect(disposals).toBe(1);
    },
  );

  it.each(['run', 'iterator'] as const)(
    'closes a return-only iterator when cancellation occurs synchronously inside %s factory',
    async (phase) => {
      const abort = new AbortController();
      const pending = gate<IteratorResult<string>>();
      let returns = 0;
      let disposals = 0;
      const controller = createGenerationRunner(
        generation(
          1,
          () => {
            if (phase === 'run') abort.abort();
            return {
              [Symbol.asyncIterator]() {
                if (phase === 'iterator') abort.abort();
                return {
                  next() {
                    return pending.promise;
                  },
                  async return() {
                    returns += 1;
                    pending.resolve({ done: true, value: undefined });
                    return { done: true as const, value: undefined };
                  },
                };
              },
            };
          },
          () => {
            disposals += 1;
          },
        ),
      );
      expect(
        await collect(controller.runner.run({ sessionId: 's', value: 'a', signal: abort.signal })),
      ).toEqual([]);
      await controller.dispose();
      expect(returns).toBe(1);
      expect(disposals).toBe(1);
    },
  );

  it('surfaces a producer finally failure from return and final close while releasing the Session once', async () => {
    const waiting = gate();
    const failure = new Error('producer cleanup failed');
    const starts: string[] = [];
    const disposals: number[] = [];
    const controller = createGenerationRunner(
      generation(
        1,
        (request) => {
          starts.push(request.value);
          if (request.value === 'b') return source(['b']);
          return {
            async *[Symbol.asyncIterator]() {
              try {
                waiting.resolve();
                await new Promise<void>((resolve) =>
                  request.signal?.addEventListener('abort', () => resolve(), { once: true }),
                );
                yield 'cancelled';
              } finally {
                await Promise.reject(failure);
              }
            },
          };
        },
        () => {
          disposals.push(1);
        },
      ),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await waiting.promise;
    const second = collect(controller.runner.run({ sessionId: 's', value: 'b' }));
    await expect(iterator.return?.()).rejects.toBe(failure);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await second).toEqual(['b']);
    await expect(controller.dispose()).rejects.toMatchObject({ errors: [failure] });
    expect(starts).toEqual(['a', 'b']);
    expect(disposals).toEqual([1]);
  });

  it('preserves an undefined cleanup rejection without treating it as success', async () => {
    const next = gate<IteratorResult<string>>();
    const controller = createGenerationRunner(
      generation(1, () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              return next.promise;
            },
            async return() {
              next.resolve({ done: true, value: undefined });
              return Promise.reject(undefined);
            },
          };
        },
      })),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await expect(iterator.return?.()).rejects.toBeUndefined();
    expect(await pending).toEqual({ done: true, value: undefined });
    await expect(controller.dispose()).rejects.toMatchObject({ errors: [undefined] });
  });

  it('does not report an AbortError from a cancelled producer as disposal failure', async () => {
    const started = gate();
    const controller = createGenerationRunner(
      generation(1, (request) => ({
        async *[Symbol.asyncIterator]() {
          started.resolve();
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
          yield 'cancelled';
          throw new DOMException('The operation was aborted', 'AbortError');
        },
      })),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started.promise;
    await iterator.return?.();
    await pending;
    await expect(controller.dispose()).resolves.toBeUndefined();
  });

  it('retains an inner return failure at final close even after the consumer left', async () => {
    const next = gate<IteratorResult<string>>();
    const failure = new Error('inner return failed');
    let returns = 0;
    const controller = createGenerationRunner(
      generation(1, () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              return next.promise;
            },
            async return() {
              returns += 1;
              next.resolve({ done: true, value: undefined });
              throw failure;
            },
          };
        },
      })),
    );
    const iterator = controller.runner.run({ sessionId: 's', value: 'a' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await expect(iterator.return?.()).rejects.toBe(failure);
    expect(await pending).toEqual({ done: true, value: undefined });
    await expect(controller.dispose()).rejects.toMatchObject({ errors: [failure] });
    expect(returns).toBe(1);
  });

  it('immediate replacement cancels every live retired generation and disposes each exactly once', async () => {
    const starts: string[] = [];
    const stopped1 = gate();
    const stopped2 = gate();
    const dispose1 = gate();
    const dispose2 = gate();
    const disposals: number[] = [];
    const controller = createGenerationRunner(
      generation(
        1,
        (request) => {
          starts.push('g1');
          return cancellableSource(request, stopped1);
        },
        () => {
          disposals.push(1);
          dispose1.resolve();
        },
      ),
    );
    const first = collect(controller.runner.run({ sessionId: 's1', value: 'a' }));
    await controller.replace(
      generation(
        2,
        (request) => {
          starts.push('g2');
          return cancellableSource(request, stopped2);
        },
        () => {
          disposals.push(2);
          dispose2.resolve();
        },
      ),
    );
    const second = collect(controller.runner.run({ sessionId: 's2', value: 'b' }));
    await controller.replace(
      generation(
        3,
        () => source([]),
        () => {
          disposals.push(3);
        },
      ),
      { immediate: true },
    );
    await Promise.all([stopped1.promise, stopped2.promise, dispose1.promise, dispose2.promise]);
    expect(await first).toEqual(['cancelled']);
    expect(await second).toEqual(['cancelled']);
    expect(starts).toEqual(['g1', 'g2']);
    expect(disposals).toEqual([1, 2]);
    await controller.dispose();
    expect(disposals).toEqual([1, 2, 3]);
  });

  it('closes queued requests promptly and preserves cancellation terminal events while shutdown waits for cleanup', async () => {
    const cleanup = gate();
    const stopped = gate();
    const starts: string[] = [];
    const disposals: number[] = [];
    const controller = createGenerationRunner(
      generation(
        1,
        (request) => {
          starts.push(request.value);
          return cancellableSource(request, stopped, cleanup.promise);
        },
        () => {
          disposals.push(1);
        },
      ),
    );
    const first = collect(controller.runner.run({ sessionId: 's', value: 'a' }));
    const second = collect(controller.runner.run({ sessionId: 's', value: 'b' }));
    const closing = controller.dispose();
    expect(await second).toEqual([]);
    expect(disposals).toEqual([]);
    cleanup.resolve();
    expect(await first).toEqual(['cancelled']);
    await closing;
    expect(starts).toEqual(['a']);
    expect(disposals).toEqual([1]);
    expect(controller.dispose()).toBe(closing);
    expect(await collect(controller.runner.run({ sessionId: 's', value: 'c' }))).toEqual([]);
  });

  it('releases failed turns and serializes concurrent next calls without duplicate production', async () => {
    const failure = new Error('turn failed');
    const starts: string[] = [];
    const controller = createGenerationRunner(
      generation(1, (request) => {
        starts.push(request.value);
        if (request.value === 'bad') throw failure;
        return source(['one', 'two']);
      }),
    );
    const bad = controller.runner.run({ sessionId: 's', value: 'bad' })[Symbol.asyncIterator]();
    await expect(bad.next()).rejects.toBe(failure);
    const result = controller.runner.run({ sessionId: 's', value: 'good' });
    const iterator = result[Symbol.asyncIterator]();
    expect(await Promise.all([iterator.next(), iterator.next(), iterator.next()])).toEqual([
      { done: false, value: 'one' },
      { done: false, value: 'two' },
      { done: true, value: undefined },
    ]);
    expect(starts).toEqual(['bad', 'good']);
    await controller.dispose();
  });
});
