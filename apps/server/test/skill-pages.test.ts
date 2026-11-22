import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@weave/runtime';
import { createSkillPage } from '../src/skill-pages.js';
const ref = {
  id: 'builtin:weave-planning',
  instructionSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
};
describe('Skill pages', () => {
  it('budgets serialized escaped Unicode JSON and preserves complete codepoints', () => {
    const text = '中文😀\\"\n'.repeat(2000);
    let offset = 0;
    let result = '';
    while (offset < Array.from(text).length) {
      const page = createSkillPage({
        skill: ref,
        kind: 'instructions',
        text,
        contentSha256: ref.instructionSha256,
        offset,
        cursor: 'c'.repeat(48),
        maxBytes: 1000,
        maxTokens: 180,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1000);
      expect(estimateTokens(JSON.stringify(page))).toBeLessThanOrEqual(180);
      result += page.text;
      offset += Array.from(page.text).length;
      expect(page.eof).toBe(offset === Array.from(text).length);
    }
    expect(result).toBe(text);
  });
  it('accepts a final short page when only continuation framing would exceed the budget', () => {
    const args = {
      skill: ref,
      kind: 'instructions' as const,
      text: 'ab',
      contentSha256: ref.instructionSha256,
      offset: 0,
      cursor: 'x'.repeat(100),
      maxBytes: 10000,
      maxTokens: 10000,
    };
    const size = Buffer.byteLength(JSON.stringify(createSkillPage(args)));
    expect(createSkillPage({ ...args, maxBytes: size })).toMatchObject({ text: 'ab', eof: true });
  });
  it('fails clearly when the empty envelope cannot fit', () => {
    expect(() =>
      createSkillPage({
        skill: ref,
        kind: 'instructions',
        text: 'hi',
        contentSha256: ref.instructionSha256,
        offset: 0,
        cursor: 'cursor',
        maxBytes: 5,
        maxTokens: 1,
      }),
    ).toThrow(/budget/i);
  });
});
