import { expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const projectId = '75d86c91-3331-4fe3-b261-eaccedfae5a1';
const otherId = '091267f1-baff-4438-b72e-a799cb54d199';
const jobId = '08497d5d-cb50-4769-aed7-36ba2bd7cf38';
const digest = 'a'.repeat(64);
const secondDigest = 'b'.repeat(64);
const time = '2026-11-23T00:00:00.000Z';
const project = { projectId, folderRevision: 1, rootDigest: digest };
const versions = {
  chunker: 'weave.line-chunks.v1',
  tokenizer: 'weave.identifier-han.v1',
  discovery: 'weave.discovery.v1',
  manifest: 'weave.retrieval-manifest.v1',
};
const vectorIdentity = {
  provider: 'openai',
  endpointId: 'openai.embeddings.v1',
  destination: 'api.openai.com',
  model: 'text-embedding-3-small',
  dimensions: 512,
  adapterVersion: 'weave.openai-embedding.v1',
};
const ref = {
  memoryId: otherId,
  revision: 2,
  sha256: secondDigest,
  scope: { kind: 'project', projectId },
};
const memory = {
  kind: 'memory',
  sourceKey: `memory:${otherId}`,
  ref,
  sourceSha256: digest,
  sourceBytes: 3,
};
const workspace = {
  kind: 'workspace',
  sourceKey: 'workspace:src/a.ts',
  path: 'src/a.ts',
  sourceSha256: digest,
  sourceBytes: 3,
  fileObjectDigest: digest,
};
const sources = [
  {
    source: memory,
    title: 'Memory',
    lexicalMetadata: { tags: ['tag'] },
    chunkCount: 1,
    capturedAt: time,
  },
  {
    source: workspace,
    title: 'a.ts',
    lexicalMetadata: { tags: [] },
    chunkCount: 1,
    capturedAt: time,
  },
];
const makeChunk = (sourceKey: string, chunkId: string) => ({
  identity: {
    chunkId,
    sourceKey,
    sourceSha256: digest,
    ordinal: 0,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 3,
    textSha256: digest,
    textBytes: 3,
    chunkerVersion: versions.chunker,
  },
  text: 'abc',
  terms: 'abc',
});
const chunks = [makeChunk(memory.sourceKey, digest), makeChunk(workspace.sourceKey, secondDigest)];
const selection = {
  workspace: {
    enabled: true,
    paths: { include: ['src'], exclude: [] },
    selectedPaths: ['src/a.ts'],
  },
  memoryRefs: [ref],
};
const counts = {
  discovered: 3,
  selected: 2,
  files: 1,
  memories: 1,
  sources: 2,
  captureBytes: 6,
  chunks: 2,
  chunkTextBytes: 6,
  skipped: 1,
};
const coverage = {
  discovery: 'git',
  truncated: false,
  skippedDetailsTruncated: true,
  skipCounts: [{ reason: 'unsafe-file', count: 1 }],
};
const manifest = {
  project,
  mode: 'lexical',
  selection,
  versions,
  sources,
  chunks,
  counts,
  coverage,
  manifestDigest: digest,
};
const batch = {
  batch: 0,
  chunkIds: [digest, secondDigest],
  inputDigests: [digest, digest],
  inputBytes: 6,
  requestBytes: 96,
  requestBodyDigest: digest,
};
const hybrid = {
  ...manifest,
  mode: 'hybrid',
  embedding: { identity: vectorIdentity, batches: [batch] },
};
const key = { requestId: projectId, callerKey: 'local-user', requestDigest: digest, projectId };
const mutation = {
  key,
  jobId,
  project,
  manifestDigest: secondDigest,
  mode: 'lexical',
  provenance: { actor: 'local-user' },
  counts,
};
const receipt = {
  operation: 'retrieval.index',
  requestId: projectId,
  requestDigest: digest,
  jobId,
  acceptedSequence: 7,
  project,
  manifestDigest: secondDigest,
};

it('normalizes prefix and exact selection order by Unicode code point', () => {
  const { normalizeRetrievalSelection } = protocol;
  expect(normalizeRetrievalSelection).toBeDefined();
  const raw = protocol.retrievalBuildIntentSchema.parse({
    mode: 'lexical',
    workspace: {
      paths: { include: ['𐀀', 'Ａ', 'Ａ', 'a'], exclude: ['b', 'a'] },
      selectedPaths: [],
    },
    memoryRefs: [{ ...ref, memoryId: projectId }, ref],
  });
  expect(normalizeRetrievalSelection(raw)).toEqual({
    workspace: {
      enabled: true,
      paths: { include: ['a', 'Ａ', '𐀀'], exclude: ['a', 'b'] },
      selectedPaths: [],
    },
    memoryRefs: [ref, { ...ref, memoryId: projectId }],
  });
  expect(
    normalizeRetrievalSelection({
      ...raw,
      workspace: { enabled: true, paths: raw.workspace.paths },
    }).workspace,
  ).not.toHaveProperty('selectedPaths');
});

it('rejects out-of-scope or unselected sources and preserves complete skip counts', () => {
  const { retrievalManifestSchema: schema } = protocol;
  expect(schema).toBeDefined();
  expect(schema.safeParse(manifest).success).toBe(true);
  for (const invalid of [
    { ...manifest, project: { ...project, projectId: otherId } },
    { ...manifest, selection: { ...selection, memoryRefs: [{ ...ref, revision: 1 }] } },
    {
      ...manifest,
      selection: { ...selection, workspace: { ...selection.workspace, selectedPaths: [] } },
    },
    {
      ...manifest,
      selection: {
        ...selection,
        workspace: { ...selection.workspace, paths: { include: ['src', 'src'], exclude: [] } },
      },
    },
    {
      ...manifest,
      selection: {
        ...selection,
        workspace: { ...selection.workspace, paths: { include: [], exclude: ['src'] } },
      },
    },
    { ...manifest, coverage: { ...coverage, skipCounts: [] } },
    { ...manifest, coverage: { ...coverage, discovery: 'memory-only' } },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
});

it('checks ordered unique sources and chunks, contiguous ordinals and exact aggregate metrics', () => {
  const { retrievalManifestSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const [firstSource, secondSource] = sources;
  const [firstChunk, secondChunk] = chunks;
  for (const invalid of [
    { ...manifest, sources: [secondSource, firstSource] },
    { ...manifest, sources: [firstSource, firstSource] },
    { ...manifest, sources: [firstSource, { ...secondSource, chunkCount: 0 }] },
    { ...manifest, chunks: [secondChunk, firstChunk] },
    {
      ...manifest,
      chunks: [
        firstChunk,
        { ...secondChunk!, identity: { ...secondChunk!.identity, chunkId: digest } },
      ],
    },
    {
      ...manifest,
      chunks: [firstChunk, { ...secondChunk!, identity: { ...secondChunk!.identity, ordinal: 1 } }],
    },
    {
      ...manifest,
      chunks: [
        firstChunk,
        { ...secondChunk!, identity: { ...secondChunk!.identity, sourceSha256: secondDigest } },
      ],
    },
    { ...manifest, counts: { ...counts, captureBytes: 7 } },
    { ...manifest, counts: { ...counts, chunkTextBytes: 7 } },
    { ...manifest, versions: { ...versions, manifest: 'weave.retrieval-manifest.v2' } },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
});

it('binds hybrid batches to the exact ordered manifest chunk IDs, digests and byte counts', () => {
  const { retrievalManifestSchema: schema } = protocol;
  expect(schema).toBeDefined();
  expect(schema.safeParse(hybrid).success).toBe(true);
  expect(schema.safeParse({ ...manifest, mode: 'hybrid' }).success).toBe(false);
  expect(schema.safeParse({ ...hybrid, mode: 'lexical' }).success).toBe(false);
  const invalidBatches = [
    [],
    [{ ...batch, batch: 1 }],
    [{ ...batch, chunkIds: [secondDigest, digest] }],
    [{ ...batch, inputDigests: [digest, secondDigest] }],
    [{ ...batch, inputBytes: 5 }],
    [{ ...batch, requestBytes: 40_961 }],
    [{ ...batch, requestBodyDigest: 'unknown' }],
  ];
  for (const batches of invalidBatches)
    expect(
      schema.safeParse({ ...hybrid, embedding: { identity: vectorIdentity, batches } }).success,
    ).toBe(false);
});

it('validates exact source bytes and canonical lexical metadata within captured documents', () => {
  const { retrievalCapturedDocumentSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const document = {
    source: memory,
    title: 'Memory',
    lexicalMetadata: { tags: ['tag'] },
    capturedAt: time,
    body: 'abc',
  };
  expect(schema.safeParse(document).success).toBe(true);
  for (const invalid of [
    { ...document, body: '😀' },
    { ...document, lexicalMetadata: { tags: ['tag', 'ＴＡＧ'] } },
    { ...document, lexicalMetadata: { tags: ['😀'.repeat(41)] } },
    { ...document, source: workspace },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
});

it('rejects inconsistent capture counters and prepared metrics at the structural ports', () => {
  const { retrievalCaptureCoverageCountsSchema, retrievalPreparedDocumentsSchema } = protocol;
  expect(retrievalCaptureCoverageCountsSchema).toBeDefined();
  expect(retrievalPreparedDocumentsSchema).toBeDefined();
  expect(
    retrievalCaptureCoverageCountsSchema.safeParse({
      discoveredFiles: 5,
      selectedFiles: 2,
      skippedFiles: 4,
    }).success,
  ).toBe(true);
  expect(
    retrievalCaptureCoverageCountsSchema.safeParse({
      discoveredFiles: 5,
      selectedFiles: 2,
      skippedFiles: 2,
    }).success,
  ).toBe(false);
  expect(
    retrievalCaptureCoverageCountsSchema.safeParse({
      discoveredFiles: 5,
      selectedFiles: 2,
      skippedFiles: 6,
    }).success,
  ).toBe(false);
  const metrics = {
    files: 1,
    memories: 1,
    sources: 2,
    captureBytes: 6,
    chunks: 2,
    chunkTextBytes: 6,
  };
  const prepared = { versions, sources, chunks, metrics };
  expect(retrievalPreparedDocumentsSchema.safeParse(prepared).success).toBe(true);
  expect(
    retrievalPreparedDocumentsSchema.safeParse({
      ...prepared,
      metrics: { ...metrics, captureBytes: 7 },
    }).success,
  ).toBe(false);
  expect(retrievalPreparedDocumentsSchema.safeParse({ ...prepared, metrics: counts }).success).toBe(
    false,
  );
});

it('requires canonical Float32 unit vectors for staged chunks', () => {
  const { retrievalUnitVectorSchema: schema } = protocol;
  const values = [1, ...Array<number>(511).fill(0)];
  const vector = { chunkId: digest, sha256: secondDigest, values };
  expect(schema.safeParse(vector).success).toBe(true);
  for (const invalid of [
    values.slice(1),
    values.slice(0, -1),
    [-0, ...values.slice(0, -1)],
    [NaN, ...values.slice(1)],
    [0.999999999, ...values.slice(1)],
    [0.5, ...values.slice(1)],
  ]) {
    expect(schema.safeParse({ ...vector, values: invalid }).success).toBe(false);
  }
});

it('agrees on accepted event identity, request, project, sequence and manifest digest', () => {
  const { retrievalJobEventSchema: schema, retrievalAcceptMutationSchema } = protocol;
  expect(schema).toBeDefined();
  const event = {
    version: 1,
    eventId: otherId,
    sequence: 7,
    occurredAt: time,
    kind: 'accepted',
    mutation,
    receipt,
  };
  expect(
    schema.safeParse({
      ...event,
      receipt: { ...receipt, project: { rootDigest: digest, projectId, folderRevision: 1 } },
    }).success,
  ).toBe(true);
  for (const invalid of [
    { ...event, version: 2 },
    { ...event, rawError: 'external text' },
    { ...event, sequence: 8 },
    { ...event, receipt: { ...receipt, requestDigest: secondDigest } },
    { ...event, receipt: { ...receipt, requestId: otherId } },
    { ...event, receipt: { ...receipt, jobId: otherId } },
    { ...event, receipt: { ...receipt, project: { ...project, folderRevision: 2 } } },
    { ...event, receipt: { ...receipt, manifestDigest: digest } },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
  expect(
    retrievalAcceptMutationSchema.safeParse({ ...mutation, key: { ...key, projectId: otherId } })
      .success,
  ).toBe(false);
  expect(retrievalAcceptMutationSchema.safeParse({ ...mutation, mode: 'hybrid' }).success).toBe(
    false,
  );
  expect(retrievalAcceptMutationSchema.safeParse({ ...mutation, vectorIdentity }).success).toBe(
    false,
  );
});

it('enforces operation, chronology and terminal coherence in started and finished events', () => {
  const { retrievalJobEventSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const operation = {
    key: { jobId, operationId: otherId, operation: 'started', digest },
    sequence: 8,
    occurredAt: time,
  };
  const started = {
    version: 1,
    eventId: otherId,
    sequence: 8,
    occurredAt: time,
    kind: 'started',
    receipt: operation,
  };
  const finished = {
    ...started,
    kind: 'finished',
    receipt: {
      ...operation,
      key: { ...operation.key, operation: 'finished' },
      terminal: { status: 'interrupted', reason: 'server-restart' },
    },
  };
  expect(schema.safeParse(started).success).toBe(true);
  expect(schema.safeParse(finished).success).toBe(true);
  const generation = {
    generationId: otherId,
    jobId,
    project,
    manifestDigest: digest,
    versions,
    mode: 'lexical',
    indexedAt: time,
    counts,
  };
  const completed = {
    ...finished,
    receipt: { ...finished.receipt, terminal: { status: 'completed', generation } },
  };
  expect(schema.safeParse(completed).success).toBe(true);
  for (const invalid of [
    { ...started, receipt: finished.receipt },
    { ...started, receipt: { ...operation, terminal: finished.receipt.terminal } },
    { ...started, occurredAt: '2026-11-24T00:00:00.000Z' },
    { ...finished, receipt: { ...operation, key: finished.receipt.key } },
    {
      ...completed,
      receipt: {
        ...completed.receipt,
        terminal: { status: 'completed', generation: { ...generation, jobId: otherId } },
      },
    },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
});
