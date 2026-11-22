import type { SkillPage, SkillRef } from '@weave/protocol';
import { estimateTokens } from '@weave/runtime';
import { SkillError } from './skill-errors.js';
export interface SkillPageInput {
  readonly skill: SkillRef;
  readonly kind: 'instructions' | 'resource';
  readonly path?: string;
  readonly text: string;
  readonly contentSha256: string;
  readonly offset: number;
  readonly cursor: string;
  readonly maxBytes: number;
  readonly maxTokens: number;
}
/** Budget the actual serialized wire value, including escaping and cursor overhead. */
export function createSkillPage(input: SkillPageInput): SkillPage {
  const chars = Array.from(input.text);
  const page = (length: number): SkillPage => {
    const eof = input.offset + length >= chars.length;
    return Object.freeze({
      skill: input.skill,
      kind: input.kind,
      ...(input.path === undefined ? {} : { path: input.path }),
      contentSha256: input.contentSha256,
      text: chars.slice(input.offset, input.offset + length).join(''),
      offset: input.offset,
      eof,
      ...(eof ? {} : { nextCursor: input.cursor }),
    });
  };
  const fits = (value: SkillPage): boolean => {
    const serialized = JSON.stringify(value);
    return (
      Buffer.byteLength(serialized) <= input.maxBytes &&
      estimateTokens(serialized) <= input.maxTokens
    );
  };
  if (fits(page(chars.length - input.offset))) return page(chars.length - input.offset);
  let low = 0;
  let high = chars.length - input.offset - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(page(middle))) low = middle;
    else high = middle - 1;
  }
  const result = page(low);
  if (!fits(result) || (low === 0 && !result.eof))
    throw new SkillError('skill-unavailable', 'The Skill page cannot fit the tool result budget');
  return result;
}
