import type {
  RetrievalGeneration,
  RetrievalPreparedDocuments,
  RetrievalCapturedDocument,
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
  RetrievalProjectIdentity,
  RetrievalIndexStatus,
  RetrievalMode,
  RetrievalQueryIntent,
  RetrievalRankedCandidate,
  RetrievalCitation,
} from '@weave/protocol';

export interface RetrievalLifecycle {
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}
// Index handles are private exact objects in the concrete implementation.
export interface RetrievalReadLease {
  readonly generation: RetrievalGeneration;
}
export interface RetrievalStageHandle {
  readonly jobId: string;
  readonly generationId: string;
}
export interface RetrievalIndex extends RetrievalLifecycle {
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
