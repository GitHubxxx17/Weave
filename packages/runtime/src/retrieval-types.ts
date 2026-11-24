import type { z } from 'zod';
import type {
  MemoryRef,
  MemoryContent,
  RetrievalProjectIdentity,
  RetrievalBuildIntent,
  RetrievalCapturedDocument,
  RetrievalCoverage,
  RetrievalCaptureCoverageCounts,
  RetrievalSkip,
  RetrievalGeneration,
  RetrievalPreparedDocuments,
  RetrievalAcceptMutation,
  RetrievalReceipt,
  RetrievalRequestKey,
  RetrievalJobOperationKey,
  RetrievalJobOperationReceipt,
  RetrievalManifest,
  RetrievalPreparedChunk,
  RetrievalUnitVector,
  RetrievalTerminal,
  RetrievalJob,
  RetrievalIndexStatus,
  RetrievalMode,
  RetrievalQueryIntent,
  RetrievalRankedCandidate,
  RetrievalCitation,
  RetrievalEmbeddingBatchDescription,
  RetrievalCapabilities,
  RetrievalPrepareInput,
  RetrievalPreview,
  RetrievalPreviewPage,
  RetrievalTextPage,
  RetrievalBuildInput,
  RetrievalJobPage,
  RetrievalJobSnapshot,
  RetrievalCancelResult,
  RetrievalQueryInput,
  RetrievalQueryResult,
  RetrievalSourceInput,
  RetrievalSourceResult,
  RetrievalSourceIdentity,
  retrievalPreviewTextInputSchema,
} from '@weave/protocol';
import type { EmbeddingClient } from '@weave/llm';

export interface RetrievalLifecycle {
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}
export type EmbeddingClientPort = EmbeddingClient;

