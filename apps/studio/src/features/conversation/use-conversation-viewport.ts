import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface ViewportAnchor {
  readonly rowId: string;
  readonly offset: number;
}
export const conversationFollowThreshold = 80;

/** Align an exact descendant, including parameters far inside one tall row. */
export function revealViewportTarget(scroll: HTMLElement, target: HTMLElement): void {
  const bounds = scroll.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  if (rect.top < bounds.top + 12 || rect.bottom > bounds.top + scroll.clientHeight - 12) {
    scroll.scrollTop += rect.top - bounds.top - 12;
  }
}

/** One adapter owns following, reveal commands and measured reading anchors. */
export function useConversationViewport(sessionId: string, contentVersion: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const navigating = useRef(false);
  const lastTop = useRef(0);
  const anchor = useRef<ViewportAnchor | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const userScrollUntil = useRef(0);
  const [anchorRowId, setAnchorRowId] = useState<string | undefined>(undefined);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const captureAnchor = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (navigating.current) return;
    const top = element.getBoundingClientRect().top;
    const rows = element.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top && rect.top < top + element.clientHeight) {
        anchor.current = { rowId: row.dataset.messageId!, offset: rect.top - top };
        setAnchorRowId(row.dataset.messageId);
        return;
      }
    }
  }, []);

  const reconcile = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (navigating.current) return;
    if (following.current) {
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
      return;
    }
    const saved = anchor.current;
    if (saved !== undefined) {
      const row = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (entry) => entry.dataset.messageId === saved.rowId,
      );
      if (row !== undefined) {
        const displacement =
          row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
        if (Math.abs(displacement) > 0.25) element.scrollTop += displacement;
      }
    }
    lastTop.current = element.scrollTop;
  }, []);
  const scheduleReconcile = useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      reconcile();
    });
  }, [reconcile]);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (navigating.current) {
      lastTop.current = element.scrollTop;
      return;
    }
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      conversationFollowThreshold;
    if (nearBottom) following.current = true;
    else if (element.scrollTop < lastTop.current - 1 && performance.now() < userScrollUntil.current)
      following.current = false;
    lastTop.current = element.scrollTop;
    setIsAtBottom(nearBottom);
    if (!following.current && performance.now() < userScrollUntil.current) captureAnchor();
  }, [captureAnchor]);
  const pauseFollowing = useCallback(() => {
    following.current = false;
    navigating.current = true;
    anchor.current = undefined;
    setAnchorRowId(undefined);
    setIsAtBottom(false);
  }, []);
  const scrollToBottom = useCallback(() => {
    navigating.current = false;
    following.current = true;
    anchor.current = undefined;
    setAnchorRowId(undefined);
    setIsAtBottom(true);
    reconcile();
    scheduleReconcile();
  }, [reconcile, scheduleReconcile]);
  const revealElement = useCallback((target: HTMLElement) => {
    const element = scrollRef.current;
    if (element === null) return;
    following.current = false;
    revealViewportTarget(element, target);
    lastTop.current = element.scrollTop;
  }, []);
  const finishNavigation = useCallback(() => {
    navigating.current = false;
    following.current = false;
    captureAnchor();
  }, [captureAnchor]);

  useLayoutEffect(() => {
    navigating.current = false;
    following.current = true;
    anchor.current = undefined;
    setAnchorRowId(undefined);
    setIsAtBottom(true);
    reconcile();
    scheduleReconcile();
  }, [sessionId, reconcile, scheduleReconcile]);
  useLayoutEffect(reconcile, [contentVersion, reconcile]);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return {
    scrollRef,
    following,
    anchor,
    anchorRowId,
    isAtBottom,
    onScroll,
    captureAnchor,
    pauseFollowing,
    scrollToBottom,
    revealElement,
    finishNavigation,
    onUserScroll: () => {
      userScrollUntil.current = performance.now() + 300;
    },
    scheduleReconcile,
  };
}
