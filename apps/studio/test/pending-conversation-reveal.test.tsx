// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createConversationStore } from '../src/features/conversation/conversation-store.js';
import { usePendingConversationReveal } from '../src/features/conversation/use-pending-conversation-reveal.js';
import type {
  ConversationTarget,
  TimelineHandle,
} from '../src/features/conversation/conversation-types.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('retries a missing exact target on publication without accepting another Session or Turn', async () => {
  const store = createConversationStore();
  const timeline = createRef<TimelineHandle>();
  const reveal = vi.fn().mockResolvedValue('revealed');
  timeline.current = { reveal, scrollToBottom: vi.fn() };
  const done = vi.fn();
  const target: ConversationTarget = {
    kind: 'tool',
    sessionId: 's',
    turnId: 'right',
    toolCallId: 'same',
  };
  function Host({ session = 's' }: { session?: string }) {
    usePendingConversationReveal(store, session, target, timeline, done);
    return null;
  }
  const view = render(<Host />);
  const hydrate = (sessionId: string, turnId: string) =>
    store.hydrateView({
      sessionId,
      turns: [],
      detailKnown: true,
      messages: [
        {
          id: turnId,
          turnId,
          role: 'assistant',
          text: '',
          reasoning: '',
          tools: [{ toolCallId: 'same', name: 'read', arguments: '{}', status: 'called' }],
          occurredAt: '',
        },
      ],
    });
  act(() => {
    hydrate('other', 'right');
    hydrate('s', 'wrong');
  });
  expect(reveal).not.toHaveBeenCalled();
  act(() => {
    hydrate('s', 'right');
  });
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(reveal).toHaveBeenCalledExactlyOnceWith(target);
  view.rerender(<Host session="other" />);
  act(() => {
    hydrate('s', 'right');
  });
  expect(reveal).toHaveBeenCalledTimes(1);
  store.dispose();
});

function exactTargetHarness() {
  const store = createConversationStore();
  store.hydrateView({
    sessionId: 's',
    detailKnown: true,
    turns: [],
    messages: [
      {
        id: 'answer',
        turnId: 'right',
        role: 'assistant',
        text: '',
        reasoning: '',
        occurredAt: '',
        tools: [{ toolCallId: 'same', name: 'read', arguments: '{}', status: 'called' }],
      },
    ],
  });
  const target: ConversationTarget = {
    kind: 'tool',
    sessionId: 's',
    turnId: 'right',
    toolCallId: 'same',
  };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => {
    frames.delete(frame);
  });
  const timeline = createRef<TimelineHandle>();
  const reveal = vi
    .fn<TimelineHandle['reveal']>()
    .mockResolvedValueOnce('missing')
    .mockResolvedValue('revealed');
  timeline.current = { reveal, scrollToBottom: vi.fn() };
  const done = vi.fn();
  function Host({ session = 's' }: { session?: string }) {
    usePendingConversationReveal(store, session, target, timeline, done);
    return null;
  }
  return { store, target, frames, timeline, reveal, done, Host };
}

it('retries once after a frame when an exact target publishes before its pane commits', async () => {
  const h = exactTargetHarness();
  const view = render(<h.Host />);
  await act(async () => {});
  expect(h.reveal).toHaveBeenCalledExactlyOnceWith(h.target);
  expect(h.done).not.toHaveBeenCalled();
  expect(h.frames.size).toBe(1);
  const frame = [...h.frames.values()][0]!;
  h.frames.clear();
  await act(async () => {
    frame(16);
  });
  expect(h.reveal).toHaveBeenCalledTimes(2);
  expect(h.reveal.mock.calls[1]?.[0]).toBe(h.target);
  expect(h.done).toHaveBeenCalledOnce();
  expect(h.frames.size).toBe(0);
  view.unmount();
  h.store.dispose();
});

it('cancels the post-commit retry when the Session changes and fences a late cancelled frame', async () => {
  const h = exactTargetHarness();
  const view = render(<h.Host />);
  await act(async () => {});
  const late = [...h.frames.values()][0]!;
  expect(h.frames.size).toBe(1);
  view.rerender(<h.Host session="other" />);
  expect(h.frames.size).toBe(0);
  await act(async () => {
    late(16);
  });
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.done).not.toHaveBeenCalled();
  view.unmount();
  h.store.dispose();
});

it('bounds a still-missing target to one post-commit retry without another publication', async () => {
  const h = exactTargetHarness();
  h.reveal.mockReset().mockResolvedValue('missing');
  const view = render(<h.Host />);
  await act(async () => {});
  const frame = [...h.frames.values()][0]!;
  h.frames.clear();
  await act(async () => {
    frame(16);
  });
  expect(h.reveal).toHaveBeenCalledTimes(2);
  expect(h.frames.size).toBe(0);
  expect(h.done).not.toHaveBeenCalled();
  view.unmount();
  h.store.dispose();
});
