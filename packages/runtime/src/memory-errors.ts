/** Finite, content-free errors allowed to cross the host Memory tool boundary. */
export const memoryErrorMessages = Object.freeze({
  'memory-disabled': 'Memory access is disabled',
  'memory-read-only': 'Memory access is read-only',
  'memory-not-found': 'Memory was not found',
  'memory-stale-revision': 'Memory revision has changed',
  'memory-stale-cursor': 'Memory results have changed; restart from the first page',
  'memory-invalid-cursor': 'Memory cursor is invalid',
  'memory-request-conflict': 'Memory request conflicts with an existing operation',
  'memory-project-ambiguous': 'Memory Project scope is ambiguous',
  'memory-scope-forbidden': 'Memory scope is not permitted',
  'memory-limit': 'Memory operation exceeds its limit',
  'memory-persistence-error': 'Memory persistence is unavailable',
  'memory-persistence-uncertain': 'Memory persistence outcome is uncertain',
  'memory-busy': 'Memory is busy',
  'memory-cancelled': 'Memory operation was cancelled',
} as const);

export type MemoryErrorCode = keyof typeof memoryErrorMessages;
const errors = new WeakSet<object>();

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode) {
    if (!Object.hasOwn(memoryErrorMessages, code)) throw new TypeError('Invalid Memory error code');
    super(memoryErrorMessages[code]);
    this.name = 'MemoryError';
    this.code = code;
    errors.add(this);
    Object.freeze(this);
  }
}

export function isMemoryError(error: unknown): error is MemoryError {
  return typeof error === 'object' && error !== null && errors.has(error);
}
