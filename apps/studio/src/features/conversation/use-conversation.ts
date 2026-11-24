import { useCallback, useSyncExternalStore } from 'react';
import {
  conversationToolMessages,
  conversationTurns,
  type ConversationToolMessage,
} from './conversation-model.js';
import type { ConversationSnapshot, ConversationStore } from './conversation-types.js';
import type { TurnSummary } from '../workspace/workspace-types.js';

function useConversationSelector<T>(
  store: ConversationStore,
  sessionId: string,
  select: (snapshot: ConversationSnapshot) => T,
): T {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeSession(sessionId, listener),
    [store, sessionId],
  );
  const read = useCallback(() => select(store.getSnapshot(sessionId)), [store, sessionId, select]);
  return useSyncExternalStore(subscribe, read, read);
}
const identity = (snapshot: ConversationSnapshot): ConversationSnapshot => snapshot;
/** Subscribe at the pane boundary; App and Composer do not read this snapshot. */
export function useConversation(store: ConversationStore, sessionId: string): ConversationSnapshot {
  return useConversationSelector(store, sessionId, identity);
}
/** Turn facts retain their identity across answer/reasoning token updates. */
export function useConversationTurns(
  store: ConversationStore,
  sessionId: string,
): readonly TurnSummary[] {
  return useConversationSelector(store, sessionId, conversationTurns);
}
/** Minimal message facets retain identity until topology or a tool changes. */
export function useConversationTools(
  store: ConversationStore,
  sessionId: string,
): readonly ConversationToolMessage[] {
  return useConversationSelector(store, sessionId, conversationToolMessages);
}
export const useConversationToolMessages = useConversationTools;
