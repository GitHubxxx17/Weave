import type { RetrievalEmbeddingBatchDescription, RetrievalVectorIdentity } from '@weave/protocol';

export interface EmbeddingInput {
  readonly id: string;
  readonly text: string;
  readonly sha256: string;
}

export interface EmbeddingBatch {
  readonly description: RetrievalEmbeddingBatchDescription;
  readonly inputs: readonly EmbeddingInput[];
}

export interface EmbeddingVector {
  readonly id: string;
  readonly values: readonly number[];
  readonly sha256: string;
}

export interface EmbeddingClient {
  readonly identity: Readonly<RetrievalVectorIdentity>;
  /** Provides immutable inputs and exact body metadata for the host to authorize. */
  describeBatches(inputs: readonly EmbeddingInput[]): readonly EmbeddingBatch[];
  embedBatch(
    batch: EmbeddingBatch,
    options: {
      readonly signal: AbortSignal;
      /** Absolute epoch milliseconds, including time spent waiting for a slot. */
      readonly deadline: number;
      /** Consumes host authority synchronously after slot acquisition, immediately before fetch. */
      readonly beforeSendSync: (description: RetrievalEmbeddingBatchDescription) => undefined;
    },
  ): Promise<readonly EmbeddingVector[]>;
  /** Fences further results and sends without aborting transports inside the caller's gate. */
  closeSync(): void;
  /** Cancels and waits for owned work. A timed-out drain can be retried on this client. */
  drain(): Promise<void>;
  close(): Promise<void>;
}
