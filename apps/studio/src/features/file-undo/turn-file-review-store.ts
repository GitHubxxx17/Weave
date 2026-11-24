import {
  fetchTurnFileReview,
  undoTurnFiles,
  type FileUndoReview,
  type UndoFileResult,
  type UndoRequest,
} from './file-undo-api.js';
export interface TurnFileReviewOwner {
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId: string;
}
export interface TurnFileReviewState {
  readonly open: boolean;
  readonly review?: FileUndoReview | undefined;
  readonly results?: readonly UndoFileResult[] | undefined;
  readonly error: string;
  readonly loading: boolean;
  readonly confirm: boolean;
  readonly pending?: UndoRequest | undefined;
  readonly diffPath?: string | undefined;
}
export interface TurnFileReviewStore {
  get(owner: TurnFileReviewOwner): TurnFileReviewState;
  subscribe(owner: TurnFileReviewOwner, listener: () => void): () => void;
  subscribePins(listener: () => void): () => void;
  getPinnedTurnIds(projectId: string, sessionId: string): readonly string[];
  set(owner: TurnFileReviewOwner, update: Partial<TurnFileReviewState>): void;
  removeSession(projectId: string, sessionId: string): void;
  dispose(): void;
  load(owner: TurnFileReviewOwner): Promise<void>;
  restore(owner: TurnFileReviewOwner, disabled: () => boolean, input?: UndoRequest): Promise<void>;
}
const empty: TurnFileReviewState = Object.freeze({
  open: false,
  error: '',
  loading: false,
  confirm: false,
});
const key = ({ projectId, sessionId, turnId }: TurnFileReviewOwner) =>
  JSON.stringify([projectId, sessionId, turnId]);
/** App-lifetime request ownership; a virtual row unmount is only a view detach. */
export function createTurnFileReviewStore(): TurnFileReviewStore {
  const states = new Map<string, TurnFileReviewState>();
  const owners = new Map<string, TurnFileReviewOwner>();
  const listeners = new Map<string, Set<() => void>>();
  const pins = new Set<() => void>();
  const pinCache = new Map<string, readonly string[]>();
  const removedEntries = new Set<string>();
  let disposed = false;
  const notifyPins = () => {
    pinCache.clear();
    if (!disposed) for (const listener of pins) listener();
  };
  const touch = (id: string) => {
    const state = states.get(id);
    if (state !== undefined) {
      states.delete(id);
      states.set(id, state);
    }
  };
  const remove = (id: string) => {
    const previous = states.get(id);
    states.delete(id);
    owners.delete(id);
    removedEntries.delete(id);
    if (!disposed) for (const listener of listeners.get(id) ?? []) listener();
    if (previous?.pending !== undefined || previous?.loading) notifyPins();
  };
  const prune = () => {
    if (disposed) return;
    const settled: string[] = [];
    for (const [id, state] of states) {
      if (state.pending !== undefined || state.loading) continue;
      if (removedEntries.has(id)) remove(id);
      else if (!state.open && !listeners.get(id)?.size) settled.push(id);
    }
    // Active views and uncertain requests are outside the settled-cache budget.
    for (const id of settled.slice(0, Math.max(0, settled.length - 32))) remove(id);
  };
  const store: TurnFileReviewStore = {
    get(owner) {
      if (disposed) return empty;
      const id = key(owner);
      touch(id);
      return states.get(id) ?? empty;
    },
    subscribe(owner, listener) {
      if (disposed) return () => {};
      const id = key(owner);
      const bucket = listeners.get(id) ?? new Set();
      listeners.set(id, bucket);
      bucket.add(listener);
      touch(id);
      return () => {
        bucket.delete(listener);
        if (!bucket.size) listeners.delete(id);
        prune();
      };
    },
    subscribePins(listener) {
      if (disposed) return () => {};
      pins.add(listener);
      return () => {
        pins.delete(listener);
      };
    },
    getPinnedTurnIds(projectId, sessionId) {
      if (disposed) return [];
      const id = JSON.stringify([projectId, sessionId]);
      const cached = pinCache.get(id);
      if (cached) return cached;
      const result = [...states].flatMap(([entry, state]) => {
        const owner = owners.get(entry)!;
        return (state.pending !== undefined || state.loading) &&
          owner.projectId === projectId &&
          owner.sessionId === sessionId
          ? [owner.turnId]
          : [];
      });
      if (pinCache.size >= 32) pinCache.delete(pinCache.keys().next().value!);
      pinCache.set(id, result);
      return result;
    },
    set(owner, update) {
      if (disposed) return;
      const id = key(owner);
      const previous = store.get(owner);
      const next = { ...previous, ...update };
      states.delete(id);
      states.set(id, next);
      owners.set(id, owner);
      for (const listener of listeners.get(id) ?? []) listener();
      if (Boolean(previous.pending || previous.loading) !== Boolean(next.pending || next.loading)) {
        notifyPins();
      }
      prune();
    },
    removeSession(projectId, sessionId) {
      if (disposed) return;
      for (const [id, owner] of owners)
        if (owner.projectId === projectId && owner.sessionId === sessionId) removedEntries.add(id);
      prune();
    },
    dispose() {
      disposed = true;
      states.clear();
      owners.clear();
      listeners.clear();
      pins.clear();
      pinCache.clear();
      removedEntries.clear();
    },
    async load(owner) {
      if (disposed || store.get(owner).loading) return;
      store.set(owner, { loading: true, error: '' });
      try {
        const review = await fetchTurnFileReview(owner.projectId, owner.sessionId, owner.turnId);
        const pending = store.get(owner).pending;
        const confirmsPending =
          review.operation?.status === 'completed' &&
          review.operation.operationId === pending?.operationId &&
          review.operation.requestId === pending?.requestId;
        store.set(owner, {
          review,
          results: review.operation?.results,
          ...(review.operation?.status === 'pending'
            ? {
                pending: {
                  turnId: owner.turnId,
                  operationId: review.operation.operationId,
                  requestId: review.operation.requestId,
                },
              }
            : confirmsPending
              ? { pending: undefined }
              : {}),
        });
      } catch (caught) {
        store.set(owner, { error: caught instanceof Error ? caught.message : '加载失败' });
      } finally {
        store.set(owner, { loading: false });
      }
    },
    async restore(owner, disabled, input) {
      const current = store.get(owner);
      if (disposed || current.loading || disabled()) return;
      const exact = input ??
        current.pending ?? {
          turnId: owner.turnId,
          operationId: current.review?.operation?.operationId ?? crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        };
      store.set(owner, { loading: true, error: '', pending: exact });
      try {
        const response = await undoTurnFiles(owner.projectId, owner.sessionId, exact);
        store.set(owner, { results: response.results, pending: undefined, confirm: false });
        if (disposed || removedEntries.has(key(owner))) return;
        try {
          store.set(owner, {
            review: await fetchTurnFileReview(owner.projectId, owner.sessionId, owner.turnId),
          });
        } catch {
          store.set(owner, { error: '结果已保存，重新打开审阅可刷新文件记录。' });
        }
      } catch (caught) {
        store.set(owner, {
          error: caught instanceof Error ? caught.message : '请求未完成，请重试原请求',
        });
      } finally {
        store.set(owner, { loading: false });
      }
    },
  };
  return store;
}
