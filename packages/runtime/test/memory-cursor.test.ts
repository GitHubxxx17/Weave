import { describe, expect, it } from 'vitest';
import { createMemoryCursorCodec } from '../src/memory-cursor.js';

describe('Memory cursors', () => {
  const heads = [{ scope: { kind: 'user' as const }, sequence: 4 }];
  it('binds query, operation, durable heads and exact owner', () => {
    const owner = createMemoryCursorCodec();
    const cursor = owner.encode('search', { query: 'hello', limit: 4 }, heads, { offset: 2 });
    expect(owner.decode(cursor, 'search', { query: 'hello', limit: 4 }, heads)).toEqual({
      offset: 2,
    });
    for (const [operation, query] of [
      ['read', { query: 'hello', limit: 4 }],
      ['search', { query: 'hello', limit: 5 }],
    ] as const) {
      expect(() => owner.decode(cursor, operation, query, heads)).toThrowError(
        expect.objectContaining({ code: 'memory-invalid-cursor' }),
      );
    }
    expect(() =>
      owner.decode(cursor, 'search', { query: 'hello', limit: 4 }, [{ ...heads[0]!, sequence: 5 }]),
    ).toThrowError(expect.objectContaining({ code: 'memory-stale-cursor' }));
    expect(() =>
      createMemoryCursorCodec().decode(cursor, 'search', { query: 'hello', limit: 4 }, heads),
    ).toThrow();
    expect(() =>
      owner.decode(`${cursor.slice(0, -2)}AA`, 'search', { query: 'hello', limit: 4 }, heads),
    ).toThrow();
  });
  it('rejects oversized and malformed values before decoding', () => {
    const owner = createMemoryCursorCodec();
    for (const value of ['', 'x'.repeat(2049), 'a.b.c', '__proto__'])
      expect(() => owner.decode(value, 'search', {}, heads)).toThrow();
    expect(() => owner.encode('search', {}, heads, { text: 'x'.repeat(3000) })).toThrowError(
      expect.objectContaining({ code: 'memory-limit' }),
    );
  });
});
