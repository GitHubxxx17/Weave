import { describe, expect, it } from 'vitest';
import {
  fileReferenceSchema,
  fileReferencesSchema,
  fileAttachmentSummarySchema,
} from '../src/features/file-context/file-context-types.js';

describe('Studio file context wire values', () => {
  it('preserves literal valid paths and rejects non-relative or unsafe spellings', () => {
    for (const path of ['src/中文 file.ts', 'A%20B', ' a ', '.env'])
      expect(fileReferenceSchema.parse({ path })).toEqual({ path });
    for (const path of [
      '',
      '/a',
      'a\\b',
      'C:a',
      'a//b',
      './a',
      'a/../b',
      'a/',
      'a\u0000',
      'a\u2028',
      'a\u200b',
      'a\ud800',
      'x'.repeat(1025),
    ])
      expect(fileReferenceSchema.safeParse({ path }).success).toBe(false);
    expect(fileReferenceSchema.safeParse({ path: 'a', content: 'secret' }).success).toBe(false);
  });
  it('requires one to eight unique ordered references and closed summaries', () => {
    expect(fileReferencesSchema.safeParse([]).success).toBe(false);
    expect(fileReferencesSchema.safeParse([{ path: 'a' }, { path: 'a' }]).success).toBe(false);
    expect(
      fileReferencesSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ path: `${i}` })))
        .success,
    ).toBe(false);
    const summary = { path: 'a', encoding: 'utf-8', byteLength: 0, sha256: 'a'.repeat(64) };
    expect(fileAttachmentSummarySchema.parse(summary)).toEqual(summary);
    for (const override of [
      { encoding: 'utf8' },
      { byteLength: -1 },
      { byteLength: 65537 },
      { sha256: 'A'.repeat(64) },
      { content: 'hidden' },
    ])
      expect(fileAttachmentSummarySchema.safeParse({ ...summary, ...override }).success).toBe(
        false,
      );
  });
});

it('uses the same UTF-16 path boundary for supplementary Unicode characters', () => {
  expect(fileReferenceSchema.safeParse({ path: '😀'.repeat(512) }).success).toBe(true);
  expect(fileReferenceSchema.safeParse({ path: '😀'.repeat(513) }).success).toBe(false);
});
