/* global AbortController */
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createSqliteMemoryStore } from '../dist/index.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const directory = mkdtempSync(join(tmpdir(), 'weave-memory-bench-'));
const filename = join(directory, 'memory.sqlite');
const scope = { kind: 'project', projectId: randomUUID() };
const guard = { assertAuthorized() {}, assertNewMutation() {}, beforeCommit() {} };
const percentile = (samples, p) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
let store = createSqliteMemoryStore({ filename });
try {
  const body = '本地记忆✨严格类型与有界搜索。'.repeat(140);
  const started = performance.now();
  for (let index = 0; index < 10000; index += 1) {
    store.commit(
      {
        kind: 'create',
        expectedRevision: 0,
        key: { scope, requestId: randomUUID(), callerKey: 'local-user', digest: 'a'.repeat(64) },
        provenance: { actor: 'local-user' },
        content: {
          title: `${index % 10 === 0 ? 'needle' : 'record'} ${String(index).padStart(5, '0')}`,
          content: body,
          tags: ['中文', 'benchmark'],
        },
      },
      guard,
    );
  }
  const populateMs = performance.now() - started;
  const cold = [];
  const warm = [];
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  for (let sample = 0; sample < 3; sample += 1) {
    await store.close();
    store = createSqliteMemoryStore({ filename });
    delay.reset();
    const start = performance.now();
    await store.search({ scopes: [scope], query: '严格', limit: 50 });
    cold.push(performance.now() - start);
  }
  delay.reset();
  for (let sample = 0; sample < 12; sample += 1) {
    const start = performance.now();
    await store.search({ scopes: [scope], query: '严格', limit: 50 });
    warm.push(performance.now() - start);
  }
  const maxEventLoopDelayMs = delay.max / 1e6;
  delay.disable();
  const controller = new AbortController();
  const pending = store
    .search({ scopes: [scope], query: '严格', limit: 50 }, controller.signal)
    .catch((error) => error.code);
  const cancelled = performance.now();
  controller.abort();
  await pending;
  await store.drain();
  const cancellationCleanupMs = performance.now() - cancelled;
  process.stdout.write(
    JSON.stringify(
      {
        node: process.version,
        platform: `${platform()} ${arch()}`,
        cpu: cpus()[0]?.model,
        memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
        count: 10000,
        bodyUtf8Bytes: Buffer.byteLength(body),
        populateMs: +populateMs.toFixed(1),
        cold: {
          definition: 'first worker query after reopening Store; OS cache not evicted',
          samples: cold.length,
          p50Ms: +percentile(cold, 0.5).toFixed(1),
          p95Ms: +percentile(cold, 0.95).toFixed(1),
        },
        warm: {
          samples: warm.length,
          p50Ms: +percentile(warm, 0.5).toFixed(1),
          p95Ms: +percentile(warm, 0.95).toFixed(1),
        },
        maxEventLoopDelayMs: +maxEventLoopDelayMs.toFixed(1),
        cancellationCleanupMs: +cancellationCleanupMs.toFixed(1),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
}
