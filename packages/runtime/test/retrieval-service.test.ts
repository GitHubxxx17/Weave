import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  RetrievalCapturedDocument,
  RetrievalJob,
  RetrievalPreparedDocuments,
  RetrievalReceipt,
} from '@weave/protocol';
import { createRetrievalService } from '../src/retrieval-service.js';
import { RetrievalError } from '../src/retrieval-errors.js';
import { bindRetrievalCaller } from '../src/retrieval-caller.js';
import {
  activateAgentToolAuthority,
  createAgentToolAuthority,
  describeAgentToolAuthority,
} from '../src/agent-tool-authority.js';
import { createToolRegistry } from '../src/tool-registry.js';
import type {
  RetrievalIndexPort,
  RetrievalProjectEvidence,
  RetrievalProjectResolver,
  RetrievalServiceOptions,
  RetrievalWorkspaceCapture,
} from '../src/retrieval-types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const project = { projectId: randomUUID(), folderRevision: 1, rootDigest: hash('root') };
const versions = {
  chunker: 'weave.line-chunks.v1',
  tokenizer: 'weave.identifier-han.v1',
  discovery: 'weave.discovery.v1',
  manifest: 'weave.retrieval-manifest.v1',
} as const;
const intent = {
  mode: 'lexical',
  workspace: { enabled: true, paths: { include: [], exclude: [] } },
  memoryRefs: [],
} as const;
const signal = () => new AbortController().signal;
function fixture(budgets = { maxBytes: 24000, maxToolResultTokens: 6000 }) {
  const body = 'export function findSymbol() { return "搜索"; }';
  const source = {
    kind: 'workspace',
    sourceKey: 'workspace:src/index.ts',
    path: 'src/index.ts',
    sourceSha256: hash(body),
    sourceBytes: Buffer.byteLength(body),
    fileObjectDigest: hash('object'),
  } as const;
  const document: RetrievalCapturedDocument = {
    source,
    title: 'src/index.ts',
    lexicalMetadata: { tags: [] },
    body,
    capturedAt: new Date().toISOString(),
  };
  const chunk = {
    text: body,
    terms: body,
    identity: {
      chunkId: hash('chunk'),
      sourceKey: source.sourceKey,
      sourceSha256: source.sourceSha256,
      ordinal: 0,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: [...body].length,
      textSha256: hash(body),
      textBytes: source.sourceBytes,
      chunkerVersion: versions.chunker,
    },
  };
  const prepared: RetrievalPreparedDocuments = {
    versions,
    sources: [
      {
        source,
        title: document.title,
        lexicalMetadata: { tags: [] },
        chunkCount: 1,
        capturedAt: document.capturedAt,
      },
    ],
    chunks: [chunk],
    metrics: {
      sources: 1,
      files: 1,
      memories: 0,
      captureBytes: source.sourceBytes,
      chunks: 1,
      chunkTextBytes: source.sourceBytes,
    },
  };
  const durable = new Map<string, RetrievalJob>();
  const keys = new Map<string, RetrievalReceipt>();
  const release = vi.fn();
  const jobRelease = vi.fn();
  const resolve = (done = release): RetrievalProjectEvidence => ({
    project,
    signal: signal(),
    workspaceRoot: '/fixture',
    checkpoint: async () => {},
    assertCurrentSync() {},
    withAdmission: async (operation) => operation(),
    release: done,
  });
  const projects: RetrievalProjectResolver = {
    resolveLocal: async () => resolve(),
    resolveAgent: async () => resolve(),
    retainForJob: async () => resolve(jobRelease),
  };
  const captureHandle = {} as RetrievalWorkspaceCapture;
  let phase: 'running' | 'published' = 'running';
  let blocking: Promise<void> | undefined;
  const index: RetrievalIndexPort = {
    capability: { available: true },
    prepareDocuments: (documents) => {
      const docs = [...documents].sort((a, b) =>
        a.source.sourceKey.localeCompare(b.source.sourceKey),
      );
      return docs.length === 1
        ? prepared
        : {
            versions,
            sources: docs.map((doc) => ({
              source: doc.source,
              title: doc.title,
              lexicalMetadata: doc.lexicalMetadata,
              chunkCount: 1,
              capturedAt: doc.capturedAt,
            })),
            chunks: docs.map((doc, n) => ({
              text: doc.body,
              terms: doc.body,
              identity: {
                ...chunk.identity,
                chunkId: hash(String(n)),
                sourceKey: doc.source.sourceKey,
                sourceSha256: doc.source.sourceSha256,
                textSha256: hash(doc.body),
                textBytes: Buffer.byteLength(doc.body),
                endColumn: [...doc.body].length,
              },
            })),
            metrics: {
              sources: docs.length,
              files: 1,
              memories: docs.length - 1,
              chunks: docs.length,
              captureBytes: docs.reduce((sum, doc) => sum + doc.source.sourceBytes, 0),
              chunkTextBytes: docs.reduce((sum, doc) => sum + doc.source.sourceBytes, 0),
            },
          };
    },
    manifestDigest: (manifest) => hash(JSON.stringify(manifest)),
    lookupAccepted(key) {
      const receipt = keys.get(key.requestId);
      if (receipt && receipt.requestDigest !== key.requestDigest)
        throw new RetrievalError('retrieval-request-conflict');
      return receipt;
    },
    accept(mutation, guard) {
      guard.assertAuthorizedSync();
      const old = this.lookupAccepted(mutation.key);
      if (old) return old;
      guard.assertNewMutationSync();
      const receipt: RetrievalReceipt = {
        operation: 'retrieval.index',
        requestId: mutation.key.requestId,
        requestDigest: mutation.key.requestDigest,
        jobId: mutation.jobId,
        acceptedSequence: durable.size + 1,
        project,
        manifestDigest: mutation.manifestDigest,
      };
      keys.set(receipt.requestId, receipt);
      durable.set(receipt.jobId, {
        receipt,
        mode: mutation.mode,
        provenance: mutation.provenance,
        counts: mutation.counts,
        acceptedAt: new Date().toISOString(),
      });
      return receipt;
    },
    lookupJobOperation: () => undefined,
    markStarted(input, guard) {
      guard.assertCurrentSync();
      return { key: input.key, sequence: 2, occurredAt: new Date().toISOString() };
    },
    beginStage(input, guard) {
      guard.assertCurrentSync();
      return { jobId: input.jobId, generationId: input.generationId };
    },
    stageBatch(_stage, _input, guard) {
      guard.assertCurrentSync();
    },
    publish(stage, input, guard) {
      guard.assertPublishCurrentSync();
      const job = durable.get(stage.jobId)!;
      const generation = {
        generationId: stage.generationId,
        jobId: stage.jobId,
        project,
        manifestDigest: job.receipt.manifestDigest,
        versions,
        mode: job.mode,
        indexedAt: new Date().toISOString(),
        counts: job.counts,
      };
      job.terminal = { status: 'completed', generation };
      job.finishedAt = new Date().toISOString();
      phase = 'published';
      return { key: input.key, sequence: 3, occurredAt: job.finishedAt, terminal: job.terminal };
    },
    finish(input, guard) {
      guard.assertCanFinishSync();
      const job = durable.get(input.key.jobId)!;
      job.terminal = input.terminal;
      job.finishedAt = new Date().toISOString();
      return { key: input.key, sequence: 3, occurredAt: job.finishedAt, terminal: input.terminal };
    },
    getJob: (id, jobId) => (id === project.projectId ? durable.get(jobId) : undefined),
    listJobs: () => ({ jobs: [...durable.values()], hasMore: false }),
    status: () => ({
      project,
      availability: phase === 'published' ? 'ready' : 'not-built',
      needsRebuild: phase !== 'published',
    }),
    unfinishedJobs: () => [],
    leaseActive() {
      const generation = [...durable.values()].find(
        (job) => job.terminal?.status === 'completed',
      )?.terminal;
      if (generation?.status !== 'completed') throw new RetrievalError('retrieval-unavailable');
      return { generation: generation.generation };
    },
    query: async () => [
      { source, chunk: chunk.identity, title: document.title, text: body, lexicalRank: 1 },
    ],
    readChunk: () => ({ source, chunk: chunk.identity, title: document.title, text: body }),
    releaseReadLease() {},
    discardStage() {},
    collectGarbage() {},
    closeSync() {},
    drain: async () => {},
    close: async () => {},
  };
  const options: RetrievalServiceOptions = {
    index,
    projects,
    budgets,
    egress: {
      consumeForBuild() {
        throw Error('unexpected egress');
      },
      consumeBatchSync() {
        throw Error('unexpected egress');
      },
      consumeQueryBatchSync() {
        throw Error('unexpected egress');
      },
    },
    memory: {
      capture: async () => ({
        projectId: project.projectId,
        settingRevision: 1,
        liveEpoch: 1,
        records: [],
      }),
      assertCurrentSync() {},
      captureAccess: async () => ({
        projectId: project.projectId,
        settingRevision: 1,
        liveEpoch: 1,
        level: 'disabled',
      }),
      assertAccessCurrentSync() {},
    },
    capture: {
      capture: async () => captureHandle,
      describe: () => ({
        documents: [document],
        coverage: {
          discovery: 'walk',
          truncated: false,
          skippedDetailsTruncated: false,
          skipCounts: [],
        },
        counts: { discoveredFiles: 1, selectedFiles: 1, skippedFiles: 0 },
        skipped: [],
      }),
      verify: async () => {
        await blocking;
      },
      readCurrent: async () => document,
      release() {},
    },
  };
  return {
    options,
    index,
    release,
    jobRelease,
    durable,
    block: (value: Promise<void> | undefined) => {
      blocking = value;
    },
    service: () => createRetrievalService(options),
  };
}
const buildInput = (
  preview: Awaited<ReturnType<ReturnType<typeof createRetrievalService>['local']['prepare']>>,
) => ({
  requestId: preview.requestId,
  previewId: preview.previewId,
  mode: preview.mode,
  manifestDigest: preview.manifestDigest,
});
async function settled(service: ReturnType<typeof createRetrievalService>, jobId: string) {
  for (let i = 0; i < 30; i++) {
    const snapshot = await service.local.job(project.projectId, jobId, signal());
    if (snapshot.job.terminal) return snapshot.job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error('job did not settle');
}

describe('retrieval service orchestration', () => {
  it('keeps accepted lexical work alive when the initiating request ends and replays exact receipts', async () => {
    const f = fixture();
    const service = f.service();
    const controller = new AbortController();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      controller.signal,
    );
    const receipt = await service.local.build(
      project.projectId,
      buildInput(preview),
      undefined,
      controller.signal,
    );
    controller.abort();
    expect((await settled(service, receipt.jobId)).terminal?.status).toBe('completed');
    expect(
      await service.local.build(project.projectId, buildInput(preview), undefined, signal()),
    ).toEqual(receipt);
    expect(f.durable.size).toBe(1);
    expect(f.jobRelease).toHaveBeenCalledTimes(2);
    await service.close();
  });
  it('releases authority if preview admission is busy', async () => {
    const f = fixture();
    const service = f.service();
    await service.local.prepare(project.projectId, { requestId: randomUUID(), intent }, signal());
    await expect(
      service.local.prepare(project.projectId, { requestId: randomUUID(), intent }, signal()),
    ).rejects.toMatchObject({ code: 'retrieval-busy' });
    expect(f.release).toHaveBeenCalledTimes(2);
    await service.close();
  });
  it('does not trigger authority-release callbacks inside Memory precommit', async () => {
    const f = fixture();
    const service = f.service();
    const memoryIntent = {
      ...intent,
      memoryRefs: [
        {
          scope: { kind: 'project' as const, projectId: project.projectId },
          memoryId: randomUUID(),
          revision: 1,
          sha256: hash('memory'),
        },
      ],
    };
    f.options.memory.capture = async () => ({
      projectId: project.projectId,
      settingRevision: 1,
      liveEpoch: 1,
      records: [
        {
          ref: memoryIntent.memoryRefs[0]!,
          content: { title: 'Memory', content: 'memory', tags: [] },
        },
      ],
    });
    await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent: memoryIntent },
      signal(),
    );
    f.release.mockClear();
    f.jobRelease.mockClear();
    service.beforeMemoryCommit({
      scope: { kind: 'project', projectId: project.projectId },
      liveEpoch: 2,
    });
    expect(f.release).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(f.jobRelease).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it('uses user cancellation as its durable reason', async () => {
    const f = fixture();
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    const receipt = await service.local.build(
      project.projectId,
      buildInput(preview),
      undefined,
      signal(),
    );
    await service.local.cancel(project.projectId, receipt.jobId, signal());
    expect((await settled(service, receipt.jobId)).terminal).toEqual({
      status: 'cancelled',
      reason: 'user',
    });
    await service.close();
  });
  it('does not hide cancellation from source validation as a stale source', async () => {
    const f = fixture();
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    const receipt = await service.local.build(
      project.projectId,
      buildInput(preview),
      undefined,
      signal(),
    );
    await settled(service, receipt.jobId);
    f.options.capture.readCurrent = async () => {
      throw new RetrievalError('retrieval-cancelled');
    };
    await expect(
      service.local.query(
        project.projectId,
        {
          requestId: randomUUID(),
          mode: 'lexical',
          intent: {
            query: 'findSymbol',
            filters: { sources: ['workspace'], paths: { include: [], exclude: [] } },
            limit: 10,
          },
        },
        undefined,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'retrieval-cancelled' });
    await service.close();
  });
  it('reconciles an uncertain accepted append before starting exactly one producer', async () => {
    const f = fixture();
    const originalAccept = f.index.accept.bind(f.index);
    const originalLookup = f.index.lookupAccepted.bind(f.index);
    let uncertain = false;
    let blocked = true;
    f.index.accept = (mutation, guard) => {
      originalAccept(mutation, guard);
      uncertain = true;
      throw new RetrievalError('retrieval-persistence-uncertain');
    };
    f.index.lookupAccepted = (key) => {
      if (uncertain && blocked) throw new RetrievalError('retrieval-persistence-uncertain');
      return originalLookup(key);
    };
    const stage = vi.spyOn(f.index, 'beginStage');
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    await expect(
      service.local.build(project.projectId, buildInput(preview), undefined, signal()),
    ).rejects.toMatchObject({ code: 'retrieval-persistence-uncertain' });
    expect(stage).not.toHaveBeenCalled();
    blocked = false;
    const receipt = await service.local.build(
      project.projectId,
      buildInput(preview),
      undefined,
      signal(),
    );
    expect((await settled(service, receipt.jobId)).terminal?.status).toBe('completed');
    expect(stage).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it('releases retained resources for a definitely absent failed acceptance', async () => {
    const f = fixture();
    f.index.accept = () => {
      throw new RetrievalError('retrieval-persistence-error');
    };
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    await expect(
      service.local.build(project.projectId, buildInput(preview), undefined, signal()),
    ).rejects.toMatchObject({ code: 'retrieval-persistence-error' });
    expect(f.jobRelease).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('releases an uncertain Agent preview once acceptance is confirmed absent before retrying', async () => {
    const f = fixture();
    const accept = f.index.accept.bind(f.index);
    const lookup = f.index.lookupAccepted.bind(f.index);
    let lookupBlocked = false;
    f.index.accept = () => {
      lookupBlocked = true;
      throw new RetrievalError('retrieval-persistence-uncertain');
    };
    f.index.lookupAccepted = (key) => {
      if (lookupBlocked) throw new RetrievalError('retrieval-persistence-uncertain');
      return lookup(key);
    };
    const registry = createToolRegistry();
    const identity = {
      sessionId: randomUUID(),
      executionId: randomUUID(),
      turnId: randomUUID(),
      userMessageId: randomUUID(),
    };
    const authority = createAgentToolAuthority({ identity, registry, ownerOf: () => 'host' });
    const end = activateAgentToolAuthority(
      {
        sessionId: identity.sessionId,
        executionIdentity: identity,
        toolAuthority: authority,
        userMessage: { role: 'user', content: [{ type: 'text', text: 'build' }] },
      },
      registry,
      { provider: 'test', model: 'test', permissionMode: 'yolo', useProviderDefaults: false },
      signal(),
    )!;
    const caller = bindRetrievalCaller(
      {
        ...describeAgentToolAuthority(authority),
        toolCallId: 'call',
        toolName: 'build_project_index',
      },
      authority,
      () => {},
    );
    const releaseCapture = vi.spyOn(f.options.capture, 'release');
    const service = f.service();
    try {
      const first = await service.agent.prepareBuild(caller, intent, signal());
      await expect(
        service.agent.executeBuild(caller, intent, first, undefined, signal()),
      ).rejects.toMatchObject({ code: 'retrieval-persistence-uncertain' });
      service.agent.releaseBuild(first);
      expect(releaseCapture).not.toHaveBeenCalled();
      expect(f.durable.size).toBe(0);
      lookupBlocked = false;
      f.index.accept = accept;
      const retry = await service.agent.prepareBuild(caller, intent, signal());
      expect(releaseCapture).toHaveBeenCalledTimes(1);
      const receipt = await service.agent.executeBuild(caller, intent, retry, undefined, signal());
      service.agent.releaseBuild(retry);
      expect((await settled(service, receipt.jobId)).terminal?.status).toBe('completed');
      expect(f.durable.size).toBe(1);
    } finally {
      await service.close();
      end();
    }
  });

  it('keeps the shutdown terminal key while a previously uncertain acceptance is reconciled', async () => {
    const f = fixture();
    const accept = f.index.accept.bind(f.index);
    const lookupAccepted = f.index.lookupAccepted.bind(f.index);
    const finish = f.index.finish.bind(f.index);
    const getJob = f.index.getJob.bind(f.index);
    let acceptUncertain = false;
    let terminalOffline = false;
    let terminalAttempted = false;
    f.index.accept = (...args) => {
      accept(...args);
      acceptUncertain = true;
      throw new RetrievalError('retrieval-persistence-uncertain');
    };
    f.index.lookupAccepted = (key) => {
      if (acceptUncertain) throw new RetrievalError('retrieval-persistence-uncertain');
      return lookupAccepted(key);
    };
    f.index.getJob = (...args) => {
      if (terminalOffline && terminalAttempted)
        throw new RetrievalError('retrieval-persistence-uncertain');
      return getJob(...args);
    };
    f.index.lookupJobOperation = () => {
      if (terminalOffline && terminalAttempted)
        throw new RetrievalError('retrieval-persistence-uncertain');
      return undefined;
    };
    const writes = vi
      .spyOn(f.index, 'finish')
      .mockImplementationOnce(() => {
        terminalOffline = true;
        terminalAttempted = true;
        throw new RetrievalError('retrieval-persistence-uncertain');
      })
      .mockImplementation(finish);
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    await expect(
      service.local.build(project.projectId, buildInput(preview), undefined, signal()),
    ).rejects.toMatchObject({ code: 'retrieval-persistence-uncertain' });
    acceptUncertain = false;
    try {
      await expect(service.close()).rejects.toMatchObject({
        code: 'retrieval-persistence-uncertain',
      });
      expect(f.jobRelease).not.toHaveBeenCalled();
    } finally {
      terminalOffline = false;
      await service.close();
    }
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls[1]?.[0]).toEqual(writes.mock.calls[0]?.[0]);
    expect([...f.durable.values()][0]?.terminal).toEqual({
      status: 'cancelled',
      reason: 'shutdown',
    });
  });
  it('keeps a preview reservation after two overlapping competitors are rejected', async () => {
    const f = fixture();
    const service = f.service();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const capture = f.options.capture.capture;
    const blocked = vi.spyOn(f.options.capture, 'capture').mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return capture(input);
    });
    const prepare = () =>
      service.local.prepare(project.projectId, { requestId: randomUUID(), intent }, signal());
    const first = prepare();
    try {
      await entered.promise;
      await expect(prepare()).rejects.toMatchObject({ code: 'retrieval-busy' });
      await expect(prepare()).rejects.toMatchObject({ code: 'retrieval-busy' });
      expect(blocked).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await first;
      await service.close();
    }
  });

  it('keeps a build reservation after two overlapping competitors are rejected', async () => {
    const f = fixture();
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const verify = vi.spyOn(f.options.capture, 'verify').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const build = () =>
      service.local.build(project.projectId, buildInput(preview), undefined, signal());
    const first = build();
    try {
      await entered.promise;
      await expect(build()).rejects.toMatchObject({ code: 'retrieval-busy' });
      await expect(build()).rejects.toMatchObject({ code: 'retrieval-busy' });
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      const receipt = await first;
      expect((await settled(service, receipt.jobId)).terminal?.status).toBe('completed');
      await service.close();
    }
  });

  it.each([true, false])(
    'reconciles an unreadable terminal on shutdown retry (already committed: %s)',
    async (committed) => {
      const f = fixture();
      const storeClose = vi.spyOn(f.index, 'close');
      const finish = f.index.finish.bind(f.index);
      const firstFinish = Promise.withResolvers<void>();
      const getJob = f.index.getJob.bind(f.index);
      let attempted = false;
      let offline = true;
      vi.spyOn(f.index, 'stageBatch').mockImplementation(() => {
        throw new RetrievalError('retrieval-persistence-error');
      });
      const writes = vi.spyOn(f.index, 'finish').mockImplementationOnce((...args) => {
        attempted = true;
        if (committed) finish(...args);
        firstFinish.resolve();
        throw new RetrievalError('retrieval-persistence-uncertain');
      });
      vi.spyOn(f.index, 'lookupJobOperation').mockImplementation(() => {
        if (offline && attempted) throw new RetrievalError('retrieval-persistence-uncertain');
        return undefined;
      });
      vi.spyOn(f.index, 'getJob').mockImplementation((...args) => {
        if (offline && attempted) throw new RetrievalError('retrieval-persistence-uncertain');
        return getJob(...args);
      });
      const service = f.service();
      const preview = await service.local.prepare(
        project.projectId,
        { requestId: randomUUID(), intent },
        signal(),
      );
      const receipt = await service.local.build(
        project.projectId,
        buildInput(preview),
        undefined,
        signal(),
      );
      try {
        await firstFinish.promise;
        await expect(service.close()).rejects.toMatchObject({
          code: 'retrieval-persistence-uncertain',
        });
        expect(f.jobRelease).not.toHaveBeenCalled();
        expect(storeClose).not.toHaveBeenCalled();
      } finally {
        offline = false;
        await service.close();
      }
      const terminal = f.durable.get(receipt.jobId)?.terminal;
      expect(terminal).toEqual({ status: 'failed', code: 'index-failed' });
      expect(writes).toHaveBeenCalledTimes(committed ? 1 : 2);
      if (!committed) expect(writes.mock.calls[1]?.[0]).toEqual(writes.mock.calls[0]?.[0]);
      expect(f.jobRelease).toHaveBeenCalledTimes(2);
      expect(storeClose).toHaveBeenCalledOnce();
    },
  );

  it('does not orphan durable acceptance when the first accepted job read fails', async () => {
    const f = fixture();
    const getJob = f.index.getJob;
    let broken = true;
    f.index.getJob = (...args) => {
      if (broken && f.durable.size) {
        broken = false;
        throw new RetrievalError('retrieval-persistence-error');
      }
      return getJob(...args);
    };
    const service = f.service();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      signal(),
    );
    await service.local
      .build(project.projectId, buildInput(preview), undefined, signal())
      .catch(() => undefined);
    const receipt = await service.local.build(
      project.projectId,
      buildInput(preview),
      undefined,
      signal(),
    );
    expect((await settled(service, receipt.jobId)).terminal?.status).toBe('completed');
    await service.close();
  });

  it('keeps preview authority independent from the completed request', async () => {
    const f = fixture();
    const original = f.options.projects.resolveLocal;
    f.options.projects.resolveLocal = async (id, signal) => {
      const evidence = await original(id, signal);
      return {
        ...evidence,
        assertCurrentSync() {
          if (signal.aborted) throw new RetrievalError('retrieval-cancelled');
        },
      };
    };
    const service = f.service();
    const controller = new AbortController();
    const preview = await service.local.prepare(
      project.projectId,
      { requestId: randomUUID(), intent },
      controller.signal,
    );
    controller.abort();
    expect(
      (await service.local.preview(project.projectId, preview.previewId, {}, signal())).sources,
    ).toHaveLength(1);
    await service.close();
  });
});

it('releases refused Agent build previews after Pipeline closes', async () => {
  // Public lifecycle method is intentionally safe for repeated disposal.
  const f = fixture();
  const service = f.service();
  expect(() => service.agent.releaseBuild({} as never)).not.toThrow();
  await service.close();
});
