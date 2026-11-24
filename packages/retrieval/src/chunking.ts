import {
  compareRetrievalCodepoints,
  retrievalCapturedDocumentSchema,
  retrievalLimits,
  type RetrievalCapturedDocument,
  type RetrievalChunkIdentity,
  type RetrievalPreparedChunk,
  type RetrievalPreparedDocuments,
  type RetrievalSourceSummary,
  type RetrievalVersions,
} from '@weave/protocol';
import { RetrievalStoreError } from './errors.js';
import { retrievalChunkId, retrievalTextDigest } from './identity.js';
import { buildLexicalTerms } from './lexical-query.js';

export const retrievalVersions: Readonly<RetrievalVersions> = Object.freeze({
  chunker: 'weave.line-chunks.v1',
  tokenizer: 'weave.identifier-han.v1',
  discovery: 'weave.discovery.v1',
  manifest: 'weave.retrieval-manifest.v1',
});

interface LineFragment {
  readonly text: string;
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly bytes: number;
  readonly wholeLine: boolean;
}

function* lineFragments(body: string): Generator<LineFragment> {
  let line = 0;
  for (const [text] of body.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu)) {
    line++;
    const bytes = Buffer.byteLength(text);
    if (bytes <= retrievalLimits.maxChunkBytes) {
      yield { text, line, startColumn: 0, endColumn: [...text].length, bytes, wholeLine: true };
      continue;
    }

    let offset = 0;
    let start = 0;
    let startColumn = 0;
    let column = 0;
    let width = 0;
    // Treat CRLF as one fragment unit while counting both codepoints.
    for (const [point] of text.matchAll(/\r\n|[\s\S]/gu)) {
      const pointWidth = Buffer.byteLength(point);
      if (width + pointWidth > retrievalLimits.maxChunkBytes) {
        yield {
          text: text.slice(start, offset),
          line,
          startColumn,
          endColumn: column,
          bytes: width,
          wholeLine: false,
        };
        start = offset;
        startColumn = column;
        width = 0;
      }
      width += pointWidth;
      offset += point.length;
      column += point === '\r\n' ? 2 : 1;
    }
    yield {
      text: text.slice(start),
      line,
      startColumn,
      endColumn: column,
      bytes: width,
      wholeLine: false,
    };
  }
}

function carryLines(
  parts: readonly LineFragment[],
  next: LineFragment,
): {
  parts: LineFragment[];
  bytes: number;
} {
  let bytes = 0;
  let start = parts.length;
  while (start > 0 && parts.length - start < retrievalLimits.maxOverlapLines) {
    const part = parts[start - 1]!;
    if (
      !part.wholeLine ||
      bytes + part.bytes > retrievalLimits.maxOverlapBytes ||
      bytes + part.bytes + next.bytes > retrievalLimits.maxChunkBytes ||
      next.line - part.line >= retrievalLimits.maxChunkLines
    )
      break;
    bytes += part.bytes;
    start--;
  }
  return { parts: parts.slice(start), bytes };
}

function* chunksFor(document: RetrievalCapturedDocument): Generator<RetrievalPreparedChunk> {
  const { source, body, title, lexicalMetadata } = document;
  const metadata = [
    title,
    ...(source.kind === 'workspace' ? [source.path] : []),
    ...lexicalMetadata.tags,
  ];
  let ordinal = 0;
  let parts: LineFragment[] = [];
  let bytes = 0;

  function emit(): RetrievalPreparedChunk {
    const first = parts[0]!;
    const last = parts.at(-1)!;
    const text = parts.map((part) => part.text).join('');
    const identity: Omit<RetrievalChunkIdentity, 'chunkId'> = {
      sourceKey: source.sourceKey,
      sourceSha256: source.sourceSha256,
      ordinal: ordinal++,
      startLine: first.line,
      endLine: last.line,
      startColumn: first.startColumn,
      endColumn: last.endColumn,
      textSha256: retrievalTextDigest(text),
      textBytes: bytes,
      chunkerVersion: retrievalVersions.chunker,
    };
    return Object.freeze({
      identity: Object.freeze({ ...identity, chunkId: retrievalChunkId(identity) }),
      text,
      terms: buildLexicalTerms(text, metadata),
    });
  }

  for (const part of lineFragments(body)) {
    if (
      parts.length &&
      (bytes + part.bytes > retrievalLimits.maxChunkBytes ||
        part.line - parts[0]!.line >= retrievalLimits.maxChunkLines)
    ) {
      yield emit();
      ({ parts, bytes } = carryLines(parts, part));
    }
    parts.push(part);
    bytes += part.bytes;
  }
  if (parts.length) yield emit();
}

