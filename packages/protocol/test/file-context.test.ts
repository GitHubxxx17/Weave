import { describe, expect, it } from 'vitest';
import {
  fileAttachmentSummarySchema,
  fileReferenceSchema,
  fileReferencesSchema,
} from '../src/index.js';

describe('project file reference values', () => {
  it.each([
    '',
    '../x',
    'a/../x',
    '/x',
    'C:/x',
    'a\\x',
    'a//x',
    './x',
    'a/./x',
    'a\0x',
    'file:x',
    '//host/x',
    'a/',
    'a\nx',
    'a\u007fx',
    'a\u200bx',
    'a\u2028x',
    'a\u2029x',
    'a\ud800x',
    'a\udc00x',
    'a'.repeat(1025),
  ])('rejects unsafe reference %j', (path) => {
    expect(fileReferenceSchema.safeParse({ path }).success).toBe(false);
  });

  it('preserves legal spaces, Unicode, percent escapes, case and code units', () => {
    for (const path of ['src/中文 file.ts', ' a / b ', '.env', '%2e%2e/file', 'A/é😀']) {
      expect(fileReferenceSchema.parse({ path })).toEqual({ path });
    }
    expect(fileReferenceSchema.safeParse({ path: '😀'.repeat(512) }).success).toBe(true);
    expect(fileReferenceSchema.safeParse({ path: '😀'.repeat(513) }).success).toBe(false);
  });

  it('accepts only path references and a nonempty ordered unique batch of at most eight', () => {
    for (const extra of [{ content: 'forged' }, { sha256: 'a'.repeat(64) }, { root: '/tmp' }]) {
      expect(fileReferenceSchema.safeParse({ path: 'a', ...extra }).success).toBe(false);
    }
    expect(fileReferencesSchema.safeParse([]).success).toBe(false);
    expect(fileReferencesSchema.safeParse([{ path: 'a' }, { path: 'a' }]).success).toBe(false);
    expect(
      fileReferencesSchema.safeParse(Array.from({ length: 9 }, (_, n) => ({ path: `${n}` })))
        .success,
    ).toBe(false);
    expect(fileReferencesSchema.parse([{ path: 'b' }, { path: 'a' }])).toEqual([
      { path: 'b' },
      { path: 'a' },
    ]);
    expect(fileReferencesSchema.safeParse([{ path: 'A' }, { path: 'a' }]).success).toBe(true);
  });

  it('keeps attachment summaries strict and bounded without captured authority', () => {
    const summary = { path: 'a', encoding: 'utf-8', byteLength: 0, sha256: 'a'.repeat(64) };
    expect(fileAttachmentSummarySchema.parse(summary)).toEqual(summary);
    for (const invalid of [
      { ...summary, byteLength: -1 },
      { ...summary, byteLength: 0.5 },
      { ...summary, byteLength: 65_537 },
      { ...summary, encoding: 'utf8' },
      { ...summary, sha256: 'A'.repeat(64) },
      { ...summary, content: '' },
      { ...summary, fileIdentity: 'b'.repeat(64) },
    ])
      expect(fileAttachmentSummarySchema.safeParse(invalid).success).toBe(false);
  });
});
