import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import {
  compareRetrievalCodepoints,
  retrievalLimits,
  type RetrievalRankedCandidate,
} from '@weave/protocol';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { persistence } from './errors.js';
import { ftsTable, rowCandidate, storedGeneration, vectorBytes } from './generation.js';
import { buildLexicalMatch } from './lexical-query.js';
import { workerInput } from './query.js';
import { diversifyRetrievalCandidates, fuseRetrievalCandidates } from './rrf.js';

type QueryInput = z.infer<typeof workerInput>;

function scopedFilter({ intent, memoryAllowed, generation }: QueryInput) {
  const { filters } = intent;
  const sourceConditions: string[] = [];
  const parameters: SQLInputValue[] = [generation.generationId];
  if (filters.sources.includes('workspace')) {
    const workspace = [`d.kind = 'workspace'`];
    const pathClause = "(d.path = ? OR substr(d.path, 1, length(?) + 1) = ? || '/')";
    if (filters.paths.include.length > 0) {
      workspace.push(`(${filters.paths.include.map(() => pathClause).join(' OR ')})`);
      for (const prefix of filters.paths.include) parameters.push(prefix, prefix, prefix);
    }
    for (const prefix of filters.paths.exclude) {
      workspace.push(`NOT ${pathClause}`);
      parameters.push(prefix, prefix, prefix);
    }
    sourceConditions.push(`(${workspace.join(' AND ')})`);
  }
  if (memoryAllowed && filters.sources.includes('memory'))
    sourceConditions.push(`d.kind = 'memory'`);
  return {
    sql: `c.generation_id = ? AND (${sourceConditions.join(' OR ') || '0'})`,
    parameters,
  };
}

function rank(database: DatabaseSync, input: QueryInput) {
  const { generation, intent } = input;
  if (!isDeepStrictEqual(storedGeneration(database, generation.generationId), generation))
    throw persistence();
  const table = ftsTable(generation.generationId);
  const filter = scopedFilter(input);
  const from =
    'FROM retrieval_chunks c JOIN retrieval_documents d USING(generation_id, source_key)';
  const match = buildLexicalMatch(intent.query);
  const lexical =
    match === undefined
      ? []
      : database
          .prepare(
            `
    SELECT d.source, c.chunk
    ${from}
    JOIN ${table} ON ${table}.rowid = c.position
    WHERE ${filter.sql} AND ${table} MATCH ?
    ORDER BY bm25(${table}), c.source_key COLLATE BINARY, c.ordinal
    LIMIT ?
  `,
          )
          .all(...filter.parameters, match, retrievalLimits.maxRankerCandidates)
          .map((row, index) => ({ ...rowCandidate(row), lexicalRank: index + 1 }));
  if (input.mode === 'lexical') return diversifyRetrievalCandidates(lexical);

  if (generation.mode !== 'hybrid' || !input.vector) throw persistence();
  const query = input.vector;
  vectorBytes(query);
  type Ranked = {
    readonly score: number;
    readonly id: string;
    readonly sourceKey: string;
    readonly ordinal: number;
  };
  const compare = (a: Ranked, b: Ranked) =>
    b.score - a.score ||
    compareRetrievalCodepoints(a.sourceKey, b.sourceKey) ||
    a.ordinal - b.ordinal;
  const vectorRanks: Ranked[] = [];
  let seen = 0;
  for (const row of database
    .prepare(
      `
    SELECT c.chunk_id, c.source_key, c.ordinal, c.vector
    ${from} WHERE ${filter.sql}
    LIMIT ?
  `,
    )
    .iterate(...filter.parameters, retrievalLimits.maxChunks + 1)) {
    const { vector, chunk_id: id, source_key: sourceKey, ordinal } = row;
    if (
      ++seen > retrievalLimits.maxChunks ||
      !(vector instanceof Uint8Array) ||
      vector.byteLength !== retrievalLimits.embeddingDimensions * 4 ||
      typeof id !== 'string' ||
      typeof sourceKey !== 'string' ||
      typeof ordinal !== 'number'
    )
      throw persistence();
    const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    let score = 0;
    let norm = 0;
    for (let index = 0; index < retrievalLimits.embeddingDimensions; index++) {
      const value = bytes.readFloatLE(index * 4);
      score += query[index]! * value;
      norm += value * value;
    }
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-6) throw persistence();
    const rowRank = { score: score / Math.sqrt(norm), id, sourceKey, ordinal };
    const worst = vectorRanks.at(-1);
    if (
      vectorRanks.length < retrievalLimits.maxRankerCandidates ||
      (worst && compare(rowRank, worst) < 0)
    ) {
      vectorRanks.push(rowRank);
      vectorRanks.sort(compare);
      if (vectorRanks.length > retrievalLimits.maxRankerCandidates) vectorRanks.pop();
    }
  }
  const readCandidate = database.prepare(`
    SELECT d.source, c.chunk ${from} WHERE c.generation_id = ? AND c.chunk_id = ?
  `);
  const vectors = vectorRanks.map(({ id }, index) => {
    const row = readCandidate.get(generation.generationId, id);
    if (!row) throw persistence();
    return { ...rowCandidate(row), vectorRank: index + 1 } satisfies RetrievalRankedCandidate;
  });
  return fuseRetrievalCandidates(lexical, vectors);
}

if (parentPort) {
  const parsed = workerInput.safeParse(workerData);
  if (!parsed.success) parentPort.postMessage({ ok: false, code: 'retrieval-invalid-input' });
  else {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(parsed.data.filename, { readOnly: true });
      database.exec('PRAGMA busy_timeout = 0; BEGIN');
      const candidates = rank(database, parsed.data);
      database.close();
      parentPort.postMessage({ ok: true, candidates });
    } catch {
      if (database?.isOpen) database.close();
      parentPort.postMessage({ ok: false, code: 'retrieval-unavailable' });
    }
  }
}