function parseDocument(input: RetrievalCapturedDocument): RetrievalCapturedDocument {
  const parsed = retrievalCapturedDocumentSchema.safeParse(input);
  if (!parsed.success)
    throw new RetrievalStoreError('retrieval-invalid-input', { cause: parsed.error });
  if (retrievalTextDigest(parsed.data.body) !== parsed.data.source.sourceSha256)
    throw new RetrievalStoreError('retrieval-invalid-input');
  return parsed.data;
}

export function chunkDocument(
  document: RetrievalCapturedDocument,
): readonly RetrievalPreparedChunk[] {
  return Object.freeze([...chunksFor(parseDocument(document))]);
}

function freezeSource(source: RetrievalCapturedDocument['source']): void {
  if (source.kind === 'memory') {
    Object.freeze(source.ref.scope);
    Object.freeze(source.ref);
  }
  Object.freeze(source);
}

export function prepareDocuments(
  documents: readonly RetrievalCapturedDocument[],
): RetrievalPreparedDocuments {
  if (documents.length > retrievalLimits.maxSources)
    throw new RetrievalStoreError('retrieval-limit');
  const parsed: RetrievalCapturedDocument[] = [];
  const keys = new Set<string>();
  let captureBytes = 0;
  let files = 0;
  for (const input of documents) {
    const document = parseDocument(input);
    if (keys.has(document.source.sourceKey))
      throw new RetrievalStoreError('retrieval-invalid-input');
    keys.add(document.source.sourceKey);
    captureBytes += document.source.sourceBytes;
    if (document.source.kind === 'workspace') files++;
    if (
      captureBytes > retrievalLimits.maxCaptureBytes ||
      files > retrievalLimits.maxFiles ||
      parsed.length + 1 - files > retrievalLimits.maxMemoryRefs
    )
      throw new RetrievalStoreError('retrieval-limit');
    parsed.push(document);
  }
  parsed.sort((a, b) => compareRetrievalCodepoints(a.source.sourceKey, b.source.sourceKey));

  const sources: RetrievalSourceSummary[] = [];
  const chunks: RetrievalPreparedChunk[] = [];
  let chunkTextBytes = 0;
  for (const { body, ...summary } of parsed) {
    const before = chunks.length;
    for (const chunk of chunksFor({ body, ...summary })) {
      chunkTextBytes += chunk.identity.textBytes;
      if (
        chunks.length >= retrievalLimits.maxChunks ||
        chunkTextBytes > retrievalLimits.maxChunkTextBytes
      ) {
        throw new RetrievalStoreError('retrieval-limit');
      }
      chunks.push(chunk);
    }
    freezeSource(summary.source);
    Object.freeze(summary.lexicalMetadata.tags);
    Object.freeze(summary.lexicalMetadata);
    sources.push(Object.freeze({ ...summary, chunkCount: chunks.length - before }));
  }

  return Object.freeze({
    versions: retrievalVersions,
    sources: Object.freeze(sources),
    chunks: Object.freeze(chunks),
    metrics: Object.freeze({
      files,
      memories: sources.length - files,
      sources: sources.length,
      captureBytes,
      chunks: chunks.length,
      chunkTextBytes,
    }),
  });
}
