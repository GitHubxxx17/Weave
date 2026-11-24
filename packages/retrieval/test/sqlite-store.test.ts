import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import type {
  RetrievalAcceptMutation,
  RetrievalCapturedDocument,
  RetrievalManifest,
  RetrievalQueryIntent,
  RetrievalSourceIdentity,
} from '@weave/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { RetrievalStoreStartupError } from '../src/errors.js';
import { retrievalManifestDigest } from '../src/identity.js';
import type { RetrievalQueryWorker } from '../src/query.js';
import {
  createSqliteRetrievalIndex,
  type SqliteRetrievalIndexOptions,
} from '../src/sqlite-store.js';
import type { RetrievalIndex } from '../src/types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];
const stores = new Set<RetrievalIndex>();
const guard = {
  assertAuthorizedSync() {},
  assertNewMutationSync() {},
  assertCurrentSync() {},
  assertPublishCurrentSync() {},
  assertCanFinishSync() {},
};

function filenameFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'weave-retrieval-'));
  directories.push(directory);
  return join(directory, 'index.sqlite');
}

function open(filename = filenameFixture(), options: Partial<SqliteRetrievalIndexOptions> = {}) {
  const store = createSqliteRetrievalIndex({ filename, ...options });
  stores.add(store);
  return { filename, store };
}

