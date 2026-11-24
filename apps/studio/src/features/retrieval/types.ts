import { z } from 'zod';
import { memoryRefSchema, sameMemoryRef } from '../memory/types.js';

export const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;
function text(points: number, bytes: number, multiline = false, empty = false) {
  return z.string().refine(
    (value) =>
      (empty || value.length > 0) &&
      !/[\uD800-\uDFFF]/u.test(value) &&
      [...value].length <= points &&
      utf8Length(value) <= bytes &&
      ![...value].some((point) => {
        const code = point.codePointAt(0)!;
        return (
          code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10 || code === 13)))
        );
      }),
  );
}
export const id = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
export const cursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);
const path = text(1024, 4096).refine(
  (value) =>
    !/[\\:]/u.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..'),
);
export const paths = z.strictObject({
  include: z.array(path).max(32),
  exclude: z.array(path).max(32),
});
const mode = z.enum(['lexical', 'hybrid']);
export type RetrievalMode = z.infer<typeof mode>;
const kind = z.enum(['workspace', 'memory']);
export type RetrievalSourceKind = z.infer<typeof kind>;
const project = z.strictObject({ projectId: id, folderRevision: count, rootDigest: digest });
const memoryRef = memoryRefSchema.refine((ref) => ref.scope.kind === 'project');
const versions = z.strictObject({
  chunker: z.literal('weave.line-chunks.v1'),
  tokenizer: z.literal('weave.identifier-han.v1'),
  discovery: z.literal('weave.discovery.v1'),
  manifest: z.literal('weave.retrieval-manifest.v1'),
});
const vector = z.strictObject({
  provider: z.literal('openai'),
  endpointId: z.literal('openai.embeddings.v1'),
  destination: z.literal('api.openai.com'),
  model: z.literal('text-embedding-3-small'),
  dimensions: z.literal(512),
  adapterVersion: z.literal('weave.openai-embedding.v1'),
});
export const capabilities = z.strictObject({
  lexical: z.discriminatedUnion('available', [
    z.strictObject({ available: z.literal(true) }),
    z.strictObject({ available: z.literal(false), reason: z.literal('fts5-unavailable') }),
  ]),
  embedding: z.discriminatedUnion('configured', [
    z.strictObject({ configured: z.literal(true), identity: vector }),
    z.strictObject({ configured: z.literal(false), reason: z.literal('not-configured') }),
  ]),
});
export type RetrievalCapabilities = z.infer<typeof capabilities>;
const counts = z.strictObject({
  discovered: count.max(50048),
  selected: count.max(2048),
  skipped: count.max(50000),
  sources: count.max(2048),
  files: count.max(2000),
  memories: count.max(48),
  chunks: count.max(20000),
  captureBytes: count.max(16777216),
  chunkTextBytes: count.max(41943040),
});
export const skipReason = z.enum([
  'system-exclusion',
  'not-selected',
  'empty',
  'too-large',
  'invalid-utf8',
  'binary',
  'unsafe-file',
  'changed',
  'unavailable',
  'source-limit',
  'capture-limit',
  'chunk-limit',
]);
const coverage = z.strictObject({
  discovery: z.enum(['git', 'walk', 'memory-only']),
  truncated: z.boolean(),
  skippedDetailsTruncated: z.boolean(),
  skipCounts: z.array(z.strictObject({ reason: skipReason, count: positive.max(50000) })).max(12),
});
const sourceFields = { sourceKey: text(1034, 4106), sourceSha256: digest };
const source = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...sourceFields,
      kind: z.literal('workspace'),
      path,
      sourceBytes: positive.max(262144),
      fileObjectDigest: digest,
    }),
    z.strictObject({
      ...sourceFields,
      kind: z.literal('memory'),
      ref: memoryRef,
      sourceBytes: positive.max(8192),
    }),
  ])
  .refine(
    (value) =>
      value.sourceKey ===
      (value.kind === 'workspace' ? `workspace:${value.path}` : `memory:${value.ref.memoryId}`),
  );
export type RetrievalSource = z.infer<typeof source>;
export function sameSource(a: RetrievalSource, b: RetrievalSource): boolean {
  return (
    a.sourceKey === b.sourceKey &&
    a.sourceSha256 === b.sourceSha256 &&
    a.sourceBytes === b.sourceBytes &&
    (a.kind === 'workspace' && b.kind === 'workspace'
      ? a.path === b.path && a.fileObjectDigest === b.fileObjectDigest
      : a.kind === 'memory' && b.kind === 'memory' && sameMemoryRef(a.ref, b.ref))
  );
}
const chunk = z
  .strictObject({
    chunkId: digest,
    sourceKey: sourceFields.sourceKey,
    sourceSha256: digest,
    ordinal: count.max(19999),
    startLine: positive,
    endLine: positive,
    startColumn: count,
    endColumn: count,
    textSha256: digest,
    textBytes: positive.max(2048),
    chunkerVersion: versions.shape.chunker,
  })
  .refine(
    (value) =>
      value.endLine >= value.startLine &&
      value.endLine - value.startLine < 80 &&
      (value.endLine > value.startLine || value.endColumn > value.startColumn),
  );
