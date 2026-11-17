import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Distance from the bottom, in pixels, that still counts as "at the bottom". */
export const autoScrollThreshold = 80;

export interface AutoScrollState<T extends HTMLElement> {
  /** Attach to the scrollable element. */
  readonly ref: RefObject<T | null>;
  /** Whether the viewport is currently near the bottom. */
  readonly isAtBottom: boolean;
  /** Scroll handler for the scrollable element. */
  readonly onScroll: () => void;
  /** Jumps to the bottom and resumes following new content. */
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function scrollElementToBottom(element: HTMLElement, behavior: ScrollBehavior): void {
  if (behavior === 'smooth' && typeof element.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior });
    return;
  }
  element.scrollTop = element.scrollHeight;
}

/**
 * Keeps a scroll container pinned to its bottom while new content arrives.
 *
 * Following stops as soon as the user scrolls upward and resumes once the
 * user returns to the bottom or calls `scrollToBottom()`. Only upward
 * movement disables following, so a smooth programmatic scroll toward the
 * bottom cannot cancel itself halfway.
 *
 * @param contentVersion Changes whenever rendered content may have grown.
 * @param resetKey Changes when a different conversation is shown; forces the
 *   viewport back to the bottom and resumes following.
 */
export function useAutoScroll<T extends HTMLElement>(
  contentVersion: unknown,
  resetKey: unknown,
): AutoScrollState<T> {
  const ref = useRef<T | null>(null);
  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const atBottom = distanceFromBottom(element) <= autoScrollThreshold;
    const movedUp = element.scrollTop < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = element.scrollTop;

    if (atBottom) {
      followRef.current = true;
    } else if (movedUp) {
      followRef.current = false;
    }
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = ref.current;
    followRef.current = true;
    setIsAtBottom(true);
    if (element !== null) {
      scrollElementToBottom(element, behavior);
      lastScrollTopRef.current = element.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    followRef.current = true;
    const element = ref.current;
    if (element !== null) {
      scrollElementToBottom(element, 'auto');
      lastScrollTopRef.current = element.scrollTop;
    }
    setIsAtBottom(true);
  }, [resetKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || !followRef.current) {
      return;
    }
    scrollElementToBottom(element, 'auto');
    lastScrollTopRef.current = element.scrollTop;
  }, [contentVersion]);

  return { ref, isAtBottom, onScroll, scrollToBottom };
}
