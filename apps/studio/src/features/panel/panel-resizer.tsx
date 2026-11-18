import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { z } from 'zod';

/** Width bounds of the side panel, in CSS pixels. */
export const sidePanelWidthLimits = { min: 260, max: 720, default: 292 } as const;

/** The conversation never gets narrower than this while the panel is dragged. */
const minConversationWidth = 380;
const keyboardStep = 16;
const storageKey = 'weave.studio.sidePanelWidth';

const storedWidthSchema = z.coerce
  .number()
  .int()
  .min(sidePanelWidthLimits.min)
  .max(sidePanelWidthLimits.max);

function clampWidth(width: number, max: number = sidePanelWidthLimits.max): number {
  return Math.round(Math.min(Math.max(width, sidePanelWidthLimits.min), max));
}

/** Reads the saved width; missing or invalid values fall back to the default. */
export function readSidePanelWidth(): number {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey) ?? undefined;
    const parsed = storedWidthSchema.safeParse(stored);
    return parsed.success ? parsed.data : sidePanelWidthLimits.default;
  } catch {
    return sidePanelWidthLimits.default;
  }
}

function saveSidePanelWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(storageKey, String(width));
  } catch {
    // Storage can be unavailable (private mode, quota); the width still applies.
  }
}

/** Persisted side panel width; `setWidth` clamps and saves. */
export function useSidePanelWidth(): readonly [number, (width: number) => void] {
  const [width, setWidthState] = useState(() => readSidePanelWidth());
  return [
    width,
    (next: number) => {
      const clamped = clampWidth(next);
      setWidthState(clamped);
      saveSidePanelWidth(clamped);
    },
  ];
}

/**
 * Vertical splitter on the panel's left edge. Dragging writes the width to the
 * shell's `--panel-width` variable directly, so the large App tree does not
 * re-render on every pointer move; the final width is committed on release.
 * Arrow keys adjust it, and a double-click restores the default.
 */
export function PanelResizer({
  width,
  shellRef,
  conversationRef,
  onResize,
}: {
  readonly width: number;
  readonly shellRef: RefObject<HTMLElement | null>;
  readonly conversationRef: RefObject<HTMLElement | null>;
  readonly onResize: (width: number) => void;
}): ReactElement {
  const drag = useRef<{ startX: number; startWidth: number; max: number; current: number } | null>(
    null,
  );
  const [isDragging, setIsDragging] = useState(false);

  /** The widest the panel can get without squeezing the conversation too far. */
  function maxWidth(startWidth: number): number {
    const conversationWidth = conversationRef.current?.getBoundingClientRect().width;
    if (conversationWidth === undefined || conversationWidth === 0) {
      return sidePanelWidthLimits.max;
    }
    return clampWidth(startWidth + conversationWidth - minConversationWidth);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    // Optional call: some environments (jsdom) do not implement pointer capture.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      startX: event.clientX,
      startWidth: width,
      max: maxWidth(width),
      current: width,
    };
    setIsDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const state = drag.current;
    if (state === null) {
      return;
    }
    // The panel sits on the right, so moving left makes it wider.
    state.current = clampWidth(state.startWidth + state.startX - event.clientX, state.max);
    shellRef.current?.style.setProperty('--panel-width', `${state.current}px`);
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>): void {
    const state = drag.current;
    if (state === null) {
      return;
    }
    drag.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResize(state.current);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? keyboardStep : -keyboardStep;
      onResize(clampWidth(width + delta, maxWidth(width)));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onResize(event.key === 'Home' ? sidePanelWidthLimits.min : maxWidth(width));
    }
  }

  return (
    <div
      className={`panel-resizer${isDragging ? ' panel-resizer-active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      aria-valuemin={sidePanelWidthLimits.min}
      aria-valuemax={sidePanelWidthLimits.max}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={() => onResize(sidePanelWidthLimits.default)}
      onKeyDown={handleKeyDown}
    />
  );
}
