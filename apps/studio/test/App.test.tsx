// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStreamError, streamAgentRun } from '../src/features/agent/agent-stream.js';
import { App } from '../src/app/App.js';
import type { AgentStreamHandlers } from '../src/features/agent/agent-types.js';

vi.mock('../src/features/agent/agent-stream.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/agent/agent-stream.js')>(
    '../src/features/agent/agent-stream.js',
  );

  return {
    ...actual,
    streamAgentRun: vi.fn(),
  };
});

const streamAgentRunMock = vi.mocked(streamAgentRun);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Studio Agent Chat', () => {
  it('submits a message and renders streamed assistant text', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'reasoning-delta', text: '先分析。' });
      handlers.onEvent({ type: 'text-delta', text: '你好，' });
      handlers.onEvent({ type: 'text-delta', text: '这是 Weave。' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-1' });
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '介绍一下 Weave' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('介绍一下 Weave')).toBeTruthy();
    expect(await screen.findByText('你好，这是 Weave。')).toBeTruthy();
    expect(screen.getByText('先分析。')).toBeTruthy();
    expect(screen.getByText('Completed', { selector: '.run-status' })).toBeTruthy();
    expect(streamAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-local',
        provider: 'mock',
        model: 'weave-local-demo',
      }),
      expect.objectContaining({ onEvent: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('renders tool lifecycle state in order', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'workspace.search', arguments: '{"query":"SSE"}' },
      });
      handlers.onEvent({
        type: 'tool-executing',
        toolCall: { id: 'call-1', name: 'workspace.search', arguments: '{"query":"SSE"}' },
      });
      handlers.onEvent({
        type: 'tool-result',
        result: {
          toolCallId: 'call-1',
          name: 'workspace.search',
          content: '2 matches',
          truncated: false,
        },
      });
      handlers.onEvent({ type: 'completed', turnId: 'turn-2' });
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '搜索 SSE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('workspace.search')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Tools' })).getByText('Completed', {
        selector: '.status-badge',
      }),
    ).toBeTruthy();
    expect(screen.getByText('2 matches')).toBeTruthy();
    expect(screen.getByText('{"query":"SSE"}')).toBeTruthy();
  });

  it('shows a safe error without leaking implementation details', async () => {
    const error = new AgentStreamError('agent-step-limit', 'Agent run failed', {
      cause: '/Users/mi/private/secret.ts',
    });
    streamAgentRunMock.mockRejectedValue(error);

    render(<App />);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '触发错误' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Agent run failed')).toBeTruthy();
    expect(screen.queryByText(/secret\.ts|\/Users\/mi\/private/)).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Run error' })).getByText('Error', {
        selector: '.status-badge',
      }),
    ).toBeTruthy();
  });

  it('cancels an active stream and restores the send control', async () => {
    let abortObserved = false;
    streamAgentRunMock.mockImplementation(
      (_request, _handlers, options) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            },
            { once: true },
          );
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '取消这次运行' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(abortObserved).toBe(true);
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '取消后继续发送' },
    });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('Run cancelled')).toBeTruthy();
  });

  it('does not submit a second message while streaming', () => {
    streamAgentRunMock.mockImplementation(
      () =>
        new Promise<void>(() => {
          // Keep the first run active so the duplicate-submit guard is observable.
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '只发送一次' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.submit(screen.getByLabelText('Message').closest('form') as HTMLFormElement);

    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it('ignores late events and errors from a cancelled run', async () => {
    type PendingRun = {
      readonly handlers: AgentStreamHandlers;
      readonly reject: (error: unknown) => void;
    };
    const runs: PendingRun[] = [];

    streamAgentRunMock.mockImplementation((_request, handlers) => {
      return new Promise<void>((_resolve, reject) => {
        runs.push({
          handlers,
          reject,
        });
      });
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '第一轮' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '第二轮' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(runs).toHaveLength(2);

    act(() => {
      runs[0]?.handlers.onEvent({ type: 'text-delta', text: '旧响应' });
      runs[0]?.reject(new DOMException('The operation was aborted.', 'AbortError'));
      runs[1]?.handlers.onEvent({ type: 'text-delta', text: '新响应' });
      runs[1]?.handlers.onEvent({ type: 'completed', turnId: 'turn-2' });
    });

    await waitFor(() => {
      expect(screen.getByText('新响应')).toBeTruthy();
      expect(screen.queryByText('旧响应')).toBeNull();
      expect(screen.getByText('Completed', { selector: '.run-status' })).toBeTruthy();
    });
  });
});
