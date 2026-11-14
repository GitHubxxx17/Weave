import { llmRequestSchema } from '@weave/protocol';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import type { LlmClient } from './client.js';
import type { LlmStreamOptions } from './types.js';

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createMockLlmClient(
  script: readonly StreamEvent[],
  options?: { readonly delayMs?: number },
): LlmClient {
  const delayMs = options?.delayMs ?? 0;

  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('delayMs must be a finite non-negative number');
  }

  return {
    async *stream(
      request: LlmRequest,
      streamOptions?: LlmStreamOptions,
    ): AsyncIterable<StreamEvent> {
      llmRequestSchema.parse(request);
      const signal = streamOptions?.signal;

      for (const event of script) {
        throwIfAborted(signal);
        if (delayMs > 0) {
          await wait(delayMs, signal);
        }
        throwIfAborted(signal);
        yield event;
      }
    },
  };
}
