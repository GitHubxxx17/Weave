export interface DetachedEventSubscription<T> {
  readonly initial: readonly T[];
  readonly events: AsyncIterable<T>;
  close(): void;
}

/** One pull consumes one frame; disconnect detaches only this bounded observer. */
export function detachedEventStream<T>(
  subscription: DetachedEventSubscription<T>,
  signal: AbortSignal,
  encode: (frame: T) => Uint8Array,
): ReadableStream<Uint8Array> {
  const initial = [...subscription.initial];
  const iterator = subscription.events[Symbol.asyncIterator]();
  let ended = false;
  let pending: Promise<IteratorResult<T>> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const close = () => {
    if (ended) return;
    ended = true;
    if (heartbeat !== undefined) clearTimeout(heartbeat);
    wake?.();
    signal.removeEventListener('abort', abort);
    subscription.close();
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  };
  const abort = () => {
    close();
    try {
      streamController?.close();
    } catch {
      /* disconnected reader */
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        if (ended) return;
        const first = initial.shift();
        if (first !== undefined) {
          controller.enqueue(encode(first));
          return;
        }
        pending ??= iterator.next();
        try {
          const tick = new Promise<undefined>((resolve) => {
            wake = () => resolve(undefined);
            heartbeat = setTimeout(() => resolve(undefined), 15_000);
            heartbeat.unref?.();
          });
          const next = await Promise.race([pending, tick]);
          if (heartbeat !== undefined) clearTimeout(heartbeat);
          heartbeat = undefined;
          wake = undefined;
          if (ended) return;
          if (next === undefined) {
            controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
            return;
          }
          pending = undefined;
          if (next.done) {
            close();
            controller.close();
            return;
          }
          controller.enqueue(encode(next.value));
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: 0 },
  );
}
