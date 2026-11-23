export interface GenerationRequest {
  readonly sessionId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface GenerationRunner<R extends GenerationRequest, E> {
  run(request: R, scope?: RunningGenerationScope<R, E>): AsyncIterable<E>;
}

export interface RunningGenerationScope<R extends GenerationRequest, E> {
  retain(): RetainedGenerationLease<R, E>;
}

export interface RetainedGenerationLease<R extends GenerationRequest, E> {
  run(request: R): AsyncIterable<E>;
  closeStarts(reason?: unknown): void;
  abort(reason?: unknown): void;
  release(): void;
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
   * Waits for disposal that can start at commit time. Otherwise the final
   * running turn or retained lease to release its pin starts disposal.
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
  closeRetainedStarts(generation: RunnerGeneration<R, E, T>, reason?: unknown): void;
  abortActiveRuns(reason?: unknown): void;
  dispose(): Promise<void>;
}

interface PendingNext<E> {
  resolve(result: IteratorResult<E>): void;
  reject(error: unknown): void;
}

/** Keeps production, cancellation and Session ownership independent of consumer reads. */
export function createGenerationRunner<R extends GenerationRequest, E, T>(
  initial: RunnerGeneration<R, E, T>,
): GenerationController<R, E, T> {
  interface GenerationState {
    readonly generation: RunnerGeneration<R, E, T>;
    readonly active: Set<Run>;
    readonly leases: Set<RetainedLease>;
    retainedFence?: { readonly reason: unknown };
    retired: boolean;
    disposal?: Promise<void>;
  }

  const generations = new Set<GenerationState>();
  const sessions = new Map<string, Run[]>();
  const advancingSessions = new Set<string>();
  const disposalErrors: unknown[] = [];
  let current = stateFor(initial);
  let blocked: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  function stateFor(generation: RunnerGeneration<R, E, T>): GenerationState {
    const state: GenerationState = {
      generation,
      active: new Set(),
      leases: new Set(),
      retired: false,
    };
    generations.add(state);
    return state;
  }

  function retire(state: GenerationState): Promise<void> | undefined {
    if (!state.retired || state.active.size > 0 || state.leases.size > 0) return undefined;
    if (!state.disposal) {
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

  function checkGuard(state: GenerationState): void {
    const guard = state.generation.assertCanStartSync;
    if (guard === undefined) return;
    if (typeof guard !== 'function') {
      throw new TypeError('Generation start guard must be a function');
    }
    const result: unknown = Reflect.apply(guard, state.generation, []);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Generation start guard must return undefined synchronously');
    }
  }

  function assertRetainedAdmission(state: GenerationState): void {
    if (state.retainedFence) throw state.retainedFence.reason;
    if (closed) throw new Error('Generation runner is disposed');
    if (blocked) throw blocked;
  }

  function closeRetainedStartFence(state: GenerationState, reason?: unknown): void {
    state.retainedFence ??= {
      reason: reason === undefined ? new Error('Generation retained starts are closed') : reason,
    };
  }

  function cancelWork(states: GenerationState[], runs: Run[], reason?: unknown): void {
    // Establish all fences and reserve the first reasons before notifying abort listeners.
    const targets = new Set(runs);
    for (const state of states) {
      closeRetainedStartFence(state, reason);
      for (const lease of state.leases) {
        lease.closeStarts(reason);
        if (lease.child) targets.add(lease.child);
      }
    }
    for (const run of targets) run.reserveCancellation(reason);
    for (const run of targets) run.cancel();
  }

  class RetainedLease implements RetainedGenerationLease<R, E> {
    child: Run | undefined;
    private fence: { readonly reason: unknown } | undefined;
    private producing = false;
    private releaseRequested = false;

    constructor(readonly state: GenerationState) {
      state.leases.add(this);
    }

    run(request: R): AsyncIterable<E> {
      this.assertCanStart();
      if (this.child) throw new Error('Generation lease already has a run');
      const run = new Run(request, this);
      this.child = run;
      return run.output;
    }

    closeStarts(reason?: unknown): void {
      this.fence ??= {
        reason: reason === undefined ? new Error('Generation lease starts are closed') : reason,
      };
    }

    abort(reason?: unknown): void {
      this.closeStarts(reason);
      this.child?.cancel(reason);
    }

    release(): void {
      this.closeStarts();
      this.releaseRequested = true;
      this.releasePin();
    }

    assertCanStart(): void {
      if (this.fence) throw this.fence.reason;
      assertRetainedAdmission(this.state);
    }

    childStarted(): void {
      this.producing = true;
    }

    childSettled(): void {
      this.producing = false;
      this.releasePin();
    }

    private releasePin(): void {
      if (this.releaseRequested && !this.producing && this.state.leases.delete(this)) {
        retire(this.state);
      }
    }
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

  class Run {
    readonly output: AsyncIterableIterator<E> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => this.next(),
      return: () => this.return(),
    };
    private phase: 'idle' | 'queued' | 'running' | 'finished' = 'idle';
    private guardInProgress = false;
    private producerEnded = false;
    private readonly abort = new AbortController();
    private cancellation?: { readonly reason: unknown };
    private readonly buffer: E[] = [];
    private readonly waiting: PendingNext<E>[] = [];
    private returned = false;
    private error: unknown;
    private hasError = false;
    private cleanupSignal: (() => void) | undefined;
    private production: Promise<void> = Promise.resolve();
    private iterator: AsyncIterator<E> | undefined;
    private iteratorClose: Promise<IteratorResult<E> | undefined> | undefined;
    private cleanupError: unknown;
    private hasCleanupError = false;
    private cleanupErrorReported = false;

    constructor(
      private readonly request: R,
      private readonly retained?: RetainedLease,
    ) {}

    private next(): Promise<IteratorResult<E>> {
      if (this.phase === 'idle') this.enqueue();
      return new Promise((resolve, reject) => {
        this.waiting.push({ resolve, reject });
        this.flush();
      });
    }

    private async return(): Promise<IteratorResult<E>> {
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
      if (this.retained) {
        try {
          this.retained.assertCanStart();
        } catch (cause: unknown) {
          this.finish(cause, true);
          return;
        }
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
      const state = this.retained?.state ?? current;
      this.guardInProgress = true;
      try {
        this.retained?.assertCanStart();
        checkGuard(state);
        if (this.phase !== 'queued') return;
        this.retained?.assertCanStart();
        if (blocked) throw blocked;
        if (!this.retained && state !== current) {
          throw new Error('Current generation changed during start admission');
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
      this.phase = 'running';
      state.active.add(this);
      this.retained?.childStarted();
      const scope: RunningGenerationScope<R, E> = { retain: () => this.retain(state) };
      // Runner creation and abort listeners can call dispose before pump returns a promise.
      let settle!: (production: Promise<void>) => void;
      this.production = new Promise((resolve) => {
        settle = resolve;
      });
      settle(
        this.pump(state, scope).finally(() => {
          state.active.delete(this);
          this.retained?.childSettled();
          retire(state);
          this.release();
        }),
      );
    }

    private retain(state: GenerationState): RetainedGenerationLease<R, E> {
      this.assertCanRetain(state);
      checkGuard(state);
      this.assertCanRetain(state);
      const lease = new RetainedLease(state);
      return {
        run: (request) => lease.run(request),
        closeStarts: (reason) => lease.closeStarts(reason),
        abort: (reason) => lease.abort(reason),
        release: () => lease.release(),
      };
    }

    private assertCanRetain(state: GenerationState): void {
      assertRetainedAdmission(state);
      if (
        !this.isRunning() ||
        this.producerEnded ||
        this.abort.signal.aborted ||
        this.request.signal?.aborted
      ) {
        throw new Error('Generation scope is no longer running');
      }
    }

    settled(): Promise<void> {
      return this.production;
    }

    isRunning(): boolean {
      return this.phase === 'running';
    }

    reserveCancellation(reason?: unknown): void {
      this.cancellation ??= { reason };
    }

    cancel(reason: unknown = this.request.signal?.reason): void {
      if (this.phase === 'finished' || this.abort.signal.aborted) return;
      this.reserveCancellation(reason);
      this.abort.abort(this.cancellation?.reason);
      // A custom iterator may use return() itself to release a blocked next().
      // Async generators instead unblock next() through the forwarded signal.
      if (this.phase === 'running') this.closeIterator();
      if (this.phase === 'idle') this.finish();
      else if (this.phase === 'queued') {
        this.finish();
        this.release();
      }
    }

    private closeIterator(): Promise<IteratorResult<E> | undefined> | undefined {
      const iterator = this.iterator;
      if (!iterator) return undefined;
      if (!this.iteratorClose) {
        this.iteratorClose = Promise.resolve().then(() => {
          const close = iterator.return;
          return close == null ? undefined : Reflect.apply(close, iterator, []);
        });
        // Cancellation can request close before the pump reaches its finalizer.
        void this.iteratorClose.catch(() => undefined);
      }
      return this.iteratorClose;
    }

    private async pump(state: GenerationState, scope: RunningGenerationScope<R, E>): Promise<void> {
      let exhausted = false;
      let failure: unknown;
      let failed = false;
      try {
        const iterable = state.generation.runner.run(
          { ...this.request, signal: this.abort.signal },
          scope,
        );
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
        this.producerEnded = true;
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
      const retired = [...generations].filter((state) => state.retired);
      cancelWork(
        retired,
        retired.flatMap((state) => [...state.active]),
      );
    }
    return { retirement: retire(previous) ?? Promise.resolve() };
  };

  const runner: GenerationRunner<R, E> = { run: (request) => new Run(request).output };
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
    closeRetainedStarts(generation, reason) {
      for (const state of generations) {
        if (state.generation === generation) {
          closeRetainedStartFence(state, reason);
          return;
        }
      }
    },
    abortActiveRuns(reason) {
      const runs = [...sessions.values()].flat().filter((run) => run.isRunning());
      cancelWork([...generations], runs, reason);
    },
    dispose() {
      if (!closing) {
        closed = true;
        const runs = [...sessions.values()].flat();
        const states = [...generations];
        closing = Promise.resolve().then(async () => {
          // Running turns stay in their Session queue until cancellation has fully settled.
          await Promise.all(runs.map((run) => run.settled()));
          await Promise.all(states.map((state) => retire(state)));
          if (disposalErrors.length > 0) {
            throw new AggregateError(disposalErrors, 'Generation disposal failed', {
              cause: disposalErrors[0],
            });
          }
        });
        cancelWork(states, runs);
        for (const state of states) {
          state.retired = true;
          // The controller owns these leases at shutdown. Running children still hold
          // their pins through producer cleanup; idle leases have no cleanup to await.
          for (const lease of state.leases) lease.release();
        }
      }
      return closing;
    },
  };
}
