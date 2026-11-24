import { createHash } from 'node:crypto';
import type { RetrievalChunkIdentity, RetrievalManifest } from '@weave/protocol';

export function retrievalTextDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function retrievalChunkId(chunk: Omit<RetrievalChunkIdentity, 'chunkId'>): string {
  return retrievalTextDigest(
    JSON.stringify([
      chunk.sourceKey,
      chunk.sourceSha256,
      chunk.ordinal,
      chunk.startLine,
      chunk.endLine,
      chunk.startColumn,
      chunk.endColumn,
      chunk.textSha256,
    ]),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
}

export function retrievalManifestDigest(
  manifest: Omit<RetrievalManifest, 'manifestDigest'>,
): string {
  // Identities bind source and chunk bytes. Capture timestamps are display data.
  const { project, mode, selection, versions, sources, chunks, counts, coverage, embedding } =
    manifest;
  return retrievalTextDigest(
    canonicalJson({
      project,
      mode,
      selection,
      versions,
      counts,
      coverage,
      embedding,
      sources: sources.map(({ source, title, lexicalMetadata, chunkCount }) => ({
        source,
        title,
        lexicalMetadata,
        chunkCount,
      })),
      chunks: chunks.map(({ identity, terms }) => ({
        identity,
        termsSha256: retrievalTextDigest(terms),
      })),
    }),
  );
}
