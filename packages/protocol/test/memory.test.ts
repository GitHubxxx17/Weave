import { describe, expect, it } from 'vitest';
import {
  memoryContentSchema,
  memoryScopeSchema,
  memoryRefSchema,
  memoryRecordInputSchema,
  memorySubjectSchema,
  memoryReceiptSchema,
  memoryQuerySchema,
} from '../src/memory.js';

const id = 'd495a6df-265d-4fc7-93c8-a4452c197b62';
const scope = { kind: 'project', projectId: id };
const ref = { memoryId: id, revision: 1, sha256: 'a'.repeat(64), scope };

describe('memory protocol', () => {
  it('validates strict scope, exact refs and discriminated subjects', () => {
    expect(memoryScopeSchema.safeParse({ ...scope, extra: true }).success).toBe(false);
    expect(memoryScopeSchema.safeParse({ kind: 'user', projectId: id }).success).toBe(false);
    expect(memoryRefSchema.safeParse(ref).success).toBe(true);
    expect(memoryRefSchema.safeParse({ ...ref, revision: 0 }).success).toBe(false);
    expect(memoryRefSchema.safeParse({ ...ref, sha256: 'A'.repeat(64) }).success).toBe(false);
    expect(
      memorySubjectSchema.safeParse({ kind: 'scope-access', scope, settingRevision: 1 }).success,
    ).toBe(true);
    expect(
      memorySubjectSchema.safeParse({
        kind: 'scope-access',
        scope,
        settingRevision: 1,
        memoryId: id,
      }).success,
    ).toBe(false);
  });
  it('counts code points and UTF-8 bytes, rejects surrogates and controls', () => {
    const content = { title: '😀'.repeat(160), content: '\t正文\n\r', tags: [] };
    expect(memoryContentSchema.safeParse(content).success).toBe(true);
    for (const title of ['😀'.repeat(161), '\ud800', 'bad\n']) {
      expect(memoryContentSchema.safeParse({ ...content, title }).success).toBe(false);
    }
    expect(memoryContentSchema.safeParse({ ...content, content: '😀'.repeat(2048) }).success).toBe(
      true,
    );
    for (const body of ['😀'.repeat(2049), '\udfff', 'bad\0', 'bad\x7f', '']) {
      expect(memoryContentSchema.safeParse({ ...content, content: body }).success).toBe(false);
    }
  });
  it('deduplicates tag NFKC lowercase keys while preserving display values', () => {
    expect(
      memoryContentSchema.parse({ title: 'x', content: 'x', tags: ['Ｂ', 'a', 'b', 'A'] }).tags,
    ).toEqual(['a', 'Ｂ']);
  });
  it('forbids model or browser authored actor, review and IDs in content input', () => {
    const input = {
      operation: 'create',
      requestId: id,
      expectedRevision: 0,
      title: 't',
      content: 'c',
      tags: [],
    };
    expect(memoryRecordInputSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ actor: 'local-user' }, { review: 'user-reviewed' }, { memoryId: id }]) {
      expect(memoryRecordInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
  it('separates terminal receipts from readable refs and bounds query pages', () => {
    const receipt = {
      requestId: id,
      operation: 'remove',
      sequence: 2,
      subject: { kind: 'record', scope, memoryId: id, revision: 2 },
      result: { memoryId: id, revision: 2, deleted: true },
    };
    expect(memoryReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      memoryReceiptSchema.safeParse({ ...receipt, result: { ...receipt.result, revision: 99 } })
        .success,
    ).toBe(false);
    expect(memoryRefSchema.safeParse(receipt.result).success).toBe(false);
    expect(memoryQuerySchema.safeParse({ query: '😀'.repeat(512), limit: 50 }).success).toBe(true);
    expect(memoryQuerySchema.safeParse({ query: '😀'.repeat(513), limit: 51 }).success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify({ content: '\n'.repeat(8192) }))).toBeGreaterThan(8192);
  });
});
