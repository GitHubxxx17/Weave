import type { RetrievalErrorCode } from '@weave/protocol';
import type { RetrievalLifecycle } from './types.js';

const messages: Partial<Record<RetrievalErrorCode, string>> = {
  'retrieval-invalid-input': 'Invalid retrieval input',
  'retrieval-unavailable': 'Retrieval generation is unavailable',
  'retrieval-root-changed': 'Project root changed',
  'retrieval-request-conflict': 'Retrieval request does not match its original intent',
  'retrieval-limit': 'Retrieval operation exceeds its supported limit',
  'retrieval-busy': 'Retrieval storage is busy',
  'retrieval-cancelled': 'Retrieval operation was cancelled',
  'retrieval-timeout': 'Retrieval read exceeded its deadline',
  'retrieval-semantic-unavailable': 'Semantic retrieval is unavailable',
  'retrieval-persistence-error': 'Retrieval storage is unavailable',
  'retrieval-persistence-uncertain': 'Retrieval request outcome requires reconciliation',
};

export class RetrievalStoreError extends Error {
  readonly code: RetrievalErrorCode;

  constructor(code: RetrievalErrorCode, options?: ErrorOptions) {
    super(messages[code] ?? 'Retrieval operation is unavailable', options);
    this.name = 'RetrievalStoreError';
    this.code = code;
  }
}

export class RetrievalStoreStartupError extends RetrievalStoreError {
  readonly #cleanup: RetrievalLifecycle;

  constructor(cleanup: RetrievalLifecycle, options?: ErrorOptions) {
    super('retrieval-persistence-error', options);
    this.name = 'RetrievalStoreStartupError';
    this.#cleanup = cleanup;
  }

  get cleanup(): RetrievalLifecycle {
    return this.#cleanup;
  }
}

export function persistence(cause?: unknown): RetrievalStoreError {
  return cause instanceof RetrievalStoreError
    ? cause
    : new RetrievalStoreError('retrieval-persistence-error', { cause });
}
