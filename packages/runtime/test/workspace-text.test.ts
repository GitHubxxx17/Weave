import { describe, expect, it } from 'vitest';
import {
  countLines,
  findOccurrences,
  formatFilePage,
  isBinaryContent,
  planTextEdit,
} from '../src/workspace-text.js';

describe('Workspace text helpers', () => {
  it('counts lines without an extra line for the trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\r\nb')).toBe(2);
  });

  it('detects binary content by a NUL byte near the start', () => {
    expect(isBinaryContent(Buffer.from('plain text'))).toBe(false);
    expect(isBinaryContent(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('returns a small file unchanged and pages a long one by line', () => {
    expect(formatFilePage('a\nb\n', 1, 2000)).toBe('a\nb\n');
    const content = Array.from({ length: 5 }, (_, index) => `l${index + 1}`).join('\n');
    expect(formatFilePage(content, 2, 2)).toBe(
      'l2\nl3\n\n[已显示第 2–3 行，共 5 行。继续读取请传 offset: 4]',
    );
  });

  it('shows the start of a single line that is longer than a page', () => {
    const page = formatFilePage(`${'x'.repeat(50_000)}\nshort`, 1, 2000, {
      maxBytes: 1000,
      maxTokens: 6000,
    });
    expect(page).toContain('第 1 行过长，只显示了开头部分');
    expect(page).toContain('继续读取请传 offset: 2');
    expect(Buffer.byteLength(page, 'utf8')).toBeLessThan(1200);
  });

  it('finds non-overlapping occurrences', () => {
    expect(findOccurrences('aaaa', 'aa')).toEqual([0, 2]);
    expect(findOccurrences('abc', 'd')).toEqual([]);
  });

  it('builds one hunk per changed region with line numbers', () => {
    const content = ['a', 'b', 'TARGET', 'c', 'd', 'e', 'f', 'g', 'h', 'TARGET', 'i', ''].join(
      '\n',
    );
    const plan = planTextEdit(content, { oldText: 'TARGET', newText: 'DONE', replaceAll: true });

    expect(plan.replacements).toBe(2);
    expect(plan.linesAdded).toBe(2);
    expect(plan.linesRemoved).toBe(2);
    expect(plan.diff).toBe(
      [
        '@@ -1,6 +1,6 @@',
        ' a',
        ' b',
        '-TARGET',
        '+DONE',
        ' c',
        ' d',
        ' e',
        '@@ -7,5 +7,5 @@',
        ' f',
        ' g',
        ' h',
        '-TARGET',
        '+DONE',
        ' i',
      ].join('\n'),
    );
    expect(plan.snippet).toBe('1: a\n2: b\n3: DONE\n4: c\n5: d');
  });

  it('describes deleted lines and two edits on one line as one hunk', () => {
    const deletion = planTextEdit('keep\ndrop me\nkeep too\n', {
      oldText: 'drop me\n',
      newText: '',
    });
    expect(deletion.updated).toBe('keep\nkeep too\n');
    expect(deletion).toMatchObject({ linesAdded: 0, linesRemoved: 1 });
    expect(deletion.diff).toContain('-drop me');

    const sameLine = planTextEdit('x + x\n', { oldText: 'x', newText: 'y', replaceAll: true });
    expect(sameLine.updated).toBe('y + y\n');
    expect(sameLine.diff).toBe('@@ -1,1 +1,1 @@\n-x + x\n+y + y');
  });

  it('explains why an edit cannot be applied', () => {
    expect(() => planTextEdit('a', { oldText: 'a', newText: 'a' })).toThrow(
      expect.objectContaining({ code: 'workspace-edit-noop' }),
    );
    expect(() => planTextEdit('a', { oldText: 'b', newText: 'c' })).toThrow(
      expect.objectContaining({ code: 'workspace-edit-no-match' }),
    );
    expect(() => planTextEdit('a\na\n', { oldText: 'a', newText: 'b' })).toThrow(
      expect.objectContaining({
        code: 'workspace-edit-ambiguous',
        message: expect.stringContaining('lines 1, 2'),
      }),
    );
  });

  it('caps the diff at 200 lines', () => {
    const content = `${Array.from({ length: 400 }, (_, index) => `old ${index}`).join('\n')}\n`;
    const newText = Array.from({ length: 400 }, (_, index) => `new ${index}`).join('\n');
    const plan = planTextEdit(content, { oldText: content.trimEnd(), newText });

    expect(plan.diffTruncated).toBe(true);
    expect(plan.diff.split('\n')).toHaveLength(200);
    expect(plan).toMatchObject({ linesAdded: 400, linesRemoved: 400 });
  });
});
