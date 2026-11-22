import { describe, expect, it } from 'vitest';
import { findFileMention, rankFileCandidates } from '../src/features/file-context/file-mention.js';
describe('explicit file mention discovery', () => {
  it('uses the collapsed caret token and preserves the complete replacement range', () => {
    expect(findFileMention('@src/file.ts tail', 4, 4)).toEqual({ start: 0, end: 12, query: 'src' });
    expect(findFileMention('你好 @中', 5, 5)).toEqual({ start: 3, end: 5, query: '中' });
    expect(findFileMention('email@host', 10, 10)).toBeUndefined();
    expect(findFileMention(' @a', 1, 3)).toBeUndefined();
    expect(findFileMention('hello @', 7, 7)).toEqual({ start: 6, end: 7, query: '' });
  });
  it('ranks exact names, name prefixes, path prefixes, substrings and subsequences deterministically', () => {
    expect(
      rankFileCandidates(
        ['z/a.ts', 'ab.ts', 'a.ts', 'a/b.ts', 'xxa.ts', 'src/A.ts', 'a.ts', '../bad'],
        'a',
      ),
    ).toEqual(['a.ts', 'ab.ts', 'z/a.ts', 'src/A.ts', 'a/b.ts', 'xxa.ts']);
    expect(rankFileCandidates(['folder/a b.ts'], 'a b')).toEqual(['folder/a b.ts']);
    expect(
      rankFileCandidates(
        Array.from({ length: 30 }, (_, i) => `${i}.ts`),
        '',
      ),
    ).toHaveLength(20);
    expect(rankFileCandidates(['a.ts'], 'a'.repeat(257))).toEqual([]);
  });
});

it('matches Unicode subsequences by code point and keeps deterministic raw code point ties', () => {
  expect(rankFileCandidates(['src/😀-file.ts'], '😀ft')).toEqual(['src/😀-file.ts']);
  expect(rankFileCandidates(['😀.ts', '\ue000x.ts'], '')).toEqual(['\ue000x.ts', '😀.ts']);
});
