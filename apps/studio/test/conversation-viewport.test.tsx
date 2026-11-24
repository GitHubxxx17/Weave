// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useConversationViewport } from '../src/features/conversation/use-conversation-viewport.js';
import { revealViewportTarget } from '../src/features/conversation/use-conversation-viewport.js';
afterEach(cleanup);
function Harness({
  version,
  sessionId,
  height,
}: {
  version: number;
  sessionId: string;
  height: number;
}) {
  const view = useConversationViewport(sessionId, version);
  return (
    <>
      <div
        data-testid="scroll"
        ref={(element) => {
          view.scrollRef.current = element;
          if (element) {
            Object.defineProperty(element, 'scrollHeight', {
              configurable: true,
              get: () => height,
            });
            Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 400 });
          }
        }}
        onScroll={view.onScroll}
        onWheel={view.onUserScroll}
      />
      <p>{view.isAtBottom ? 'following' : 'reading'}</p>
      <button onClick={view.scrollToBottom}>bottom</button>
    </>
  );
}
describe('single scroll owner', () => {
  it('brings exact tool parameters into view when its containing row is taller than the viewport', () => {
    const scroll = document.createElement('div');
    const target = document.createElement('pre');
    Object.defineProperty(scroll, 'clientHeight', { value: 400 });
    scroll.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: 2000, bottom: 2200 }) as DOMRect;
    scroll.scrollTop = 500;
    revealViewportTarget(scroll, target);
    expect(scroll.scrollTop).toBe(2388);
  });
  it('follows within 80px and preserves an upward reading offset across live changes', () => {
    const view = render(<Harness version={1} sessionId="a" height={1000} />);
    const element = screen.getByTestId('scroll');
    act(() => {
      element.scrollTop = 200;
      fireEvent.wheel(element, { deltaY: -100 });
      fireEvent.scroll(element);
    });
    expect(screen.getByText('reading')).toBeTruthy();
    view.rerender(<Harness version={2} sessionId="a" height={1600} />);
    expect(element.scrollTop).toBe(200);
    fireEvent.click(screen.getByRole('button', { name: 'bottom' }));
    expect(screen.getByText('following')).toBeTruthy();
    view.rerender(<Harness version={3} sessionId="a" height={1800} />);
    expect(element.scrollTop).toBe(1800);
  });
});
