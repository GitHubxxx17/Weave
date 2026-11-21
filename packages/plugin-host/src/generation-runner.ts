export interface GenerationRequest {
  readonly sessionId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface GenerationRunner<R extends GenerationRequest, E> {
  run(request: R): AsyncIterable<E>;
}

export interface RunnerGeneration<R extends GenerationRequest, E, T> {
  readonly id: number;
  readonly runner: GenerationRunner<R, E>;
  readonly resources: T;
  readonly assertCanStartSync?: (() => undefined) | undefined;
  dispose(): void | Promise<void>;
}

export interface GenerationCommit {
  /**
   * Waits for disposal that can start at commit time. If a running turn still
   * pins the previous generation, the last such turn starts its disposal.
   */
  readonly retirement: Promise<void>;
}

export interface GenerationController<R extends GenerationRequest, E, T> {
  readonly runner: GenerationRunner<R, E>;
  current(): RunnerGeneration<R, E, T>;
  /** Switches the current generation synchronously and throws if validation fails. */
  commit(next: RunnerGeneration<R, E, T>, options?: { immediate?: boolean }): GenerationCommit;
  replace(next: RunnerGeneration<R, E, T>, options?: { immediate?: boolean }): Promise<void>;
  blockNewRuns(error: Error): void;
  abortActiveRuns(reason?: unknown): void;
  dispose(): Promise<void>;
}

interface GenerationState<R extends GenerationRequest, E, T> {
  readonly generation: RunnerGeneration<R, E, T>;
  readonly abort: AbortController;
  active: number;
  retired: boolean;
  disposal?: Promise<void>;
}

interface PendingNext<E> {
  resolve(result: IteratorResult<E>): void;
  reject(error: unknown): void;
}

/** Keeps production, cancellation and Session ownership independent of consumer reads. */
export function createGenerationRunner<R extends GenerationRequest, E, T>(
  initial: RunnerGeneration<R, E, T>,
): GenerationController<R, E, T> {
  const generations = new Set<GenerationState<R, E, T>>();
  const sessions = new Map<string, Run[]>();
  const advancingSessions = new Set<string>();
  const disposalErrors: unknown[] = [];
  let current = stateFor(initial);
  let blocked: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  function stateFor(generation: RunnerGeneration<R, E, T>): GenerationState<R, E, T> {
    const state = { generation, abort: new AbortController(), active: 0, retired: false };
    generations.add(state);
    return state;
  }

  function retire(state: GenerationState<R, E, T>): Promise<void> | undefined {
    if (!state.retired || state.active > 0) return undefined;
    if (!state.disposal) {
      state.abort.abort();
      // Store the promise before calling external disposal code, including synchronous throws.
      state.disposal = Promise.resolve()
        .then(() => state.generation.dispose())
        .catch((error: unknown) => {
          disposalErrors.push(error);
        })
        .finally(() => {
          generations.delete(state);
        });
    }
    return state.disposal;
  }

  function startSessionHead(sessionId: string): void {
    // Synchronous rejection or cancellation can release a head while it is starting.
    if (advancingSessions.has(sessionId)) return;
    advancingSessions.add(sessionId);
    try {
      while (true) {
        const head = sessions.get(sessionId)?.[0];
        if (!head) return;
        head.start();
        if (sessions.get(sessionId)?.[0] === head) return;
      }
    } finally {
      advancingSessions.delete(sessionId);
    }
  }

  class Run implements AsyncIterableIterator<E> {
    private phase: 'idle' | 'queued' | 'running' | 'finished' = 'idle';
    private guardInProgress = false;
    private readonly abort = new AbortController();
    private readonly buffer: E[] = [];
    private readonly waiting: PendingNext<E>[] = [];
    private returned = false;
    private error: unknown;
    private hasError = false;
    private cleanupSignal: (() => void) | undefined;
    private production: Promise<void> = Promise.resolve();
    private iterator: AsyncIterator<E> | undefined;
    private iteratorClose: Promise<IteratorResult<E>> | undefined;
    private cleanupError: unknown;
    private hasCleanupError = false;
    private cleanupErrorReported = false;

    constructor(private readonly request: R) {}

    [Symbol.asyncIterator](): AsyncIterableIterator<E> {
      return this;
    }

    next(): Promise<IteratorResult<E>> {
      if (this.phase === 'idle') this.enqueue();
      return new Promise((resolve, reject) => {
        this.waiting.push({ resolve, reject });
        this.flush();
      });
    }

    async return(): Promise<IteratorResult<E>> {
      this.returned = true;
      this.buffer.length = 0;
      this.cancel();
      this.flush();
      await this.production;
      if (this.hasCleanupError) throw this.cleanupError;
      return { done: true, value: undefined };
    }

    private enqueue(): void {
      if (this.returned || this.request.signal?.aborted || closed) {
        this.finish();
        return;
      }
      if (blocked) {
        this.finish(blocked);
        return;
      }
      this.phase = 'queued';
      const signal = this.request.signal;
      if (signal) {
        const onAbort = () => this.cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        this.cleanupSignal = () => signal.removeEventListener('abort', onAbort);
      }
      const sessionId = this.request.sessionId;
      const queue = sessions.get(sessionId) ?? [];
      queue.push(this);
      sessions.set(sessionId, queue);
      if (queue[0] === this) startSessionHead(sessionId);
    }

    start(): void {
      if (closed || blocked) {
        this.finish(blocked);
        this.release();
        return;
      }
      const state = current;
      this.guardInProgress = true;
      try {
        const guard = state.generation.assertCanStartSync;
        if (guard !== undefined) {
          if (typeof guard !== 'function') {
            throw new TypeError('Generation start guard must be a function');
          }
          const result: unknown = Reflect.apply(guard, state.generation, []);
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined);
            throw new TypeError('Generation start guard must return undefined synchronously');
          }
        }
      } catch (cause: unknown) {
        const wasQueued = this.phase === 'queued';
        this.finish(cause, true);
        if (wasQueued) this.release();
        return;
      } finally {
        this.guardInProgress = false;
        this.flush();
      }

      if (this.phase !== 'queued') return;
      if (closed || blocked) {
        this.finish(blocked);
        this.release();
        return;
      }
      if (state !== current) {
        this.finish(new Error('Current generation changed during start admission'));
        this.release();
        return;
      }

      this.phase = 'running';
      state.active += 1;
      const onAbort = () => this.cancel(state.abort.signal.reason);
      state.abort.signal.addEventListener('abort', onAbort, { once: true });
      this.production = this.pump(state).finally(() => {
        state.abort.signal.removeEventListener('abort', onAbort);
        state.active -= 1;
        retire(state);
        this.release();
      });
    }

    settled(): Promise<void> {
      return this.production;
    }

    abortIfRunning(reason?: unknown): void {
      if (this.phase === 'running') this.cancel(reason);
    }

    cancel(reason: unknown = this.request.signal?.reason): void {
      if (this.abort.signal.aborted) return;
      this.abort.abort(reason);
      // A custom iterator may use return() itself to release a blocked next().
      // Async generators instead unblock next() through the forwarded signal.
      if (this.phase === 'running') this.closeIterator();
      if (this.phase === 'idle') this.finish();
      else if (this.phase === 'queued') {
        this.finish();
        this.release();
      }
    }

    private closeIterator(): Promise<IteratorResult<E>> | undefined {
      const iterator = this.iterator;
      if (!iterator?.return) return undefined;
      if (!this.iteratorClose) {
        this.iteratorClose = Promise.resolve().then(() => iterator.return!());
        // Cancellation can request close before the pump reaches its finalizer.
        void this.iteratorClose.catch(() => undefined);
      }
      return this.iteratorClose;
    }

    private async pump(state: GenerationState<R, E, T>): Promise<void> {
      let exhausted = false;
      let failure: unknown;
      let failed = false;
      try {
        const iterable = state.generation.runner.run({
          ...this.request,
          signal: this.abort.signal,
        });
        const iterator = iterable[Symbol.asyncIterator]();
        this.iterator = iterator;
        if (this.abort.signal.aborted) this.closeIterator();
        while (true) {
          const result = await iterator.next();
          if (result.done) {
            exhausted = true;
            break;
          }
          if (!this.returned) {
            this.buffer.push(result.value);
            this.flush();
          }
          if (this.returned) break;
        }
      } catch (error: unknown) {
        failure = error;
        failed = true;
        if (this.returned && !this.isCancellation(error)) this.recordCleanupError(error);
      } finally {
        if (!exhausted || this.iteratorClose) {
          try {
            await this.closeIterator();
          } catch (error: unknown) {
            failed = true;
            failure = error;
            this.recordCleanupError(error);
          }
        }
        this.finish(failed ? failure : undefined, failed);
      }
    }

    private finish(error?: unknown, failed = error !== undefined): void {
      this.phase = 'finished';
      this.cleanupSignal?.();
      this.cleanupSignal = undefined;
      if (!this.returned && failed) {
        this.error = error;
        this.hasError = true;
      }
      this.flush();
    }

    private recordCleanupError(error: unknown): void {
      if (!this.hasCleanupError) {
        this.hasCleanupError = true;
        this.cleanupError = error;
      }
      if (!this.cleanupErrorReported) {
        this.cleanupErrorReported = true;
        disposalErrors.push(error);
      }
    }

    private isCancellation(error: unknown): boolean {
      if (!this.abort.signal.aborted) return false;
      if (error === this.abort.signal.reason) return true;
      if (error instanceof DOMException && error.name === 'AbortError') return true;
      return (
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled'
      );
    }

    private release(): void {
      const sessionId = this.request.sessionId;
      const queue = sessions.get(sessionId);
      if (!queue) return;
      const index = queue.indexOf(this);
      if (index < 0) return;
      queue.splice(index, 1);
      if (queue.length === 0) sessions.delete(sessionId);
      else if (index === 0) startSessionHead(sessionId);
    }

    private flush(): void {
      // A guard can synchronously finish this run, then throw before admission settles.
      if (this.guardInProgress) return;
      while (this.waiting.length > 0) {
        if (!this.returned && this.buffer.length > 0) {
          this.waiting.shift()!.resolve({ done: false, value: this.buffer.shift()! });
        } else if (this.returned || this.phase === 'finished') {
          const next = this.waiting.shift()!;
          if (this.hasError) {
            this.hasError = false;
            next.reject(this.error);
          } else next.resolve({ done: true, value: undefined });
        } else break;
      }
    }
  }

  const commit: GenerationController<R, E, T>['commit'] = (next, options) => {
    // Read the option before validating state because an accessor can reenter the controller.
    const immediate = options?.immediate;
    if (closed) throw new Error('Generation runner is disposed');
    if (!Number.isSafeInteger(next.id) || next.id <= current.generation.id) {
      throw new Error('Generation ids must increase monotonically');
    }
    const previous = current;
    current = stateFor(next);
    blocked = undefined;
    previous.retired = true;
    if (immediate) {
      for (const state of generations) if (state.retired) state.abort.abort();
    }
    return { retirement: retire(previous) ?? Promise.resolve() };
  };

  const runner: GenerationRunner<R, E> = { run: (request) => new Run(request) };
  return {
    runner,
    current: () => current.generation,
    commit,
    async replace(next, options) {
      await commit(next, options).retirement;
    },
    blockNewRuns(error) {
      blocked = error;
    },
    abortActiveRuns(reason) {
      for (const run of [...sessions.values()].flat()) run.abortIfRunning(reason);
    },
    dispose() {
      if (!closing) {
        closed = true;
        for (const queue of [...sessions.values()]) {
          for (const run of [...queue]) run.cancel();
        }
        for (const state of generations) {
          state.retired = true;
          state.abort.abort();
        }
        closing = (async () => {
          // Running turns stay in their Session queue until cancellation has fully settled.
          await Promise.all([...sessions.values()].flat().map((run) => run.settled()));
          await Promise.all([...generations].map((state) => retire(state)));
          if (disposalErrors.length > 0) {
            throw new AggregateError(disposalErrors, 'Generation disposal failed', {
              cause: disposalErrors[0],
            });
          }
        })();
      }
      return closing;
    },
  };
}