declare const retrievalCallerBrand: unique symbol;
export interface RetrievalCaller {
  readonly [retrievalCallerBrand]: true;
}
declare const retrievalPreviewBrand: unique symbol;
export interface RetrievalPreparedBuild {
  readonly [retrievalPreviewBrand]: true;
}
declare const retrievalPermitBrand: unique symbol;
export interface RetrievalEgressPermit {
  readonly [retrievalPermitBrand]: true;
}
declare const retrievalGrantBrand: unique symbol;
export interface RetrievalJobEgressGrant {
  readonly [retrievalGrantBrand]: true;
}
declare const retrievalCaptureBrand: unique symbol;
export interface RetrievalWorkspaceCapture {
  readonly [retrievalCaptureBrand]: true;
}
// Runtime implementation checks exact objects in private WeakMaps. TS brands
// cannot themselves enforce authority or make an object safe to deserialize.
export interface RetrievalBudgets {
  readonly maxBytes: number; // identical effective Pipeline setting
  readonly maxToolResultTokens: number; // identical effective Runner setting
}
export interface RetrievalProjectEvidence {
  readonly project: RetrievalProjectIdentity;
  readonly signal: AbortSignal;
  /** Not JSON. Private root path usable only by trusted capture implementation. */
  readonly workspaceRoot: string;
  checkpoint(): Promise<void>; // outside retrieval gates and Memory callback
  assertCurrentSync(): void; // membership + Project marker + root object identity
  /**
   * Short Project authority gate. operation MUST return synchronously; reject
   * thenables. No approval/capture/network/worker/drain in this callback.
   */
  withAdmission<T>(operation: () => T): Promise<T>;
  release(): void;
}
export interface RetrievalProjectResolver {
  resolveLocal(projectId: string, signal: AbortSignal): Promise<RetrievalProjectEvidence>;
  resolveAgent(caller: RetrievalCaller, signal: AbortSignal): Promise<RetrievalProjectEvidence>;
  /** Independent project-only lifetime, same exact captured identity. */
  retainForJob(evidence: RetrievalProjectEvidence): Promise<RetrievalProjectEvidence>;
}
export interface RetrievalWorkspaceCapturePort {
  capture(input: {
    readonly project: RetrievalProjectEvidence;
    readonly selection: RetrievalBuildIntent['workspace'];
    readonly signal: AbortSignal;
  }): Promise<RetrievalWorkspaceCapture>;
  describe(capture: RetrievalWorkspaceCapture): {
    readonly documents: readonly RetrievalCapturedDocument[];
    readonly coverage: RetrievalCoverage;
    readonly counts: RetrievalCaptureCoverageCounts;
    /** <=maxSkipDetails examples; truncating these never changes counts. */
    readonly skipped: readonly RetrievalSkip[];
  };
  /** Safe bounded full-source reread; uses same primitive as capture. */
  verify(
    capture: RetrievalWorkspaceCapture,
    signal: AbortSignal,
    project?: RetrievalProjectEvidence,
  ): Promise<void>;
  /** Reads current exact source; root/file/digest mismatch is stale-source. */
  readCurrent(input: {
    readonly project: RetrievalProjectEvidence;
    readonly source: Extract<RetrievalSourceIdentity, { kind: 'workspace' }>;
    readonly signal: AbortSignal;
  }): Promise<RetrievalCapturedDocument>;
  release(capture: RetrievalWorkspaceCapture): void;
}
export interface RetrievalMemoryAccessCapture {
  readonly projectId: string;
  readonly level: 'disabled' | 'read-only' | 'read-write';
  readonly settingRevision: number;
  readonly liveEpoch: number;
}
export interface RetrievalReviewedMemoryCapture {
  readonly projectId: string;
  readonly settingRevision: number;
  readonly liveEpoch: number;
  readonly records: readonly { readonly ref: MemoryRef; readonly content: MemoryContent }[];
}
export interface RetrievalMemorySourcePort {
  // Structurally mirror MemoryService.reviewedSource, after adding access-only port.
  capture(input: {
    readonly projectId: string;
    readonly refs: readonly MemoryRef[];
    readonly signal: AbortSignal;
  }): Promise<RetrievalReviewedMemoryCapture>;
  assertCurrentSync(capture: RetrievalReviewedMemoryCapture): void;
  captureAccess(input: {
    readonly projectId: string;
    readonly signal: AbortSignal;
  }): Promise<RetrievalMemoryAccessCapture>;
  assertAccessCurrentSync(capture: RetrievalMemoryAccessCapture): void;
}
export interface RetrievalInvalidationPort {
  /** Called inside Memory precommit; fence synchronously, queue abort outside. */
  beforeMemoryCommit(change: {
    readonly scope:
      { readonly kind: 'project'; readonly projectId: string } | { readonly kind: 'user' };
    readonly memoryId?: string;
    readonly liveEpoch: number;
  }): undefined;
}
// Index handles are process-local exact objects, not JSON capabilities. Leaf
// mirrors these structural signatures using protocol values only and private
// WeakMaps; it does not import Runtime. Copies must fail exact-handle checks.
export interface RetrievalReadLease {
  readonly generation: RetrievalGeneration;
}
export interface RetrievalStageHandle {
  readonly jobId: string;
  readonly generationId: string;
}
export interface RetrievalIndexPort extends RetrievalLifecycle {
  readonly capability:
    | { readonly available: true }
    | { readonly available: false; readonly reason: 'fts5-unavailable' };
  /**
   * All-or-nothing pure preparation of every input document. Chunk/aggregate
   * limit failure rejects; it never silently drops a source or adds skip counts.
   */
  prepareDocuments(documents: readonly RetrievalCapturedDocument[]): RetrievalPreparedDocuments;
  manifestDigest(manifest: Omit<RetrievalManifest, 'manifestDigest'>): string;
  /** BEGIN IMMEDIATE -> live guard -> exact receipt -> new mutation guard -> append -> COMMIT. */
  accept(
    mutation: RetrievalAcceptMutation,
    guard: {
      assertAuthorizedSync(): void;
      assertNewMutationSync(): void;
    },
  ): RetrievalReceipt;
  /** Read-only exact lookup; first proves/rolls back any open uncertain transaction. */
  lookupAccepted(key: RetrievalRequestKey): RetrievalReceipt | undefined;
  lookupJobOperation(key: RetrievalJobOperationKey): RetrievalJobOperationReceipt | undefined;
  markStarted(
    input: { readonly key: RetrievalJobOperationKey },
    guard: { assertCurrentSync(): void },
  ): RetrievalJobOperationReceipt;
  beginStage(
    input: {
      readonly jobId: string;
      readonly generationId: string;
      readonly manifest: RetrievalManifest;
    },
    guard: { assertCurrentSync(): void },
  ): RetrievalStageHandle;
  /** Each bounded batch writes <=128 chunks; FTS rows prepared here, never at publish. */
  stageBatch(
    stage: RetrievalStageHandle,
    input: {
      readonly chunks: readonly RetrievalPreparedChunk[];
      readonly vectors?: readonly RetrievalUnitVector[];
    },
    guard: { assertCurrentSync(): void },
  ): void;
  /**
   * Synchronous final transaction: prove exact complete staging/config/manifest,
   * call guard immediately before durable writes; append completed + active pointer
   * atomically. No await between guard, append, pointer, COMMIT. Guard is repeated
   * before COMMIT. It checks current Project/Memory/config/job fences only;
   * no inverse locks, I/O promises, abort listeners, network, or capture here.
   */
  publish(
    stage: RetrievalStageHandle,
    input: {
      readonly key: RetrievalJobOperationKey;
    },
    guard: { assertPublishCurrentSync(): void },
  ): RetrievalJobOperationReceipt;
  finish(
    input: {
      readonly key: RetrievalJobOperationKey;
      readonly terminal: Exclude<RetrievalTerminal, { status: 'completed' }>;
    },
    guard: { assertCanFinishSync(): void },
  ): RetrievalJobOperationReceipt;
  getJob(projectId: string, jobId: string): RetrievalJob | undefined;
  listJobs(input: {
    readonly projectId: string;
    readonly limit: number;
    readonly beforeSequence?: number;
  }): {
    readonly jobs: readonly RetrievalJob[];
    readonly hasMore: boolean;
  };
  status(project: RetrievalProjectIdentity): RetrievalIndexStatus;
  /** Called once per startup, never produces/restarts embedding work. */
  // Constructor validates/rebuilds all job rows; Server caps retained unfinished
  // job admission at2, so this list is bounded by prior supported ownership model.
  unfinishedJobs(): readonly RetrievalJob[];
  leaseActive(project: RetrievalProjectIdentity, expectedGenerationId?: string): RetrievalReadLease;
  /** FTS and vector/ranking work run in tracked bounded readers, not main-thread loops. */
  query(
    input: {
      readonly lease: RetrievalReadLease;
      readonly mode: RetrievalMode;
      readonly intent: RetrievalQueryIntent;
      readonly memoryAllowed: boolean;
      readonly vector?: readonly number[];
    },
    options: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<readonly RetrievalRankedCandidate[]>;
  readChunk(
    lease: RetrievalReadLease,
    citation: RetrievalCitation,
  ): RetrievalRankedCandidate | undefined;
  /** Only after actual query worker/connection cleanup; GC respects same lease. */
  releaseReadLease(lease: RetrievalReadLease): void;
  discardStage(stage: RetrievalStageHandle): void;
  collectGarbage(projectId: string): void;
}
// Concrete adapter and
// Server compositor check their own exact epoch in describe/execute. Runtime may
// hold an opaque config snapshot only via a host port, never use a key hash.
export interface RetrievalEmbeddingAuthorityPort {
  capture(): object;
  assertCurrentSync(snapshot: object): void;
}
export interface RetrievalEgressPort {
  /** Consumes exactly one private genuine execution admission or guarded local action. */
  consumeForBuild(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly manifestDigest: string;
    readonly permit: RetrievalEgressPermit;
    readonly batches: readonly RetrievalEmbeddingBatchDescription[];
  }): RetrievalJobEgressGrant;
  /** Marks this exact ordered batch as sent once; no automatic resend on uncertainty. */
  consumeBatchSync(
    grant: RetrievalJobEgressGrant,
    description: RetrievalEmbeddingBatchDescription,
  ): undefined;
  /** One semantic permit -> one batch -> one send; repeated approval is a new explicit action. */
  consumeQueryBatchSync(
    permit: RetrievalEgressPermit,
    description: RetrievalEmbeddingBatchDescription,
    binding: { readonly projectId: string; readonly requestId: string },
  ): undefined;
}
// The permit issuer lives only in Pipeline/guarded HTTP adapter. There is no
// public mint(approved:boolean), generic JSON issuer, or Plugin SDK export.
export interface RetrievalServiceOptions {
  readonly index: RetrievalIndexPort;
  readonly projects: RetrievalProjectResolver;
  readonly capture: RetrievalWorkspaceCapturePort;
  readonly memory: RetrievalMemorySourcePort;
  readonly embedding?: EmbeddingClientPort;
  readonly embeddingAuthority?: RetrievalEmbeddingAuthorityPort;
  readonly egress: RetrievalEgressPort;
  readonly budgets: RetrievalBudgets;
}
export interface RetrievalService extends RetrievalLifecycle, RetrievalInvalidationPort {
  readonly local: {
    capabilities(): RetrievalCapabilities;
    prepare(
      projectId: string,
      input: RetrievalPrepareInput,
      signal: AbortSignal,
    ): Promise<RetrievalPreview>;
    preview(
      projectId: string,
      previewId: string,
      page: { readonly cursor?: string | undefined },
      signal: AbortSignal,
    ): Promise<RetrievalPreviewPage>;
    previewText(
      projectId: string,
      input: z.infer<typeof retrievalPreviewTextInputSchema>,
      signal: AbortSignal,
    ): Promise<RetrievalTextPage>;
    /**
     * Compute exact replay key from input.mode + manifestDigest before looking
     * up preview. A new build must also match preview.mode exactly.
     * Guarded HTTP adapter binds local explicit-action permit; lexical needs none.
     */
    build(
      projectId: string,
      input: RetrievalBuildInput,
      permit: RetrievalEgressPermit | undefined,
      signal: AbortSignal,
    ): Promise<RetrievalReceipt>;
    jobs(
      projectId: string,
      page: { readonly cursor?: string | undefined },
      signal: AbortSignal,
    ): Promise<RetrievalJobPage>;
    job(projectId: string, jobId: string, signal: AbortSignal): Promise<RetrievalJobSnapshot>;
    status(projectId: string, signal: AbortSignal): Promise<RetrievalIndexStatus>;
    cancel(projectId: string, jobId: string, signal: AbortSignal): Promise<RetrievalCancelResult>;
    query(
      projectId: string,
      input: RetrievalQueryInput,
      permit: RetrievalEgressPermit | undefined,
      signal: AbortSignal,
    ): Promise<RetrievalQueryResult>;
    source(
      projectId: string,
      input: RetrievalSourceInput,
      signal: AbortSignal,
    ): Promise<RetrievalSourceResult>;
  };
  readonly agent: {
    prepareBuild(
      caller: RetrievalCaller,
      input: RetrievalBuildIntent,
      signal: AbortSignal,
    ): Promise<RetrievalPreparedBuild>;
    releaseBuild(prepared: RetrievalPreparedBuild): void;
    describeBuild(prepared: RetrievalPreparedBuild): {
      readonly preview?: RetrievalPreview;
      readonly receipt?: RetrievalReceipt;
    };
    executeBuild(
      caller: RetrievalCaller,
      input: RetrievalBuildIntent,
      prepared: RetrievalPreparedBuild | undefined,
      permit: RetrievalEgressPermit | undefined,
      signal: AbortSignal,
    ): Promise<RetrievalReceipt>;
    status(caller: RetrievalCaller, signal: AbortSignal): Promise<RetrievalIndexStatus>;
    cancel(
      caller: RetrievalCaller,
      jobId: string,
      signal: AbortSignal,
    ): Promise<RetrievalCancelResult>;
    query(
      caller: RetrievalCaller,
      input: RetrievalQueryIntent,
      mode: RetrievalMode,
      permit: RetrievalEgressPermit | undefined,
      signal: AbortSignal,
    ): Promise<RetrievalQueryResult>;
  };
}
