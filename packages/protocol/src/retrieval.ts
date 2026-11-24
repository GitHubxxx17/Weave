import { z } from 'zod';
import { memoryRefSchema, memoryTagsSchema, type MemoryRef } from './memory.js';

export const retrievalLimits = Object.freeze({
  maxFiles: 2_000,
  maxMemoryRefs: 48,
  maxSources: 2_048,
  maxDiscoveredFiles: 50_000,
  maxSkipDetails: 2_000,
  maxFileBytes: 262_144,
  maxCaptureBytes: 16_777_216,
  maxChunks: 20_000,
  maxChunkBytes: 2_048,
  maxChunkLines: 80,
  maxOverlapBytes: 256,
  maxOverlapLines: 8,
  maxChunkTextBytes: 41_943_040,
  maxPreviews: 2,
  maxPreviewsPerProject: 1,
  previewTtlMs: 300_000,
  maxJobs: 2,
  maxJobsPerProject: 1,
  maxJobMs: 600_000,
  maxReaders: 4,
  maxLocalReadMs: 5_000,
  maxSemanticMs: 35_000,
  maxEmbeddingRequests: 2,
  maxEmbeddingRequestMs: 30_000,
  maxEmbeddingBatch: 16,
  maxEmbeddingRequestBytes: 40_960,
  maxEmbeddingResponseBytes: 2_097_152,
  embeddingDimensions: 512,
  maxQueryPoints: 512,
  maxQueryBytes: 2_048,
  maxQueryTerms: 32,
  maxRankerCandidates: 50,
  maxCandidates: 50,
  maxHits: 10,
  maxVerifiedFiles: 20,
  maxVerifiedFileBytes: 5_242_880,
  maxExcerptBytes: 1_200,
  maxResponseBytes: 24_576,
  maxTextPageBytes: 8_192,
  maxPreviewPage: 50,
  maxJobPage: 20,
  maxCursorBytes: 2_048,
  maxPostBodyBytes: 16_384,
  maxApprovalBytes: 12_288,
  maxGenerationsPerProject: 3,
} as const);
const encoder = new TextEncoder();
const utf8Bytes = (value: string) => encoder.encode(value).byteLength;
const fitsResponse = (value: unknown) =>
  utf8Bytes(JSON.stringify(value)) <= retrievalLimits.maxResponseBytes;
const wellFormed = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
function text(
  points: number,
  bytes: number,
  options: { empty?: boolean; multiline?: boolean } = {},
) {
  return z.string().refine(
    (value) =>
      (options.empty || value.length > 0) &&
      wellFormed(value) &&
      [...value].length <= points &&
      utf8Bytes(value) <= bytes &&
      ![...value].some((point) => {
        const n = point.codePointAt(0)!;
        return n === 127 || (n < 32 && !(options.multiline && (n === 9 || n === 10 || n === 13)));
      }),
    'Unsupported text or Unicode/UTF-8 bound exceeded',
  );
}
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const counter = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const timestamp = z.iso.datetime();
const hostId = text(240, 960);
const cursor = z
  .string()
  .min(1)
  .max(retrievalLimits.maxCursorBytes)
  .regex(/^[A-Za-z0-9_-]+$/);
export const retrievalPathSchema = text(1_024, 4_096).refine(
  (value) =>
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  'A normalized POSIX relative path is required',
);
// Prefixes mean directory/path-prefix filters, not glob/regex expressions.
export const retrievalPathFiltersSchema = z.strictObject({
  include: z.array(retrievalPathSchema).max(32).default([]),
  exclude: z.array(retrievalPathSchema).max(32).default([]),
});
export type RetrievalPathFilters = z.infer<typeof retrievalPathFiltersSchema>;
export function retrievalPathMatches(path: string, filters: RetrievalPathFilters): boolean {
  const matchesPrefix = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return (
    (filters.include.length === 0 || filters.include.some(matchesPrefix)) &&
    !filters.exclude.some(matchesPrefix)
  );
}
export const retrievalModeSchema = z.enum(['lexical', 'hybrid']);
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;
export const retrievalSourceKindSchema = z.enum(['workspace', 'memory']);
export type RetrievalSourceKind = z.infer<typeof retrievalSourceKindSchema>;
export const retrievalProjectIdentitySchema = z.strictObject({
  projectId: uuid,
  folderRevision: counter,
  rootDigest: sha256,
});
export type RetrievalProjectIdentity = z.infer<typeof retrievalProjectIdentitySchema>;
export function sameRetrievalProject(
  a: RetrievalProjectIdentity,
  b: RetrievalProjectIdentity,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.folderRevision === b.folderRevision &&
    a.rootDigest === b.rootDigest
  );
}
export const retrievalVersionsSchema = z.strictObject({
  chunker: z.literal('weave.line-chunks.v1'),
  tokenizer: z.literal('weave.identifier-han.v1'),
  discovery: z.literal('weave.discovery.v1'),
  manifest: z.literal('weave.retrieval-manifest.v1'),
});
export type RetrievalVersions = z.infer<typeof retrievalVersionsSchema>;
export const retrievalVectorIdentitySchema = z.strictObject({
  provider: z.literal('openai'),
  endpointId: z.literal('openai.embeddings.v1'),
  destination: z.literal('api.openai.com'),
  model: z.literal('text-embedding-3-small'),
  dimensions: z.literal(512),
  adapterVersion: z.literal('weave.openai-embedding.v1'),
});
export type RetrievalVectorIdentity = z.infer<typeof retrievalVectorIdentitySchema>;
const projectMemoryRefSchema = memoryRefSchema.refine((ref) => ref.scope.kind === 'project');
function sameProjectMemoryRef(a: MemoryRef, b: MemoryRef): boolean {
  return (
    a.memoryId === b.memoryId &&
    a.revision === b.revision &&
    a.sha256 === b.sha256 &&
    a.scope.kind === 'project' &&
    b.scope.kind === 'project' &&
    a.scope.projectId === b.scope.projectId
  );
}
const buildSelectionFields = {
  workspace: z.strictObject({
    enabled: z.boolean().default(true),
    paths: retrievalPathFiltersSchema,
    // Omitted selects all allowed discovered files. An empty list selects none.
    selectedPaths: z.array(retrievalPathSchema).max(retrievalLimits.maxFiles).optional(),
  }),
  memoryRefs: z.array(projectMemoryRefSchema).max(retrievalLimits.maxMemoryRefs).default([]),
};
export type RetrievalNormalizedSelection = {
  workspace: z.infer<typeof buildSelectionFields.workspace>;
  memoryRefs: z.infer<typeof buildSelectionFields.memoryRefs>;
};
function validateBuildSelection(value: RetrievalNormalizedSelection, ctx: z.RefinementCtx) {
  if (!value.workspace.enabled && value.memoryRefs.length === 0)
    ctx.addIssue({ code: 'custom', message: 'At least one source selection is required' });
  const refs = value.memoryRefs.map((ref) => ref.memoryId);
  if (new Set(refs).size !== refs.length)
    ctx.addIssue({ code: 'custom', message: 'Memory refs must have unique record IDs' });
  const paths = value.workspace.selectedPaths;
  if (paths && new Set(paths).size !== paths.length)
    ctx.addIssue({ code: 'custom', message: 'Selected paths must be unique' });
}
export const retrievalBuildIntentSchema = z
  .strictObject({
    mode: retrievalModeSchema,
    ...buildSelectionFields,
  })
  .superRefine(validateBuildSelection);
