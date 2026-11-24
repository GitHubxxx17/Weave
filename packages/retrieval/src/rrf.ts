import {
  compareRetrievalCodepoints,
  retrievalLimits,
  type RetrievalRankedCandidate,
} from '@weave/protocol';

const reciprocalRankConstant = 60;
type RankField = 'lexicalRank' | 'vectorRank';

function overlap(
  a: RetrievalRankedCandidate['chunk'],
  b: RetrievalRankedCandidate['chunk'],
): boolean {
  return (
    (a.startLine < b.endLine || (a.startLine === b.endLine && a.startColumn < b.endColumn)) &&
    (b.startLine < a.endLine || (b.startLine === a.endLine && b.startColumn < a.endColumn))
  );
}

export function diversifyRetrievalCandidates(
  ranked: readonly RetrievalRankedCandidate[],
): RetrievalRankedCandidate[] {
  const selected: RetrievalRankedCandidate[] = [];
  const bySource = new Map<string, RetrievalRankedCandidate['chunk'][]>();
  for (const candidate of ranked) {
    const siblings = bySource.get(candidate.chunk.sourceKey) ?? [];
    if (siblings.length >= 2 || siblings.some((chunk) => overlap(chunk, candidate.chunk))) continue;
    siblings.push(candidate.chunk);
    bySource.set(candidate.chunk.sourceKey, siblings);
    selected.push(candidate);
    if (selected.length === retrievalLimits.maxCandidates) break;
  }
  return selected;
}

export function fuseRetrievalCandidates(
  lexical: readonly RetrievalRankedCandidate[],
  vector: readonly RetrievalRankedCandidate[],
): RetrievalRankedCandidate[] {
  const union = new Map<string, RetrievalRankedCandidate>();
  function merge(lane: readonly RetrievalRankedCandidate[], rankField: RankField) {
    const seen = new Set<string>();
    for (const [index, row] of lane.slice(0, retrievalLimits.maxRankerCandidates).entries()) {
      const { source, title, chunk, text } = row;
      const id = chunk.chunkId;
      if (seen.has(id)) continue;
      seen.add(id);
      const current = union.get(id) ?? { source, title, chunk, text };
      union.set(id, {
        ...current,
        [rankField]: index + 1,
        rrfScore: (current.rrfScore ?? 0) + 1 / (reciprocalRankConstant + index + 1),
      });
    }
  }
  merge(lexical, 'lexicalRank');
  merge(vector, 'vectorRank');
  const ranked = [...union.values()].sort(
    (a, b) =>
      b.rrfScore! - a.rrfScore! ||
      compareRetrievalCodepoints(a.chunk.sourceKey, b.chunk.sourceKey) ||
      a.chunk.ordinal - b.chunk.ordinal,
  );
  return diversifyRetrievalCandidates(ranked);
}
