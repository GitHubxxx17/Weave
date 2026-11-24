// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationPane } from '../src/features/conversation/conversation-pane.js';
import { createConversationStore } from '../src/features/conversation/conversation-store.js';
import { createTurnFileReviewStore } from '../src/features/file-undo/turn-file-review-store.js';
import type { TimelineHandle } from '../src/features/conversation/conversation-types.js';
afterEach(cleanup);
describe('conversation full text navigation', () => {
  it('invalidates an old reveal across Session A to B to A before its first frame', async () => {
    const store = createConversationStore();
    const ref = createRef<TimelineHandle>();
    const common = {
      store,
      projectId: 'project',
      status: 'completed' as const,
      sessionHasWork: false,
      canCompose: false,
      isChildSession: false,
      onAction: vi.fn(),
      fileReviewStore: createTurnFileReviewStore(),
    };
    const view = render(<ConversationPane {...common} sessionId="a" ref={ref} />);
    let pending: Promise<string>;
    act(() => {
      pending = ref.current!.reveal({ kind: 'row', sessionId: 'a', rowId: 'missing' });
    });
    view.rerender(<ConversationPane {...common} sessionId="b" ref={ref} />);
    view.rerender(<ConversationPane {...common} sessionId="a" ref={ref} />);
    expect(await pending!).toBe('stale');
    store.dispose();
  });
  it('closes full text, remounts and reveals the exact requested row', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    HTMLElement.prototype.scrollTo = function () {};
    const store = createConversationStore();
    store.hydrateView({
      sessionId: 'session',
      detailKnown: true,
      turns: [],
      messages: [
        {
          id: 'one',
          role: 'assistant',
          text: 'full-text target',
          reasoning: '',
          tools: [],
          occurredAt: '2026-11-24T00:00:00Z',
        },
      ],
    });
    const ref = createRef<TimelineHandle>();
    render(
      <ConversationPane
        ref={ref}
        store={store}
        sessionId="session"
        projectId="project"
        status="completed"
        sessionHasWork={false}
        canCompose={false}
        isChildSession={false}
        onAction={vi.fn()}
        fileReviewStore={createTurnFileReviewStore()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '完整文本', exact: true }));
    expect(screen.getByRole('textbox', { name: '完整会话文本内容' })).toBeTruthy();
    let result: string | undefined;
    await act(async () => {
      result = await ref.current!.reveal({ kind: 'row', sessionId: 'session', rowId: 'one' });
    });
    expect(result).toBe('revealed');
    expect(screen.queryByRole('textbox', { name: '完整会话文本内容' })).toBeNull();
    expect(document.activeElement?.getAttribute('data-message-id')).toBe('one');
    store.dispose();
  });
});
