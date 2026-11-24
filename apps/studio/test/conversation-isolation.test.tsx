// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { memo, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationPane } from '../src/features/conversation/conversation-pane.js';
import { createConversationStore } from '../src/features/conversation/conversation-store.js';
import { createTurnFileReviewStore } from '../src/features/file-undo/turn-file-review-store.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('../src/features/conversation/markdown-message.js', () => ({
  MarkdownMessage: memo(({ text }: { text: string }) => {
    renders.set(text, (renders.get(text) ?? 0) + 1);
    return <p>{text}</p>;
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  renders.clear();
});
it('isolates historical row commits from draft edits, live deltas and other sessions', () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  const store = createConversationStore({
    scheduleFrame: () => 1,
    cancelFrame: () => {},
    scheduleTimeout: () => 2,
    cancelTimeout: () => {},
  });
  store.hydrateView({
    sessionId: 's',
    detailKnown: true,
    turns: [],
    messages: [
      {
        id: 'history',
        role: 'assistant',
        text: 'stable historical markdown',
        reasoning: '',
        tools: [],
        occurredAt: '',
      },
    ],
  });
  const review = createTurnFileReviewStore();
  const action = vi.fn();
  function Host() {
    const [draft, setDraft] = useState('');
    return (
      <>
        <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <ConversationPane
          store={store}
          sessionId="s"
          projectId="p"
          status="streaming"
          sessionHasWork
          canCompose
          isChildSession={false}
          onAction={action}
          fileReviewStore={review}
        />
      </>
    );
  }
  render(<Host />);
  const commits = renders.get('stable historical markdown');
  expect(commits).toBe(1);
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'new draft' } });
  expect(renders.get('stable historical markdown')).toBe(commits);
  const owner = {
    sessionId: 's',
    executionId: 'e',
    turnId: 't',
    userMessageId: 'u',
    runId: 'r',
    epoch: 1,
  };
  const execution: AgentExecutionSnapshot = {
    executionId: 'e',
    requestId: 'q',
    sessionId: 's',
    turnId: 't',
    userMessageId: 'u',
    createdAt: '',
    cursor: 'epoch:e:0',
    status: 'running',
    input: {
      provider: 'p',
      model: 'm',
      permissionMode: 'ask',
      userMessage: { role: 'user', content: [{ type: 'text', text: 'question' }] },
    },
    events: [],
  };
  act(() => {
    store.replaceLive(owner, execution);
    for (let i = 0; i < 100; i++) store.appendLive(owner, { type: 'text-delta', text: 'x' });
    store.flush(owner);
  });
  expect(screen.getByText('x'.repeat(100))).toBeTruthy();
  expect(renders.get('stable historical markdown')).toBe(commits);
  act(() => {
    store.hydrateView({
      sessionId: 'other',
      detailKnown: true,
      turns: [],
      messages: [
        {
          id: 'foreign',
          role: 'assistant',
          text: 'other session output',
          reasoning: '',
          tools: [],
          occurredAt: '',
        },
      ],
    });
  });
  expect(screen.queryByText('other session output')).toBeNull();
  expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('new draft');
  store.dispose();
});
