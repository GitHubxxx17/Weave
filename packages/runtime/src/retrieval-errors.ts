import type { RetrievalErrorCode } from '@weave/protocol';

/** Finite content-free errors issued only by the host retrieval boundary. */
export const retrievalErrorMessages = Object.freeze({
  'retrieval-invalid-input': 'Retrieval input is invalid',
  'retrieval-unavailable': 'Project retrieval is unavailable',
  'retrieval-not-found': 'Retrieval item was not found',
  'retrieval-scope-forbidden': 'Retrieval scope is not permitted',
  'retrieval-project-ambiguous': 'Retrieval Project scope is ambiguous',
  'retrieval-root-changed': 'Project root has changed',
  'retrieval-stale-preview': 'Retrieval preview has changed or expired',
  'retrieval-stale-source': 'Retrieval source has changed',
  'retrieval-invalid-cursor': 'Retrieval cursor is invalid',
  'retrieval-stale-cursor': 'Retrieval results have changed; restart from the first page',
  'retrieval-request-conflict': 'Retrieval request conflicts with an existing operation',
  'retrieval-limit': 'Retrieval operation exceeds its limit',
  'retrieval-busy': 'Project retrieval is busy',
  'retrieval-cancelled': 'Retrieval operation was cancelled',
  'retrieval-timeout': 'Retrieval operation reached its deadline',
  'retrieval-semantic-unavailable': 'Semantic retrieval is unavailable',
  'retrieval-embedding-failed': 'Embedding request failed',
  'retrieval-persistence-error': 'Retrieval persistence is unavailable',
  'retrieval-persistence-uncertain': 'Retrieval persistence outcome is uncertain',
} as const satisfies Readonly<Record<RetrievalErrorCode, string>>);

const errors = new WeakSet<object>();
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode) {
    if (!Object.hasOwn(retrievalErrorMessages, code))
      throw new TypeError('Invalid Retrieval error code');
    super(retrievalErrorMessages[code]);
    this.name = 'RetrievalError';
    this.code = code;
    errors.add(this);
    Object.freeze(this);
  }
}
export function isRetrievalError(error: unknown): error is RetrievalError {
  return typeof error === 'object' && error !== null && errors.has(error);
}
