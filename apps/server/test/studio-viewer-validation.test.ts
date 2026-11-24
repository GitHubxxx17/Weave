import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error Node-only performance tooling is JavaScript.
import {
  validateViewerPayload as validate,
  diffRowsReady,
} from './performance/viewer-validation.mjs';

const validateViewerPayload = (file: unknown, expected: unknown) => validate({ file, expected });

describe('viewer benchmark correctness', () => {
  it('rejects same-length corruption even when metadata and rendered content agree', async () => {
    const content = 'const 中文 = 42;\n';
    const expected = {
      path: 'file.ts',
      bytes: Buffer.byteLength(content),
      codeUnits: content.length,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
    await expect(
      validateViewerPayload(
        { path: 'file.ts', bytes: expected.bytes, content, truncated: false },
        expected,
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateViewerPayload(
        {
          path: 'file.ts',
          bytes: expected.bytes,
          content: content.replace('42', '43'),
          truncated: false,
        },
        expected,
      ),
    ).rejects.toThrow('hash');
    await expect(
      validateViewerPayload(
        { path: 'file.ts', bytes: expected.bytes, content, truncated: false },
        { ...expected, bytes: content.length },
      ),
    ).rejects.toThrow('bytes');
    await expect(
      validateViewerPayload(
        { path: 'other.ts', bytes: expected.bytes, content, truncated: false },
        expected,
      ),
    ).rejects.toThrow('path');
    await expect(
      validateViewerPayload(
        { path: 'file.ts', bytes: expected.bytes, content, truncated: true },
        expected,
      ),
    ).rejects.toThrow('truncat');
  });

  it('requires actual changed old/new first-line cells, rejecting table headers and unrelated lines', () => {
    const expected = { oldFirstLine: 'let   value = 42;', newFirstLine: 'const value = 42;' };
    expect(diffRowsReady([], expected)).toBe(false);
    expect(
      diffRowsReady(
        [{ state: 'header', text: 'line numberline content', old: null, next: null }],
        expected,
      ),
    ).toBe(false);
    expect(
      diffRowsReady(
        [{ state: 'diff', text: expected.oldFirstLine, old: '1', next: null }],
        expected,
      ),
    ).toBe(false);
    const rows = [
      { state: 'diff', text: expected.oldFirstLine, old: '1', next: null },
      { state: 'diff', text: expected.newFirstLine, old: null, next: '1' },
    ];
    expect(diffRowsReady(rows, expected)).toBe(true);
    expect(diffRowsReady([{ ...rows[0], old: '2' }, rows[1]], expected)).toBe(false);
    expect(diffRowsReady([rows[0], { ...rows[1], text: 'wrong' }], expected)).toBe(false);
  });
});

it('accepts both installed DiffView plain and syntax body classes without operator text', () => {
  const expected = { oldFirstLine: 'let   x = 1;', newFirstLine: 'const x = 1;' };
  const plain = [
    { state: 'diff', old: '1', next: null, plainText: expected.oldFirstLine },
    { state: 'diff', old: null, next: '1', plainText: expected.newFirstLine },
  ];
  const syntax = [
    { state: 'diff', old: '1', next: null, syntaxText: expected.oldFirstLine },
    { state: 'diff', old: null, next: '1', syntaxText: expected.newFirstLine },
  ];
  expect(diffRowsReady(plain, expected)).toBe(true);
  expect(diffRowsReady(syntax, expected)).toBe(true);
  expect(
    diffRowsReady([{ ...syntax[0], syntaxText: '-' + expected.oldFirstLine }, syntax[1]], expected),
  ).toBe(false);
});
