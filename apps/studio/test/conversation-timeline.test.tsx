// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationTimeline } from '../src/features/conversation/conversation-timeline.js';
import { projectConversationView } from '../src/features/conversation/conversation-model.js';
import { createConversationUiState } from '../src/features/conversation/conversation-ui-state.js';
import type { TimelineHandle } from '../src/features/conversation/conversation-types.js';
import { createTurnFileReviewStore } from '../src/features/file-undo/turn-file-review-store.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  });
  HTMLElement.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === 'object' ? (options.top ?? 0) : 0;
    this.dispatchEvent(new Event('scroll'));
  };
});
afterEach(cleanup);
const snapshot = projectConversationView({
  sessionId: 'session',
  detailKnown: true,
  turns: [],
  messages: Array.from({ length: 5000 }, (_, index) => ({
    id: `row-${index}`,
    role: 'assistant' as const,
    text: `sentinel ${index}`,
    reasoning: '',
    tools:
      index === 2499
        ? [
            {
              toolCallId: 'duplicate',
              name: 'read_file',
              arguments: '{"path":"target"}',
              result: 'whole target result',
              status: 'completed' as const,
            },
          ]
        : [],
    turnId: `turn-${index}`,
    occurredAt: '2026-11-24T00:00:00Z',
  })),
});
const uiState = createConversationUiState();
const review = createTurnFileReviewStore();
const props = {
  snapshot,
  projectId: 'project',
  status: 'completed' as const,
  sessionHasWork: false,
  canCompose: false,
  onAction: vi.fn(),
  uiState,
  fileReviewStore: review,
};
describe('logical conversation window', () => {
  it('cancels an in-flight reveal when the visible bottom button is clicked', async () => {
    const ref = createRef<TimelineHandle>();
    render(<ConversationTimeline {...props} ref={ref} />);
    let pending: Promise<string>;
    act(() => {
      pending = ref.current!.reveal({ kind: 'row', sessionId: 'session', rowId: 'row-0' });
    });
    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
    expect(await pending!).toBe('stale');
    expect(document.activeElement?.getAttribute('data-message-id')).not.toBe('row-0');
  });
  it('keeps 5000 logical records while mounting only a bounded window with complete stable keys', () => {
    const { container } = render(<ConversationTimeline {...props} />);
    expect(
      container.querySelector('[data-logical-count]')?.getAttribute('data-logical-count'),
    ).toBe('5000');
    expect(container.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(64);
    expect(container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0);
  });
  it('resolves an off-window exact tool, mounts its complete body and focuses its parameters', async () => {
    const ref = createRef<TimelineHandle>();
    render(<ConversationTimeline {...props} ref={ref} />);
    let result: string | undefined;
    await act(async () => {
      result = await ref.current!.reveal({
        kind: 'tool',
        sessionId: 'session',
        turnId: 'turn-2499',
        toolCallId: 'duplicate',
      });
    });
    expect(result).toBe('revealed');
    expect(screen.getByText('whole target result')).toBeTruthy();
    expect(document.activeElement?.hasAttribute('data-tool-parameters')).toBe(true);
    expect(
      await ref.current!.reveal({
        kind: 'tool',
        sessionId: 'session',
        turnId: 'wrong',
        toolCallId: 'duplicate',
      }),
    ).toBe('missing');
  });
  it('invalidates a queued reveal when the active session changes between async phases', async () => {
    const ref = createRef<TimelineHandle>();
    const view = render(<ConversationTimeline {...props} ref={ref} />);
    let pending: Promise<string>;
    act(() => {
      pending = ref.current!.reveal({ kind: 'row', sessionId: 'session', rowId: 'row-0' });
    });
    const next = projectConversationView({
      sessionId: 'other',
      detailKnown: true,
      turns: [],
      messages: [],
    });
    view.rerender(<ConversationTimeline {...props} snapshot={next} ref={ref} />);
    expect(await pending!).toBe('stale');
  });
});