export const citation = z
  .strictObject({ project, generationId: id, source, chunk })
  .refine(
    (value) =>
      value.source.sourceKey === value.chunk.sourceKey &&
      value.source.sourceSha256 === value.chunk.sourceSha256 &&
      value.chunk.textBytes <= value.source.sourceBytes &&
      value.chunk.endLine <= value.source.sourceBytes &&
      value.chunk.startColumn <= value.source.sourceBytes &&
      value.chunk.endColumn <= value.source.sourceBytes &&
      (value.source.kind === 'workspace' ||
        (value.source.ref.scope.kind === 'project' &&
          value.source.ref.scope.projectId === value.project.projectId)),
  );
export type RetrievalCitation = z.infer<typeof citation>;
export const prepareInput = z.strictObject({
  requestId: id,
  intent: z
    .strictObject({
      mode,
      workspace: z.strictObject({
        enabled: z.boolean(),
        paths,
        selectedPaths: z.array(path).max(2000).optional(),
      }),
      memoryRefs: z.array(memoryRef).max(48),
    })
    .refine((value) => value.workspace.enabled || value.memoryRefs.length > 0),
});
export type RetrievalPrepareInput = z.infer<typeof prepareInput>;
export const buildInput = z.strictObject({
  requestId: id,
  previewId: id,
  mode,
  manifestDigest: digest,
});
export type RetrievalBuildInput = z.infer<typeof buildInput>;
export const preview = z
  .strictObject({
    previewId: id,
    requestId: id,
    project,
    manifestDigest: digest,
    mode,
    versions,
    createdAt: timestamp,
    expiresAt: timestamp,
    counts,
    coverage,
    embedding: z
      .strictObject({
        identity: vector,
        inputCount: positive.max(20000),
        inputBytes: positive.max(41943040),
        requestCount: positive.max(20000),
        requestBytes: positive.max(819200000),
      })
      .optional(),
  })
  .refine(
    (value) =>
      (value.mode === 'hybrid') === Boolean(value.embedding) &&
      (!value.embedding ||
        (value.embedding.inputCount === value.counts.chunks &&
          value.embedding.inputBytes === value.counts.chunkTextBytes)),
  );
export type RetrievalPreview = z.infer<typeof preview>;
const title = text(160, 640);
export const previewPage = z.strictObject({
  previewId: id,
  manifestDigest: digest,
  sources: z
    .array(
      z.strictObject({
        source,
        title,
        lexicalMetadata: z.strictObject({ tags: z.array(text(40, 160)).max(12) }),
        chunkCount: count.max(20000),
        capturedAt: timestamp,
      }),
    )
    .max(50),
  skipped: z.array(z.strictObject({ path, reason: skipReason })).max(50),
  nextCursor: cursor.optional(),
});
export type RetrievalPreviewPage = z.infer<typeof previewPage>;
export const textPage = z
  .strictObject({
    source,
    offset: count,
    text: text(8192, 8192, true, true),
    eof: z.boolean(),
    nextCursor: cursor.optional(),
  })
  .refine(
    (value) =>
      value.offset + utf8Length(value.text) <= value.source.sourceBytes &&
      (value.eof
        ? value.nextCursor === undefined
        : value.text.length > 0 && value.nextCursor !== undefined),
  );
export type RetrievalTextPage = z.infer<typeof textPage>;
export const receipt = z.strictObject({
  operation: z.literal('retrieval.index'),
  requestId: id,
  requestDigest: digest,
  jobId: id,
  acceptedSequence: positive,
  project,
  manifestDigest: digest,
});
export type RetrievalReceipt = z.infer<typeof receipt>;
const generation = z
  .strictObject({
    generationId: id,
    jobId: id,
    project,
    manifestDigest: digest,
    versions,
    mode,
    vectorIdentity: vector.optional(),
    indexedAt: timestamp,
    counts,
  })
  .refine((value) => (value.mode === 'hybrid') === Boolean(value.vectorIdentity));