export type RetrievalBuildIntent = z.infer<typeof retrievalBuildIntentSchema>;
/**
 * Canonical selection after defaults: paths include/exclude are deduplicated
 * and sorted by locale-independent codepoint order; selectedPaths (when present)
 * is sorted, and memoryRefs is sorted by memoryId. Preserve absent selectedPaths
 * versus []. The same normalization supplies Agent intent and manifest hashing.
 */
export function compareRetrievalCodepoints(a: string, b: string): number {
  const right = b[Symbol.iterator]();
  for (const left of a) {
    const next = right.next();
    if (next.done) return 1;
    const difference = left.codePointAt(0)! - next.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return right.next().done ? 0 : -1;
}
export function normalizeRetrievalSelection(
  selection: RetrievalNormalizedSelection,
): RetrievalNormalizedSelection {
  const { workspace, memoryRefs } = selection;
  const { enabled, paths, selectedPaths } = workspace;
  return {
    workspace: {
      enabled,
      paths: {
        include: [...new Set(paths.include)].sort(compareRetrievalCodepoints),
        exclude: [...new Set(paths.exclude)].sort(compareRetrievalCodepoints),
      },
      ...(selectedPaths === undefined
        ? {}
        : { selectedPaths: [...selectedPaths].sort(compareRetrievalCodepoints) }),
    },
    memoryRefs: [...memoryRefs].sort((a, b) => compareRetrievalCodepoints(a.memoryId, b.memoryId)),
  };
}
export const retrievalPrepareInputSchema = z.strictObject({
  requestId: uuid,
  intent: retrievalBuildIntentSchema,
});
export type RetrievalPrepareInput = z.infer<typeof retrievalPrepareInputSchema>;
export const retrievalBuildInputSchema = z.strictObject({
  requestId: uuid,
  previewId: uuid,
  mode: retrievalModeSchema,
  manifestDigest: sha256,
});
export type RetrievalBuildInput = z.infer<typeof retrievalBuildInputSchema>;
// Agent build tool accepts only intent. requestId/project/preview/caller are host-owned.
export const retrievalAgentBuildInputSchema = retrievalBuildIntentSchema;
export const retrievalSourceIdentitySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('workspace'),
      sourceKey: text(1_034, 4_106),
      path: retrievalPathSchema,
      sourceSha256: sha256,
      sourceBytes: z.number().int().min(1).max(262_144),
      fileObjectDigest: sha256,
    }),
    z.strictObject({
      kind: z.literal('memory'),
      sourceKey: text(43, 43),
      ref: projectMemoryRefSchema,
      // Hash of exact body text, distinct from ref.sha256(title/content/tags).
      sourceSha256: sha256,
      sourceBytes: z.number().int().min(1).max(8_192),
    }),
  ])
  .superRefine((source, ctx) => {
    const expected =
      source.kind === 'workspace' ? `workspace:${source.path}` : `memory:${source.ref.memoryId}`;
    if (source.sourceKey !== expected)
      ctx.addIssue({ code: 'custom', message: 'Source key must agree with source identity' });
  });
export type RetrievalSourceIdentity = z.infer<typeof retrievalSourceIdentitySchema>;
function sameSource(a: RetrievalSourceIdentity, b: RetrievalSourceIdentity): boolean {
  return (
    a.sourceKey === b.sourceKey &&
    a.sourceSha256 === b.sourceSha256 &&
    a.sourceBytes === b.sourceBytes &&
    (a.kind === 'workspace' && b.kind === 'workspace'
      ? a.path === b.path && a.fileObjectDigest === b.fileObjectDigest
      : a.kind === 'memory' && b.kind === 'memory' && sameProjectMemoryRef(a.ref, b.ref))
  );
}
const canonicalMemoryTagsSchema = z
  .array(z.string())
  .max(12)
  .superRefine((tags, ctx) => {
    const canonical = memoryTagsSchema.safeParse(tags);
    if (
      !canonical.success ||
      canonical.data.length !== tags.length ||
      tags.some((tag, index) => tag !== canonical.data[index])
    ) {
      ctx.addIssue({ code: 'custom', message: 'Memory tags must be bounded and canonical' });
    }
  });
