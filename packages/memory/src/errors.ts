import type { MemoryErrorCode } from '@weave/protocol';

const messages: Partial<Record<MemoryErrorCode, string>> = {
  'memory-busy': 'Memory storage is busy',
  'memory-not-found': 'Memory record does not exist',
  'memory-stale-revision': 'Memory record changed; reload and retry',
  'memory-request-conflict': 'Memory request does not match its original intent',
  'memory-persistence-uncertain': 'Memory request outcome requires reconciliation',
  'memory-persistence-error': 'Memory storage is unavailable',
  'memory-limit': 'Memory operation exceeds its supported limit',
  'memory-cancelled': 'Memory operation was cancelled',
};
export class MemoryStoreError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, options?: ErrorOptions) {
    super(messages[code] ?? 'Memory operation is unavailable', options);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

export interface MemoryStoreStartupCleanup {
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Only a partially acquired host resource carries this private cleanup brand. */
export class MemoryStoreStartupError extends MemoryStoreError {
  readonly #cleanup: MemoryStoreStartupCleanup;

  constructor(cleanup: MemoryStoreStartupCleanup, options?: ErrorOptions) {
    super('memory-persistence-error', options);
    this.name = 'MemoryStoreStartupError';
    this.#cleanup = cleanup;
  }

  get cleanup(): MemoryStoreStartupCleanup {
    return this.#cleanup;
  }
}

export function persistence(error?: unknown): MemoryStoreError {
  return error instanceof MemoryStoreError
    ? error
    : new MemoryStoreError('memory-persistence-error', { cause: error });
}
