import { retrievalLimits, retrievalQueryIntentSchema } from '@weave/protocol';
import { RetrievalStoreError } from './errors.js';

const han = /\p{Script=Han}/u;
const lexicalWord = /\p{Script=Han}+|[\p{L}\p{N}\p{M}]+/gu;
const hanRuns = /\p{Script=Han}+/gu;

function* words(text: string): Generator<string> {
  // Split Han runs before grouping other letters, including mixed identifiers.
  const normalized = text.normalize('NFKC').replace(hanRuns, ' $& ');
  for (const [word] of normalized.matchAll(lexicalWord)) {
    if (han.test(word)) {
      const points = [...word];
      for (let index = 1; index < points.length; index++) yield points[index - 1]! + points[index]!;
      yield* points;
      continue;
    }
    yield word.toLowerCase();
    const split = word
      .replace(/([\p{Lu}\p{Lt}])([\p{Lu}\p{Lt}][\p{Ll}])/gu, '$1 $2')
      .replace(/([\p{Ll}\p{N}])([\p{Lu}\p{Lt}])/gu, '$1 $2');
    if (split !== word) yield* split.toLowerCase().split(' ');
  }
}

export function buildLexicalTerms(text: string, metadata: readonly string[] = []): string {
  const terms = new Set<string>();
  let points = 0;
  for (const input of [...metadata, text]) {
    for (const term of words(input)) {
      if (terms.has(term)) continue;
      const size = [...term].length + (terms.size ? 1 : 0);
      if (points + size > 8_192) continue;
      terms.add(term);
      points += size;
    }
  }
  return [...terms].join(' ');
}

export function buildLexicalMatch(query: string): string | undefined {
  const parsed = retrievalQueryIntentSchema.shape.query.safeParse(query);
  if (!parsed.success)
    throw new RetrievalStoreError('retrieval-invalid-input', { cause: parsed.error });
  const terms = new Set<string>();
  for (const term of words(parsed.data)) {
    terms.add(term);
    if (terms.size === retrievalLimits.maxQueryTerms) break;
  }
  // All words are Unicode letters, numbers, or marks. The MATCH value itself
  // must still be supplied through a SQL parameter.
  return terms.size ? [...terms].map((term) => `"${term}"`).join(' OR ') : undefined;
}
