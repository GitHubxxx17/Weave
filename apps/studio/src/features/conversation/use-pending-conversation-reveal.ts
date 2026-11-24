import { useEffect, type RefObject } from 'react';
import { resolveConversationTarget } from './conversation-model.js';
import type {
  ConversationStore,
  ConversationTarget,
  TimelineHandle,
} from './conversation-types.js';

/** Only a pending navigation subscribes; streamed rows never rerender App. */
export function usePendingConversationReveal(
  store: ConversationStore,
  sessionId: string,
  target: ConversationTarget | undefined,
  timeline: RefObject<TimelineHandle | null>,
  onRevealed: () => void,
): void {
  useEffect(() => {
    if (target === undefined || target.sessionId !== sessionId) return;
    let current = true;
    let busy = false;
    let retry = false;
    let publication = 0;
    let retriedPublication = -1;
    let frame: number | undefined;
    const attempt = () => {
      if (!current) return;
      if (busy) {
        retry = true;
        return;
      }
      if (resolveConversationTarget(store.getSnapshot(sessionId), target) === undefined) return;
      const handle = timeline.current;
      if (handle === null) return;
      busy = true;
      void handle.reveal(target).then((result) => {
        busy = false;
        if (!current) return;
        if (result === 'revealed') {
          current = false;
          onRevealed();
        } else if (retry) {
          retry = false;
          attempt();
        } else if (result === 'missing' && retriedPublication !== publication) {
          // Store notifications may precede the pane's React commit. Retry once
          // after that commit, retaining the same exact target and effect owner.
          retriedPublication = publication;
          frame = requestAnimationFrame(() => {
            frame = undefined;
            attempt();
          });
        }
      });
    };
    const unsubscribe = store.subscribeSession(sessionId, () => {
      publication++;
      attempt();
    });
    attempt();
    return () => {
      current = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [store, sessionId, target, timeline, onRevealed]);
}
