import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { retrievalLimits } from '@weave/protocol';
import { createSqliteRetrievalIndex } from '../dist/index.js';

const { AbortController } = globalThis;

// The vectors in this benchmark are deterministic test inputs for timing and ranking.
const count = process.argv.includes('--smoke') ? 20 : retrievalLimits.maxChunks;
const trials = process.argv.includes('--smoke') ? 2 : 20;
const directory = mkdtempSync(join(tmpdir(), 'weave-retrieval-benchmark-'));
const filename = join(directory, 'index.sqlite');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const guard = {
  assertAuthorizedSync() {},
  assertNewMutationSync() {},
  assertCurrentSync() {},
  assertPublishCurrentSync() {},
};
const embeddingIdentity = {
  provider: 'openai',
  endpointId: 'openai.embeddings.v1',
  destination: 'api.openai.com',
  model: 'text-embedding-3-small',
  dimensions: retrievalLimits.embeddingDimensions,
  adapterVersion: 'weave.openai-embedding.v1',
};
const project = { projectId: randomUUID(), folderRevision: 1, rootDigest: digest('root') };
const values = Array.from({ length: retrievalLimits.embeddingDimensions }, (_, i) =>
  Number(i === 0),
);
const vectorData = Buffer.alloc(values.length * 4);
vectorData.writeFloatLE(1);
const vectorDigest = digest(vectorData);
const filters = { sources: ['workspace'], paths: { include: ['src'], exclude: [] } };

function build(store) {
  const started = performance.now();
  const files = Math.min(200, count);
  const docs = Array.from({ length: files }, (_, index) => {
    const path = `src/file-${String(index).padStart(3, '0')}.ts`;
    // First chunk has 80 lines, then each subsequent one overlaps by 8 lines.
    const body = `lookupNeedle\n${'x\n'.repeat(71)}`.repeat(count / files) + 'x\n'.repeat(8);
    return {
      source: {
        kind: 'workspace',
        sourceKey: `workspace:${path}`,
        path,
        sourceSha256: digest(body),
        sourceBytes: Buffer.byteLength(body),
        fileObjectDigest: digest(path),
      },
      title: path,
      lexicalMetadata: { tags: [] },
      body,
      capturedAt: '2026-11-23T00:00:00.000Z',
    };
  });
  const prepared = store.prepareDocuments(docs);
  assert.equal(prepared.chunks.length, count);
  const counts = { ...prepared.metrics, discovered: files, selected: files, skipped: 0 };
  const batches = [];
  for (let index = 0; index < prepared.chunks.length; index += retrievalLimits.maxEmbeddingBatch) {
    const chunks = prepared.chunks.slice(index, index + retrievalLimits.maxEmbeddingBatch);
    const request = JSON.stringify({
      model: embeddingIdentity.model,
      input: chunks.map(({ text }) => text),
      dimensions: embeddingIdentity.dimensions,
      encoding_format: 'float',
    });
    batches.push({
      batch: batches.length,
      chunkIds: chunks.map(({ identity }) => identity.chunkId),
      inputDigests: chunks.map(({ identity }) => identity.textSha256),
      inputBytes: chunks.reduce((sum, { identity }) => sum + identity.textBytes, 0),
      requestBytes: Buffer.byteLength(request),
      requestBodyDigest: digest(request),
    });
  }
  const input = {
    mode: 'hybrid',
    project,
    selection: {
      workspace: { enabled: true, paths: { include: [], exclude: [] } },
      memoryRefs: [],
    },
    counts,
    coverage: {
      discovery: 'walk',
      truncated: false,
      skippedDetailsTruncated: false,
      skipCounts: [],
    },
    versions: prepared.versions,
    sources: prepared.sources,
    chunks: prepared.chunks,
    embedding: { identity: embeddingIdentity, batches },
  };
  const manifest = { ...input, manifestDigest: store.manifestDigest(input) };
  const jobId = randomUUID();
  const generationId = randomUUID();
  const key = {
    requestId: randomUUID(),
    callerKey: 'local-user',
    requestDigest: digest('request'),
    projectId: project.projectId,
  };
  const operation = (operation) => ({
    key: { jobId, operationId: randomUUID(), operation, digest: digest(operation) },
  });
  const receipt = store.accept(
    {
      key,
      jobId,
      project,
      manifestDigest: manifest.manifestDigest,
      mode: 'hybrid',
      provenance: { actor: 'local-user' },
      counts,
      vectorIdentity: embeddingIdentity,
    },
    guard,
  );
  store.markStarted(operation('started'), guard);
  const stage = store.beginStage({ jobId, generationId, manifest }, guard);
  for (let offset = 0; offset < prepared.chunks.length; offset += 128) {
    const chunks = prepared.chunks.slice(offset, offset + 128);
    store.stageBatch(
      stage,
      {
        chunks,
        vectors: chunks.map(({ identity }) => ({
          chunkId: identity.chunkId,
          values,
          sha256: vectorDigest,
        })),
      },
      guard,
    );
  }
  const finished = store.publish(stage, operation('finished'), guard);
  assert.equal(finished.terminal.generation.generationId, generationId);
  return { elapsed: performance.now() - started, key, receipt };
}

