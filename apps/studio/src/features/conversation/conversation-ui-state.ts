export interface ConversationRowUi {
  readonly processOpen: boolean;
  readonly openTools: ReadonlySet<string>;
}
export interface ConversationUiState {
  get(sessionId: string, rowId: string): ConversationRowUi;
  subscribe(sessionId: string, rowId: string, listener: () => void): () => void;
  setProcess(sessionId: string, rowId: string, open: boolean): void;
  setTool(
    sessionId: string,
    rowId: string,
    turnId: string | undefined,
    toolCallId: string,
    open: boolean,
  ): void;
  isToolOpen(
    sessionId: string,
    rowId: string,
    turnId: string | undefined,
    toolCallId: string,
  ): boolean;
  clear(): void;
}

const empty: ConversationRowUi = { processOpen: false, openTools: new Set() };
const rowKey = (sessionId: string, rowId: string) => JSON.stringify([sessionId, rowId]);
export const conversationToolKey = (
  sessionId: string,
  turnId: string | undefined,
  toolCallId: string,
): string => JSON.stringify([sessionId, turnId ?? null, toolCallId]);

/** Owned by a pane. Row detachment leaves disclosure state intact. */
export function createConversationUiState(): ConversationUiState {
  const states = new Map<string, ConversationRowUi>();
  const listeners = new Map<string, Set<() => void>>();
  function publish(key: string, next: ConversationRowUi) {
    states.set(key, next);
    for (const listener of listeners.get(key) ?? []) listener();
  }
  return {
    get: (sessionId, rowId) => states.get(rowKey(sessionId, rowId)) ?? empty,
    subscribe(sessionId, rowId, listener) {
      const key = rowKey(sessionId, rowId);
      const bucket = listeners.get(key) ?? new Set();
      listeners.set(key, bucket);
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(key);
      };
    },
    setProcess(sessionId, rowId, open) {
      const key = rowKey(sessionId, rowId);
      const previous = states.get(key) ?? empty;
      if (previous.processOpen !== open) publish(key, { ...previous, processOpen: open });
    },
    setTool(sessionId, rowId, turnId, toolCallId, open) {
      const key = rowKey(sessionId, rowId);
      const previous = states.get(key) ?? empty;
      const toolKey = conversationToolKey(sessionId, turnId, toolCallId);
      if (previous.openTools.has(toolKey) === open) return;
      const openTools = new Set(previous.openTools);
      if (open) openTools.add(toolKey);
      else openTools.delete(toolKey);
      publish(key, { ...previous, openTools });
    },
    isToolOpen(sessionId, rowId, turnId, toolCallId) {
      return (states.get(rowKey(sessionId, rowId)) ?? empty).openTools.has(
        conversationToolKey(sessionId, turnId, toolCallId),
      );
    },
    clear() {
      states.clear();
      listeners.clear();
    },
  };
}
