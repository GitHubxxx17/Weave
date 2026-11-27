// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionQueueList } from '../src/features/agent/execution-queue-list.js';
import type { AgentExecutionQueueSnapshot } from '../src/features/agent/agent-execution-types.js';
afterEach(cleanup);
const state: AgentExecutionQueueSnapshot = {
  sessionId: 's',
  revision: 4,
  cursor: 'epoch:s:4',
  active: null,
  scheduler: 'ready',
  limits: { sessionQueued: 10, globalQueued: 100 },
  queued: ['a', 'b'].map((id) => ({
    executionId: id,
    requestId: id,
    sessionId: 's',
    turnId: id,
    userMessageId: id,
    createdAt: '2026-11-23T00:00:00.000Z',
    status: 'queued',
    cursor: `epoch:${id}:0`,
    preview: `question ${id}`,
    provider: 'mock',
    model: 'model',
    imageCount: 1,
    skillCount: 2,
    fileCount: id === 'a' ? 3 : 1,
  })),
};
it('exposes exact queue rows, count and independent copy/move/cancel actions', () => {
  const cancel = vi.fn();
  const move = vi.fn();
  const copy = vi.fn();
  render(
    <ExecutionQueueList
      state={state}
      pending={false}
      onCancel={cancel}
      onMove={move}
      onCopy={copy}
    />,
  );
  expect(screen.getByText('待执行 2/10')).toBeTruthy();
  expect(screen.getByText(/3 个文件/)).toBeTruthy();
  expect(screen.getByText(/1 个文件/)).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: '上移第 1 条消息' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '上移第 2 条消息' }));
  fireEvent.click(screen.getByRole('button', { name: '取消第 1 条消息' }));
  fireEvent.click(screen.getByRole('button', { name: '复制第 2 条消息到草稿' }));
  expect(move).toHaveBeenCalledWith('b');
  expect(cancel).toHaveBeenCalledWith('a');
  expect(copy).toHaveBeenCalledWith('b');
  expect(screen.getAllByText(/1 张图片.*2 个技能/)).toHaveLength(2);
});
it('renders nothing for an empty queue without an error', () => {
  const { container } = render(
    <ExecutionQueueList
      state={{ ...state, queued: [] }}
      pending={false}
      onCancel={vi.fn()}
      onMove={vi.fn()}
      onCopy={vi.fn()}
    />,
  );
  expect(container.innerHTML).toBe('');
  expect(screen.queryByRole('region', { name: '待执行消息' })).toBeNull();
});
it('keeps an empty queue visible while it reports an error', () => {
  render(
    <ExecutionQueueList
      state={{ ...state, queued: [], error: { code: 'queue-full', message: '队列已满' } }}
      pending={false}
      onCancel={vi.fn()}
      onMove={vi.fn()}
      onCopy={vi.fn()}
    />,
  );
  expect(screen.getByText('待执行 0/10')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('队列已满');
});
