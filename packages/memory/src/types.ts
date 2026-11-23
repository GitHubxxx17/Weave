import type {
  MemoryAccess,
  MemoryAccessLevel,
  MemoryContent,
  MemoryCurrent,
  MemoryHistoryEntry,
  MemoryOperation,
  MemoryProvenance,
  MemoryReceipt,
  MemoryRef,
  MemoryScope,
  MemorySummary,
} from '@weave/protocol';

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
        readonly reason?: string | undefined;
      }
    | {
        readonly kind: 'setAccess';
        readonly level: MemoryAccessLevel;
        readonly expectedSettingRevision: number;
      }
  );
export interface MemoryCommitGuard {
  assertAuthorized(currentAccess: MemoryAccess): void;
  assertNewMutation(currentAccess: MemoryAccess, current: MemoryCurrent | undefined): void;
  beforeCommit(change: { readonly scope: MemoryScope; readonly memoryId?: string }): undefined;
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
export interface MemoryStore {
  lookupReceipt(key: MemoryRequestKey): MemoryReceipt | undefined;
  commit(mutation: MemoryMutation, guard: MemoryCommitGuard): MemoryReceipt;
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
  rebuild(): void;
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}
export interface MemoryEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: 'created' | 'revised' | 'reviewed' | 'deleted' | 'access-changed';
  readonly occurredAt: string;
  readonly subject: MemoryReceipt['subject'];
  readonly key: MemoryRequestKey;
  readonly operation: MemoryOperation;
  readonly provenance: MemoryProvenance;
  readonly previousRef?: MemoryRef | undefined;
  readonly current?: MemoryCurrent | undefined;
  readonly reason?: string | undefined;
  readonly access?: MemoryAccess | undefined;
  readonly receipt: MemoryReceipt;
}