afterEach(async () => {
  for (const store of stores) await store.close();
  stores.clear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
  store: RetrievalIndex,
  project = { projectId: randomUUID(), folderRevision: 1, rootDigest: hash('root') },
  path = 'src/parser.ts',
  body = 'parseDocument normalizes the input',
  documents: readonly RetrievalCapturedDocument[] = [workspaceDocument(path, body)],
) {
  const prepared = store.prepareDocuments(documents);
  const input = {
    project,
    mode: 'lexical',
    versions: prepared.versions,
    selection: {
      workspace: { enabled: true, paths: { include: [], exclude: [] } },
      memoryRefs: prepared.sources.flatMap(({ source }) =>
        source.kind === 'memory' ? [source.ref] : [],
      ),
    },
    sources: prepared.sources,
    chunks: prepared.chunks,
    counts: {
      ...prepared.metrics,
      discovered: documents.length,
      selected: documents.length,
      skipped: 0,
    },
    coverage: {
      discovery: 'walk',
      truncated: false,
      skippedDetailsTruncated: false,
      skipCounts: [],
    },
  } satisfies Omit<RetrievalManifest, 'manifestDigest'>;
  const manifest = { ...input, manifestDigest: retrievalManifestDigest(input) };
  const mutation: RetrievalAcceptMutation = {
    key: {
      requestId: randomUUID(),
      callerKey: 'local-user',
      requestDigest: hash(randomUUID()),
      projectId: project.projectId,
    },
    jobId: randomUUID(),
    project,
    mode: manifest.mode,
    manifestDigest: manifest.manifestDigest,
    counts: manifest.counts,
    provenance: { actor: 'local-user' },
  };
  const operations = {
    started: {
      jobId: mutation.jobId,
      operationId: randomUUID(),
      operation: 'started' as const,
      digest: hash('start'),
    },
    finished: {
      jobId: mutation.jobId,
      operationId: randomUUID(),
      operation: 'finished' as const,
      digest: hash('finish'),
    },
  };
  return { manifest, mutation, operations, generationId: randomUUID() };
}

function workspaceDocument(path: string, body: string): RetrievalCapturedDocument {
  return {
    source: {
      kind: 'workspace',
      sourceKey: `workspace:${path}`,
      path,
      sourceSha256: hash(body),
      sourceBytes: Buffer.byteLength(body),
      fileObjectDigest: hash(path),
    },
    title: path,
    lexicalMetadata: { tags: [] },
    body,
    capturedAt: '2026-11-23T00:00:00.000Z',
  };
}

function stageBuild(store: RetrievalIndex, data: ReturnType<typeof fixture>) {
  const { mutation, manifest, operations, generationId } = data;
  store.accept(mutation, guard);
  store.markStarted({ key: operations.started }, guard);
  const stage = store.beginStage({ jobId: mutation.jobId, generationId, manifest }, guard);
  store.stageBatch(stage, { chunks: manifest.chunks }, guard);
  return stage;
}

function publish(store: RetrievalIndex, data: ReturnType<typeof fixture>) {
  return store.publish(stageBuild(store, data), { key: data.operations.finished }, guard);
}

test('publishes a complete generation and exact receipts across reopen', async () => {
  const { store, filename } = open();
  const data = fixture(store);
  const terminal = publish(store, data);
  await store.close();
  const { store: reopened } = open(filename);
  expect(reopened.lookupAccepted(data.mutation.key)?.jobId).toBe(data.mutation.jobId);
  expect(reopened.lookupJobOperation(data.operations.finished)).toEqual(terminal);
  expect(reopened.status(data.mutation.project).active?.generationId).toBe(data.generationId);
  const lease = reopened.leaseActive(data.mutation.project);
  try {
    const hits = await reopened.query(
      {
        lease,
        mode: 'lexical',
        memoryAllowed: false,
        intent: {
          query: 'parse document',
          filters: { sources: ['workspace'], paths: { include: ['src'], exclude: [] } },
          limit: 10,
        },
      },
      { signal: new AbortController().signal, deadline: Date.now() + 5000 },
    );
    expect(hits).toMatchObject([{ text: 'parseDocument normalizes the input', lexicalRank: 1 }]);
  } finally {
    reopened.releaseReadLease(lease);
  }
});

test('retrieves fixed identifier, Chinese, Memory, and scope ground truth', async () => {
  const { store } = open();
  const project = { projectId: randomUUID(), folderRevision: 1, rootDigest: hash('quality root') };
  type GroundTruth = {
    readonly source: RetrievalSourceIdentity;
    readonly line: number;
    readonly query: string;
    readonly sources: RetrievalQueryIntent['filters']['sources'];
    readonly include: string[];
  };
  const truth: GroundTruth[] = [];
  const docs: RetrievalCapturedDocument[] = [];
  function add(document: RetrievalCapturedDocument, query: string, include: string[] = []) {
    docs.push(document);
    truth.push({
      source: document.source,
      line: 1,
      query,
      sources: [document.source.kind],
      include,
    });
  }
  for (const [path, identifier, query] of [
    ['src/agent/dispatch.ts', 'dispatchTurn', 'dispatch turn'],
    ['src/session/snapshot.ts', 'read_session_snapshot', 'session snapshot'],
    ['src/plugins/dependencies.ts', 'collectPluginDependencies', 'plugin dependencies'],
    ['src/net/reconnect.ts', 'scheduleReconnect', 'schedule reconnect'],
    ['src/search/symbols.ts', 'resolve.SymbolAlias', 'symbol alias'],
    ['src/server/stream.ts', 'decodeSSEFrame', 'SSE frame'],
    ['src/runtime/resume.ts', 'resume_with_cursor', 'resume cursor'],
    ['services/approval/broker.ts', 'rememberApproval', 'services approval broker'],
  ])
    add(workspaceDocument(path!, identifier!), query!);
  for (const [name, body, query] of [
    ['cancel', '后台任务取消后释放审批资源。', '任务取消'],
    ['revision', '版本变更后重新核对文件摘要。', '文件摘要'],
    ['fold', '折叠旧会话记录以便快速浏览。', '会话折叠'],
    ['diagnostic', '类型诊断会记录代码所在位置。', '类型诊断'],
    ['notify', '重连通知只发送给当前订阅者。', '重连通知'],
    ['manifest', '索引清单绑定快照和向量配置。', '索引清单'],
    ['shutdown', '关闭窗口后后台进程继续运行。', '关闭窗口'],
    ['dependency', '依赖图帮助定位插件加载失败。', '依赖图'],
  ])
    add(workspaceDocument(`docs/${name}.md`, body!), query!);
  for (const [index, [title, body, tag]] of [
    ['Deployment convention', 'Use the approved rollout channel.', 'bluegreen'],
    ['Office preference', 'Prefer a short meeting slot.', 'calendaring'],
    ['Review protocol', 'Ask the component owner for review.', 'checkpoints'],
    ['Project naming', 'Use conventional branch prefixes.', 'shortnames'],
  ].entries()) {
    const memoryId = `075bb0c5-3d1c-4826-903a-8941fa39501${index}`;
    const ref = {
      memoryId,
      revision: 1,
      sha256: hash(`${title}:${body}:${tag}`),
      scope: { kind: 'project' as const, projectId: project.projectId },
    };
    add(
      {
        source: {
          kind: 'memory',
          sourceKey: `memory:${memoryId}`,
          ref,
          sourceSha256: hash(body!),
          sourceBytes: Buffer.byteLength(body!),
        },
        title: title!,
        body: body!,
        capturedAt: '2026-11-23T00:00:00.000Z',
        lexicalMetadata: { tags: [tag!] },
      },
      tag!,
    );
  }
  const competing: RetrievalCapturedDocument[] = [];
  for (const [name, query] of [
    ['permissions', 'shared policy'],
    ['renderer', 'shared layout'],
    ['node', 'shared runner'],
    ['database', 'shared migration'],
  ]) {
    const path = `packages/${name}/src/shared.ts`;
    add(workspaceDocument(path, query!), query!, [`packages/${name}`]);
    docs.push(workspaceDocument(`legacy/${name}/src/shared.ts`, query!.repeat(15)));
    competing.push(workspaceDocument(path, `${query} foreignProjectContent`));
  }
  // These would occupy top 50 if the include prefix were applied after ranking.
  for (let index = 0; index < 55; index++) {
    docs.push(workspaceDocument(`legacy/noise-${index}.ts`, 'shared policy '.repeat(35)));
  }
  const data = fixture(store, project, undefined, undefined, docs);
  publish(store, data);
  const anotherProject = { ...project, projectId: randomUUID() };
  const other = fixture(store, anotherProject, undefined, undefined, competing);
  publish(store, other);

  const lease = store.leaseActive(project);
  const query = (intent: RetrievalQueryIntent, memoryAllowed = true) =>
    store.query(
      { lease, mode: 'lexical', intent, memoryAllowed },
      { signal: new AbortController().signal, deadline: Date.now() + 5000 },
    );
  try {
    const missed: string[] = [];
    for (const { query: text, source, sources, include, line } of truth) {
      const hits = await query({
        query: text,
        filters: { sources, paths: { include, exclude: [] } },
        limit: 5,
      });
      expect(hits.every(({ text }) => !text.includes('foreignProjectContent'))).toBe(true);
      if (include.length)
        expect(
          hits.every(
            ({ source }) => source.kind === 'workspace' && source.path.startsWith(include[0]!),
          ),
        ).toBe(true);
      const expected = hits
        .slice(0, 5)
        .find(
          ({ source: hit, chunk }) =>
            hit.sourceKey === source.sourceKey && line >= chunk.startLine && line <= chunk.endLine,
        );
      if (!expected) {
        missed.push(text);
        continue;
      }
      expect(expected.source).toEqual(source);
      const citation = {
        project,
        generationId: lease.generation.generationId,
        source,
        chunk: expected.chunk,
      };
      expect(store.readChunk(lease, citation)?.text).toBe(expected.text);
      expect(
        store.readChunk(lease, {
          ...citation,
          chunk: { ...expected.chunk, textSha256: hash('wrong body') },
        }),
      ).toBeUndefined();
    }
    expect(truth).toHaveLength(24);
    expect(missed).toEqual([]);
    expect(
      await query(
        {
          query: 'bluegreen',
          filters: { sources: ['memory'], paths: { include: [], exclude: [] } },
          limit: 5,
        },
        false,
      ),
    ).toEqual([]);
  } finally {
    store.releaseReadLease(lease);
  }
  // Each of the 24 ground-truth queries starts a query worker (~100ms locally), so CI runners
  // 8x slower exceed the default budget; the work cannot be shared without weakening coverage.
}, 60_000);

test('rolls back the pointer and terminal together when the final guard fails', () => {
  const { store } = open();
  const old = fixture(store);
  publish(store, old);
  const fresh = fixture(store, old.mutation.project, 'src/fresh.ts');
  const stage = stageBuild(store, fresh);
  let checks = 0;
  const fail = new Error('stale authority');
  expect(() =>
    store.publish(
      stage,
      { key: fresh.operations.finished },
      {
        assertPublishCurrentSync() {
          if (++checks === 2) throw fail;
        },
      },
    ),
  ).toThrow(fail);
  expect(store.lookupJobOperation(fresh.operations.finished)).toBeUndefined();
  expect(store.status(old.mutation.project).active?.generationId).toBe(old.generationId);
  expect(store.publish(stage, { key: fresh.operations.finished }, guard).terminal?.status).toBe(
    'completed',
  );
  expect(store.status(old.mutation.project).previous?.generationId).toBe(old.generationId);
  expect(() => store.publish({ ...stage }, { key: fresh.operations.finished }, guard)).toThrow(
    expect.objectContaining({ code: 'retrieval-request-conflict' }),
  );
});

test('reconciles commit acknowledgement loss and fences an unreadable exact receipt', async () => {
  let failAcknowledge = false;
  let failReadback = false;
  const { store } = open(undefined, {
    databaseFactory(filename) {
      const database = new DatabaseSync(filename);
      const originalExec = database.exec.bind(database);
      const originalPrepare = database.prepare.bind(database);
      vi.spyOn(database, 'exec').mockImplementation((sql) => {
        originalExec(sql);
        if (failAcknowledge && sql === 'COMMIT') {
          failAcknowledge = false;
          throw new Error('lost acknowledgement');
        }
      });
      vi.spyOn(database, 'prepare').mockImplementation((sql) => {
        if (failReadback && sql.startsWith('SELECT id, body FROM retrieval_events'))
          throw new Error('readback failed');
        return originalPrepare(sql);
      });
      return database;
    },
  });
  const data = fixture(store);
  failAcknowledge = true;
  const first = store.accept(data.mutation, guard);
  expect(store.accept({ ...data.mutation, jobId: randomUUID() }, guard)).toEqual(first);
  expect(() =>
    store.lookupAccepted({ ...data.mutation.key, requestDigest: hash('other') }),
  ).toThrow(expect.objectContaining({ code: 'retrieval-request-conflict' }));
  store.markStarted({ key: data.operations.started }, guard);
  const stage = store.beginStage(
    { jobId: data.mutation.jobId, generationId: data.generationId, manifest: data.manifest },
    guard,
  );
  store.stageBatch(stage, { chunks: data.manifest.chunks }, guard);
  failAcknowledge = true;
  failReadback = true;
  expect(() => store.publish(stage, { key: data.operations.finished }, guard)).toThrow(
    expect.objectContaining({ code: 'retrieval-persistence-uncertain' }),
  );
  expect(() => store.accept(fixture(store).mutation, guard)).toThrow(
    expect.objectContaining({ code: 'retrieval-persistence-uncertain' }),
  );
  await expect(store.close()).rejects.toMatchObject({ code: 'retrieval-persistence-uncertain' });
  failReadback = false;
  expect(store.lookupJobOperation(data.operations.finished)?.terminal?.status).toBe('completed');
  expect(store.getJob(data.mutation.project.projectId, data.mutation.jobId)?.terminal?.status).toBe(
    'completed',
  );
  await store.close();
});

test('rebuilds the active projection and detects damaged derived data without losing history', async () => {
  const { store, filename } = open();
  const data = fixture(store);
  publish(store, data);
  await store.close();
  const database = new DatabaseSync(filename);
  expect(() => database.exec("UPDATE retrieval_events SET body = '{}'")).toThrow(/append-only/);
  expect(() => database.exec('DELETE FROM retrieval_events')).toThrow(/append-only/);
  database.exec('DROP TABLE retrieval_active');
  database.close();
  const { store: rebuilt } = open(filename);
  expect(rebuilt.status(data.mutation.project).availability).toBe('ready');
  await rebuilt.close();
  const corrupt = new DatabaseSync(filename);
  corrupt.exec('DELETE FROM retrieval_chunks');
  corrupt.close();
  const { store: damaged } = open(filename);
  expect(damaged.status(data.mutation.project).availability).toBe('generation-unavailable');
  expect(damaged.lookupAccepted(data.mutation.key)?.jobId).toBe(data.mutation.jobId);
  expect(
    damaged.getJob(data.mutation.project.projectId, data.mutation.jobId)?.terminal?.status,
  ).toBe('completed');
});

test('pins one retired generation and refuses a fourth until the lease is released', async () => {
  const { store } = open();
  const first = fixture(store);
  const project = first.mutation.project;
  publish(store, first);
  const lease = store.leaseActive(project);
  try {
    publish(store, fixture(store, project));
    publish(store, fixture(store, project));
    const fourth = fixture(store, project);
    const { mutation, generationId, manifest, operations } = fourth;
    store.accept(mutation, guard);
    store.markStarted({ key: operations.started }, guard);
    expect(() =>
      store.beginStage({ jobId: mutation.jobId, generationId, manifest }, guard),
    ).toThrow(expect.objectContaining({ code: 'retrieval-busy' }));
    const citation = {
      project,
      generationId: first.generationId,
      source: first.manifest.sources[0]!.source,
      chunk: first.manifest.chunks[0]!.identity,
    };
    expect(store.readChunk(lease, citation)?.text).toBe(first.manifest.chunks[0]?.text);
    store.releaseReadLease(lease);
    expect(
      store.beginStage({ jobId: mutation.jobId, generationId, manifest }, guard).generationId,
    ).toBe(generationId);
  } finally {
    store.releaseReadLease(lease);
  }
});

test('keeps a cancelled query and its owner retained through actual worker exit', async () => {
  class DelayedWorker extends EventEmitter {
    readonly terminate = vi.fn(async () => 1);
  }
  const worker = new DelayedWorker();
  const { store, filename } = open(undefined, {
    queryWorkerFactory: () => worker as RetrievalQueryWorker,
  });
  const data = fixture(store);
  publish(store, data);
  const lease = store.leaseActive(data.mutation.project);
  const abort = new AbortController();
  const result = store.query(
    {
      lease,
      mode: 'lexical',
      memoryAllowed: false,
      intent: {
        query: 'parse',
        filters: { sources: ['workspace'], paths: { include: [], exclude: [] } },
        limit: 10,
      },
    },
    { signal: abort.signal, deadline: Date.now() + 5000 },
  );
  const settlement = vi.fn();
  const observed = result.then(settlement, settlement);
  abort.abort();
  store.releaseReadLease(lease);
  await wait(10);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(settlement).not.toHaveBeenCalled();
  expect(() => store.closeSync()).toThrow(expect.objectContaining({ code: 'retrieval-busy' }));
  expect(() => createSqliteRetrievalIndex({ filename })).toThrow(
    expect.objectContaining({ code: 'retrieval-busy' }),
  );
  worker.emit('exit', 1);
  await observed;
  expect(settlement).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: 'retrieval-cancelled' }),
  );
  await store.close();
});