const terminal = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), generation }),
  z.strictObject({
    status: z.literal('failed'),
    code: z.enum([
      'stale-source',
      'root-changed',
      'memory-revoked',
      'embedding-unavailable',
      'embedding-failed',
      'index-failed',
      'deadline',
    ]),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    reason: z.enum(['user', 'shutdown', 'authority-revoked']),
  }),
  z.strictObject({ status: z.literal('interrupted'), reason: z.literal('server-restart') }),
]);
const hostId = text(240, 960);
const provenance = z.discriminatedUnion('actor', [
  z.strictObject({ actor: z.literal('local-user') }),
  z.strictObject({
    actor: z.literal('agent'),
    sessionId: hostId,
    executionId: hostId,
    turnId: hostId,
    toolCallId: hostId,
  }),
]);
export const job = z.strictObject({
  job: z
    .strictObject({
      receipt,
      mode,
      provenance,
      counts,
      acceptedAt: timestamp,
      startedAt: timestamp.optional(),
      finishedAt: timestamp.optional(),
      terminal: terminal.optional(),
    })
    .refine((value) => Boolean(value.finishedAt) === Boolean(value.terminal)),
  live: z
    .strictObject({
      phase: z.enum([
        'accepted',
        'capturing',
        'indexing',
        'embedding',
        'validating',
        'publishing',
        'cancelling',
      ]),
      discovered: count,
      captured: count,
      chunks: count,
      embedded: count,
    })
    .optional(),
});
export type RetrievalJob = z.infer<typeof job>;
export const jobs = z.strictObject({ jobs: z.array(job).max(20), nextCursor: cursor.optional() });
export const cancel = z.strictObject({
  jobId: id,
  cancelling: z.boolean(),
  terminal: terminal.optional(),
});
export const status = z.strictObject({
  project,
  availability: z.enum(['ready', 'not-built', 'root-changed', 'generation-unavailable']),
  active: generation.optional(),
  previous: generation.optional(),
  needsRebuild: z.boolean(),
  activeJob: job.optional(),
});
export type RetrievalStatus = z.infer<typeof status>;
const filters = z.strictObject({
  sources: z
    .array(kind)
    .min(1)
    .max(2)
    .refine((items) => new Set(items).size === items.length),
  paths,
});
export const queryInput = z.strictObject({
  requestId: id,
  mode,
  intent: z.strictObject({ query: text(512, 2048), filters, limit: positive.max(10) }),
});
export type RetrievalQueryInput = z.infer<typeof queryInput>;
const rank = positive.max(50).optional();
const hit = z.strictObject({
  citation,
  title,
  excerpt: text(1200, 1200, true),
  lexicalRank: rank,
  vectorRank: rank,
  rrfScore: z.number().finite().positive().optional(),
  verifiedAt: timestamp,
});
export const queryResult = z
  .strictObject({
    requestId: id,
    actualMode: mode,
    generation,
    filters,
    hits: z.array(hit).max(10),
    omitted: z.strictObject({ stale: count, unavailable: count, budget: count }),
    truncated: z.boolean(),
    verifiedAt: timestamp,
  })
  .refine(
    (value) =>
      (value.actualMode === 'lexical' || value.generation.mode === 'hybrid') &&
      value.hits.every(
        (item) =>
          item.citation.generationId === value.generation.generationId &&
          sameProject(item.citation.project, value.generation.project) &&
          value.filters.sources.includes(item.citation.source.kind) &&
          (item.citation.source.kind === 'memory' ||
            matchesPath(item.citation.source.path, value.filters.paths)) &&
          (value.actualMode === 'lexical'
            ? item.lexicalRank !== undefined &&
              item.vectorRank === undefined &&
              item.rrfScore === undefined
            : item.rrfScore !== undefined &&
              (item.lexicalRank !== undefined || item.vectorRank !== undefined)),
      ),
  );
export type RetrievalQueryResult = z.infer<typeof queryResult>;
export const sourceResult = z
  .strictObject({
    citation,
    page: textPage,
    verifiedAt: timestamp,
    open: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('workspace'), path, line: positive }),
      z.strictObject({ kind: z.literal('memory'), ref: memoryRef }),
    ]),
  })
  .refine(
    ({ citation: value, page, open }) =>
      sameSource(value.source, page.source) &&
      (value.source.kind === 'workspace' && open.kind === 'workspace'
        ? value.source.path === open.path && value.chunk.startLine === open.line
        : value.source.kind === 'memory' &&
          open.kind === 'memory' &&
          sameMemoryRef(value.source.ref, open.ref)),
  );
export type RetrievalSourceResult = z.infer<typeof sourceResult>;
export const error = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'retrieval-invalid-input',
      'retrieval-unavailable',
      'retrieval-not-found',
      'retrieval-scope-forbidden',
      'retrieval-project-ambiguous',
      'retrieval-root-changed',
      'retrieval-stale-preview',
      'retrieval-stale-source',
      'retrieval-invalid-cursor',
      'retrieval-stale-cursor',
      'retrieval-request-conflict',
      'retrieval-limit',
      'retrieval-busy',
      'retrieval-cancelled',
      'retrieval-timeout',
      'retrieval-semantic-unavailable',
      'retrieval-embedding-failed',
      'retrieval-persistence-error',
      'retrieval-persistence-uncertain',
    ]),
    message: text(240, 960),
  }),
});

export function sameProject(a: z.infer<typeof project>, b: z.infer<typeof project>): boolean {
  return (
    a.projectId === b.projectId &&
    a.folderRevision === b.folderRevision &&
    a.rootDigest === b.rootDigest
  );
}

function matchesPath(value: string, filters: z.infer<typeof paths>): boolean {
  const matches = (prefix: string) => value === prefix || value.startsWith(`${prefix}/`);
  return (
    (filters.include.length === 0 || filters.include.some(matches)) &&
    !filters.exclude.some(matches)
  );
}
