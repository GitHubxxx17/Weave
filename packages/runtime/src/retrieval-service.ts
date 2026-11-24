import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  normalizeRetrievalSelection,
  retrievalBuildInputSchema,
  retrievalBuildIntentSchema,
  retrievalPrepareInputSchema,
  retrievalQueryInputSchema,
  retrievalQueryIntentSchema,
  retrievalManifestSchema,
  retrievalLimits,
  retrievalReceiptSchema,
  type RetrievalBuildIntent,
  type RetrievalCounts,
  type RetrievalManifest,
  type RetrievalPreview,
  type RetrievalPreparedDocuments,
  type RetrievalJobOperationKey,
  type RetrievalReceipt,
  type RetrievalRequestKey,
  type RetrievalTerminal,
  type RetrievalQueryResult,
  type RetrievalSourceIdentity,
  type RetrievalTextPage,
  type RetrievalSourceInput,
  type RetrievalSourceResult,
  type RetrievalJobSnapshot,
  type RetrievalProvenance,
} from '@weave/protocol';
import type { EmbeddingBatch, EmbeddingClient } from '@weave/llm';
import type { AgentToolInvocationAuthority } from './agent-tool-authority.js';
import { agentToolAuthorityParent } from './agent-tool-authority.js';
import { describeRetrievalCaller, retrievalCallerAuthority } from './retrieval-caller.js';
import { estimateTokens } from './context/token-estimate.js';
import { z } from 'zod';
import { isMemoryError } from './memory-errors.js';
import { isRetrievalError, RetrievalError } from './retrieval-errors.js';
import type {
  RetrievalServiceOptions,
  RetrievalService,
  RetrievalProjectEvidence,
  RetrievalWorkspaceCapture,
  RetrievalReviewedMemoryCapture,
  RetrievalPreparedBuild,
  RetrievalEgressPermit,
  RetrievalJobEgressGrant,
  RetrievalCaller,
} from './retrieval-types.js';

