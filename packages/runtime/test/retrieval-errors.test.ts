import { describe, expect, it } from 'vitest';
import { RetrievalError, isRetrievalError } from '../src/retrieval-errors.js';

describe('safe retrieval errors', () => {
  it('recognizes only exact issued instances, not JSON or prototype copies', () => {
    const error = new RetrievalError('retrieval-invalid-input');
    expect(isRetrievalError(error)).toBe(true);
    expect(isRetrievalError({ code: error.code, message: error.message })).toBe(false);
    expect(isRetrievalError(Object.create(RetrievalError.prototype))).toBe(false);
    expect(isRetrievalError(new Error(error.message))).toBe(false);
    expect(Object.isFrozen(error)).toBe(true);
    expect(error.cause).toBeUndefined();
  });
  it('rejects unclassified codes without echoing input', () => {
    expect(() => new RetrievalError('private canary' as never)).toThrow(
      'Invalid Retrieval error code',
    );
  });
});
