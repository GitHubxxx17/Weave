import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { flushSync } from 'react-dom';
import {
  conversationTurns,
  getConversationRow,
  getConversationTurn,
  resolveConversationTarget,
} from './conversation-model.js';
import { ConversationRow } from './conversation-row.js';
import type {
  ConversationAction,
  ConversationRunStatus,
  ConversationSnapshot,
  ConversationTarget,
  TimelineHandle,
} from './conversation-types.js';
import type { ConversationUiState } from './conversation-ui-state.js';
import type { TurnFileReviewStore } from '../file-undo/turn-file-review-store.js';
import { useConversationViewport } from './use-conversation-viewport.js';
import './conversation-window.css';

export interface ConversationTimelineProps {
  readonly snapshot: ConversationSnapshot;
  readonly projectId: string;
  readonly status: ConversationRunStatus;
  readonly sessionHasWork: boolean;
  readonly canCompose: boolean;
  readonly onAction: (action: ConversationAction) => void;
  readonly uiState: ConversationUiState;
  readonly fileReviewStore: TurnFileReviewStore;
  readonly emptyContent?: ReactNode;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const noPins: readonly string[] = [];

export const ConversationTimeline = forwardRef<TimelineHandle, ConversationTimelineProps>(
  function ConversationTimeline(
    {
      snapshot,
      projectId,
      status,
      sessionHasWork,
      canCompose,
      onAction,
      uiState,
      fileReviewStore,
      emptyContent,
    },
    ref,
  ): ReactElement {
    const viewport = useConversationViewport(snapshot.sessionId, snapshot.revision);
    const current = useRef(snapshot);
    current.current = snapshot;
    const navigationTicket = useRef(0);
    const active = useRef(true);
    const [interactionPins, setInteractionPins] = useState<readonly string[]>(noPins);
    const [revealPin, setRevealPin] = useState<string | undefined>(undefined);
    const getPins = useCallback(
      () => fileReviewStore.getPinnedTurnIds(projectId, snapshot.sessionId),
      [fileReviewStore, projectId, snapshot.sessionId],
    );
    const subscribePins = useCallback(
      (listener: () => void) => fileReviewStore.subscribePins(listener),
      [fileReviewStore],
    );
    const pendingTurns = useSyncExternalStore(subscribePins, getPins);
    const rowIndex = useMemo(
      () => new Map(snapshot.rowIds.map((id, index) => [id, index])),
      [snapshot.rowIds],
    );
    const pendingRows = useMemo(
      () =>
        pendingTurns.flatMap((id) => {
          for (const overlay of snapshot.liveOverlays.values()) {
            const row = overlay.lastReplyIdByTurn.get(id);
            if (row !== undefined) return [row];
          }
          const row = snapshot.lastReplyIdByTurn.get(id);
          return row === undefined ? [] : [row];
        }),
      [pendingTurns, snapshot.lastReplyIdByTurn, snapshot.liveOverlays],
    );
    const pinnedIndexes = useMemo(
      () =>
        [
          ...new Set([
            ...interactionPins,
            ...pendingRows,
            ...(revealPin === undefined ? [] : [revealPin]),
            ...(viewport.anchorRowId === undefined ? [] : [viewport.anchorRowId]),
          ]),
        ].flatMap((id) => {
          const index = rowIndex.get(id);
          return index === undefined ? [] : [index];
        }),
      [interactionPins, pendingRows, revealPin, rowIndex, viewport.anchorRowId],
    );
    const rangeExtractor = useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [...new Set([...defaultRangeExtractor(range), ...pinnedIndexes])].sort((a, b) => a - b),
      [pinnedIndexes],
    );
    const getScrollElement = useCallback(() => viewport.scrollRef.current, [viewport.scrollRef]);
    const getItemKey = useCallback(
      (index: number) => JSON.stringify([snapshot.sessionId, snapshot.rowIds[index]]),
      [snapshot.sessionId, snapshot.rowIds],
    );
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
      count: snapshot.rowIds.length,
      getScrollElement,
      estimateSize: () => 180,
      getItemKey,
      overscan: 8,
      rangeExtractor,
      onChange: viewport.scheduleReconcile,
      useFlushSync: false,
    });
    // The viewport adapter compensates its captured row exactly once after
    // measurement. The core's independent size compensation would double it.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    const items = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const turns = conversationTurns(snapshot);
    const lastTurnId = turns.at(-1)?.turnId;

    useLayoutEffect(() => {
      viewport.scheduleReconcile();
    }, [totalSize, snapshot.revision, viewport.scheduleReconcile]);
    useLayoutEffect(() => {
      const element = viewport.scrollRef.current;
      if (element === null || typeof ResizeObserver === 'undefined') return;
      let width = element.clientWidth;
      const observer = new ResizeObserver(() => {
        if (width === element.clientWidth) return;
        width = element.clientWidth;
        virtualizer.measure();
        viewport.scheduleReconcile();
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, [virtualizer, viewport.scrollRef, viewport.captureAnchor, viewport.scheduleReconcile]);
    useEffect(() => {
      active.current = true;
      return () => {
        active.current = false;
        navigationTicket.current++;
      };
    }, []);
    useEffect(() => {
      navigationTicket.current++;
      setInteractionPins(noPins);
      setRevealPin(undefined);
    }, [snapshot.sessionId]);

    const refreshInteractionPins = useCallback(() => {
      const element = viewport.scrollRef.current;
      if (element === null) return;
      const ids = new Set<string>();
      const add = (node: Node | null) => {
        const target = node instanceof Element ? node : node?.parentElement;
        const row = target?.closest<HTMLElement>('[data-message-id]');
        if (
          row !== null &&
          row !== undefined &&
          element.contains(row) &&
          row.dataset.messageId !== undefined
        )
          ids.add(row.dataset.messageId);
      };
      add(document.activeElement);
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed) {
        add(selection.anchorNode);
        add(selection.focusNode);
      }
      const next = [...ids];
      setInteractionPins((previous) =>
        previous.length === next.length && previous.every((id, index) => id === next[index])
          ? previous
          : next,
      );
    }, [viewport.scrollRef]);
    useEffect(() => {
      document.addEventListener('selectionchange', refreshInteractionPins);
      return () => document.removeEventListener('selectionchange', refreshInteractionPins);
    }, [refreshInteractionPins]);

    const scrollToBottom = useCallback(() => {
      navigationTicket.current++;
      virtualizer.cancelScroll();
      setRevealPin(undefined);
      viewport.scrollToBottom();
    }, [virtualizer, viewport.scrollToBottom]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        async reveal(target: ConversationTarget) {
          const ticket = ++navigationTicket.current;
          const initial = resolveConversationTarget(current.current, target);
          if (initial === undefined)
            return target.sessionId === current.current.sessionId ? 'missing' : 'stale';
          const sessionId = current.current.sessionId;
          const valid = () =>
            active.current &&
            ticket === navigationTicket.current &&
            current.current.sessionId === sessionId &&
            resolveConversationTarget(current.current, target)?.rowId === initial.rowId;
          const index = current.current.rowIds.indexOf(initial.rowId);
          viewport.pauseFollowing();
          try {
            // Navigation can be requested by an App layout/effect after switching
            // Sessions. Leave that lifecycle before committing a pinned row.
            await nextFrame();
            if (!valid()) return 'stale';
            flushSync(() => setRevealPin(initial.rowId));
            virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
            await nextFrame();
            if (!valid()) return 'stale';
            const element = viewport.scrollRef.current;
            const row =
              element === null
                ? undefined
                : [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
                    (entry) => entry.dataset.messageId === initial.rowId,
                  );
            if (row === undefined) return 'missing';
            flushSync(() => {
              uiState.setProcess(sessionId, initial.rowId, true);
              if (target.kind === 'tool')
                uiState.setTool(sessionId, initial.rowId, target.turnId, target.toolCallId, true);
            });
            await nextFrame();
            if (!valid()) return 'stale';
            virtualizer.measureElement(row);
            virtualizer.scrollToIndex(current.current.rowIds.indexOf(initial.rowId), {
              align: 'center',
              behavior: 'auto',
            });
            await nextFrame();
            if (!valid()) return 'stale';
            let focus: HTMLElement = row;
            if (target.kind === 'tool') {
              const tool = [...row.querySelectorAll<HTMLElement>('[data-tool-call-id]')].find(
                (entry) => entry.dataset.toolCallId === target.toolCallId,
              );
              const parameters = tool?.querySelector<HTMLElement>('[data-tool-parameters]');
              if (parameters === null || parameters === undefined) return 'missing';
              focus = parameters;
            }
            let stableFrames = 0;
            let previousLayout = '';
            for (let phase = 0; phase < 45 && stableFrames < 5; phase++) {
              virtualizer.cancelScroll();
              viewport.revealElement(focus);
              await nextFrame();
              if (!valid()) return 'stale';
              const layout = `${virtualizer.getTotalSize()}:${focus.getBoundingClientRect().top}:${viewport.scrollRef.current?.scrollTop}`;
              stableFrames = layout === previousLayout ? stableFrames + 1 : 0;
              previousLayout = layout;
            }
            viewport.finishNavigation();
            focus.focus({ preventScroll: true });
            viewport.captureAnchor();
            refreshInteractionPins();
            setRevealPin(undefined);
            return 'revealed';
          } finally {
            if (
              active.current &&
              ticket === navigationTicket.current &&
              current.current.sessionId === sessionId
            ) {
              virtualizer.cancelScroll();
              viewport.finishNavigation();
              setRevealPin(undefined);
            }
          }
        },
      }),
      [
        virtualizer,
        uiState,
        viewport.pauseFollowing,
        viewport.scrollToBottom,
        viewport.captureAnchor,
        viewport.scrollRef,
        viewport.revealElement,
        viewport.finishNavigation,
        refreshInteractionPins,
        scrollToBottom,
      ],
    );

    return (
      <div className="conversation-viewport">
        <div
          className="message-list conversation-scroll conversation-window"
          aria-label="Agent 工作流"
          data-session-id={snapshot.sessionId}
          data-logical-count={snapshot.rowIds.length}
          data-range-start={items[0]?.index ?? -1}
          data-range-end={items.at(-1)?.index ?? -1}
          ref={viewport.scrollRef}
          onScroll={viewport.onScroll}
          onWheelCapture={viewport.onUserScroll}
          onPointerDownCapture={viewport.onUserScroll}
          onTouchStartCapture={viewport.onUserScroll}
          onKeyDownCapture={viewport.onUserScroll}
          onFocusCapture={refreshInteractionPins}
          onBlurCapture={() => queueMicrotask(refreshInteractionPins)}
          onLoadCapture={viewport.scheduleReconcile}
        >
          {snapshot.rowIds.length === 0 ? (
            emptyContent
          ) : (
            <div role="list" className="conversation-window-space" style={{ height: totalSize }}>
              {items.map((item) => {
                const rowId = snapshot.rowIds[item.index];
                if (rowId === undefined) return null;
                const row = getConversationRow(snapshot, rowId);
                if (row === undefined) return null;
                const turn =
                  row.turnId === undefined ? undefined : getConversationTurn(snapshot, row.turnId);
                let lastReply =
                  row.turnId === undefined ? undefined : snapshot.lastReplyIdByTurn.get(row.turnId);
                let hasUser = row.turnId !== undefined && snapshot.userByTurn.has(row.turnId);
                let hasRetry = row.turnId !== undefined && snapshot.retryByTurn.has(row.turnId);
                for (const overlay of snapshot.liveOverlays.values()) {
                  if (row.turnId === undefined || overlay.owner.turnId !== row.turnId) continue;
                  lastReply = overlay.lastReplyIdByTurn.get(row.turnId) ?? lastReply;
                  hasUser ||= overlay.userByTurn.has(row.turnId);
                  hasRetry ||= overlay.retryByTurn.has(row.turnId);
                }
                return (
                  <article
                    role="listitem"
                    aria-posinset={item.index + 1}
                    aria-setsize={snapshot.rowIds.length}
                    className={`timeline-item timeline-item-${row.role} conversation-window-row`}
                    key={item.key}
                    data-index={item.index}
                    data-message-id={row.id}
                    data-message-index={item.index}
                    data-turn-id={row.turnId}
                    ref={virtualizer.measureElement}
                    tabIndex={-1}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <ConversationRow
                      row={row}
                      sessionId={snapshot.sessionId}
                      projectId={projectId}
                      turn={turn}
                      isLatestAssistant={snapshot.latestAssistantId === row.id}
                      isLastReply={lastReply === row.id}
                      canRetry={row.turnId === lastTurnId}
                      hasRetry={hasRetry}
                      hasUser={hasUser}
                      status={snapshot.latestAssistantId === row.id ? status : 'completed'}
                      sessionHasWork={sessionHasWork}
                      canCompose={canCompose}
                      onAction={onAction}
                      uiState={uiState}
                      fileReviewStore={fileReviewStore}
                    />
                  </article>
                );
              })}
            </div>
          )}
        </div>
        {!viewport.isAtBottom && snapshot.rowIds.length > 0 ? (
          <button
            className="scroll-to-bottom"
            type="button"
            aria-label="回到底部"
            onClick={scrollToBottom}
          >
            <ArrowDown aria-hidden="true" />
            {status === 'streaming' ? '有新内容' : '回到底部'}
          </button>
        ) : null}
      </div>
    );
  },
);
