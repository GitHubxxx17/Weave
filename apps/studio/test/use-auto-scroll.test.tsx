// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useAutoScroll } from '../src/features/conversation/use-auto-scroll.js';

type Geometry = { scrollHeight: number; clientHeight: number };

function Harness({
  version,
  sessionId,
  geometry,
}: {
  readonly version: number;
  readonly sessionId: string;
  readonly geometry: Geometry;
}) {
  const scroll = useAutoScroll<HTMLDivElement>(version, sessionId);
  return (
    <div>
      <div
        data-testid="viewport"
        ref={(element) => {
          scroll.ref.current = element;
          if (element !== null) {
            Object.defineProperty(element, 'scrollHeight', {
              configurable: true,
              get: () => geometry.scrollHeight,
            });
            Object.defineProperty(element, 'clientHeight', {
              configurable: true,
              get: () => geometry.clientHeight,
            });
          }
        }}
        onScroll={scroll.onScroll}
      />
      <span data-testid="at-bottom">{String(scroll.isAtBottom)}</span>
      <button type="button" onClick={() => scroll.scrollToBottom('auto')}>
        bottom
      </button>
    </div>
  );
}

function viewport(): HTMLDivElement {
  return screen.getByTestId('viewport') as HTMLDivElement;
}

function userScrollTo(top: number): void {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
}

describe('useAutoScroll', () => {
  afterEach(() => cleanup());

  it('follows new content while the viewport stays at the bottom', () => {
    const geometry = { scrollHeight: 1000, clientHeight: 400 };
    const { rerender } = render(<Harness version={1} sessionId="s1" geometry={geometry} />);
    expect(viewport().scrollTop).toBe(1000);

    geometry.scrollHeight = 1600;
    rerender(<Harness version={2} sessionId="s1" geometry={geometry} />);

    expect(viewport().scrollTop).toBe(1600);
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
  });

  it('stops following after the user scrolls up and resumes from the button', () => {
    const geometry = { scrollHeight: 1000, clientHeight: 400 };
    const { rerender } = render(<Harness version={1} sessionId="s1" geometry={geometry} />);
    userScrollTo(600);
    userScrollTo(200);
    expect(screen.getByTestId('at-bottom').textContent).toBe('false');

    geometry.scrollHeight = 1600;
    rerender(<Harness version={2} sessionId="s1" geometry={geometry} />);
    expect(viewport().scrollTop).toBe(200);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'bottom' }));
    });
    expect(viewport().scrollTop).toBe(1600);
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');

    geometry.scrollHeight = 2000;
    rerender(<Harness version={3} sessionId="s1" geometry={geometry} />);
    expect(viewport().scrollTop).toBe(2000);
  });

  it('resumes following when the user scrolls back near the bottom', () => {
    const geometry = { scrollHeight: 1000, clientHeight: 400 };
    const { rerender } = render(<Harness version={1} sessionId="s1" geometry={geometry} />);
    userScrollTo(600);
    userScrollTo(100);
    userScrollTo(560);
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');

    geometry.scrollHeight = 1400;
    rerender(<Harness version={2} sessionId="s1" geometry={geometry} />);
    expect(viewport().scrollTop).toBe(1400);
  });

  it('jumps to the bottom when a different session is shown', () => {
    const geometry = { scrollHeight: 1000, clientHeight: 400 };
    const { rerender } = render(<Harness version={1} sessionId="s1" geometry={geometry} />);
    userScrollTo(600);
    userScrollTo(0);

    geometry.scrollHeight = 3000;
    rerender(<Harness version={1} sessionId="s2" geometry={geometry} />);

    expect(viewport().scrollTop).toBe(3000);
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
  });
});