export function retrievalAgentRequestId(caller: AgentToolInvocationAuthority): string {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'weave.retrieval.agent-request.v1',
        caller.identity,
        caller.toolCallId,
        caller.toolName,
      ]),
    )
    .digest();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function describeRetrievalQueryBatch(
  embedding: EmbeddingClient,
  query: string,
): EmbeddingBatch {
  const sha256 = createHash('sha256').update(query).digest('hex');
  return embedding.describeBatches([{ id: sha256, text: query, sha256 }])[0]!;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function failure(error: unknown): RetrievalError {
  if (isRetrievalError(error)) return error;
  if (error instanceof z.ZodError) return new RetrievalError('retrieval-invalid-input');
  const code = isMemoryError(error) ? error.code : undefined;
  if (code === 'memory-disabled' || code === 'memory-stale-cursor' || code === 'memory-not-found')
    return new RetrievalError('retrieval-stale-source');
  return new RetrievalError('retrieval-persistence-error');
}
interface Preview {
  readonly view: RetrievalPreview;
  readonly project: RetrievalProjectEvidence;
  readonly capture: RetrievalWorkspaceCapture;
  readonly memory?: RetrievalReviewedMemoryCapture;
  readonly config?: object;
  readonly manifest: RetrievalManifest;
  readonly prepared: RetrievalPreparedDocuments;
  readonly batches: readonly EmbeddingBatch[];
  readonly documents: readonly import('@weave/protocol').RetrievalCapturedDocument[];
  readonly skipped: readonly import('@weave/protocol').RetrievalSkip[];
  consumed: boolean;
  invalidated?: boolean;
  released?: boolean;
}
interface Running {
  readonly receipt: RetrievalReceipt;
  readonly preview: Preview;
  readonly project: RetrievalProjectEvidence;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly grant?: RetrievalJobEgressGrant;
  promise: Promise<void>;
  phase: 'accepted' | 'indexing' | 'embedding' | 'validating' | 'publishing' | 'cancelling';
  embedded: number;
  fenced: boolean;
  cancelReason?: 'user' | 'shutdown' | 'authority-revoked';
  terminalAttempt?: {
    key: RetrievalJobOperationKey;
    terminal: Exclude<RetrievalTerminal, { status: 'completed' }>;
  };
}

export function createRetrievalService(options: RetrievalServiceOptions): RetrievalService {
  const previews = new Map<string, Preview>();
  const preparedHandles = new WeakMap<
    RetrievalPreparedBuild,
    { callerKey: string; intentDigest: string; preview?: Preview; receipt?: RetrievalReceipt }
  >();
  const jobs = new Map<string, Running>();
  const pending = new Set<Promise<unknown>>();
  const preparing = new Set<string>();
  const admitting = new Set<string>();
  const shutdown = new AbortController();
  const uncertain = new Map<
    string,
    {
      key: RetrievalRequestKey;
      preview: Preview;
      project: RetrievalProjectEvidence;
      grant?: RetrievalJobEgressGrant;
      terminalAttempt?: {
        key: RetrievalJobOperationKey;
        terminal: Exclude<RetrievalTerminal, { status: 'completed' }>;
      };
    }
  >();
  const secret = randomBytes(32);
  let closed = false;
  let drainWork: Promise<void> | undefined;
  let readers = 0;
  const maxBytes = Math.min(retrievalLimits.maxResponseBytes, options.budgets.maxBytes);
  const within = (value: unknown, tool = false) => {
    const json = JSON.stringify(value);
    return (
      Buffer.byteLength(json) <= (tool ? maxBytes : retrievalLimits.maxResponseBytes) &&
      (!tool || estimateTokens(json) <= options.budgets.maxToolResultTokens)
    );
  };
  const requireBudget = (value: unknown, tool = false) => {
    if (!within(value, tool)) throw new RetrievalError('retrieval-limit');
  };
  function current(signal?: AbortSignal): void {
    if (closed || signal?.aborted) throw new RetrievalError('retrieval-cancelled');
  }
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve()
      .then(() => {
        current();
        return operation();
      })
      .catch((error) => {
        throw failure(error);
      });
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  function releasePreview(preview: Preview): void {
    if (preview.released) return;
    preview.released = true;
    previews.delete(preview.view.previewId);
    options.capture.release(preview.capture);
    preview.project.release();
  }
  function prune(): void {
    for (const preview of previews.values())
      if (!preview.consumed && Date.parse(preview.view.expiresAt) <= Date.now())
        releasePreview(preview);
  }
  function encode(value: object): string {
    const record = value as { binding: object; offset: number };
    const data = Buffer.from(
      JSON.stringify({ binding: digest(record.binding), offset: record.offset }),
    ).toString('base64url');
    return Buffer.from(
      `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`,
    ).toString('base64url');
  }
  function decode(cursor: string | undefined, binding: object): number {
    if (cursor === undefined) return 0;
    try {
      if (Buffer.byteLength(cursor) > 2048) throw 0;
      const [data, mac, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
      if (!data || !mac || extra) throw 0;
      const expected = createHmac('sha256', secret).update(data).digest();
      const actual = Buffer.from(mac, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw 0;
      const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as {
        binding: string;
        offset: number;
      };
      if (
        parsed.binding !== digest(binding) ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      )
        throw 0;
      return parsed.offset;
    } catch {
      throw new RetrievalError('retrieval-invalid-cursor');
    }
  }
  function previewFor(projectId: string, id: string): Preview {
    prune();
    const preview = previews.get(id);
    if (
      !preview ||
      preview.invalidated ||
      preview.consumed ||
      preview.view.project.projectId !== projectId
    )
      throw new RetrievalError('retrieval-stale-preview');
    preview.project.assertCurrentSync();
    if (preview.memory) options.memory.assertCurrentSync(preview.memory);
    if (preview.config) options.embeddingAuthority?.assertCurrentSync(preview.config);
    return preview;
  }
  async function prepareIndependent(
    original: RetrievalProjectEvidence,
    requestId: string,
    intent: RetrievalBuildIntent,
    signal: AbortSignal,
  ): Promise<Preview> {
    let retained: RetrievalProjectEvidence | undefined;
    try {
      retained = await options.projects.retainForJob(original);
      current(signal);
      original.assertCurrentSync();
    } catch (error) {
      retained?.release();
      throw error;
    } finally {
      original.release();
    }
    return prepare(retained, requestId, intent, signal);
  }
  async function prepare(
    project: RetrievalProjectEvidence,
    requestId: string,
    intentInput: RetrievalBuildIntent,
    signal: AbortSignal,
  ): Promise<Preview> {
    let capture: RetrievalWorkspaceCapture | undefined;
    let acquired = false;
    try {
      prune();
      current(signal);
      if (
        previews.size + preparing.size >= 2 ||
        preparing.has(project.project.projectId) ||
        [...previews.values()].some((p) => p.view.project.projectId === project.project.projectId)
      )
        throw new RetrievalError('retrieval-busy');
      preparing.add(project.project.projectId);
      acquired = true;
      const intent = retrievalBuildIntentSchema.parse(intentInput);
      const selection = normalizeRetrievalSelection(intent);
      if (intent.mode === 'hybrid' && !options.embedding)
        throw new RetrievalError('retrieval-semantic-unavailable');
      const memory = selection.memoryRefs.length
        ? await options.memory.capture({
            projectId: project.project.projectId,
            refs: selection.memoryRefs,
            signal,
          })
        : undefined;
      capture = await options.capture.capture({ project, selection: intent.workspace, signal });
      const captured = options.capture.describe(capture);
      const documents = [
        ...captured.documents,
        ...(memory?.records.map(({ ref, content }) => ({
          source: {
            kind: 'memory' as const,
            sourceKey: `memory:${ref.memoryId}`,
            ref,
            sourceSha256: createHash('sha256').update(content.content).digest('hex'),
            sourceBytes: Buffer.byteLength(content.content),
          },
          title: content.title,
          lexicalMetadata: { tags: content.tags },
          body: content.content,
          capturedAt: new Date().toISOString(),
        })) ?? []),
      ];
      const prepared = options.index.prepareDocuments(documents);
      const counts: RetrievalCounts = {
        ...prepared.metrics,
        discovered: captured.counts.discoveredFiles + prepared.metrics.memories,
        selected: captured.counts.selectedFiles + prepared.metrics.memories,
        skipped: captured.counts.skippedFiles,
      };
      const batches =
        intent.mode === 'hybrid'
          ? options.embedding!.describeBatches(
              prepared.chunks.map((chunk) => ({
                id: chunk.identity.chunkId,
                text: chunk.text,
                sha256: chunk.identity.textSha256,
              })),
            )
          : [];
      const config = intent.mode === 'hybrid' ? options.embeddingAuthority?.capture() : undefined;
      const base = {
        project: project.project,
        mode: intent.mode,
        selection,
        versions: prepared.versions,
        sources: prepared.sources,
        chunks: prepared.chunks,
        counts,
        coverage: captured.coverage,
        ...(intent.mode === 'hybrid'
          ? {
              embedding: {
                identity: options.embedding!.identity,
                batches: batches.map((batch) => batch.description),
              },
            }
          : {}),
      };
      const manifest = freeze(
        retrievalManifestSchema.parse({
          ...base,
          manifestDigest: options.index.manifestDigest(base),
        }),
      );
      const createdAt = new Date().toISOString();
      const view: RetrievalPreview = {
        previewId: randomUUID(),
        requestId,
        project: project.project,
        manifestDigest: manifest.manifestDigest,
        mode: intent.mode,
        versions: prepared.versions,
        createdAt,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        counts,
        coverage: captured.coverage,
        ...(intent.mode === 'hybrid'
          ? {
              embedding: {
                identity: options.embedding!.identity,
                inputCount: prepared.chunks.length,
                inputBytes: counts.chunkTextBytes,
                requestCount: batches.length,
                requestBytes: batches.reduce((sum, b) => sum + b.description.requestBytes, 0),
              },
            }
          : {}),
      };
      current(signal);
      project.assertCurrentSync();
      if (memory) options.memory.assertCurrentSync(memory);
      const preview: Preview = {
        view: freeze(view),
        project,
        capture,
        manifest,
        prepared,
        batches,
        documents,
        skipped: captured.skipped,
        consumed: false,
        ...(memory ? { memory } : {}),
        ...(config ? { config } : {}),
      };
      previews.set(view.previewId, preview);
      return preview;
    } catch (error) {
      if (capture) options.capture.release(capture);
      project.release();
      throw error;
    } finally {
      if (acquired) preparing.delete(project.project.projectId);
    }
  }
  function jobGuard(job: Running): void {
    if (job.fenced || closed || job.controller.signal.aborted)
      throw new RetrievalError('retrieval-cancelled');
    if (Date.now() >= job.deadline) throw new RetrievalError('retrieval-timeout');
    job.project.assertCurrentSync();
    if (job.preview.memory) options.memory.assertCurrentSync(job.preview.memory);
    if (job.preview.config) options.embeddingAuthority?.assertCurrentSync(job.preview.config);
  }
  function operation(
    jobId: string,
    name: 'started' | 'finished',
    payload: unknown,
  ): RetrievalJobOperationKey {
    return {
      jobId,
      operationId: randomUUID(),
      operation: name,
      digest: digest([name, jobId, payload]),
    };
  }
  function exactOperation<T>(key: RetrievalJobOperationKey, action: () => T): T {
    try {
      return action();
    } catch (error) {
      const found = options.index.lookupJobOperation(key);
      if (found) return found as T;
      throw error;
    }
  }
  async function produce(job: Running): Promise<void> {
    let stage: import('./retrieval-types.js').RetrievalStageHandle | undefined;
    const started = operation(job.receipt.jobId, 'started', null);
    try {
      jobGuard(job);
      exactOperation(started, () =>
        options.index.markStarted({ key: started }, { assertCurrentSync: () => jobGuard(job) }),
      );
      stage = options.index.beginStage(
        { jobId: job.receipt.jobId, generationId: randomUUID(), manifest: job.preview.manifest },
        { assertCurrentSync: () => jobGuard(job) },
      );
      if (job.preview.manifest.mode === 'hybrid') {
        job.phase = 'embedding';
        for (const batch of job.preview.batches) {
          const vectors = await options.embedding!.embedBatch(batch, {
            signal: job.controller.signal,
            deadline: job.deadline,
            beforeSendSync(description) {
              jobGuard(job);
              options.egress.consumeBatchSync(job.grant!, description);
              return undefined;
            },
          });
          jobGuard(job);
          const ids = new Set(batch.description.chunkIds);
          options.index.stageBatch(
            stage,
            {
              chunks: job.preview.prepared.chunks.filter((chunk) =>
                ids.has(chunk.identity.chunkId),
              ),
              vectors: vectors.map((vector) => ({
                chunkId: vector.id,
                values: vector.values,
                sha256: vector.sha256,
              })),
            },
            { assertCurrentSync: () => jobGuard(job) },
          );
          job.embedded += vectors.length;
        }
      } else {
        job.phase = 'indexing';
        for (let offset = 0; offset < job.preview.prepared.chunks.length; offset += 128) {
          jobGuard(job);
          options.index.stageBatch(
            stage,
            { chunks: job.preview.prepared.chunks.slice(offset, offset + 128) },
            { assertCurrentSync: () => jobGuard(job) },
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      job.phase = 'validating';
      await job.project.checkpoint();
      await options.capture.verify(job.preview.capture, job.controller.signal, job.project);
      jobGuard(job);
      job.phase = 'publishing';
      const finished = operation(job.receipt.jobId, 'finished', stage.generationId);
      await job.project.withAdmission(() =>
        exactOperation(finished, () =>
          options.index.publish(
            stage!,
            { key: finished },
            { assertPublishCurrentSync: () => jobGuard(job) },
          ),
        ),
      );
    } catch (error) {
      const safe = failure(error);
      const terminal: Exclude<RetrievalTerminal, { status: 'completed' }> =
        job.fenced || closed || safe.code === 'retrieval-cancelled'
          ? {
              status: 'cancelled',
              reason: closed ? 'shutdown' : (job.cancelReason ?? 'authority-revoked'),
            }
          : {
              status: 'failed',
              code:
                safe.code === 'retrieval-timeout'
                  ? 'deadline'
                  : safe.code === 'retrieval-stale-preview' ||
                      safe.code === 'retrieval-stale-source'
                    ? 'stale-source'
                    : safe.code === 'retrieval-embedding-failed'
                      ? 'embedding-failed'
                      : 'index-failed',
            };
      if (stage) {
        try {
          options.index.discardStage(stage);
        } catch {
          /* Terminal append remains independently reconcilable. */
        }
      }
      const finished = operation(job.receipt.jobId, 'finished', terminal);
      job.terminalAttempt = { key: finished, terminal };
      exactOperation(finished, () =>
        options.index.finish({ key: finished, terminal }, { assertCanFinishSync() {} }),
      );
    } finally {
      // A failed exact terminal readback retains job capacity and all dependencies.
      const durable = options.index.getJob(job.receipt.project.projectId, job.receipt.jobId);
      if (durable?.terminal) {
        jobs.delete(job.receipt.jobId);
        releasePreview(job.preview);
        job.project.release();
      }
    }
  }
  function start(
    receipt: RetrievalReceipt,
    preview: Preview,
    project: RetrievalProjectEvidence,
    grant?: RetrievalJobEgressGrant,
  ): void {
    if (jobs.has(receipt.jobId)) return;
    preview.consumed = true;
    let acceptedAt = Date.now();
    try {
      const durable = options.index.getJob(receipt.project.projectId, receipt.jobId);
      if (durable) acceptedAt = Date.parse(durable.acceptedAt);
    } catch {
      /* Exact acceptance owns this producer even if metadata is temporarily unreadable. */
    }
    const job: Running = {
      receipt,
      preview,
      project,
      controller: new AbortController(),
      deadline: acceptedAt + 600000,
      promise: Promise.resolve(),
      phase: 'accepted',
      embedded: 0,
      fenced: false,
      ...(grant ? { grant } : {}),
    };
    jobs.set(receipt.jobId, job);
    project.signal.addEventListener(
      'abort',
      () => {
        job.fenced = true;
        queueMicrotask(() => job.controller.abort());
      },
      { once: true },
    );
    job.promise = Promise.resolve().then(() => produce(job));
    void job.promise.catch(() => undefined);
  }
  async function build(
    projectId: string,
    input: import('@weave/protocol').RetrievalBuildInput,
    permit: RetrievalEgressPermit | undefined,
    signal: AbortSignal,
    key?: RetrievalRequestKey,
    provenance: RetrievalProvenance = { actor: 'local-user' },
    caller?: RetrievalCaller,
  ): Promise<RetrievalReceipt> {
    current(signal);
    const parsed = retrievalBuildInputSchema.parse(input);
    let acquired = false;
    const authority = caller
      ? await options.projects.resolveAgent(caller, signal)
      : await options.projects.resolveLocal(projectId, signal);
    try {
      const requestKey = key ?? {
        projectId,
        callerKey: 'local-user',
        requestId: parsed.requestId,
        requestDigest: digest([
          'weave.retrieval.request.v1',
          'local-user',
          projectId,
          parsed.requestId,
          parsed.mode,
          parsed.manifestDigest,
        ]),
      };
      const known = options.index.lookupAccepted(requestKey);
      const held = uncertain.get(requestKey.requestId);
      if (held && !isDeepStrictEqual(held.key, requestKey))
        throw new RetrievalError('retrieval-request-conflict');
      if (held) {
        if (known) start(known, held.preview, held.project, held.grant);
        else {
          held.project.release();
          releasePreview(held.preview);
        }
        uncertain.delete(requestKey.requestId);
      }
      if (known) {
        requireBudget(known, provenance.actor === 'agent');
        return known;
      }
      if (uncertain.size) throw new RetrievalError('retrieval-persistence-uncertain');
      if (
        jobs.size + admitting.size >= 2 ||
        admitting.has(projectId) ||
        [...jobs.values()].some((job) => job.receipt.project.projectId === projectId)
      )
        throw new RetrievalError('retrieval-busy');
      admitting.add(projectId);
      acquired = true;
      const preview = previewFor(projectId, parsed.previewId);
      if (
        preview.view.mode !== parsed.mode ||
        preview.view.manifestDigest !== parsed.manifestDigest
      )
        throw new RetrievalError('retrieval-stale-preview');
      await options.capture.verify(preview.capture, signal);
      await preview.project.checkpoint();
      const project = await options.projects.retainForJob(preview.project);
      let retained = false;
      try {
        let grant: RetrievalJobEgressGrant | undefined;
        const mutation = {
          key: requestKey,
          jobId: randomUUID(),
          project: project.project,
          manifestDigest: parsed.manifestDigest,
          mode: parsed.mode,
          provenance,
          counts: preview.manifest.counts,
          ...(preview.manifest.embedding
            ? { vectorIdentity: preview.manifest.embedding.identity }
            : {}),
        };
        const minimum = {
          operation: 'retrieval.index',
          requestId: parsed.requestId,
          requestDigest: requestKey.requestDigest,
          jobId: mutation.jobId,
          acceptedSequence: Number.MAX_SAFE_INTEGER,
          project: project.project,
          manifestDigest: parsed.manifestDigest,
        };
        requireBudget(minimum, provenance.actor === 'agent');
        if (parsed.mode === 'hybrid') {
          if (!permit) {
            throw new RetrievalError('retrieval-scope-forbidden');
          }
          grant = options.egress.consumeForBuild({
            permit,
            projectId,
            requestId: parsed.requestId,
            manifestDigest: parsed.manifestDigest,
            batches: preview.batches.map((batch) => batch.description),
          });
        }
        let receipt: RetrievalReceipt;
        try {
          receipt = await project.withAdmission(() =>
            options.index.accept(mutation, {
              assertAuthorizedSync: () => {
                current(signal);
                authority.assertCurrentSync();
                project.assertCurrentSync();
              },
              assertNewMutationSync: () => {
                preview.project.assertCurrentSync();
                if (preview.memory) options.memory.assertCurrentSync(preview.memory);
                if (preview.config) options.embeddingAuthority?.assertCurrentSync(preview.config);
              },
            }),
          );
        } catch (error) {
          let recovered: RetrievalReceipt | undefined;
          try {
            recovered = options.index.lookupAccepted(requestKey);
          } catch (reconcileError) {
            uncertain.set(requestKey.requestId, {
              key: requestKey,
              preview,
              project,
              ...(grant ? { grant } : {}),
            });
            retained = true;
            preview.consumed = true;
            throw reconcileError;
          }
          if (!recovered) throw error;
          receipt = recovered;
        }
        retained = true;
        start(receipt, preview, project, grant);
        return retrievalReceiptSchema.parse(receipt);
      } finally {
        if (!retained) project.release();
      }
    } finally {
      if (acquired) admitting.delete(projectId);
      authority.release();
    }
  }
  async function readProject<T>(
    projectId: string,
    signal: AbortSignal,
    operation: (project: RetrievalProjectEvidence) => Promise<T> | T,
  ): Promise<T> {
    current(signal);
    const project = await options.projects.resolveLocal(projectId, signal);
    try {
      const value = await operation(project);
      current(signal);
      project.assertCurrentSync();
      requireBudget(value);
      return value;
    } finally {
      project.release();
    }
  }
  function snapshot(projectId: string, jobId: string): RetrievalJobSnapshot {
    const job = options.index.getJob(projectId, jobId);
    if (!job) throw new RetrievalError('retrieval-not-found');
    const running = jobs.get(jobId);
    return {
      job,
      ...(running
        ? {
            live: {
              phase: running.phase,
              discovered: job.counts.discovered,
              captured: job.counts.sources,
              chunks: job.counts.chunks,
              embedded: running.embedded,
            },
          }
        : {}),
    };
  }
  async function query(
    project: RetrievalProjectEvidence,
    input: import('@weave/protocol').RetrievalQueryInput,
    permit: RetrievalEgressPermit | undefined,
    signal: AbortSignal,
    tool = false,
  ): Promise<RetrievalQueryResult> {
    current(signal);
    if (readers >= 4) throw new RetrievalError('retrieval-busy');
    readers++;
    const controller = new AbortController();
    const localSignal = AbortSignal.any([
      signal,
      project.signal,
      controller.signal,
      shutdown.signal,
    ]);
    const deadline = Date.now() + (input.mode === 'hybrid' ? 35000 : 5000);
    const timer = setTimeout(() => controller.abort(), deadline - Date.now());
    let lease: import('./retrieval-types.js').RetrievalReadLease | undefined;
    try {
      const access = await options.memory.captureAccess({
        projectId: project.project.projectId,
        signal: localSignal,
      });
      lease = options.index.leaseActive(project.project);
      let vector: readonly number[] | undefined;
      if (input.mode === 'hybrid') {
        if (
          !options.embedding ||
          !permit ||
          lease.generation.mode !== 'hybrid' ||
          !isDeepStrictEqual(lease.generation.vectorIdentity, options.embedding.identity)
        )
          throw new RetrievalError('retrieval-semantic-unavailable');
        const batch = describeRetrievalQueryBatch(options.embedding, input.intent.query);
        const vectors = await options.embedding.embedBatch(batch, {
          signal: localSignal,
          deadline: Math.min(deadline, Date.now() + 30000),
          beforeSendSync(description) {
            current(localSignal);
            project.assertCurrentSync();
            options.memory.assertAccessCurrentSync(access);
            options.egress.consumeQueryBatchSync(permit, description, {
              projectId: project.project.projectId,
              requestId: input.requestId,
            });
            return undefined;
          },
        });
        vector = vectors[0]!.values;
      }
      const candidates = await options.index.query(
        {
          lease,
          mode: input.mode,
          intent: input.intent,
          memoryAllowed: access.level !== 'disabled',
          ...(vector ? { vector } : {}),
        },
        { signal: localSignal, deadline: Math.min(deadline, Date.now() + 5000) },
      );
      const result: RetrievalQueryResult = {
        requestId: input.requestId,
        actualMode: input.mode,
        generation: lease.generation,
        filters: input.intent.filters,
        hits: [],
        omitted: { stale: 0, unavailable: 0, budget: 0 },
        truncated: false,
        verifiedAt: new Date().toISOString(),
      };
      const memoryCaptures: RetrievalReviewedMemoryCapture[] = [];
      const verified = new Map<string, boolean>();
      let verifiedBytes = 0;
      let verifiedFiles = 0;
      for (const candidate of candidates) {
        current(localSignal);
        if (result.hits.length >= input.intent.limit) break;
        let valid = verified.get(candidate.source.sourceKey);
        if (valid === undefined) {
          try {
            if (candidate.source.kind === 'workspace') {
              if (
                ++verifiedFiles > 20 ||
                (verifiedBytes += candidate.source.sourceBytes) > 5242880
              ) {
                result.omitted.budget++;
                result.truncated = true;
                continue;
              }
              await options.capture.readCurrent({
                project,
                source: candidate.source,
                signal: localSignal,
              });
            } else {
              const capture = await options.memory.capture({
                projectId: project.project.projectId,
                refs: [candidate.source.ref],
                signal: localSignal,
              });
              memoryCaptures.push(capture);
            }
            valid = true;
          } catch (error) {
            const safe = failure(error);
            if (
              safe.code === 'retrieval-cancelled' ||
              safe.code === 'retrieval-timeout' ||
              safe.code === 'retrieval-root-changed'
            )
              throw safe;
            valid = false;
          }
          verified.set(candidate.source.sourceKey, valid);
        }
        if (!valid) {
          result.omitted.stale++;
          continue;
        }
        let excerpt = candidate.text;
        if (Buffer.byteLength(excerpt) > 1200) result.truncated = true;
        while (Buffer.byteLength(excerpt) > 1200) excerpt = [...excerpt].slice(0, -1).join('');
        const hit = {
          citation: {
            project: project.project,
            generationId: lease.generation.generationId,
            source: candidate.source,
            chunk: candidate.chunk,
          },
          title: candidate.title,
          excerpt,
          verifiedAt: new Date().toISOString(),
          ...(candidate.lexicalRank ? { lexicalRank: candidate.lexicalRank } : {}),
          ...(candidate.vectorRank ? { vectorRank: candidate.vectorRank } : {}),
          ...(candidate.rrfScore ? { rrfScore: candidate.rrfScore } : {}),
        };
        result.hits.push(hit);
        if (!within(result, tool)) result.truncated = true;
        while (!within(result, tool) && [...hit.excerpt].length > 1)
          hit.excerpt = [...hit.excerpt]
            .slice(0, Math.max(1, Math.floor([...hit.excerpt].length / 2)))
            .join('');
        if (!within(result, tool)) {
          result.hits.pop();
          result.omitted.budget++;
          result.truncated = true;
        }
      }
      if (result.hits.length === 0 && result.omitted.budget > 0)
        throw new RetrievalError('retrieval-limit');
      project.assertCurrentSync();
      options.memory.assertAccessCurrentSync(access);
      for (const capture of memoryCaptures) options.memory.assertCurrentSync(capture);
      current(localSignal);
      requireBudget(result, tool);
      return result;
    } finally {
      clearTimeout(timer);
      if (lease) options.index.releaseReadLease(lease);
      readers--;
    }
  }
  function textPage(
    source: RetrievalSourceIdentity,
    body: string,
    binding: object,
    cursor?: string,
  ): RetrievalTextPage {
    const points = [...body];
    const byteOffset = decode(cursor, binding);
    let offset = 0;
    let bytes = 0;
    while (offset < points.length && bytes < byteOffset)
      bytes += Buffer.byteLength(points[offset++]!);
    if (bytes !== byteOffset || offset > points.length)
      throw new RetrievalError('retrieval-invalid-cursor');
    let end = Math.min(points.length, offset + 8192);
    let text = points.slice(offset, end).join('');
    while (Buffer.byteLength(text) > 8192) {
      end--;
      text = points.slice(offset, end).join('');
    }
    let page: RetrievalTextPage;
    do {
      const eof = end === points.length;
      page = {
        source,
        offset: byteOffset,
        text,
        eof,
        ...(eof
          ? {}
          : { nextCursor: encode({ binding, offset: byteOffset + Buffer.byteLength(text) }) }),
      };
      if (within(page)) return page;
      end--;
      text = points.slice(offset, end).join('');
    } while (end > offset);
    throw new RetrievalError('retrieval-limit');
  }
  function recoverAgentReceipt(key: RetrievalRequestKey): RetrievalReceipt | undefined {
    const known = options.index.lookupAccepted(key);
    const held = uncertain.get(key.requestId);
    if (held && !isDeepStrictEqual(held.key, key))
      throw new RetrievalError('retrieval-request-conflict');
    if (held) {
      if (known) start(known, held.preview, held.project, held.grant);
      else {
        held.project.release();
        releasePreview(held.preview);
      }
      uncertain.delete(key.requestId);
    }
    return known;
  }
  function agentInfo(caller: RetrievalCaller, rootOnly = false) {
    const authority = retrievalCallerAuthority(caller);
    const view = describeRetrievalCaller(caller);
    if (rootOnly && agentToolAuthorityParent(authority) !== undefined)
      throw new RetrievalError('retrieval-scope-forbidden');
    return view;
  }
  function agentKey(
    caller: RetrievalCaller,
    projectId: string,
    intentInput: RetrievalBuildIntent,
  ): RetrievalRequestKey {
    const view = agentInfo(caller, true);
    const intent = retrievalBuildIntentSchema.parse(intentInput);
    const callerKey = digest(['agent', view.identity, view.toolCallId, view.toolName]);
    const requestId = retrievalAgentRequestId(view);
    return {
      projectId,
      callerKey,
      requestId,
      requestDigest: digest([
        'weave.retrieval.agent-intent.v1',
        callerKey,
        projectId,
        requestId,
        intent.mode,
        normalizeRetrievalSelection(intent),
      ]),
    };
  }
  async function withAgentProject<T>(
    caller: RetrievalCaller,
    signal: AbortSignal,
    rootOnly: boolean,
    action: (project: RetrievalProjectEvidence) => Promise<T> | T,
  ): Promise<T> {
    current(signal);
    agentInfo(caller, rootOnly);
    const project = await options.projects.resolveAgent(caller, signal);
    try {
      const value = await action(project);
      agentInfo(caller, rootOnly);
      project.assertCurrentSync();
      requireBudget(value, true);
      return value;
    } finally {
      project.release();
    }
  }
  const service: RetrievalService = {
    local: {
      capabilities: () => ({
        lexical: options.index.capability,
        embedding: options.embedding
          ? { configured: true, identity: options.embedding.identity }
          : { configured: false, reason: 'not-configured' },
      }),
      prepare: (projectId, input, signal) =>
        track(async () => {
          const parsed = retrievalPrepareInputSchema.parse(input);
          const project = await options.projects.resolveLocal(projectId, signal);
          return (await prepareIndependent(project, parsed.requestId, parsed.intent, signal)).view;
        }),
      preview: (projectId, id, page, signal) =>
        track(async () => {
          current(signal);
          const preview = previewFor(projectId, id);
          const binding = {
            operation: 'preview',
            projectId,
            id,
            digest: preview.manifest.manifestDigest,
          };
          const offset = decode(page.cursor, binding);
          const rows = [
            ...preview.manifest.sources.map((source) => ({ source })),
            ...preview.skipped.map((skipped) => ({ skipped })),
          ];
          let end = Math.min(rows.length, offset + 50);
          while (end >= offset) {
            const result = {
              previewId: id,
              manifestDigest: preview.manifest.manifestDigest,
              sources: rows
                .slice(offset, end)
                .flatMap((row) => ('source' in row ? [row.source] : [])),
              skipped: rows
                .slice(offset, end)
                .flatMap((row) => ('skipped' in row ? [row.skipped] : [])),
              ...(end < rows.length ? { nextCursor: encode({ binding, offset: end }) } : {}),
            };
            if (within(result) && (end > offset || end === rows.length)) return result;
            end--;
          }
          throw new RetrievalError('retrieval-limit');
        }),
      previewText: (projectId, input, signal) =>
        track(async () => {
          current(signal);
          const preview = previewFor(projectId, input.previewId);
          if (preview.manifest.manifestDigest !== input.manifestDigest)
            throw new RetrievalError('retrieval-stale-preview');
          const document = preview.documents.find(
            (item) => item.source.sourceKey === input.sourceKey,
          );
          if (!document) throw new RetrievalError('retrieval-not-found');
          return textPage(
            document.source,
            document.body,
            {
              operation: 'preview-text',
              projectId,
              id: input.previewId,
              digest: input.manifestDigest,
              source: input.sourceKey,
            },
            input.cursor,
          );
        }),
      build: (...args) => track(() => build(...args)),
      jobs: (projectId, page, signal) =>
        track(() =>
          readProject(projectId, signal, () => {
            const binding = { operation: 'jobs', projectId };
            const before = decode(page.cursor, binding);
            const result = options.index.listJobs({
              projectId,
              limit: 20,
              ...(before ? { beforeSequence: before } : {}),
            });
            const rows = result.jobs.map((job) => snapshot(projectId, job.receipt.jobId));
            return {
              jobs: rows,
              ...(result.hasMore && rows.length
                ? {
                    nextCursor: encode({
                      binding,
                      offset: rows.at(-1)!.job.receipt.acceptedSequence,
                    }),
                  }
                : {}),
            };
          }),
        ),
      job: (projectId, id, signal) =>
        track(() => readProject(projectId, signal, () => snapshot(projectId, id))),
      status: (projectId, signal) =>
        track(() =>
          readProject(projectId, signal, (project) => {
            const status = options.index.status(project.project);
            const running = [...jobs.values()].find(
              (job) => job.receipt.project.projectId === projectId,
            );
            return {
              ...status,
              ...(running ? { activeJob: snapshot(projectId, running.receipt.jobId) } : {}),
            };
          }),
        ),
      cancel: (projectId, id, signal) =>
        track(() =>
          readProject(projectId, signal, () => {
            const job = options.index.getJob(projectId, id);
            if (!job) throw new RetrievalError('retrieval-not-found');
            const running = jobs.get(id);
            if (running) {
              running.cancelReason = 'user';
              running.fenced = true;
              running.phase = 'cancelling';
              running.controller.abort();
            }
            return {
              jobId: id,
              cancelling: running !== undefined,
              ...(job.terminal ? { terminal: job.terminal } : {}),
            };
          }),
        ),
      query: (projectId, input, permit, signal) =>
        track(() =>
          readProject(projectId, signal, (project) =>
            query(project, retrievalQueryInputSchema.parse(input), permit, signal),
          ),
        ),
      source: (projectId, input: RetrievalSourceInput, signal) =>
        track(() =>
          readProject(projectId, signal, async (project) => {
            if (readers >= 4) throw new RetrievalError('retrieval-busy');
            readers++;
            const controller = new AbortController();
            const deadline = Date.now() + 5000;
            const sourceSignal = AbortSignal.any([
              signal,
              project.signal,
              controller.signal,
              shutdown.signal,
            ]);
            const timer = setTimeout(() => controller.abort(), 5000);
            let lease: import('./retrieval-types.js').RetrievalReadLease | undefined;
            try {
              lease = options.index.leaseActive(project.project, input.citation.generationId);
              const candidate = options.index.readChunk(lease, input.citation);
              if (!candidate) throw new RetrievalError('retrieval-stale-source');
              let body: string;
              if (candidate.source.kind === 'workspace')
                body = (
                  await options.capture.readCurrent({
                    project,
                    source: candidate.source,
                    signal: sourceSignal,
                  })
                ).body;
              else {
                const capture = await options.memory.capture({
                  projectId,
                  refs: [candidate.source.ref],
                  signal: sourceSignal,
                });
                options.memory.assertCurrentSync(capture);
                body = capture.records[0]!.content.content;
              }
              if (Date.now() >= deadline) throw new RetrievalError('retrieval-timeout');
              current(sourceSignal);
              project.assertCurrentSync();
              const result: RetrievalSourceResult = {
                citation: input.citation,
                page: textPage(
                  candidate.source,
                  body,
                  { operation: 'source', citation: input.citation },
                  input.cursor,
                ),
                verifiedAt: new Date().toISOString(),
                open:
                  candidate.source.kind === 'workspace'
                    ? {
                        kind: 'workspace',
                        path: candidate.source.path,
                        line: candidate.chunk.startLine,
                      }
                    : { kind: 'memory', ref: candidate.source.ref },
              };
              requireBudget(result);
              return result;
            } finally {
              clearTimeout(timer);
              if (lease) options.index.releaseReadLease(lease);
              readers--;
            }
          }),
        ),
    },
    agent: {
      prepareBuild: (caller, input, signal) =>
        track(async () => {
          agentInfo(caller, true);
          const intent = retrievalBuildIntentSchema.parse(input);
          const project = await options.projects.resolveAgent(caller, signal);
          let key: RetrievalRequestKey;
          let known: RetrievalReceipt | undefined;
          try {
            key = agentKey(caller, project.project.projectId, intent);
            known = recoverAgentReceipt(key);
          } catch (error) {
            project.release();
            throw error;
          }
          const handle = Object.freeze({}) as RetrievalPreparedBuild;
          if (known) {
            project.release();
            preparedHandles.set(handle, {
              callerKey: key.callerKey,
              intentDigest: key.requestDigest,
              receipt: known,
            });
            return handle;
          }
          const preview = await prepareIndependent(project, key.requestId, intent, signal);
          preparedHandles.set(handle, {
            callerKey: key.callerKey,
            intentDigest: key.requestDigest,
            preview,
          });
          return handle;
        }),
      releaseBuild(handle) {
        const state = preparedHandles.get(handle);
        if (state?.preview && !state.preview.consumed) releasePreview(state.preview);
        preparedHandles.delete(handle);
      },
      describeBuild(handle) {
        const state = preparedHandles.get(handle);
        if (!state) throw new RetrievalError('retrieval-stale-preview');
        return {
          ...(state.preview ? { preview: state.preview.view } : {}),
          ...(state.receipt ? { receipt: state.receipt } : {}),
        };
      },
      executeBuild: (caller, input, handle, permit, signal) =>
        track(async () => {
          agentInfo(caller, true);
          const project = await options.projects.resolveAgent(caller, signal);
          try {
            const key = agentKey(caller, project.project.projectId, input);
            const known = recoverAgentReceipt(key);
            if (known) {
              requireBudget(known, true);
              return known;
            }
            const state = handle && preparedHandles.get(handle);
            if (
              !state?.preview ||
              state.callerKey !== key.callerKey ||
              state.intentDigest !== key.requestDigest
            )
              throw new RetrievalError('retrieval-stale-preview');
            const view = agentInfo(caller, true);
            return build(
              project.project.projectId,
              {
                requestId: key.requestId,
                previewId: state.preview.view.previewId,
                mode: input.mode,
                manifestDigest: state.preview.manifest.manifestDigest,
              },
              permit,
              signal,
              key,
              {
                actor: 'agent',
                sessionId: view.identity.sessionId,
                executionId: view.identity.executionId,
                turnId: view.identity.turnId,
                toolCallId: view.toolCallId,
              },
              caller,
            );
          } finally {
            project.release();
          }
        }),
      status: (caller, signal) =>
        track(() =>
          withAgentProject(caller, signal, false, (project) =>
            options.index.status(project.project),
          ),
        ),
      cancel: (caller, jobId, signal) =>
        track(() =>
          withAgentProject(caller, signal, true, (project) => {
            const job = options.index.getJob(project.project.projectId, jobId);
            if (!job) throw new RetrievalError('retrieval-not-found');
            const running = jobs.get(jobId);
            const result = {
              jobId,
              cancelling: running !== undefined,
              ...(job.terminal ? { terminal: job.terminal } : {}),
            };
            requireBudget(result, true);
            if (running) {
              running.fenced = true;
              running.cancelReason = 'user';
              running.phase = 'cancelling';
              running.controller.abort();
            }
            return result;
          }),
        ),
      query: (caller, intent, mode, permit, signal) =>
        track(() =>
          withAgentProject(caller, signal, mode === 'hybrid', (project) =>
            query(
              project,
              {
                requestId: retrievalAgentRequestId(agentInfo(caller, mode === 'hybrid')),
                mode,
                intent: retrievalQueryIntentSchema.parse(intent),
              },
              permit,
              signal,
              true,
            ),
          ),
        ),
    },
    beforeMemoryCommit(change) {
      if (change.scope.kind !== 'project') return undefined;
      const projectId = change.scope.projectId;
      for (const preview of previews.values())
        if (preview.memory && preview.view.project.projectId === projectId && !preview.consumed) {
          preview.invalidated = true;
          queueMicrotask(() => releasePreview(preview));
        }
      for (const job of jobs.values())
        if (job.preview.memory && job.receipt.project.projectId === projectId) {
          job.fenced = true;
          queueMicrotask(() => job.controller.abort());
        }
      return undefined;
    },
    closeSync() {
      if (closed) return;
      closed = true;
      for (const job of jobs.values()) job.fenced = true;
    },
    async drain() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!drainWork) {
        const work = (async () => {
          shutdown.abort();
          for (const job of jobs.values()) job.controller.abort();
          await Promise.allSettled([...pending, ...[...jobs.values()].map((job) => job.promise)]);
          for (const job of jobs.values()) {
            let durable = options.index.getJob(job.receipt.project.projectId, job.receipt.jobId);
            if (!durable?.terminal) {
              const terminal = { status: 'cancelled', reason: 'shutdown' } as const;
              const attempt = job.terminalAttempt ?? {
                key: operation(job.receipt.jobId, 'finished', terminal),
                terminal,
              };
              job.terminalAttempt = attempt;
              exactOperation(attempt.key, () =>
                options.index.finish(attempt, { assertCanFinishSync() {} }),
              );
              durable = options.index.getJob(job.receipt.project.projectId, job.receipt.jobId);
            }
            if (durable?.terminal) {
              jobs.delete(job.receipt.jobId);
              releasePreview(job.preview);
              job.project.release();
            }
          }
          for (const [requestId, held] of uncertain) {
            const receipt = options.index.lookupAccepted(held.key);
            if (
              receipt &&
              !options.index.getJob(receipt.project.projectId, receipt.jobId)?.terminal
            ) {
              const terminal = { status: 'cancelled', reason: 'shutdown' } as const;
              const attempt = held.terminalAttempt ?? {
                key: operation(receipt.jobId, 'finished', terminal),
                terminal,
              };
              held.terminalAttempt = attempt;
              exactOperation(attempt.key, () =>
                options.index.finish(attempt, { assertCanFinishSync() {} }),
              );
            }
            held.project.release();
            releasePreview(held.preview);
            uncertain.delete(requestId);
          }
          if (jobs.size || uncertain.size)
            throw new RetrievalError('retrieval-persistence-uncertain');
          for (const preview of [...previews.values()]) releasePreview(preview);
          await options.embedding?.drain();
          await options.index.drain();
        })();
        drainWork = work;
        void work
          .finally(() => {
            drainWork = undefined;
          })
          .catch(() => undefined);
      }
      return Promise.race([
        drainWork,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RetrievalError('retrieval-busy')), 5000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    },
    async close() {
      service.closeSync();
      await service.drain();
      await options.embedding?.close();
      await options.index.close();
    },
  };
  // Interrupted acceptance never resumes frozen bytes or network after restart.
  for (const job of options.index.unfinishedJobs()) {
    const terminal = { status: 'interrupted', reason: 'server-restart' } as const;
    const key = operation(job.receipt.jobId, 'finished', terminal);
    exactOperation(key, () =>
      options.index.finish({ key, terminal }, { assertCanFinishSync() {} }),
    );
  }
  return service;
}