export const retrievalLexicalMetadataSchema = z.strictObject({
  // Existing Memory bound/canonicalization: <=12 tags, each <=40 points/160 bytes.
  // Workspace documents use []; tags never become embedding input.
  tags: canonicalMemoryTagsSchema,
});
export type RetrievalLexicalMetadata = z.infer<typeof retrievalLexicalMetadataSchema>;
export const retrievalSourceSummarySchema = z
  .strictObject({
    // title is bounded display metadata; full path/sourceKey identity is preserved.
    source: retrievalSourceIdentitySchema,
    title: text(160, 640),
    lexicalMetadata: retrievalLexicalMetadataSchema,
    chunkCount: z.number().int().min(0).max(20_000),
    capturedAt: timestamp,
  })
  .refine(
    (summary) => summary.source.kind === 'memory' || summary.lexicalMetadata.tags.length === 0,
  );
export type RetrievalSourceSummary = z.infer<typeof retrievalSourceSummarySchema>;
export const retrievalChunkIdentitySchema = z
  .strictObject({
    chunkId: sha256,
    sourceKey: text(1_034, 4_106),
    sourceSha256: sha256,
    ordinal: z.number().int().min(0).max(19_999),
    startLine: positive,
    endLine: positive,
    // Codepoint column, zero-based; supports slices of a single very long line.
    startColumn: counter,
    endColumn: counter,
    textSha256: sha256,
    textBytes: z.number().int().min(1).max(2_048),
    chunkerVersion: z.literal('weave.line-chunks.v1'),
  })
  .superRefine((chunk, ctx) => {
    if (
      chunk.endLine < chunk.startLine ||
      chunk.endLine - chunk.startLine >= 80 ||
      (chunk.startLine === chunk.endLine && chunk.endColumn <= chunk.startColumn)
    )
      ctx.addIssue({ code: 'custom', message: 'Chunk source range is invalid' });
  });
export type RetrievalChunkIdentity = z.infer<typeof retrievalChunkIdentitySchema>;
function chunkMatchesSource(
  chunk: RetrievalChunkIdentity,
  source: RetrievalSourceIdentity,
): boolean {
  return (
    chunk.sourceKey === source.sourceKey &&
    chunk.sourceSha256 === source.sourceSha256 &&
    chunk.textBytes <= source.sourceBytes &&
    chunk.endLine <= source.sourceBytes &&
    chunk.startColumn <= source.sourceBytes &&
    chunk.endColumn <= source.sourceBytes
  );
}
const preparedMetricsFields = {
  files: counter.max(retrievalLimits.maxFiles),
  memories: counter.max(retrievalLimits.maxMemoryRefs),
  sources: counter.max(retrievalLimits.maxSources),
  captureBytes: counter.max(retrievalLimits.maxCaptureBytes),
  chunks: counter.max(retrievalLimits.maxChunks),
  chunkTextBytes: counter.max(retrievalLimits.maxChunkTextBytes),
};
export const retrievalCountsSchema = z
  .strictObject({
    // Runtime alone composes capture coverage counters and leaf prepared metrics.
    // discovered = capture.discoveredFiles + metrics.memories;
    // selected = capture.selectedFiles + metrics.memories;
    // skipped = capture.skippedFiles; all other fields come from metrics.
    // Invalid exact Memory refs and pure preparation overflow reject the preview.
    discovered: counter.max(retrievalLimits.maxDiscoveredFiles + retrievalLimits.maxMemoryRefs),
    selected: counter.max(retrievalLimits.maxSources),
    ...preparedMetricsFields,
    skipped: counter.max(retrievalLimits.maxDiscoveredFiles),
  })
  .refine(
    (counts) =>
      counts.sources === counts.files + counts.memories &&
      counts.discovered === counts.sources + counts.skipped &&
      counts.sources <= counts.selected &&
      counts.selected <= counts.discovered &&
      counts.selected - counts.memories <= retrievalLimits.maxFiles,
  );
