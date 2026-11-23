// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentTaskPanel } from '../src/features/tasks/task-panel.js';
import type { AgentTaskView } from '../src/features/tasks/task-types.js';

const task: AgentTaskView = {
  taskId: '00000000-0000-4000-8000-000000000001',
  rootSessionId: 'root',
  parentSessionId: 'root',
  parentTurnId: 'parent-turn',
  childSessionId: '00000000-0000-4000-8000-000000000002',
  childExecutionId: '00000000-0000-4000-8000-000000000003',
  childTurnId: '00000000-0000-4000-8000-000000000004',
  title: '检查变更',
  access: 'read-only',
  acceptedAt: '2026-11-23T00:00:00.000Z',
  status: 'running',
  resultKind: 'none',
  preview: '',
  previewTruncated: false,
  pendingApprovalIds: [],
  pendingApprovalCount: 1,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('updates elapsed time while a task waits and releases the clock after settlement', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T00:00:05.000Z'));
  const props = { onOpen: vi.fn(), onStop: vi.fn(), pending: new Set<string>() };
  const { rerender } = render(<AgentTaskPanel {...props} tasks={[task]} />);
  expect(screen.getByText('5 秒')).toBeDefined();
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByText('8 秒')).toBeDefined();
  rerender(
    <AgentTaskPanel
      {...props}
      tasks={[
        {
          ...task,
          status: 'completed',
          settledAt: '2026-11-23T00:00:08.000Z',
          pendingApprovalCount: 0,
        },
      ]}
    />,
  );
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByText('8 秒')).toBeDefined();
});

it('exposes task status, scoped stop and a distinct stop-all control', () => {
  const onStop = vi.fn();
  const onOpen = vi.fn();
  render(<AgentTaskPanel tasks={[task]} onOpen={onOpen} onStop={onStop} pending={new Set()} />);
  expect(screen.getByText('待审批 1')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '打开子会话：检查变更' }));
  expect(onOpen).toHaveBeenCalledWith(task);
  fireEvent.click(screen.getByRole('button', { name: '停止任务：检查变更' }));
  fireEvent.click(screen.getByRole('button', { name: '停止全部子任务' }));
  expect(onStop.mock.calls).toEqual([[task.taskId], []]);
});

it('labels step-limited output as partial and prepares read-only or explicit workspace drafts', () => {
  const result = {
    sessionId: task.childSessionId,
    executionId: task.childExecutionId,
    turnId: task.childTurnId,
    messageId: 'answer',
    terminalSequence: 8,
  };
  const onOpen = vi.fn();
  const onPrepare = vi.fn();
  render(
    <AgentTaskPanel
      tasks={[
        {
          ...task,
          status: 'failed',
          reason: 'agent-step-limit',
          resultKind: 'partial',
          preview: '已检查一部分',
          previewTruncated: true,
          pendingApprovalCount: 0,
          result,
        },
      ]}
      onOpen={onOpen}
      onStop={vi.fn()}
      onPrepare={onPrepare}
      pending={new Set()}
    />,
  );
  expect(screen.getByText('未完成答复')).toBeDefined();
  expect(screen.getByText('部分输出')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '查看全文：检查变更' }));
  expect(onOpen.mock.calls[0]?.[1]).toEqual(result);
  const access = screen.getByLabelText('子任务访问权限');
  expect((access as HTMLSelectElement).value).toBe('read-only');
  fireEvent.change(screen.getByLabelText('委派说明'), { target: { value: '检查改动' } });
  fireEvent.click(screen.getByRole('button', { name: '添加到会话草稿' }));
  expect(onPrepare).toHaveBeenLastCalledWith('检查改动', 'read-only');
  fireEvent.change(access, { target: { value: 'workspace' } });
  fireEvent.click(screen.getByRole('button', { name: '添加到会话草稿' }));
  expect(onPrepare).toHaveBeenLastCalledWith('检查改动', 'workspace');
});
