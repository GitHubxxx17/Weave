import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { TurnFileReviewStore } from '../file-undo/turn-file-review-store.js';
import { flushSync } from 'react-dom';
import { useConversation } from './use-conversation.js';
import { ConversationSearch } from './conversation-search.js';
import { ConversationTranscript } from './conversation-transcript.js';
import { ConversationTimeline } from './conversation-timeline.js';
import { createConversationUiState } from './conversation-ui-state.js';
import type {
  ConversationAction,
  ConversationRunStatus,
  ConversationStore,
  ConversationTarget,
  TimelineHandle,
} from './conversation-types.js';

export interface ConversationPaneProps {
  readonly store: ConversationStore;
  readonly sessionId: string;
  readonly projectId: string;
  readonly status: ConversationRunStatus;
  readonly sessionHasWork: boolean;
  readonly canCompose: boolean;
  readonly isChildSession: boolean;
  readonly onAction: (action: ConversationAction) => void;
  readonly emptyContent?: ReactNode;
  readonly fileReviewStore: TurnFileReviewStore;
  readonly expandedMessageId?: string | undefined;
}

/** App draft updates stop here; session publications enter through this subscription. */
export const ConversationPane = memo(
  forwardRef<TimelineHandle, ConversationPaneProps>(function ConversationPane(
    {
      store,
      sessionId,
      projectId,
      status,
      sessionHasWork,
      canCompose,
      isChildSession,
      onAction,
      emptyContent,
      fileReviewStore,
      expandedMessageId,
    },
    ref,
  ): ReactElement {
    const snapshot = useConversation(store, sessionId);
    const paneTicket = useRef(0);
    const lastPaneSession = useRef(sessionId);
    if (lastPaneSession.current !== sessionId) {
      lastPaneSession.current = sessionId;
      paneTicket.current++;
    }
    useEffect(
      () => () => {
        paneTicket.current++;
      },
      [],
    );
    const timeline = useRef<TimelineHandle | null>(null);
    // A session switch starts a fresh presentation cache. Pending file undo
    // state belongs to the independent App-lifetime fileReviewStore.
    const uiStates = useRef({ sessionId, state: createConversationUiState() });
    if (uiStates.current.sessionId !== sessionId)
      uiStates.current = { sessionId, state: createConversationUiState() };
    const uiState = uiStates.current.state;
    const [showTranscript, setShowTranscript] = useState(false);
    const active = useRef(sessionId);
    active.current = sessionId;
    useEffect(() => {
      setShowTranscript(false);
    }, [sessionId]);
    useEffect(() => {
      if (expandedMessageId !== undefined) uiState.setProcess(sessionId, expandedMessageId, true);
    }, [uiState, sessionId, expandedMessageId]);
    const revealTarget = useCallback(
      async (target: ConversationTarget): Promise<'revealed' | 'missing' | 'stale'> => {
        const ticket = ++paneTicket.current;
        if (target.sessionId !== active.current) return 'stale';
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (ticket !== paneTicket.current || target.sessionId !== active.current) return 'stale';
        flushSync(() => setShowTranscript(false));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (ticket !== paneTicket.current || target.sessionId !== active.current) return 'stale';
        return timeline.current?.reveal(target) ?? 'missing';
      },
      [],
    );
    const reveal = useCallback(
      (target: ConversationTarget) => {
        void revealTarget(target);
      },
      [revealTarget],
    );
    useImperativeHandle(
      ref,
      () => ({
        reveal: revealTarget,
        scrollToBottom: () => {
          paneTicket.current++;
          timeline.current?.scrollToBottom();
        },
      }),
      [revealTarget],
    );
    return (
      <section className="conversation-pane">
        <div className="conversation-tools">
          <ConversationSearch key={sessionId} snapshot={snapshot} onReveal={reveal} />
          <button
            type="button"
            onClick={() => setShowTranscript((current) => !current)}
            aria-expanded={showTranscript}
          >
            完整文本
          </button>
        </div>
        {showTranscript ? (
          <ConversationTranscript snapshot={snapshot} onClose={() => setShowTranscript(false)} />
        ) : (
          <ConversationTimeline
            ref={timeline}
            snapshot={snapshot}
            projectId={projectId}
            status={status}
            sessionHasWork={sessionHasWork}
            canCompose={canCompose}
            onAction={onAction}
            uiState={uiState}
            fileReviewStore={fileReviewStore}
            emptyContent={
              isChildSession ? (
                <p className="task-child-empty">子任务会话暂无消息。</p>
              ) : (
                emptyContent
              )
            }
          />
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {status === 'streaming'
            ? 'Agent 正在回复'
            : status === 'completed'
              ? 'Agent 回复完成'
              : status === 'error'
                ? 'Agent 运行失败'
                : status === 'cancelled'
                  ? 'Agent 运行已取消'
                  : ''}
        </span>
      </section>
    );
  }),
);