export type RetrievalCounts = z.infer<typeof retrievalCountsSchema>;
function sameCounts(a: RetrievalCounts, b: RetrievalCounts): boolean {
  return (
    a.discovered === b.discovered &&
    a.selected === b.selected &&
    a.files === b.files &&
    a.memories === b.memories &&
    a.sources === b.sources &&
    a.captureBytes === b.captureBytes &&
    a.chunks === b.chunks &&
    a.chunkTextBytes === b.chunkTextBytes &&
    a.skipped === b.skipped
  );
}
export const retrievalSkipReasonSchema = z.enum([
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
export type RetrievalSkipReason = z.infer<typeof retrievalSkipReasonSchema>;
export const retrievalSkipSchema = z.strictObject({
  path: retrievalPathSchema,
  reason: retrievalSkipReasonSchema,
});
export type RetrievalSkip = z.infer<typeof retrievalSkipSchema>;
export const retrievalCoverageSchema = z
  .strictObject({
    discovery: z.enum(['git', 'walk', 'memory-only']),
    truncated: z.boolean(),
    // Discovery truncation and bounded omission-detail truncation are distinct.
    skippedDetailsTruncated: z.boolean(),
    skipCounts: z
      .array(
        z.strictObject({
          reason: retrievalSkipReasonSchema,
          count: positive.max(retrievalLimits.maxDiscoveredFiles),
        }),
      )
      .max(12),
  })
  .refine(
    (coverage) =>
      new Set(coverage.skipCounts.map((skip) => skip.reason)).size === coverage.skipCounts.length,
  );
export type RetrievalCoverage = z.infer<typeof retrievalCoverageSchema>;
function coverageMatchesCounts(coverage: RetrievalCoverage, counts: RetrievalCounts): boolean {
  return (
    coverage.skipCounts.reduce((total, skip) => total + skip.count, 0) === counts.skipped &&
    (coverage.discovery !== 'memory-only' ||
      (!coverage.truncated &&
        !coverage.skippedDetailsTruncated &&
        counts.files === 0 &&
        counts.skipped === 0))
  );
}
export const retrievalEmbeddingPlanSchema = z
  .strictObject({
    identity: retrievalVectorIdentitySchema,
    inputCount: z.number().int().min(1).max(20_000),
    inputBytes: z.number().int().min(1).max(41_943_040),
    requestCount: z.number().int().min(1).max(20_000),
    requestBytes: positive.max(
      retrievalLimits.maxEmbeddingRequestBytes * retrievalLimits.maxChunks,
    ),
  })
  .refine(
    (plan) =>
      plan.requestCount <= plan.inputCount &&
      plan.inputCount <= plan.requestCount * retrievalLimits.maxEmbeddingBatch &&
      plan.requestBytes <= plan.requestCount * retrievalLimits.maxEmbeddingRequestBytes &&
      plan.requestBytes >= plan.inputBytes,
  );
export type RetrievalEmbeddingPlan = z.infer<typeof retrievalEmbeddingPlanSchema>;
export const retrievalPreviewSchema = z
  .strictObject({
    previewId: uuid,
    requestId: uuid,
    project: retrievalProjectIdentitySchema,
    manifestDigest: sha256,
    mode: retrievalModeSchema,
    versions: retrievalVersionsSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    counts: retrievalCountsSchema,
    coverage: retrievalCoverageSchema,
    embedding: retrievalEmbeddingPlanSchema.optional(),
  })
  .refine(
    (value) =>
      (value.mode === 'hybrid') === (value.embedding !== undefined) &&
      coverageMatchesCounts(value.coverage, value.counts) &&
      (!value.embedding ||
        (value.embedding.inputCount === value.counts.chunks &&
          value.embedding.inputBytes === value.counts.chunkTextBytes)),
  );
export type RetrievalPreview = z.infer<typeof retrievalPreviewSchema>;
export const retrievalPageInputSchema = z.strictObject({ cursor: cursor.optional() });
export const retrievalPreviewPageSchema = z
  .strictObject({
    previewId: uuid,
    manifestDigest: sha256,
    sources: z.array(retrievalSourceSummarySchema).max(50),
    skipped: z.array(retrievalSkipSchema).max(50),
    nextCursor: cursor.optional(),
  })
  .refine(fitsResponse);
export type RetrievalPreviewPage = z.infer<typeof retrievalPreviewPageSchema>;
// Cursor binds request, owner epoch, manifest/source digest, operation + codepoint offset.
export const retrievalPreviewTextInputSchema = z.strictObject({
  previewId: uuid,
  manifestDigest: sha256,
  sourceKey: text(1_034, 4_106),
  cursor: cursor.optional(),
});
export const retrievalTextPageSchema = z
  .strictObject({
    source: retrievalSourceIdentitySchema,
    offset: counter,
    text: text(8_192, 8_192, { empty: true, multiline: true }),
    eof: z.boolean(),
    nextCursor: cursor.optional(),
  })
  .refine(
    (page) =>
      (page.eof
        ? page.nextCursor === undefined
        : page.text.length > 0 && page.nextCursor !== undefined) &&
      page.offset + utf8Bytes(page.text) <= page.source.sourceBytes &&
      fitsResponse(page),
  );
export type RetrievalTextPage = z.infer<typeof retrievalTextPageSchema>;
export const retrievalProvenanceSchema = z.discriminatedUnion('actor', [
  z.strictObject({ actor: z.literal('local-user') }),
  z.strictObject({
    actor: z.literal('agent'),
    sessionId: hostId,
    executionId: hostId,
    turnId: hostId,
    toolCallId: hostId,
  }),
]);
export type RetrievalProvenance = z.infer<typeof retrievalProvenanceSchema>;
export const retrievalReceiptSchema = z.strictObject({
  operation: z.literal('retrieval.index'),
  requestId: uuid,
  requestDigest: sha256,
  jobId: uuid,
  acceptedSequence: positive,
  project: retrievalProjectIdentitySchema,
  manifestDigest: sha256,
});
export type RetrievalReceipt = z.infer<typeof retrievalReceiptSchema>;
export const retrievalGenerationSchema = z
  .strictObject({
    generationId: uuid,
    jobId: uuid,
    project: retrievalProjectIdentitySchema,
    manifestDigest: sha256,
    versions: retrievalVersionsSchema,
    mode: retrievalModeSchema,
    vectorIdentity: retrievalVectorIdentitySchema.optional(),
    indexedAt: timestamp,
    counts: retrievalCountsSchema,
  })
  .refine((value) => (value.mode === 'hybrid') === (value.vectorIdentity !== undefined));
export type RetrievalGeneration = z.infer<typeof retrievalGenerationSchema>;
export const retrievalTerminalSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), generation: retrievalGenerationSchema }),
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
export type RetrievalTerminal = z.infer<typeof retrievalTerminalSchema>;
export const retrievalJobSchema = z
  .strictObject({
    receipt: retrievalReceiptSchema,
    mode: retrievalModeSchema,
    provenance: retrievalProvenanceSchema,
    counts: retrievalCountsSchema,
    acceptedAt: timestamp,
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    terminal: retrievalTerminalSchema.optional(),
  })
  .superRefine((job, ctx) => {
    if ((job.finishedAt !== undefined) !== (job.terminal !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Terminal outcome and time must agree' });
    const terminal = job.terminal;
    if (
      terminal?.status === 'completed' &&
      (terminal.generation.jobId !== job.receipt.jobId ||
        terminal.generation.manifestDigest !== job.receipt.manifestDigest ||
        terminal.generation.mode !== job.mode ||
        !sameCounts(terminal.generation.counts, job.counts) ||
        !sameRetrievalProject(terminal.generation.project, job.receipt.project))
    )
      ctx.addIssue({ code: 'custom', message: 'Published generation must match its accepted job' });
  });
export type RetrievalJob = z.infer<typeof retrievalJobSchema>;
export const retrievalProgressSchema = z.strictObject({
  phase: z.enum([
    'accepted',
    'capturing',
    'indexing',
    'embedding',
    'validating',
    'publishing',
    'cancelling',
  ]),
  discovered: counter,
  captured: counter,
  chunks: counter,
  embedded: counter,
});
export type RetrievalProgress = z.infer<typeof retrievalProgressSchema>;
export const retrievalJobSnapshotSchema = z.strictObject({
  job: retrievalJobSchema,
  live: retrievalProgressSchema.optional(),
});
export type RetrievalJobSnapshot = z.infer<typeof retrievalJobSnapshotSchema>;
export const retrievalJobPageSchema = z
  .strictObject({
    jobs: z.array(retrievalJobSnapshotSchema).max(20),
    nextCursor: cursor.optional(),
  })
  .refine(fitsResponse);
export type RetrievalJobPage = z.infer<typeof retrievalJobPageSchema>;
export const retrievalCancelInputSchema = z.strictObject({ jobId: uuid });
export const retrievalCancelResultSchema = z.strictObject({
  jobId: uuid,
  cancelling: z.boolean(),
  terminal: retrievalTerminalSchema.optional(),
});
export type RetrievalCancelResult = z.infer<typeof retrievalCancelResultSchema>;
export const retrievalIndexStatusSchema = z.strictObject({
  project: retrievalProjectIdentitySchema,
  availability: z.enum(['ready', 'not-built', 'root-changed', 'generation-unavailable']),
  active: retrievalGenerationSchema.optional(),
  previous: retrievalGenerationSchema.optional(),
  needsRebuild: z.boolean(),
  activeJob: retrievalJobSnapshotSchema.optional(),
});
export type RetrievalIndexStatus = z.infer<typeof retrievalIndexStatusSchema>;
export const retrievalQueryFiltersSchema = z
  .strictObject({
    sources: z.array(retrievalSourceKindSchema).min(1).max(2),
    paths: retrievalPathFiltersSchema,
  })
  .refine((value) => new Set(value.sources).size === value.sources.length);
export type RetrievalQueryFilters = z.infer<typeof retrievalQueryFiltersSchema>;
export const retrievalQueryIntentSchema = z.strictObject({
  query: text(512, 2_048),
  filters: retrievalQueryFiltersSchema,
  limit: z.number().int().min(1).max(10).default(10),
});
export type RetrievalQueryIntent = z.infer<typeof retrievalQueryIntentSchema>;
export const retrievalQueryInputSchema = z.strictObject({
  requestId: uuid,
  mode: retrievalModeSchema,
  intent: retrievalQueryIntentSchema,
});
export type RetrievalQueryInput = z.infer<typeof retrievalQueryInputSchema>;
// Separate Agent tool names fix actual mode; Agent does not submit request/project IDs.
export const retrievalAgentQueryInputSchema = retrievalQueryIntentSchema;
export const retrievalCitationSchema = z
  .strictObject({
    project: retrievalProjectIdentitySchema,
    generationId: uuid,
    source: retrievalSourceIdentitySchema,
    chunk: retrievalChunkIdentitySchema,
  })
  .superRefine((citation, ctx) => {
    if (
      !chunkMatchesSource(citation.chunk, citation.source) ||
      (citation.source.kind === 'memory' &&
        citation.source.ref.scope.kind === 'project' &&
        citation.source.ref.scope.projectId !== citation.project.projectId)
    )
      ctx.addIssue({ code: 'custom', message: 'Citation identities must agree' });
  });
export type RetrievalCitation = z.infer<typeof retrievalCitationSchema>;
export const retrievalHitSchema = z.strictObject({
  citation: retrievalCitationSchema,
  title: text(160, 640),
  excerpt: text(1_200, 1_200, { multiline: true }),
  lexicalRank: z.number().int().min(1).max(50).optional(),
  vectorRank: z.number().int().min(1).max(50).optional(),
  rrfScore: z.number().finite().positive().optional(),
  verifiedAt: timestamp,
});
export type RetrievalHit = z.infer<typeof retrievalHitSchema>;
export const retrievalQueryResultSchema = z
  .strictObject({
    requestId: uuid,
    actualMode: retrievalModeSchema,
    generation: retrievalGenerationSchema,
    filters: retrievalQueryFiltersSchema,
    hits: z.array(retrievalHitSchema).max(10),
    omitted: z.strictObject({ stale: counter, unavailable: counter, budget: counter }),
    truncated: z.boolean(),
    verifiedAt: timestamp,
  })
  .superRefine((result, ctx) => {
    if (result.actualMode === 'hybrid' && result.generation.mode !== 'hybrid')
      ctx.addIssue({ code: 'custom', message: 'Hybrid results require a hybrid generation' });
    if (
      result.hits.some(
        (hit) =>
          hit.citation.generationId !== result.generation.generationId ||
          !sameRetrievalProject(hit.citation.project, result.generation.project),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Hits must belong to the selected generation' });
    if (
      result.hits.some((hit) =>
        result.actualMode === 'lexical'
          ? hit.lexicalRank === undefined ||
            hit.vectorRank !== undefined ||
            hit.rrfScore !== undefined
          : hit.rrfScore === undefined ||
            (hit.lexicalRank === undefined && hit.vectorRank === undefined),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Ranks must match the actual search mode' });
    if (
      result.hits.some(
        ({ citation: { source } }) =>
          !result.filters.sources.includes(source.kind) ||
          (source.kind === 'workspace' && !retrievalPathMatches(source.path, result.filters.paths)),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Hits must satisfy the selected source filters' });
  })
  .refine(fitsResponse);
export type RetrievalQueryResult = z.infer<typeof retrievalQueryResultSchema>;
export const retrievalSourceInputSchema = z.strictObject({
  citation: retrievalCitationSchema,
  cursor: cursor.optional(),
});
export type RetrievalSourceInput = z.infer<typeof retrievalSourceInputSchema>;
export const retrievalSourceResultSchema = z
  .strictObject({
    citation: retrievalCitationSchema,
    page: retrievalTextPageSchema,
    verifiedAt: timestamp,
    // Data descriptors, never file:// URLs, absolute paths, or authority tokens.
    open: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('workspace'), path: retrievalPathSchema, line: positive }),
      z.strictObject({ kind: z.literal('memory'), ref: projectMemoryRefSchema }),
    ]),
  })
  .superRefine((result, ctx) => {
    const source = result.citation.source;
    if (
      !sameSource(source, result.page.source) ||
      source.kind !== result.open.kind ||
      (source.kind === 'workspace' &&
        result.open.kind === 'workspace' &&
        (source.path !== result.open.path ||
          result.citation.chunk.startLine !== result.open.line)) ||
      (source.kind === 'memory' &&
        result.open.kind === 'memory' &&
        !sameProjectMemoryRef(source.ref, result.open.ref))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Source page and open descriptor must agree with citation',
      });
  })
  .refine(fitsResponse);
export type RetrievalSourceResult = z.infer<typeof retrievalSourceResultSchema>;
export const retrievalCapabilitiesSchema = z.strictObject({
  lexical: z.discriminatedUnion('available', [
    z.strictObject({ available: z.literal(true) }),
    z.strictObject({ available: z.literal(false), reason: z.literal('fts5-unavailable') }),
  ]),
  embedding: z.discriminatedUnion('configured', [
    z.strictObject({ configured: z.literal(true), identity: retrievalVectorIdentitySchema }),
    z.strictObject({ configured: z.literal(false), reason: z.literal('not-configured') }),
  ]),
});
export type RetrievalCapabilities = z.infer<typeof retrievalCapabilitiesSchema>;
export const retrievalErrorCodeSchema = z.enum([
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
]);
export type RetrievalErrorCode = z.infer<typeof retrievalErrorCodeSchema>;
export const retrievalErrorResponseSchema = z.strictObject({
  error: z.strictObject({ code: retrievalErrorCodeSchema, message: text(240, 960) }),
});

// Pure data shared by the Runtime and the retrieval store.
// These values contain data only. Do not expose capture documents via a general
// HTTP endpoint: use guarded bounded preview/source text pages instead.
export const retrievalCapturedDocumentSchema = z
  .strictObject({
    source: retrievalSourceIdentitySchema,
    title: text(160, 640),
    lexicalMetadata: retrievalLexicalMetadataSchema,
    body: text(262_144, 262_144, { multiline: true }),
    capturedAt: timestamp,
  })
  .refine(
    (document) =>
      utf8Bytes(document.body) === document.source.sourceBytes &&
      (document.source.kind === 'memory' || document.lexicalMetadata.tags.length === 0),
  );
export type RetrievalCapturedDocument = z.infer<typeof retrievalCapturedDocumentSchema>;
export const retrievalPreparedChunkSchema = z
  .strictObject({
    identity: retrievalChunkIdentitySchema,
    text: text(2_048, 2_048, { multiline: true }),
    // Normalized body/title/path/tag auxiliary terms; never embedding input.
    terms: text(8_192, 32_768, { empty: true }),
  })
  .refine((chunk) => utf8Bytes(chunk.text) === chunk.identity.textBytes);
export type RetrievalPreparedChunk = z.infer<typeof retrievalPreparedChunkSchema>;
export interface RetrievalCaptureCoverageCounts {
  /** Actual listing entries observed, <=50k; not an estimated total beyond cap. */
  readonly discoveredFiles: number;
  /** Selection + source-cap admitted files, <=2k, before safety/size reads. */
  readonly selectedFiles: number;
  /** Every observed entry not captured; includes not-selected/system/cap skips. */
  readonly skippedFiles: number;
}
export const retrievalCaptureCoverageCountsSchema = z
  .strictObject({
    discoveredFiles: counter.max(retrievalLimits.maxDiscoveredFiles),
    selectedFiles: counter.max(retrievalLimits.maxFiles),
    skippedFiles: counter.max(retrievalLimits.maxDiscoveredFiles),
  })
  .refine(
    ({ discoveredFiles, selectedFiles, skippedFiles }) =>
      skippedFiles <= discoveredFiles &&
      selectedFiles <= discoveredFiles &&
      discoveredFiles - skippedFiles <= selectedFiles,
  );

const retrievalPreparedMetricsSchema = z.strictObject(preparedMetricsFields);
export type RetrievalPreparedMetrics = z.infer<typeof retrievalPreparedMetricsSchema>;
export interface RetrievalPreparedDocuments {
  readonly versions: RetrievalVersions;
  readonly sources: readonly RetrievalSourceSummary[];
  readonly chunks: readonly RetrievalPreparedChunk[];
  // Exact metrics of all input documents. No discovery/selection/skip estimates.
  readonly metrics: RetrievalPreparedMetrics;
}

function strictlyOrdered<T>(items: readonly T[], key: (item: T) => string): boolean {
  let previous: string | undefined;
  for (const item of items) {
    const current = key(item);
    if (previous !== undefined && compareRetrievalCodepoints(previous, current) >= 0) return false;
    previous = current;
  }
  return true;
}

const sortedPaths = (max: number) =>
  z
    .array(retrievalPathSchema)
    .max(max)
    .refine((paths) => strictlyOrdered(paths, (path) => path));
export const retrievalNormalizedSelectionSchema = z
  .strictObject({
    workspace: z.strictObject({
      enabled: z.boolean(),
      paths: z.strictObject({ include: sortedPaths(32), exclude: sortedPaths(32) }),
      selectedPaths: sortedPaths(retrievalLimits.maxFiles).optional(),
    }),
    memoryRefs: z
      .array(projectMemoryRefSchema)
      .max(retrievalLimits.maxMemoryRefs)
      .refine((refs) => strictlyOrdered(refs, (ref) => ref.memoryId)),
  })
  .superRefine(validateBuildSelection);

export interface RetrievalEmbeddingBatchDescription {
  readonly batch: number;
  readonly chunkIds: readonly string[];
  readonly inputDigests: readonly string[];
  readonly inputBytes: number;
  readonly requestBytes: number;
  readonly requestBodyDigest: string;
}

export const retrievalEmbeddingBatchDescriptionSchema = z
  .strictObject({
    batch: counter.max(retrievalLimits.maxChunks - 1),
    chunkIds: z.array(sha256).min(1).max(retrievalLimits.maxEmbeddingBatch),
    inputDigests: z.array(sha256).min(1).max(retrievalLimits.maxEmbeddingBatch),
    inputBytes: positive.max(retrievalLimits.maxEmbeddingBatch * retrievalLimits.maxChunkBytes),
    requestBytes: positive.max(retrievalLimits.maxEmbeddingRequestBytes),
    requestBodyDigest: sha256,
  })
  .refine(
    (batch) =>
      batch.chunkIds.length === batch.inputDigests.length &&
      new Set(batch.chunkIds).size === batch.chunkIds.length &&
      batch.requestBytes >= batch.inputBytes,
  );

export interface RetrievalManifest {
  readonly project: RetrievalProjectIdentity;
  readonly mode: RetrievalMode;
  readonly selection: RetrievalNormalizedSelection;
  readonly versions: RetrievalVersions;
  readonly sources: readonly RetrievalSourceSummary[];
  readonly chunks: readonly RetrievalPreparedChunk[];
  readonly counts: RetrievalCounts;
  readonly coverage: RetrievalCoverage;
  readonly embedding?:
    | {
        readonly identity: RetrievalVectorIdentity;
        readonly batches: readonly RetrievalEmbeddingBatchDescription[];
      }
    | undefined;
  readonly manifestDigest: string;
}

function manifestSelectionMatches(manifest: RetrievalManifest): boolean {
  const { sources, project, selection, coverage, counts } = manifest;
  const { workspace, memoryRefs } = selection;
  if (workspace.enabled === (coverage.discovery === 'memory-only')) return false;
  if (workspace.selectedPaths && counts.selected - counts.memories > workspace.selectedPaths.length)
    return false;
  const selectedPaths = workspace.selectedPaths && new Set(workspace.selectedPaths);
  const expectedRefs = new Map(memoryRefs.map((ref) => [ref.memoryId, ref]));
  for (const { source } of sources) {
    if (source.kind === 'workspace') {
      if (
        !workspace.enabled ||
        !retrievalPathMatches(source.path, workspace.paths) ||
        (selectedPaths && !selectedPaths.has(source.path))
      )
        return false;
    } else {
      const expected = expectedRefs.get(source.ref.memoryId);
      if (
        !expected ||
        !sameProjectMemoryRef(source.ref, expected) ||
        source.ref.scope.kind !== 'project' ||
        source.ref.scope.projectId !== project.projectId
      )
        return false;
      expectedRefs.delete(source.ref.memoryId);
    }
  }
  return expectedRefs.size === 0;
}

function preparedContentsMatch({
  sources,
  chunks,
  metrics,
  versions,
}: RetrievalPreparedDocuments): boolean {
  if (!strictlyOrdered(sources, (summary) => summary.source.sourceKey)) return false;

  const chunkIds = new Set<string>();
  let files = 0;
  let captureBytes = 0;
  let chunkTextBytes = 0;
  let chunkIndex = 0;
  for (const { source, chunkCount } of sources) {
    if (source.kind === 'workspace') files++;
    if (chunkCount === 0) return false;
    captureBytes += source.sourceBytes;
    for (let ordinal = 0; ordinal < chunkCount; ordinal++, chunkIndex++) {
      const chunk = chunks[chunkIndex]?.identity;
      if (
        !chunk ||
        chunkIds.has(chunk.chunkId) ||
        chunk.ordinal !== ordinal ||
        chunk.chunkerVersion !== versions.chunker ||
        !chunkMatchesSource(chunk, source)
      )
        return false;
      chunkIds.add(chunk.chunkId);
      chunkTextBytes += chunk.textBytes;
    }
  }
  return (
    metrics.files === files &&
    metrics.memories === sources.length - files &&
    metrics.sources === sources.length &&
    metrics.captureBytes === captureBytes &&
    metrics.chunks === chunks.length &&
    chunkIndex === chunks.length &&
    metrics.chunkTextBytes === chunkTextBytes
  );
}

const preparedContentsFields = {
  versions: retrievalVersionsSchema,
  sources: z.array(retrievalSourceSummarySchema).max(retrievalLimits.maxSources),
  chunks: z.array(retrievalPreparedChunkSchema).max(retrievalLimits.maxChunks),
};
export const retrievalPreparedDocumentsSchema = z
  .strictObject({
    ...preparedContentsFields,
    metrics: retrievalPreparedMetricsSchema,
  })
  .refine(preparedContentsMatch, 'Source order, chunk identities and aggregate metrics must agree');

function manifestBatchesMatch(manifest: RetrievalManifest): boolean {
  if (manifest.mode === 'lexical') return manifest.embedding === undefined;
  if (!manifest.embedding) return false;
  let chunkIndex = 0;
  for (const [index, batch] of manifest.embedding.batches.entries()) {
    if (batch.batch !== index) return false;
    let bytes = 0;
    for (const [offset, chunkId] of batch.chunkIds.entries()) {
      const chunk = manifest.chunks[chunkIndex++]?.identity;
      if (!chunk || chunk.chunkId !== chunkId || chunk.textSha256 !== batch.inputDigests[offset])
        return false;
      bytes += chunk.textBytes;
    }
    if (bytes !== batch.inputBytes) return false;
  }
  return chunkIndex === manifest.chunks.length;
}

export const retrievalManifestSchema = z
  .strictObject({
    project: retrievalProjectIdentitySchema,
    mode: retrievalModeSchema,
    selection: retrievalNormalizedSelectionSchema,
    ...preparedContentsFields,
    counts: retrievalCountsSchema,
    coverage: retrievalCoverageSchema,
    embedding: z
      .strictObject({
        identity: retrievalVectorIdentitySchema,
        batches: z
          .array(retrievalEmbeddingBatchDescriptionSchema)
          .min(1)
          .max(retrievalLimits.maxChunks),
      })
      .optional(),
    manifestDigest: sha256,
  })
  .superRefine((manifest, ctx) => {
    if (!manifestSelectionMatches(manifest))
      ctx.addIssue({
        code: 'custom',
        path: ['selection'],
        message: 'Sources must satisfy the exact project selection',
      });
    if (!preparedContentsMatch({ ...manifest, metrics: manifest.counts }))
      ctx.addIssue({
        code: 'custom',
        path: ['chunks'],
        message: 'Source order, chunk identities and aggregate metrics must agree',
      });
    if (!coverageMatchesCounts(manifest.coverage, manifest.counts))
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'Coverage must account for every skipped source',
      });
    if (!manifestBatchesMatch(manifest))
      ctx.addIssue({
        code: 'custom',
        path: ['embedding'],
        message: 'Embedding batches must match mode and ordered chunks',
      });
  });

export interface EmbeddingVector {
  readonly id: string;
  readonly values: readonly number[];
  readonly sha256: string;
}
export interface RetrievalUnitVector {
  readonly chunkId: string;
  readonly values: readonly number[];
  readonly sha256: string;
}
const unitFloat32Vector = z
  .array(z.number().min(-1).max(1))
  .length(retrievalLimits.embeddingDimensions)
  .refine(
    (values) =>
      Math.abs(values.reduce((squares, value) => squares + value * value, 0) - 1) <= 1e-6 &&
      values.every((value) => !Object.is(value, -0) && Math.fround(value) === value),
  );
export const retrievalUnitVectorSchema = z.strictObject({
  chunkId: sha256,
  values: unitFloat32Vector,
  sha256,
});

export interface RetrievalRankedCandidate {
  readonly source: RetrievalSourceIdentity;
  readonly title: string;
  readonly chunk: RetrievalChunkIdentity;
  readonly text: string;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly rrfScore?: number;
}

export const retrievalRequestKeySchema = z.strictObject({
  requestId: uuid,
  // Agent keys can contain JSON-escaped invocation identifiers.
  callerKey: text(5_800, 5_800),
  requestDigest: sha256,
  projectId: uuid,
});
export type RetrievalRequestKey = z.infer<typeof retrievalRequestKeySchema>;

export const retrievalAcceptMutationSchema = z
  .strictObject({
    key: retrievalRequestKeySchema,
    jobId: uuid,
    project: retrievalProjectIdentitySchema,
    manifestDigest: sha256,
    mode: retrievalModeSchema,
    provenance: retrievalProvenanceSchema,
    counts: retrievalCountsSchema,
    vectorIdentity: retrievalVectorIdentitySchema.optional(),
  })
  .refine(
    (mutation) =>
      mutation.key.projectId === mutation.project.projectId &&
      (mutation.provenance.actor === 'local-user') === (mutation.key.callerKey === 'local-user') &&
      (mutation.mode === 'hybrid') === (mutation.vectorIdentity !== undefined),
  );
export type RetrievalAcceptMutation = z.infer<typeof retrievalAcceptMutationSchema>;

export const retrievalJobOperationKeySchema = z.strictObject({
  jobId: uuid,
  operationId: uuid,
  operation: z.enum(['started', 'finished']),
  digest: sha256,
});
export type RetrievalJobOperationKey = z.infer<typeof retrievalJobOperationKeySchema>;

export const retrievalJobOperationReceiptSchema = z
  .strictObject({
    key: retrievalJobOperationKeySchema,
    sequence: positive,
    occurredAt: timestamp,
    terminal: retrievalTerminalSchema.optional(),
  })
  .refine(
    (receipt) =>
      (receipt.key.operation === 'finished') === (receipt.terminal !== undefined) &&
      (receipt.terminal?.status !== 'completed' ||
        receipt.terminal.generation.jobId === receipt.key.jobId),
  );
export type RetrievalJobOperationReceipt = z.infer<typeof retrievalJobOperationReceiptSchema>;

const eventFields = {
  version: z.literal(1),
  eventId: uuid,
  sequence: positive,
  occurredAt: timestamp,
};
export const retrievalJobEventSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...eventFields,
      kind: z.literal('accepted'),
      mutation: retrievalAcceptMutationSchema,
      receipt: retrievalReceiptSchema,
    }),
    z.strictObject({
      ...eventFields,
      kind: z.literal('started'),
      receipt: retrievalJobOperationReceiptSchema,
    }),
    z.strictObject({
      ...eventFields,
      kind: z.literal('finished'),
      receipt: retrievalJobOperationReceiptSchema,
    }),
  ])
  .superRefine((event, ctx) => {
    if (event.kind === 'accepted') {
      const { mutation, receipt } = event;
      if (
        receipt.acceptedSequence === event.sequence &&
        receipt.jobId === mutation.jobId &&
        receipt.requestId === mutation.key.requestId &&
        receipt.requestDigest === mutation.key.requestDigest &&
        receipt.manifestDigest === mutation.manifestDigest &&
        sameRetrievalProject(receipt.project, mutation.project)
      )
        return;
    } else if (
      event.sequence === event.receipt.sequence &&
      event.occurredAt === event.receipt.occurredAt &&
      event.kind === event.receipt.key.operation
    ) {
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['receipt'],
      message: 'Receipt must match the event identity and operation',
    });
  });
export type RetrievalJobEvent = z.infer<typeof retrievalJobEventSchema>;
