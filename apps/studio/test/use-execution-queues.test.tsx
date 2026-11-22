// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useExecutionQueues } from '../src/features/agent/use-execution-queues.js';
import {
  cancelQueuedExecution,
  getExecutionQueue,
  observeExecutionQueue,
  reorderExecutionQueue,
} from '../src/features/agent/agent-queue-client.js';
import { AgentStreamError } from '../src/features/agent/agent-stream.js';
import type { AgentExecutionQueueSnapshot } from '../src/features/agent/agent-execution-types.js';
vi.mock('../src/features/agent/agent-queue-client.js', () => ({
  cancelQueuedExecution: vi.fn(),
  getExecutionQueue: vi.fn(),
  observeExecutionQueue: vi.fn(),
  reorderExecutionQueue: vi.fn(),
}));
const view = (sessionId = 's', sequence = 4): AgentExecutionQueueSnapshot => ({
  sessionId,
  revision: sequence,
  cursor: `epoch:${sessionId}:${sequence}`,
  active: null,
  queued: ['a', 'b'].map((executionId) => ({
    executionId,
    requestId: executionId,
    sessionId,
    turnId: executionId,
    userMessageId: executionId,
    createdAt: '2026-11-23T00:00:00.000Z',
    status: 'queued',
    cursor: `epoch:${executionId}:0`,
    preview: executionId,
    provider: 'p',
    model: 'm',
    imageCount: 0,
    skillCount: 0,
    fileCount: 0,
  })),
  scheduler: 'ready',
  limits: { sessionQueued: 10, globalQueued: 100 },
});
beforeEach(() => {
  vi.mocked(getExecutionQueue).mockImplementation(async (sessionId) => view(sessionId));
  vi.mocked(observeExecutionQueue).mockImplementation(
    async () => new Promise<void>(() => undefined),
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('detaches queue observation on navigation and opens a fresh replacement when returning', async () => {
  const calls: {
    sessionId: string;
    signal: AbortSignal | undefined;
    receive: (state: AgentExecutionQueueSnapshot) => void;
  }[] = [];
  vi.mocked(observeExecutionQueue).mockImplementation(async (sessionId, receive, options) => {
    calls.push({ sessionId, signal: options?.signal, receive });
    return new Promise<void>(() => undefined);
  });
  const { result, rerender } = renderHook(
    ({ sessionId }) =>
      useExecutionQueues({
        activeSessionId: sessionId,
        activeProjectId: 'p',
        onActive: vi.fn(),
        onNotice: vi.fn(),
      }),
    { initialProps: { sessionId: 's' } },
  );
  await waitFor(() => expect(result.current.states.s).toBeDefined());
  rerender({ sessionId: 'next' });
  await waitFor(() => expect(result.current.states.next).toBeDefined());
  expect(calls[0]?.signal?.aborted).toBe(true);
  act(() => calls[0]?.receive(view('s', 90)));
  expect(result.current.states.s).toBeUndefined();
  expect(result.current.pending.s).toBeUndefined();
  rerender({ sessionId: 's' });
  await waitFor(() => expect(calls.map((call) => call.sessionId)).toEqual(['s', 'next', 's']));
  expect(calls[1]?.signal?.aborted).toBe(true);
  expect(calls.filter((call) => !call.signal?.aborted)).toHaveLength(1);
});

it('ignores an initial GET from an older epoch after a stream replacement arrives', async () => {
  let release: (state: AgentExecutionQueueSnapshot) => void = () => undefined;
  let receive: (state: AgentExecutionQueueSnapshot) => void = () => undefined;
  vi.mocked(getExecutionQueue).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.mocked(observeExecutionQueue).mockImplementation(async (_sessionId, callback) => {
    receive = callback;
    return new Promise<void>(() => undefined);
  });
  const { result } = renderHook(() =>
    useExecutionQueues({
      activeSessionId: 's',
      activeProjectId: 'p',
      onActive: vi.fn(),
      onNotice: vi.fn(),
    }),
  );
  act(() => receive({ ...view(), revision: 9, cursor: 'new:s:1' }));
  await act(async () => release(view('s', 100)));
  expect(result.current.states.s?.cursor).toBe('new:s:1');
});

it('refreshes a concurrently claimed cancel instead of converting it into active Stop', async () => {
  const onNotice = vi.fn();
  vi.mocked(cancelQueuedExecution).mockRejectedValueOnce(
    new AgentStreamError('execution-not-queued', 'claimed'),
  );
  const { result } = renderHook(() =>
    useExecutionQueues({ activeSessionId: 's', activeProjectId: 'p', onActive: vi.fn(), onNotice }),
  );
  await waitFor(() => expect(result.current.states.s).toBeDefined());
  await act(async () => result.current.cancel('s', 'a'));
  expect(cancelQueuedExecution).toHaveBeenCalledOnce();
  expect(cancelQueuedExecution).toHaveBeenCalledWith(
    's',
    'a',
    { requestId: expect.any(String), expectedRevision: 4 },
    expect.any(AbortSignal),
  );
  expect(getExecutionQueue).toHaveBeenCalledTimes(2);
  expect(onNotice).toHaveBeenCalledWith('该消息已开始，未取消当前运行。');
});

it('moves one item by sending an exact permutation with the observed revision', async () => {
  vi.mocked(reorderExecutionQueue).mockResolvedValueOnce(view('s', 5));
  const { result } = renderHook(() =>
    useExecutionQueues({
      activeSessionId: 's',
      activeProjectId: 'p',
      onActive: vi.fn(),
      onNotice: vi.fn(),
    }),
  );
  await waitFor(() => expect(result.current.states.s).toBeDefined());
  await act(async () => result.current.move('s', 'b'));
  expect(reorderExecutionQueue).toHaveBeenCalledWith(
    's',
    { requestId: expect.any(String), expectedRevision: 4, executionIds: ['b', 'a'] },
    expect.any(AbortSignal),
  );
});

it('discards late control results after navigation without observing the old Session again', async () => {
  let release: (state: AgentExecutionQueueSnapshot) => void = () => undefined;
  vi.mocked(cancelQueuedExecution).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const onActive = vi.fn();
  const { result, rerender } = renderHook(
    ({ sessionId }) =>
      useExecutionQueues({
        activeSessionId: sessionId,
        activeProjectId: 'p',
        onActive,
        onNotice: vi.fn(),
      }),
    { initialProps: { sessionId: 's' } },
  );
  await waitFor(() => expect(result.current.states.s).toBeDefined());
  let pending: Promise<void>;
  act(() => {
    pending = result.current.cancel('s', 'a');
  });
  rerender({ sessionId: 'next' });
  await waitFor(() => expect(result.current.states.next).toBeDefined());
  const initial = view('s', 8);
  await act(async () => {
    release({ ...initial, active: { ...initial.queued[0]!, status: 'running' }, queued: [] });
    await pending!;
  });
  expect(result.current.states.s).toBeUndefined();
  expect(onActive).not.toHaveBeenCalled();
  expect(vi.mocked(cancelQueuedExecution).mock.calls[0]?.[3]?.aborted).toBe(true);
});
