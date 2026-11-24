import { expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const id = '75d86c91-3331-4fe3-b261-eaccedfae5a1';
const jobId = '091267f1-baff-4438-b72e-a799cb54d199';
const digest = 'a'.repeat(64);
const time = '2026-11-23T00:00:00.000Z';
const project = { projectId: id, folderRevision: 1, rootDigest: digest };
const versions = {
  chunker: 'weave.line-chunks.v1',
  tokenizer: 'weave.identifier-han.v1',
  discovery: 'weave.discovery.v1',
  manifest: 'weave.retrieval-manifest.v1',
};
const counts = {
  discovered: 2,
  selected: 1,
  files: 1,
  memories: 0,
  sources: 1,
  captureBytes: 8,
  chunks: 1,
  chunkTextBytes: 8,
  skipped: 1,
};
const source = {
  kind: 'workspace',
  sourceKey: 'workspace:src/a.ts',
  path: 'src/a.ts',
  sourceSha256: digest,
  sourceBytes: 8,
  fileObjectDigest: digest,
};
const chunk = {
  sourceKey: source.sourceKey,
  sourceSha256: digest,
  chunkId: digest,
  ordinal: 0,
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 8,
  textSha256: digest,
  textBytes: 8,
  chunkerVersion: versions.chunker,
};

it('requires build mode and rejects caller-controlled authority or destination fields', () => {
  const { retrievalBuildInputSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const base = { requestId: id, previewId: id, manifestDigest: digest };
  const request = { ...base, mode: 'lexical' };
  expect(schema.safeParse(request).success).toBe(true);
  for (const invalid of [
    base,
    { ...request, mode: 'semantic' },
    { ...request, vectors: [] },
    { ...request, providerUrl: 'https://example.com' },
    { ...request, actor: 'local-user' },
    { ...request, projectId: id },
    { ...request, manifestDigest: digest.toUpperCase() },
    { ...request, requestId: 'browser' },
  ]) {
    expect(schema.safeParse(invalid).success).toBe(false);
  }
});

it('preserves exact file selection and rejects non-relative or ambiguous paths', () => {
  const { retrievalBuildIntentSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const workspace = { paths: {}, selectedPaths: [] };
  const intent = { mode: 'lexical', workspace };
  expect(schema.parse(intent)).toEqual({
    mode: 'lexical',
    workspace: { enabled: true, paths: { include: [], exclude: [] }, selectedPaths: [] },
    memoryRefs: [],
  });
  expect(
    schema.parse({ ...intent, workspace: { paths: {} } }).workspace.selectedPaths,
  ).toBeUndefined();
  for (const selectedPaths of [
    ['/src/a.ts'],
    ['C:/a.ts'],
    ['src/../a.ts'],
    ['src//a.ts'],
    ['src\\a.ts'],
    ['a.ts', 'a.ts'],
    Array.from({ length: 2_001 }, (_, n) => `src/${n}.ts`),
  ]) {
    expect(
      schema.safeParse({ ...intent, workspace: { ...workspace, selectedPaths } }).success,
    ).toBe(false);
  }
  expect(
    schema.safeParse({
      ...intent,
      memoryRefs: [{ memoryId: id, revision: 1, sha256: digest, scope: { kind: 'user' } }],
    }).success,
  ).toBe(false);
});

it('bounds query by Unicode code points and rejects control characters and lone surrogates', () => {
  const { retrievalQueryIntentSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const filters = { sources: ['workspace'], paths: {} };
  expect(schema.parse({ query: '😀'.repeat(512), filters }).limit).toBe(10);
  for (const query of ['😀'.repeat(513), 'x'.repeat(513), '', 'x\0', 'x\n', '\ud800', '\udfff']) {
    expect(schema.safeParse({ query, filters }).success).toBe(false);
  }
  expect(
    schema.safeParse({ query: 'query', filters: { ...filters, sources: ['memory', 'memory'] } })
      .success,
  ).toBe(false);
});

it('keeps long source identity distinct from its display title and validates citation boundaries', () => {
  const { retrievalSourceSummarySchema, retrievalCitationSchema } = protocol;
  expect(retrievalCitationSchema).toBeDefined();
  const path = `src/${'长'.repeat(1000)}.ts`;
  const longSource = { ...source, path, sourceKey: `workspace:${path}` };
  const summary = {
    source: longSource,
    title: '长'.repeat(160),
    lexicalMetadata: { tags: [] },
    chunkCount: 1,
    capturedAt: time,
  };
  expect(retrievalSourceSummarySchema.parse(summary).source).toEqual(longSource);
  expect(
    retrievalSourceSummarySchema.safeParse({ ...summary, lexicalMetadata: { tags: ['a'] } })
      .success,
  ).toBe(false);
  const citation = { project, generationId: id, source, chunk };
  expect(retrievalCitationSchema.safeParse(citation).success).toBe(true);
  for (const badChunk of [
    { ...chunk, endColumn: 0 },
    { ...chunk, endLine: 81 },
    { ...chunk, textBytes: 9 },
    { ...chunk, sourceSha256: 'b'.repeat(64) },
  ]) {
    expect(retrievalCitationSchema.safeParse({ ...citation, chunk: badChunk }).success).toBe(false);
  }
});

it('checks preview mode, embedding counts and complete skip coverage', () => {
  const { retrievalPreviewSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const preview = {
    previewId: id,
    requestId: id,
    project,
    manifestDigest: digest,
    mode: 'lexical',
    versions,
    counts,
    createdAt: time,
    expiresAt: '2026-11-23T00:05:00.000Z',
    coverage: {
      discovery: 'git',
      truncated: false,
      skippedDetailsTruncated: true,
      skipCounts: [{ reason: 'unsafe-file', count: 1 }],
    },
  };
  expect(schema.safeParse(preview).success).toBe(true);
  expect(schema.safeParse({ ...preview, mode: 'hybrid' }).success).toBe(false);
  expect(
    schema.safeParse({ ...preview, coverage: { ...preview.coverage, skipCounts: [] } }).success,
  ).toBe(false);
  expect(schema.safeParse({ ...preview, counts: { ...counts, selected: 0 } }).success).toBe(false);
});

it('keeps lexical results valid on hybrid generations and rejects spoofed ranks, citations and filters', () => {
  const { retrievalQueryResultSchema: schema } = protocol;
  expect(schema).toBeDefined();
  const generation = {
    generationId: id,
    jobId,
    project,
    manifestDigest: digest,
    versions,
    mode: 'hybrid',
    indexedAt: time,
    counts,
    vectorIdentity: {
      provider: 'openai',
      endpointId: 'openai.embeddings.v1',
      destination: 'api.openai.com',
      model: 'text-embedding-3-small',
      dimensions: 512,
      adapterVersion: 'weave.openai-embedding.v1',
    },
  };
  const hit = {
    citation: {
      project: { rootDigest: digest, folderRevision: 1, projectId: id },
      generationId: id,
      source,
      chunk,
    },
    title: 'a.ts',
    excerpt: 'a b',
    lexicalRank: 1,
    verifiedAt: time,
  };
  const result = {
    requestId: id,
    actualMode: 'lexical',
    generation,
    filters: { sources: ['workspace'], paths: { include: ['src'], exclude: [] } },
    hits: [hit],
    omitted: { stale: 0, unavailable: 0, budget: 0 },
    truncated: false,
    verifiedAt: time,
  };
  expect(schema.safeParse(result).success).toBe(true);
  for (const invalid of [
    { ...result, actualMode: 'hybrid' },
    { ...result, hits: [{ ...hit, vectorRank: 1 }] },
    { ...result, hits: [{ ...hit, citation: { ...hit.citation, generationId: jobId } }] },
    { ...result, filters: { ...result.filters, paths: { include: ['sr'], exclude: [] } } },
    { ...result, filters: { ...result.filters, sources: ['memory'] } },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
});

it('keeps pages forward-moving and enforces the full JSON envelope byte cap', () => {
  const { retrievalTextPageSchema: schema, retrievalSourceResultSchema } = protocol;
  expect(schema).toBeDefined();
  const page = { source, offset: 0, text: '', eof: false, nextCursor: 'next' };
  expect(schema.safeParse(page).success).toBe(false);
  expect(schema.safeParse({ ...page, text: 'a' }).success).toBe(true);
  const path = `src/${'"'.repeat(1020)}`;
  const longSource = { ...source, path, sourceKey: `workspace:${path}`, sourceBytes: 8_192 };
  const result = {
    citation: {
      project,
      generationId: id,
      source: longSource,
      chunk: { ...chunk, sourceKey: longSource.sourceKey },
    },
    page: { source: longSource, offset: 0, text: '\n'.repeat(8_192), eof: true },
    open: { kind: 'workspace', path, line: 1 },
    verifiedAt: time,
  };
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(24_576);
  expect(retrievalSourceResultSchema.safeParse(result).success).toBe(false);
});