async function query(store, mode, signal = new AbortController().signal) {
  const start = performance.now();
  const lease = store.leaseActive(project);
  try {
    const hits = await store.query(
      {
        lease,
        mode,
        memoryAllowed: false,
        intent: { query: 'lookup needle', filters, limit: 5 },
        ...(mode === 'hybrid' ? { vector: values } : {}),
      },
      { signal, deadline: Date.now() + 5000 },
    );
    assert.ok(hits.some(({ text }) => text.includes('lookupNeedle')));
    if (mode === 'hybrid') assert.equal(hits[0].rrfScore, 2 / 61);
    else assert.equal(hits[0].lexicalRank, 1);
    return performance.now() - start;
  } finally {
    store.releaseReadLease(lease);
  }
}

function percentile(samples, value) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * value) - 1].toFixed(1));
}

const cold = [];
const warm = [];
const lexical = [];
let store;
try {
  store = createSqliteRetrievalIndex({ filename });
  assert.deepEqual(store.capability, { available: true });
  const built = build(store);
  for (let index = 0; index < trials; index++) {
    const { close } = store;
    await close();
    store = createSqliteRetrievalIndex({ filename });
    assert.deepEqual(store.lookupAccepted(built.key), built.receipt);
    cold.push(await query(store, 'hybrid'));
    warm.push(await query(store, 'hybrid'));
    lexical.push(await query(store, 'lexical'));
  }
  const abort = new AbortController();
  const cancelled = query(store, 'hybrid', abort.signal);
  const abortAt = performance.now();
  abort.abort();
  await assert.rejects(cancelled, { code: 'retrieval-cancelled' });
  const cancelMs = performance.now() - abortAt;
  const sqlite = new DatabaseSync(':memory:');
  try {
    const percentiles = (values) => ({
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
    });
    process.stdout.write(
      JSON.stringify(
        {
          chunks: count,
          trials,
          node: process.version,
          sqlite: sqlite.prepare('SELECT sqlite_version() AS version').get().version,
          machine: {
            platform: platform(),
            release: release(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            cores: cpus().length,
            memoryMiB: Math.round(totalmem() / 2 ** 20),
          },
          buildMs: Number(built.elapsed.toFixed(1)),
          reopenedHybridMs: percentiles(cold),
          warmHybridMs: percentiles(warm),
          warmLexicalMs: percentiles(lexical),
          cancelToExitMs: Number(cancelMs.toFixed(1)),
          peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    sqlite.close();
  }
} finally {
  await store?.close();
  rmSync(directory, { recursive: true, force: true });
}