test('distinguishes absent FTS5 from startup failures and retains partial cleanup', async () => {
  const withoutFts = open(undefined, {
    databaseFactory(filename) {
      const database = new DatabaseSync(filename);
      const exec = database.exec.bind(database);
      vi.spyOn(database, 'exec').mockImplementation((sql) => {
        if (sql.startsWith('CREATE VIRTUAL TABLE temp.retrieval_fts_probe'))
          throw new Error('no such module: fts5');
        exec(sql);
      });
      return database;
    },
  });
  expect(withoutFts.store.capability).toEqual({ available: false, reason: 'fts5-unavailable' });
  const filename = filenameFixture();
  let startup;
  try {
    createSqliteRetrievalIndex({
      filename,
      databaseFactory(path) {
        const database = new DatabaseSync(path);
        const exec = database.exec.bind(database);
        vi.spyOn(database, 'exec').mockImplementation((sql) => {
          if (sql.startsWith('CREATE VIRTUAL TABLE temp.retrieval_fts_probe'))
            throw new Error('unrelated startup fault');
          exec(sql);
        });
        vi.spyOn(database, 'close').mockImplementationOnce(() => {
          throw new Error('close failed');
        });
        return database;
      },
    });
  } catch (error) {
    startup = error;
  }
  expect(startup).toBeInstanceOf(RetrievalStoreStartupError);
  expect(() => createSqliteRetrievalIndex({ filename })).toThrow(
    expect.objectContaining({ code: 'retrieval-busy' }),
  );
  await (startup as RetrievalStoreStartupError).cleanup.close();
  expect(open(filename).store.capability).toBeDefined();
});

test('excludes a different process until SIGKILL releases the owner lock', async () => {
  const filename = filenameFixture();
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const owner = new DatabaseSync(process.argv[1] + '.owner.sqlite');
    owner.exec('BEGIN EXCLUSIVE');
    console.log('locked');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, filename], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = once(child, 'exit');
  try {
    expect(
      Buffer.from((await once(child.stdout, 'data'))[0])
        .toString()
        .trim(),
    ).toBe('locked');
    expect(() => createSqliteRetrievalIndex({ filename })).toThrow(
      expect.objectContaining({ code: 'retrieval-busy' }),
    );
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  expect(open(filename).store.capability.available).toBe(true);
});
