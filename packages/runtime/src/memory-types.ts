import type {
  MemoryAccess,
  MemoryAccessLevel,
  MemoryContent,
  MemoryCurrent,
  MemoryHistoryEntry,
  MemoryProvenance,
  MemoryReceipt,
  MemoryRef,
  MemoryScope,
  MemorySummary,
} from '@weave/protocol';
import type { AgentToolInvocationAuthority } from './agent-tool-authority.js';

export type MemorySessionMembership =
  | { readonly kind: 'none' }
  | { readonly kind: 'unique'; readonly projectId: string }
  | { readonly kind: 'ambiguous' };

export interface MemoryScopeEvidence {
  readonly membership: MemorySessionMembership;
  assertCurrentSync(): void;
}

export interface MemoryLocalScopeEvidence {
  assertCurrentSync(): void;
}

export interface MemoryRequestKey {
  readonly scope: MemoryScope;
  readonly requestId: string;
  readonly callerKey: string;
  readonly digest: string;
}

interface MutationBase {
  readonly key: MemoryRequestKey;
  readonly provenance: MemoryProvenance;
}

export type MemoryMutation = MutationBase &
  (
    | { readonly kind: 'create'; readonly content: MemoryContent; readonly expectedRevision: 0 }
    | {
        readonly kind: 'revise';
        readonly memoryId: string;
        readonly expectedRevision: number;
        readonly content: MemoryContent;
      }
    | { readonly kind: 'review'; readonly targetRef: MemoryRef }
    | {
        readonly kind: 'remove';
        readonly memoryId: string;
        readonly expectedRevision: number;
        readonly reason?: string;
      }
    | {
        readonly kind: 'setAccess';
        readonly level: MemoryAccessLevel;
        readonly expectedSettingRevision: number;
      }
  );

export interface MemoryInvalidation {
  readonly scope: MemoryScope;
  readonly memoryId?: string;
  readonly liveEpoch: number;
}
export type BeforeMemoryCommit = (change: MemoryInvalidation) => undefined;

export interface MemoryStoreWritePort {
  lookupReceipt(key: MemoryRequestKey): MemoryReceipt | undefined;
  commit(
    mutation: MemoryMutation,
    guard: {
      assertAuthorized(currentAccess: MemoryAccess): void;
      assertNewMutation(currentAccess: MemoryAccess, current: MemoryCurrent | undefined): void;
      beforeCommit(change: Omit<MemoryInvalidation, 'liveEpoch'>): undefined;
    },
  ): MemoryReceipt;
}

export interface MemorySortKey {
  readonly titleHit: number;
  readonly updatedAt: string;
  readonly scopeRank: number;
  readonly memoryId: string;
}
export interface MemoryScopeHead {
  readonly scope: MemoryScope;
  readonly sequence: number;
}
export interface MemorySearchInput {
  readonly scopes: readonly MemoryScope[];
  readonly limit: number;
  readonly query?: string;
  readonly tag?: string;
  readonly includeAgentAuthored?: boolean;
  readonly after?: MemorySortKey;
}
export interface MemorySearchPage {
  readonly entries: readonly MemorySummary[];
  readonly keys: readonly MemorySortKey[];
  readonly scopeHeads: readonly MemoryScopeHead[];
  readonly hasMore: boolean;
}

/** Structural port implemented by Server's independent SQLite leaf. */
export interface MemoryStorePort extends MemoryStoreWritePort {
  read(scope: MemoryScope, memoryId: string): MemoryCurrent | undefined;
  readRevision(ref: MemoryRef): MemoryCurrent | undefined;
  history(
    scope: MemoryScope,
    memoryId: string,
    input?: { readonly limit?: number; readonly afterRevision?: number },
  ): readonly MemoryHistoryEntry[];
  getAccess(scope: MemoryScope): MemoryAccess;
  getScopeHead(scope: MemoryScope): number;
  list(input: MemorySearchInput): MemorySearchPage;
  search(input: MemorySearchInput, signal?: AbortSignal): Promise<MemorySearchPage>;
  readSnapshot(refs: readonly MemoryRef[]): readonly MemoryCurrent[];
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface ReviewedMemoryCapture {
  readonly projectId: string;
  readonly settingRevision: number;
  readonly liveEpoch: number;
  readonly records: readonly {
    readonly ref: MemoryRef;
    readonly content: MemoryContent;
  }[];
}

/** Host-only evidence for filtering indexed memory before ranking. */
export interface ReviewedMemoryAccessCapture {
  readonly projectId: string;
  readonly level: MemoryAccessLevel;
  readonly settingRevision: number;
  readonly liveEpoch: number;
}

export interface ReviewedMemorySource {
  capture(input: {
    readonly projectId: string;
    readonly refs: readonly MemoryRef[];
    readonly signal: AbortSignal;
  }): Promise<ReviewedMemoryCapture>;
  assertCurrentSync(capture: ReviewedMemoryCapture): void;
  captureAccess(input: {
    readonly projectId: string;
    readonly signal: AbortSignal;
  }): Promise<ReviewedMemoryAccessCapture>;
  assertAccessCurrentSync(capture: ReviewedMemoryAccessCapture): void;
}

export interface MemoryServiceOptions {
  readonly store: MemoryStorePort;
  readonly resolveAgentScope: (
    caller: AgentToolInvocationAuthority,
  ) => Promise<MemoryScopeEvidence>;
  readonly resolveLocalScope: (scope: MemoryScope) => Promise<MemoryLocalScopeEvidence>;
  readonly beforeMemoryCommit?: BeforeMemoryCommit;
  readonly budgets?: {
    readonly maxBytes?: number;
    readonly maxToolResultTokens?: number;
  };
}

export interface MemoryPage<T> {
  readonly entries: readonly T[];
  readonly nextCursor?: string;
}
