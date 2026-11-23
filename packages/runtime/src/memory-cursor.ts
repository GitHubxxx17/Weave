import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { memoryScopeSchema } from '@weave/protocol';
import { MemoryError } from './memory-errors.js';
import type { MemoryScopeHead } from './memory-types.js';

const payloadSchema = z.strictObject({
  v: z.literal(1),
  operation: z.string().min(1).max(32),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scopeHeads: z
    .array(
      z.strictObject({ scope: memoryScopeSchema, sequence: z.number().int().nonnegative().safe() }),
    )
    .min(1)
    .max(2),
  after: z.json(),
});

/** Canonical host request JSON; inputs are validated before reaching this function. */
export function memoryCanonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(memoryCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${memoryCanonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function memoryDigest(value: unknown): string {
  return createHash('sha256').update(memoryCanonicalJson(value)).digest('hex');
}

export function createMemoryCursorCodec() {
  const secret = randomBytes(32);
  return {
    encode(
      operation: string,
      query: unknown,
      scopeHeads: readonly MemoryScopeHead[],
      after: unknown,
    ): string {
      const payload = payloadSchema.parse({
        v: 1,
        operation,
        queryDigest: memoryDigest(query),
        scopeHeads,
        after,
      });
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const cursor = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
      if (Buffer.byteLength(cursor) > 2048) throw new MemoryError('memory-limit');
      return cursor;
    },
    decode(
      cursor: string,
      operation: string,
      query: unknown,
      heads: readonly MemoryScopeHead[],
    ): z.infer<typeof payloadSchema>['after'] {
      try {
        if (Buffer.byteLength(cursor) > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))
          throw new Error();
        const [body, signature] = cursor.split('.') as [string, string];
        const actual = Buffer.from(signature, 'base64url');
        const expected = createHmac('sha256', secret).update(body).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new Error();
        const payload = payloadSchema.parse(
          JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown,
        );
        if (payload.operation !== operation || payload.queryDigest !== memoryDigest(query))
          throw new Error();
        if (memoryCanonicalJson(payload.scopeHeads) !== memoryCanonicalJson(heads))
          throw new MemoryError('memory-stale-cursor');
        return payload.after;
      } catch (error) {
        if (error instanceof MemoryError && error.code === 'memory-stale-cursor') throw error;
        throw new MemoryError('memory-invalid-cursor');
      }
    },
  };
}
