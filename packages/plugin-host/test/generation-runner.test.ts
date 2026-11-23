import { describe, expect, it } from 'vitest';

import {
  createGenerationRunner,
  type GenerationRequest,
  type GenerationRunner,
  type RetainedGenerationLease,
  type RunnerGeneration,
  type RunningGenerationScope,
} from '../src/generation-runner.js';

type Request = GenerationRequest & { readonly value: string };
type Event = string;

function generation(
  id: number,
  run: GenerationRunner<Request, Event>['run'],
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
  it('commits the new generation before a slow retirement finishes', async () => {
    const disposalStarted = gate();
    const finishDisposal = gate();
    const previous = generation(
      1,
      () => source(['previous']),
      () => {
        disposalStarted.resolve();
        return finishDisposal.promise;
      },
    );
    const next = generation(2, () => source(['next']));
    const controller = createGenerationRunner(previous);

    try {
      const committed = controller.commit(next);
      expect(controller.current()).toBe(next);
      let retired = false;
      void committed.retirement.then(() => {
        retired = true;
      });
      await disposalStarted.promise;
      expect(await collect(controller.runner.run({ sessionId: 's', value: 'x' }))).toEqual([
        'next',
      ]);
      expect(retired).toBe(false);
      finishDisposal.resolve();
      await committed.retirement;
      expect(retired).toBe(true);
    } finally {
      finishDisposal.resolve();
      await controller.dispose();
    }
  });

  it('lets the final pinned turn retire its generation after commit returns', async () => {
    const finishTurn = gate();
    const disposalStarted = gate();
    const previous = generation(
      1,
      () => source(['previous'], { wait: finishTurn.promise }),
      () => disposalStarted.resolve(),
    );
    const next = generation(2, () => source(['next']));
    const controller = createGenerationRunner(previous);
    const active = collect(controller.runner.run({ sessionId: 's', value: 'x' }));
    await tick();

    try {
      const committed = controller.commit(next);
      expect(controller.current()).toBe(next);
      let retired = false;
      void committed.retirement.then(() => {
        retired = true;
      });
      let disposing = false;
      void disposalStarted.promise.then(() => {
        disposing = true;
      });
      await tick();
      expect(retired).toBe(true);
      expect(disposing).toBe(false);
      finishTurn.resolve();
      expect(await active).toEqual(['previous']);
      await disposalStarted.promise;
    } finally {
      finishTurn.resolve();
      await active;
      await controller.dispose();
    }
  });

  it.each([10, 9, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'throws synchronously for invalid generation id %s without taking ownership',
    async (id) => {
      const previous = generation(10, () => source(['previous']));
      const controller = createGenerationRunner(previous);
      let candidateDisposed = false;
      const candidate = generation(
        id,
        () => source([]),
        () => {
          candidateDisposed = true;
        },
      );

      try {
        controller.blockNewRuns(new Error('blocked'));
        expect(() => controller.commit(candidate)).toThrow('Generation ids must increase');
        expect(controller.current()).toBe(previous);
        await expect(
          collect(controller.runner.run({ sessionId: 's', value: 'x' })),
        ).rejects.toThrow('blocked');
      } finally {
        await controller.dispose();
      }
      expect(candidateDisposed).toBe(false);
    },
  );

  it('throws synchronously after disposal without changing the current generation', async () => {
    const previous = generation(1, () => source([]));
    const controller = createGenerationRunner(previous);
    const closing = controller.dispose();

    expect(() => controller.commit(generation(2, () => source([])))).toThrow(
      'Generation runner is disposed',
    );
    expect(controller.current()).toBe(previous);
    await closing;
  });

  it('preserves the current generation and admission block when reading immediate throws', async () => {
    const previous = generation(1, () => source([]));
    const controller = createGenerationRunner(previous);
    const blocked = new Error('blocked');
    const failure = new Error('cannot read immediate');
    let candidateDisposed = false;
    const candidate = generation(
      2,
      () => source([]),
      () => {
        candidateDisposed = true;
      },
    );
    const options = {
      get immediate(): boolean {
        throw failure;
      },
    };

    try {
      controller.blockNewRuns(blocked);
      expect(() => controller.commit(candidate, options)).toThrow(failure);
      expect(controller.current()).toBe(previous);
      await expect(collect(controller.runner.run({ sessionId: 's', value: 'x' }))).rejects.toBe(
        blocked,
      );
    } finally {
      await controller.dispose();
    }
    expect(candidateDisposed).toBe(false);
  });

  it('rejects a candidate when reading immediate closes the controller', async () => {
    const previous = generation(1, () => source([]));
    const controller = createGenerationRunner(previous);
    let candidateDisposed = false;
    const candidate = generation(
      2,
      () => source([]),
      () => {
        candidateDisposed = true;
      },
    );
    const options = {
      get immediate(): boolean {
        void controller.dispose();
        return true;
      },
    };

    try {
      expect(() => controller.commit(candidate, options)).toThrow('Generation runner is disposed');
      expect(controller.current()).toBe(previous);
    } finally {
      await controller.dispose();
    }
    expect(candidateDisposed).toBe(false);
  });

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

describe('generation start admission', () => {
  it('drains a long queue of guard failures in order and starts the healthy tail', async () => {
    const finishFirst = gate();
    const denial = new Error('admission denied');
    const deniedCount = 4_000;
    const started: string[] = [];
    const rejected: number[] = [];
    let guardCalls = 0;
    const controller = createGenerationRunner({
      ...generation(1, (request) => {
        started.push(request.value);
        return source(
          [request.value],
          request.value === 'first' ? { wait: finishFirst.promise } : undefined,
        );
      }),
      assertCanStartSync(): undefined {
        guardCalls += 1;
        if (guardCalls > 1 && guardCalls <= deniedCount + 1) throw denial;
        return undefined;
      },
    });
    const firstRun = controller.runner.run({ sessionId: 's', value: 'first' });
    const first = firstRun[Symbol.asyncIterator]();
    const firstNext = first.next();
    const expected = Array.from({ length: deniedCount }, (_, index) => index);
    const outcomes = expected.map((index) => {
      const deniedRun = controller.runner.run({ sessionId: 's', value: String(index) });
      return deniedRun[Symbol.asyncIterator]()
        .next()
        .then(
          () => false,
          (cause: unknown) => {
            rejected.push(index);
            return cause === denial;
          },
        );
    });
    const tail = collect(controller.runner.run({ sessionId: 's', value: 'tail' }));

    try {
      expect(started).toEqual(['first']);
      expect(guardCalls).toBe(1);
      // Await producer cleanup directly so a queue release failure surfaces in this test.
      const released = first.return!();
      finishFirst.resolve();
      await expect(released).resolves.toEqual({ done: true, value: undefined });
      await expect(firstNext).resolves.toEqual({ done: true, value: undefined });
      expect(started).toEqual(['first', 'tail']);
      expect(rejected).toEqual(expected);
      expect((await Promise.all(outcomes)).every(Boolean)).toBe(true);
      expect(await tail).toEqual(['tail']);
    } finally {
      finishFirst.resolve();
      await controller.dispose();
    }
  });

  it('checks a queued turn at the Session head and releases it when the guard throws', async () => {
    const finishFirst = gate();
    const started: string[] = [];
    let guardCalls = 0;
    let throwAtStart = false;
    const controller = createGenerationRunner({
      ...generation(1, (request) => {
        started.push(request.value);
        return source(
          [request.value],
          request.value === 'first' ? { wait: finishFirst.promise } : undefined,
        );
      }),
      assertCanStartSync(): undefined {
        guardCalls += 1;
        if (throwAtStart) throw undefined;
        return undefined;
      },
    });
    const first = collect(controller.runner.run({ sessionId: 's', value: 'first' }));
    const firstGuardCalls = guardCalls;
    const queuedRun = controller.runner.run({ sessionId: 's', value: 'queued' });
    const queued = queuedRun[Symbol.asyncIterator]();
    const next = queued.next();
    const verdict = next.then(
      () => ({ failed: false as const }),
      (cause: unknown) => ({ failed: true as const, cause }),
    );

    try {
      expect(started).toEqual(['first']);
      expect(guardCalls).toBe(firstGuardCalls);
      throwAtStart = true;
      finishFirst.resolve();
      expect(await verdict).toEqual({ failed: true, cause: undefined });
      expect(started).toEqual(['first']);
      expect(guardCalls).toBe(2);
      expect(await first).toEqual(['first']);

      throwAtStart = false;
      expect(await collect(controller.runner.run({ sessionId: 's', value: 'later' }))).toEqual([
        'later',
      ]);
      expect(started).toEqual(['first', 'later']);
      expect(guardCalls).toBe(3);
    } finally {
      finishFirst.resolve();
      await first;
      await controller.dispose();
    }
  });

  it.each([false, true])(
    'settles a queued guard that aborts its request (throws: %s)',
    async (throws) => {
      const finishFirst = gate();
      const abort = new AbortController();
      const started: string[] = [];
      let guardCalls = 0;
      const controller = createGenerationRunner({
        ...generation(1, (request) => {
          started.push(request.value);
          return source(
            [request.value],
            request.value === 'first' ? { wait: finishFirst.promise } : undefined,
          );
        }),
        assertCanStartSync(): undefined {
          if (++guardCalls === 2) {
            abort.abort();
            if (throws) throw undefined;
          }
          return undefined;
        },
      });
      const first = collect(controller.runner.run({ sessionId: 's', value: 'first' }));
      const queuedRun = controller.runner.run({
        sessionId: 's',
        value: 'cancelled',
        signal: abort.signal,
      });
      const queued = queuedRun[Symbol.asyncIterator]();
      const verdict = queued.next().then(
        (result) => ({ result }),
        (cause: unknown) => ({ cause }),
      );
      const later = collect(controller.runner.run({ sessionId: 's', value: 'later' }));

      try {
        finishFirst.resolve();
        expect(await verdict).toEqual(throws ? { cause: undefined } : { result: { done: true } });
        expect(await first).toEqual(['first']);
        expect(await later).toEqual(['later']);
        expect(started).toEqual(['first', 'later']);
      } finally {
        await controller.dispose();
      }
    },
  );

  it('finishes the head without invoking the runner when the guard disposes the controller', async () => {
    const started: string[] = [];
    const disposed: number[] = [];
    const controller = createGenerationRunner({
      ...generation(
        1,
        (request) => {
          started.push(request.value);
          return source([request.value]);
        },
        () => disposed.push(1),
      ),
      assertCanStartSync(): undefined {
        void controller.dispose();
        return undefined;
      },
    });

    try {
      expect(await collect(controller.runner.run({ sessionId: 's', value: 'head' }))).toEqual([]);
      expect(started).toEqual([]);
      expect(() => controller.commit(generation(2, () => source([])))).toThrow('disposed');
    } finally {
      await controller.dispose();
    }
    expect(disposed).toEqual([1]);
  });

  it('rejects the head with the admission block set by the guard', async () => {
    const blocked = new Error('admission blocked during start');
    const started: string[] = [];
    const controller = createGenerationRunner({
      ...generation(1, (request) => {
        started.push(request.value);
        return source([request.value]);
      }),
      assertCanStartSync(): undefined {
        controller.blockNewRuns(blocked);
        return undefined;
      },
    });

    try {
      await expect(collect(controller.runner.run({ sessionId: 's', value: 'head' }))).rejects.toBe(
        blocked,
      );
      expect(started).toEqual([]);
    } finally {
      await controller.dispose();
    }
  });

  it('fails the head when its guard replaces current and checks the new guard on the next head', async () => {
    const checked: string[] = [];
    const started: string[] = [];
    const disposed: number[] = [];
    let retirement: Promise<void> | undefined;
    const candidate = {
      ...generation(2, (request) => {
        started.push(`new:${request.value}`);
        return source([request.value]);
      }),
      assertCanStartSync(): undefined {
        checked.push('new');
        return undefined;
      },
    };
    const controller = createGenerationRunner({
      ...generation(
        1,
        (request) => {
          started.push(`old:${request.value}`);
          return source([request.value]);
        },
        () => disposed.push(1),
      ),
      assertCanStartSync(): undefined {
        checked.push('old');
        ({ retirement } = controller.commit(candidate));
        return undefined;
      },
    });

    try {
      await expect(
        collect(controller.runner.run({ sessionId: 's', value: 'head' })),
      ).rejects.toBeInstanceOf(Error);
      expect(controller.current()).toBe(candidate);
      expect(checked).toEqual(['old']);
      expect(started).toEqual([]);
      await retirement;
      expect(disposed).toEqual([1]);

      expect(await collect(controller.runner.run({ sessionId: 's', value: 'later' }))).toEqual([
        'later',
      ]);
      expect(checked).toEqual(['old', 'new']);
      expect(started).toEqual(['new:later']);
    } finally {
      await controller.dispose();
    }
  });

  it('invokes the guard itself when the function has its own call property', async () => {
    const failure = new Error('guard rejected admission');
    const guard = Object.assign(
      () => {
        throw failure;
      },
      { call: () => undefined },
    );
    const controller = createGenerationRunner({
      ...generation(1, () => source(['unexpected'])),
      assertCanStartSync: guard,
    });

    try {
      await expect(collect(controller.runner.run({ sessionId: 's', value: 'head' }))).rejects.toBe(
        failure,
      );
    } finally {
      await controller.dispose();
    }
  });

  it.each([
    ['non-callable guard', () => null],
    ['defined return', () => () => false],
    ['rejected Promise', () => () => Promise.reject(new Error('rejected Promise'))],
    [
      'rejected thenable',
      (observe: () => void) => () => ({
        then(_resolve: unknown, reject: (reason: unknown) => void) {
          observe();
          reject(new Error('rejected thenable'));
        },
      }),
    ],
  ] as const)('rejects the head with a %s across the runtime boundary', async (kind, makeGuard) => {
    const started: string[] = [];
    let thenObserved = false;
    const guard: unknown = makeGuard(() => {
      thenObserved = true;
    });
    const controller = createGenerationRunner({
      ...generation(1, (request) => {
        started.push(request.value);
        return source([request.value]);
      }),
      assertCanStartSync: guard as RunnerGeneration<Request, Event, unknown>['assertCanStartSync'],
    });

    try {
      await expect(
        collect(controller.runner.run({ sessionId: 's', value: 'invalid' })),
      ).rejects.toBeInstanceOf(TypeError);
      expect(started).toEqual([]);
      if (kind === 'rejected thenable') expect(thenObserved).toBe(true);
    } finally {
      await controller.dispose();
    }
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

describe('retained generations', () => {
  it('keeps a retiring generation pinned while its child waits behind ordinary Session work', async () => {
    const finishParent = gate();
    const oldDisposed = gate();
    const starts: string[] = [];
    let scope: RunningGenerationScope<Request, Event> | undefined;
    const old = generation(
      1,
      async function* (request, runningScope) {
        starts.push(`old:${request.value}`);
        if (request.value === 'parent') {
          scope = runningScope;
          yield 'parent';
          await finishParent.promise;
        } else yield `old:${request.value}`;
      },
      () => oldDisposed.resolve(),
    );
    const controller = createGenerationRunner(old);
    const parent = controller.runner.run({ sessionId: 'shared', value: 'parent' });
    const parentIterator = parent[Symbol.asyncIterator]();
    expect(await parentIterator.next()).toMatchObject({ value: 'parent' });
    expect(scope).toBeDefined();
    const lease = scope!.retain();
    try {
      let disposed = false;
      void oldDisposed.promise.then(() => {
        disposed = true;
      });
      await controller.replace(
        generation(2, async function* (request) {
          starts.push(`new:${request.value}`);
          yield `new:${request.value}`;
        }),
      );
      const ordinary = collect(controller.runner.run({ sessionId: 'shared', value: 'ordinary' }));
      const child = lease.run({ sessionId: 'shared', value: 'child' });
      expect(() => lease.run({ sessionId: 'elsewhere', value: 'duplicate' })).toThrow();
      const output = collect(child);
      expect(starts).toEqual(['old:parent']);
      expect(disposed).toBe(false);

      finishParent.resolve();
      expect(await parentIterator.next()).toMatchObject({ done: true });
      expect(() => scope!.retain()).toThrow();
      expect(await ordinary).toEqual(['new:ordinary']);
      expect(await output).toEqual(['old:child']);
      expect(starts).toEqual(['old:parent', 'new:ordinary', 'old:child']);
      expect(disposed).toBe(false);
      lease.release();
      lease.release();
      await oldDisposed.promise;
    } finally {
      finishParent.resolve();
      lease.release();
      await controller.dispose();
    }
  });

  it('lets an already retained child outlive cancellation of the parent request', async () => {
    const parentAbort = new AbortController();
    const leaseReady = gate<RetainedGenerationLease<Request, Event>>();
    const entered = gate();
    const controller = createGenerationRunner(
      generation(1, (request, scope) => {
        if (request.value === 'parent') {
          expect(scope).toBeDefined();
          leaseReady.resolve(scope!.retain());
          return cancellableSource(request, entered);
        }
        return source([request.signal?.aborted ? 'unexpected cancellation' : 'child']);
      }),
    );
    const parent = collect(
      controller.runner.run({ sessionId: 'parent', value: 'parent', signal: parentAbort.signal }),
    );
    const lease = await Promise.race([leaseReady.promise, parent.then(() => undefined)]);
    expect(lease).toBeDefined();
    parentAbort.abort(new Error('parent stopped'));
    expect(await parent).toEqual(['cancelled']);
    expect(await collect(lease!.run({ sessionId: 'child', value: 'child' }))).toEqual(['child']);
    lease!.release();
    await controller.dispose();
  });

  it('denies retain from an earlier listener on the parent request abort signal', async () => {
    const parentAbort = new AbortController();
    const stopped = gate();
    let scope: RunningGenerationScope<Request, Event> | undefined;
    let denied = false;
    let lateLease: RetainedGenerationLease<Request, Event> | undefined;
    parentAbort.signal.addEventListener(
      'abort',
      () => {
        try {
          lateLease = scope!.retain();
        } catch {
          denied = true;
        }
      },
      { once: true },
    );
    const controller = createGenerationRunner(
      generation(1, (request, runningScope) => {
        scope = runningScope;
        return cancellableSource(request, stopped);
      }),
    );
    const parent = collect(
      controller.runner.run({ sessionId: 'parent', value: 'parent', signal: parentAbort.signal }),
    );
    try {
      expect(scope).toBeDefined();
      parentAbort.abort();
      expect(await parent).toEqual(['cancelled']);
      expect(denied).toBe(true);
    } finally {
      lateLease?.release();
      await controller.dispose();
    }
  });

  it('checks the original guard for both retain and the child Session head', async () => {
    const finishHead = gate();
    const guardFailure = new Error('original ownership guard denies');
    const started: string[] = [];
    let scope: RunningGenerationScope<Request, Event> | undefined;
    let deny = false;
    const original = {
      ...generation(1, (request, runningScope) => {
        started.push(request.value);
        scope = runningScope;
        return source(
          ['parent'],
          request.value === 'parent' ? { wait: finishHead.promise } : undefined,
        );
      }),
      assertCanStartSync(): undefined {
        if (deny) throw guardFailure;
        return undefined;
      },
    };
    const controller = createGenerationRunner(original);
    const parent = collect(controller.runner.run({ sessionId: 'shared', value: 'parent' }));
    expect(scope).toBeDefined();
    deny = true;
    expect(() => scope!.retain()).toThrow(guardFailure);
    deny = false;
    const lease = scope!.retain();
    const child = collect(lease.run({ sessionId: 'shared', value: 'child' }));
    const rejected = expect(child).rejects.toBe(guardFailure);
    await controller.replace(generation(2, () => source(['new'])));
    deny = true;
    finishHead.resolve();
    await rejected;
    expect(await parent).toEqual(['parent']);
    expect(started).toEqual(['parent']);
    lease.release();
    await controller.dispose();
  });

  it('rechecks a permanent fence installed synchronously by the retained child guard', async () => {
    const finishParent = gate();
    const revoked = new Error('closed during guard');
    let scope: RunningGenerationScope<Request, Event> | undefined;
    let revokeOnCheck = false;
    const starts: string[] = [];
    const old = {
      ...generation(1, (request, runningScope) => {
        starts.push(request.value);
        scope = runningScope;
        return source([], { wait: finishParent.promise });
      }),
      assertCanStartSync(): undefined {
        if (revokeOnCheck) controller.closeRetainedStarts(old, revoked);
        return undefined;
      },
    };
    const controller = createGenerationRunner(old);
    const parent = collect(controller.runner.run({ sessionId: 'shared', value: 'parent' }));
    expect(scope).toBeDefined();
    const lease = scope!.retain();
    const child = lease.run({ sessionId: 'shared', value: 'child' });
    const rejected = expect(collect(child)).rejects.toBe(revoked);
    revokeOnCheck = true;
    finishParent.resolve();
    await rejected;
    await parent;
    expect(starts).toEqual(['parent']);
    lease.release();
    await controller.dispose();
  });

  it('permanently fences exactly the selected generation through ordinary publication', async () => {
    const finishParent = gate();
    const childReply = gate();
    const denial = new Error('original generation authority withdrawn');
    const starts: string[] = [];
    let scope: RunningGenerationScope<Request, Event> | undefined;
    const old = generation(1, (request, runningScope) => {
      starts.push(request.value);
      if (request.value === 'parent') scope = runningScope;
      return source([request.value], {
        wait: request.value === 'parent' ? finishParent.promise : childReply.promise,
      });
    });
    const controller = createGenerationRunner(old);
    const parent = collect(controller.runner.run({ sessionId: 'shared', value: 'parent' }));
    expect(scope).toBeDefined();
    controller.closeRetainedStarts({ ...old }, new Error('wrong object'));
    const preparing = scope!.retain();
    const queued = scope!.retain();
    const running = scope!.retain();
    const child = collect(running.run({ sessionId: 'other', value: 'running' }));
    const enqueued = expect(
      collect(queued.run({ sessionId: 'shared', value: 'queued' })),
    ).rejects.toBe(denial);

    await controller.replace(generation(2, () => source(['new'])));
    controller.closeRetainedStarts(old, denial);
    controller.closeRetainedStarts(old, new Error('second reason'));
    expect(() => scope!.retain()).toThrow(denial);
    expect(() => preparing.run({ sessionId: 'other', value: 'preparing' })).toThrow(denial);
    expect(starts).toEqual(['parent', 'running']);
    finishParent.resolve();
    childReply.resolve();
    await enqueued;
    expect(await parent).toEqual(['parent']);
    expect(await child).toEqual(['running']);
    expect(starts).toEqual(['parent', 'running']);
    preparing.release();
    queued.release();
    running.release();
    await controller.dispose();
  });

  it('blocks retained admission during a host block and honors prior permanent fences after commit', async () => {
    const finishParent = gate();
    const blocked = new Error('waiting for compliant generation');
    const revoked = new Error('old authority lost');
    let scope: RunningGenerationScope<Request, Event> | undefined;
    const old = generation(1, (request, runningScope) => {
      if (request.value === 'parent') scope = runningScope;
      return source([request.value], { wait: finishParent.promise });
    });
    const controller = createGenerationRunner(old);
    const parent = collect(controller.runner.run({ sessionId: 'shared', value: 'parent' }));
    expect(scope).toBeDefined();
    const open = scope!.retain();
    const bound = scope!.retain();
    const withdrawn = scope!.retain();
    const child = bound.run({ sessionId: 'child', value: 'child' });
    controller.blockNewRuns(blocked);
    expect(() => scope!.retain()).toThrow(blocked);
    expect(() => open.run({ sessionId: 'child', value: 'child' })).toThrow(blocked);
    await expect(collect(child)).rejects.toBe(blocked);
    withdrawn.closeStarts(revoked);

    await controller.replace(generation(2, () => source(['new'])));
    expect(() => withdrawn.run({ sessionId: 'child', value: 'child' })).toThrow(revoked);
    const result = collect(open.run({ sessionId: 'child', value: 'old child' }));
    finishParent.resolve();
    expect(await result).toEqual(['old child']);
    await parent;
    open.release();
    bound.release();
    withdrawn.release();
    await controller.dispose();
  });

  it('cancels a queued retained child without cancelling the parent or the next ordinary run', async () => {
    const finishParent = gate();
    const starts: string[] = [];
    let scope: RunningGenerationScope<Request, Event> | undefined;
    const controller = createGenerationRunner(
      generation(1, (request, runningScope) => {
        starts.push(request.value);
        if (request.value === 'parent') scope = runningScope;
        return source(
          [request.value],
          request.value === 'parent' ? { wait: finishParent.promise } : undefined,
        );
      }),
    );
    const parent = collect(controller.runner.run({ sessionId: 'shared', value: 'parent' }));
    expect(scope).toBeDefined();
    const lease = scope!.retain();
    const child = collect(lease.run({ sessionId: 'shared', value: 'queued' }));
    const ordinary = collect(controller.runner.run({ sessionId: 'shared', value: 'ordinary' }));
    const reason = new Error('queued child cancelled');
    lease.abort(reason);
    expect(await child).toEqual([]);
    expect(() => lease.run({ sessionId: 'other', value: 'retry' })).toThrow(reason);
    expect(starts).toEqual(['parent']);
    lease.release();
    finishParent.resolve();
    expect(await parent).toEqual(['parent']);
    expect(await ordinary).toEqual(['ordinary']);
    expect(starts).toEqual(['parent', 'ordinary']);
    await controller.dispose();
  });

  it.each([false, true])(
    'keeps the retirement pin through slow return with cleanup failure %s',
    async (failCleanup) => {
      const pending = gate<IteratorResult<string>>();
      const cleanup = gate();
      const enteredCleanup = gate();
      const disposed = gate();
      const failed = new Error('child return failed');
      const cancelled = new Error('child cancelled');
      let scope: RunningGenerationScope<Request, Event> | undefined;
      let childSignal: AbortSignal | undefined;
      let returnCalls = 0;
      const controller = createGenerationRunner(
        generation(
          1,
          (request, runningScope) => {
            if (request.value === 'parent') {
              scope = runningScope;
              return source(['parent']);
            }
            childSignal = request.signal;
            return {
              [Symbol.asyncIterator]() {
                return {
                  next: () => pending.promise,
                  async return() {
                    returnCalls += 1;
                    enteredCleanup.resolve();
                    pending.resolve({ done: true, value: undefined });
                    await cleanup.promise;
                    if (failCleanup) throw failed;
                    return { done: true, value: undefined };
                  },
                };
              },
            };
          },
          () => disposed.resolve(),
        ),
      );
      const parent = collect(controller.runner.run({ sessionId: 'parent', value: 'parent' }));
      expect(scope).toBeDefined();
      const lease = scope!.retain();
      expect(await parent).toEqual(['parent']);
      const child = lease.run({ sessionId: 'child', value: 'child' })[Symbol.asyncIterator]();
      const next = child.next();
      await controller.replace(generation(2, () => source(['new'])));
      let didDispose = false;
      void disposed.promise.then(() => {
        didDispose = true;
      });
      lease.closeStarts(new Error('starts closed'));
      lease.release();
      lease.release();
      expect(childSignal?.aborted).toBe(false);
      lease.abort(cancelled);
      lease.abort(new Error('second cancellation'));
      await enteredCleanup.promise;
      expect(childSignal?.reason).toBe(cancelled);
      expect(didDispose).toBe(false);
      const returning = child.return!();
      const verifiedReturn = failCleanup
        ? expect(returning).rejects.toBe(failed)
        : expect(returning).resolves.toMatchObject({ done: true });
      expect(await next).toMatchObject({ done: true });
      cleanup.resolve();
      await verifiedReturn;
      await disposed.promise;
      expect(returnCalls).toBe(1);
      if (failCleanup)
        await expect(controller.dispose()).rejects.toMatchObject({ errors: [failed] });
      else await controller.dispose();
    },
  );

  it.each(['immediate replacement', 'active abort', 'shutdown'] as const)(
    '%s fences retained starts, aborts children and preserves the first cancellation',
    async (operation) => {
      const stopped = gate();
      const cancel = new Error('host abort');
      const starts: string[] = [];
      let scope: RunningGenerationScope<Request, Event> | undefined;
      let childSignal: AbortSignal | undefined;
      let disposed = 0;
      const controller = createGenerationRunner(
        generation(
          1,
          (request, runningScope) => {
            starts.push(request.value);
            if (request.value === 'parent') scope = runningScope;
            if (request.value === 'running') childSignal = request.signal;
            if (request.value === 'ordinary') return source(['ordinary']);
            return cancellableSource(request, stopped);
          },
          () => {
            disposed += 1;
          },
        ),
      );
      const parent = collect(controller.runner.run({ sessionId: 'shared', value: 'parent' }));
      expect(scope).toBeDefined();
      const idle = scope!.retain();
      const queued = scope!.retain();
      const running = scope!.retain();
      const pendingChild = collect(queued.run({ sessionId: 'shared', value: 'queued' }));
      const child = collect(running.run({ sessionId: 'child', value: 'running' }));
      const ordinary = collect(controller.runner.run({ sessionId: 'shared', value: 'ordinary' }));
      const next = generation(2, () => source(['ordinary']));

      if (operation === 'immediate replacement')
        await controller.replace(next, { immediate: true });
      if (operation === 'active abort') controller.abortActiveRuns(cancel);
      const closing = operation === 'shutdown' ? controller.dispose() : undefined;
      expect(() => scope!.retain()).toThrow();
      expect(() => idle.run({ sessionId: 'child', value: 'idle' })).toThrow();
      expect(await parent).toEqual(['cancelled']);
      expect(await child).toEqual(['cancelled']);
      expect(await pendingChild).toEqual([]);
      expect(await ordinary).toEqual(operation === 'shutdown' ? [] : ['ordinary']);
      expect(starts).toEqual(
        operation === 'active abort' ? ['parent', 'running', 'ordinary'] : ['parent', 'running'],
      );
      expect(childSignal?.aborted).toBe(true);
      if (operation === 'active abort') expect(childSignal?.reason).toBe(cancel);
      if (closing) await closing;
      else {
        idle.release();
        queued.release();
        running.release();
        await controller.dispose();
      }
      expect(disposed).toBe(1);
    },
  );

  it('drains a retained child when runner creation and its abort listener both call dispose', async () => {
    const next = gate<IteratorResult<string>>();
    const inReturn = gate();
    const finishReturn = gate();
    const disposals: string[] = [];
    let scope: RunningGenerationScope<Request, Event> | undefined;
    let closing: Promise<void> | undefined;
    let reentered: Promise<void> | undefined;
    const controller = createGenerationRunner(
      generation(
        1,
        (request, runningScope) => {
          if (request.value === 'parent') {
            scope = runningScope;
            return source(['parent']);
          }
          request.signal?.addEventListener(
            'abort',
            () => {
              reentered = controller.dispose();
            },
            { once: true },
          );
          closing = controller.dispose();
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => next.promise,
                async return() {
                  inReturn.resolve();
                  next.resolve({ done: true, value: undefined });
                  await finishReturn.promise;
                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
        () => {
          disposals.push('old');
        },
      ),
    );
    const parent = collect(controller.runner.run({ sessionId: 'parent', value: 'parent' }));
    expect(scope).toBeDefined();
    const lease = scope!.retain();
    expect(await parent).toEqual(['parent']);
    const child = collect(lease.run({ sessionId: 'child', value: 'child' }));
    await inReturn.promise;
    expect(closing).toBeDefined();
    expect(reentered).toBe(closing);
    let closed = false;
    void closing!.then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    expect(disposals).toEqual([]);
    finishReturn.resolve();
    expect(await child).toEqual([]);
    await closing;
    expect(disposals).toEqual(['old']);
  });

  it('aggregates a throwing iterator return accessor without stranding shutdown', async () => {
    const cleanupFailure = new Error('iterator return lookup failed');
    const pending = gate<IteratorResult<Event>>();
    let scope: RunningGenerationScope<Request, Event> | undefined;
    let disposals = 0;
    let cleanupReads = 0;
    const controller = createGenerationRunner(
      generation(
        1,
        (request, runningScope) => {
          if (request.value === 'parent') {
            scope = runningScope;
            return source(['parent']);
          }
          request.signal?.addEventListener(
            'abort',
            () => pending.resolve({ done: true, value: undefined }),
            { once: true },
          );
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => pending.promise,
                get return(): never {
                  cleanupReads += 1;
                  throw cleanupFailure;
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
    const parent = collect(controller.runner.run({ sessionId: 'parent', value: 'parent' }));
    expect(scope).toBeDefined();
    const lease = scope!.retain();
    expect(await parent).toEqual(['parent']);
    const outcome = collect(lease.run({ sessionId: 'child', value: 'child' })).then(
      (events) => ({ events }),
      (failure: unknown) => ({ failure }),
    );

    const closing = controller.dispose();
    expect(controller.dispose()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [cleanupFailure] });
    expect(await outcome).toEqual({ failure: cleanupFailure });
    expect(cleanupReads).toBe(1);
    expect(disposals).toBe(1);
  });

  it('keeps the first host abort reason when a child listener aborts the controller again', async () => {
    const first = new Error('first host abort');
    const nested = new Error('nested host abort');
    const stopped = gate();
    const signals: AbortSignal[] = [];
    let scope: RunningGenerationScope<Request, Event> | undefined;
    const controller = createGenerationRunner(
      generation(1, (request, runningScope) => {
        if (request.value === 'parent') scope = runningScope;
        if (request.value === 'child') {
          request.signal?.addEventListener('abort', () => controller.abortActiveRuns(nested), {
            once: true,
          });
        }
        if (request.signal) signals.push(request.signal);
        return cancellableSource(request, stopped);
      }),
    );
    const parent = collect(controller.runner.run({ sessionId: 'parent', value: 'parent' }));
    expect(scope).toBeDefined();
    const lease = scope!.retain();
    const child = collect(lease.run({ sessionId: 'child', value: 'child' }));
    const ordinary = collect(controller.runner.run({ sessionId: 'ordinary', value: 'ordinary' }));
    controller.abortActiveRuns(first);

    try {
      expect(await Promise.all([parent, child, ordinary])).toEqual([
        ['cancelled'],
        ['cancelled'],
        ['cancelled'],
      ]);
      expect(signals.map((signal) => signal.reason)).toEqual([first, first, first]);
    } finally {
      lease.release();
      await controller.dispose();
    }
  });

  it('rejects retain once the failed producer enters iterator cleanup', async () => {
    const producerFailure = new Error('producer failed');
    const denied = gate<boolean>();
    let leaked: RetainedGenerationLease<Request, Event> | undefined;
    const controller = createGenerationRunner(
      generation(1, (_request, scope) => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw producerFailure;
            },
            async return() {
              try {
                leaked = scope!.retain();
                denied.resolve(false);
              } catch {
                denied.resolve(true);
              }
              return { done: true, value: undefined };
            },
          };
        },
      })),
    );
    try {
      await expect(
        collect(controller.runner.run({ sessionId: 'failed', value: 'failed' })),
      ).rejects.toBe(producerFailure);
      expect(await denied.promise).toBe(true);
    } finally {
      leaked?.release();
      await controller.dispose();
    }
  });

  it('drains an ordinary turn when its synchronous runner creation calls dispose', async () => {
    const cleanup = gate();
    const stopped = gate();
    const disposals: string[] = [];
    let closing: Promise<void> | undefined;
    const controller = createGenerationRunner(
      generation(
        1,
        (request) => {
          closing = controller.dispose();
          return cancellableSource(request, stopped, cleanup.promise);
        },
        () => {
          disposals.push('old');
        },
      ),
    );
    const output = collect(controller.runner.run({ sessionId: 'session', value: 'ordinary' }));
    expect(closing).toBeDefined();
    let closed = false;
    void closing!.then(() => {
      closed = true;
    });
    for (let i = 0; i < 5; i += 1) await tick();
    expect(closed).toBe(false);
    cleanup.resolve();
    expect(await output).toEqual(['cancelled']);
    await closing;
    expect(disposals).toEqual(['old']);
  });
});

describe('generation cancellation and lifetime', () => {
  it('aborts active runs in current and retired generations with the first exact reason only', async () => {
    const started = new Map([
      [1, gate()],
      [2, gate()],
      [3, gate()],
    ]);
    const cleanup = gate();
    const reasons: unknown[] = [];
    const cleanups: number[] = [];
    const disposed: number[] = [];

    const makeGeneration = (id: number) =>
      generation(
        id,
        (request) => ({
          async *[Symbol.asyncIterator]() {
            started.get(id)!.resolve();
            try {
              await new Promise<void>((resolve) => {
                if (request.signal?.aborted) resolve();
                else
                  request.signal?.addEventListener(
                    'abort',
                    () => {
                      reasons.push(request.signal?.reason);
                      resolve();
                    },
                    { once: true },
                  );
              });
              await cleanup.promise;
              yield `cancelled:${id}`;
            } finally {
              cleanups.push(id);
            }
          },
        }),
        () => disposed.push(id),
      );

    const controller = createGenerationRunner(makeGeneration(1));
    const first = collect(controller.runner.run({ sessionId: 'one', value: 'a' }));
    await started.get(1)!.promise;
    await controller.replace(makeGeneration(2));
    const second = collect(controller.runner.run({ sessionId: 'two', value: 'b' }));
    await started.get(2)!.promise;
    await controller.replace(makeGeneration(3));
    const third = collect(controller.runner.run({ sessionId: 'three', value: 'c' }));
    await started.get(3)!.promise;

    const firstReason = new Error('first cancellation reason');
    controller.abortActiveRuns(firstReason);
    controller.abortActiveRuns(new Error('ignored cancellation reason'));
    expect(reasons).toHaveLength(3);
    for (const reason of reasons) expect(reason).toBe(firstReason);
    expect(cleanups).toEqual([]);
    expect(controller.current().id).toBe(3);
    cleanup.resolve();

    expect(await first).toEqual(['cancelled:1']);
    expect(await second).toEqual(['cancelled:2']);
    expect(await third).toEqual(['cancelled:3']);
    expect(cleanups).toEqual([1, 2, 3]);

    await controller.dispose();
    expect(disposed).toEqual([1, 2, 3]);
  });

  it('cancels only running turns, admits queued work, and keeps the current generation reusable', async () => {
    const started = gate();
    const cleanup = gate();
    const starts: string[] = [];
    const signals: AbortSignal[] = [];
    const controller = createGenerationRunner(
      generation(1, async function* (request) {
        starts.push(request.value);
        signals.push(request.signal!);
        if (request.value === 'a') {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else request.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          await cleanup.promise;
          return;
        }
        yield request.value;
      }),
    );

    const first = collect(controller.runner.run({ sessionId: 'same', value: 'a' }));
    await started.promise;
    const queued = collect(controller.runner.run({ sessionId: 'same', value: 'b' }));
    await tick();

    controller.abortActiveRuns('cancel active turn');
    expect(starts).toEqual(['a']);
    expect(signals[0]?.reason).toBe('cancel active turn');
    cleanup.resolve();

    expect(await first).toEqual([]);
    expect(await queued).toEqual(['b']);
    expect(starts).toEqual(['a', 'b']);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    expect(await collect(controller.runner.run({ sessionId: 'same', value: 'c' }))).toEqual(['c']);
    expect(signals[2]?.aborted).toBe(false);
    await controller.dispose();
  });

  it('keeps admission blocked after cancelling active runs until a successful replacement', async () => {
    const started = gate();
    const stopped = gate();
    const controller = createGenerationRunner(
      generation(1, (request) => {
        started.resolve();
        return cancellableSource(request, stopped);
      }),
    );
    const active = collect(controller.runner.run({ sessionId: 'same', value: 'a' }));
    await started.promise;
    const blocked = new Error('plugin disabled');
    controller.blockNewRuns(blocked);
    controller.abortActiveRuns(blocked);

    expect(await active).toEqual(['cancelled']);
    await stopped.promise;
    await expect(collect(controller.runner.run({ sessionId: 'same', value: 'b' }))).rejects.toBe(
      blocked,
    );
    await expect(controller.replace(generation(1, () => source([])))).rejects.toThrow();
    await expect(collect(controller.runner.run({ sessionId: 'same', value: 'c' }))).rejects.toBe(
      blocked,
    );

    await controller.replace(
      generation(2, async function* (request) {
        expect(request.signal?.aborted).toBe(false);
        yield 'recovered';
      }),
    );
    expect(await collect(controller.runner.run({ sessionId: 'same', value: 'd' }))).toEqual([
      'recovered',
    ]);
    await controller.dispose();
  });

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

  it.each(['shutdown', 'immediate', 'request', 'active'] as const)(
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
      } else if (mode === 'active') {
        controller.abortActiveRuns(new Error('cancel active'));
        controller.abortActiveRuns(new Error('already cancelled'));
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
