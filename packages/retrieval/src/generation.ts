import { createHash, type Hash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  retrievalGenerationSchema,
  retrievalPreparedChunkSchema,
  retrievalSourceSummarySchema,
  retrievalLimits,
  type RetrievalGeneration,
  type RetrievalPreparedChunk,
  type RetrievalRankedCandidate,
  type RetrievalSourceSummary,
} from '@weave/protocol';
import { z } from 'zod';
import { persistence, RetrievalStoreError } from './errors.js';
import { retrievalChunkId, retrievalTextDigest } from './identity.js';

export const uuid = z.string().uuid();

export function ftsTable(generationId: string): string {
  // Encode UUID bytes as an identifier, retaining case to avoid SQLite identifier aliases.
  return `retrieval_fts_${Buffer.from(uuid.parse(generationId)).toString('hex')}`;
}

export function jsonValue(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== 'string') throw persistence();
  return JSON.parse(value) as unknown;
}

export function vectorBytes(values: readonly number[]): Buffer<ArrayBuffer> {
  if (values.length !== retrievalLimits.embeddingDimensions)
    throw new RetrievalStoreError('retrieval-invalid-input');
  let squares = 0;
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value) || Math.fround(value) !== value || Object.is(value, -0))
      throw new RetrievalStoreError('retrieval-invalid-input');
    squares += value * value;
    bytes.writeFloatLE(value, index * 4);
  }
  if (Math.abs(squares - 1) > 1e-6) throw new RetrievalStoreError('retrieval-invalid-input');
  return bytes;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function appendContent(hash: Hash, fields: readonly SQLOutputValue[]): void {
  for (const field of fields) {
    if (field instanceof Uint8Array) {
      hash.update(`B${field.byteLength}:`).update(field);
    } else {
      const text = JSON.stringify(field);
      hash.update(`J${Buffer.byteLength(text)}:`).update(text);
    }
  }
}

export function readSource(value: SQLOutputValue | undefined): RetrievalSourceSummary {
  return retrievalSourceSummarySchema.parse(jsonValue(value));
}

export function readPreparedChunk(value: SQLOutputValue | undefined): RetrievalPreparedChunk {
  const chunk = retrievalPreparedChunkSchema.parse(jsonValue(value));
  if (
    retrievalChunkId(chunk.identity) !== chunk.identity.chunkId ||
    retrievalTextDigest(chunk.text) !== chunk.identity.textSha256
  )
    throw persistence();
  return chunk;
}

export function rowCandidate(row: Record<string, SQLOutputValue>): RetrievalRankedCandidate {
  const { source, title } = readSource(row.source);
  const { identity: chunk, text } = readPreparedChunk(row.chunk);
  if (source.sourceKey !== chunk.sourceKey || source.sourceSha256 !== chunk.sourceSha256)
    throw persistence();
  return { source, title, chunk, text };
}

export function storedGeneration(
  database: DatabaseSync,
  generationId: string,
): RetrievalGeneration {
  const row = database
    .prepare('SELECT published FROM retrieval_generations WHERE id = ?')
    .get(generationId);
  return retrievalGenerationSchema.parse(jsonValue(row?.published));
}

export function digestStoredGeneration(
  database: DatabaseSync,
  generation: RetrievalGeneration,
): string {
  const id = generation.generationId;
  const counts = generation.counts;
  const table = ftsTable(id);
  const hash = createHash('sha256');
  let docs = 0;
  for (const row of database
    .prepare(
      'SELECT source_key, kind, path, source FROM retrieval_documents WHERE generation_id = ? ORDER BY source_key',
    )
    .iterate(id)) {
    if (++docs > counts.sources) throw persistence();
    appendContent(hash, [row.source_key!, row.kind!, row.path!, row.source!]);
  }
  if (docs !== counts.sources) throw persistence();
  let chunks = 0;
  for (const row of database
    .prepare(
      `
    SELECT c.position, c.chunk_id, c.source_key, c.ordinal, c.chunk, c.vector, f.title, f.path, f.body, f.terms
    FROM retrieval_chunks c
    LEFT JOIN ${table} f ON f.rowid = c.position
    WHERE c.generation_id = ?
    ORDER BY c.position
  `,
    )
    .iterate(id)) {
    if (
      ++chunks > counts.chunks ||
      row.position !== chunks ||
      row.terms === null ||
      (generation.mode === 'hybrid'
        ? !(row.vector instanceof Uint8Array) ||
          row.vector.byteLength !== retrievalLimits.embeddingDimensions * 4
        : row.vector !== null)
    )
      throw persistence();
    appendContent(hash, [
      row.position!,
      row.chunk_id!,
      row.source_key!,
      row.ordinal!,
      row.chunk!,
      row.vector!,
      row.title!,
      row.path!,
      row.body!,
      row.terms!,
    ]);
  }
  if (
    chunks !== counts.chunks ||
    database.prepare(`SELECT count(*) AS total FROM ${table}`).get()?.total !== chunks
  )
    throw persistence();
  return hash.digest('hex');
}
