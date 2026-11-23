// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  getAgentTaskTree,
  observeAgentTaskTree,
  stopAgentTask,
} from '../src/features/tasks/task-api.js';
import type { AgentTaskTreeSnapshot } from '../src/features/tasks/task-types.js';
import { useAgentTasks } from '../src/features/tasks/use-agent-tasks.js';

vi.mock('../src/features/tasks/task-api.js', () => ({
  getAgentTaskTree: vi.fn(),
  observeAgentTaskTree: vi.fn(),
  stopAgentTask: vi.fn(),
}));

const tree = (rootSessionId: string, epoch: string, revision: number): AgentTaskTreeSnapshot => ({
  rootSessionId,
  epoch,
  revision,
  tasks: [],
  cursor: `${epoch}-${revision}`,
  changed: true,
  totalCount: 0,
  truncated: false,
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('keeps one stream for the root and refuses stale GET and callbacks after a root ABA', async () => {
  const reads = [
    Promise.withResolvers<AgentTaskTreeSnapshot>(),
    Promise.withResolvers<AgentTaskTreeSnapshot>(),
    Promise.withResolvers<AgentTaskTreeSnapshot>(),
  ];
  vi.mocked(getAgentTaskTree).mockImplementation(() => reads.shift()!.promise);
  vi.mocked(observeAgentTaskTree).mockImplementation(() => new Promise(() => {}));
  const firstRead = reads[0]!;
  const { result, rerender } = renderHook(({ root }) => useAgentTasks(root), {
    initialProps: { root: 'root-a' },
  });
  const first = vi.mocked(observeAgentTaskTree).mock.calls[0]!;
  act(() => first[1](tree('root-a', 'new', 3)));
  await act(async () => firstRead.resolve(tree('root-a', 'old', 20)));
  expect(result.current.snapshot?.epoch).toBe('new');
  rerender({ root: 'root-a' });
  expect(observeAgentTaskTree).toHaveBeenCalledTimes(1);
  rerender({ root: 'root-b' });
  rerender({ root: 'root-a' });
  expect(first[2].aborted).toBe(true);
  expect(vi.mocked(observeAgentTaskTree).mock.calls[1]?.[2].aborted).toBe(true);
  act(() => first[1](tree('root-a', 'new', 100)));
  expect(result.current.snapshot).toBeUndefined();
  act(() => vi.mocked(observeAgentTaskTree).mock.calls[2]?.[1](tree('root-a', 'latest', 1)));
  expect(result.current.snapshot?.epoch).toBe('latest');
});

it('keeps a stable operation ID after an uncertain stop request and never rewrites the tree from a receipt', async () => {
  vi.mocked(getAgentTaskTree).mockResolvedValue(tree('root', 'epoch', 1));
  vi.mocked(observeAgentTaskTree).mockImplementation(() => new Promise(() => {}));
  vi.mocked(stopAgentTask)
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(undefined);
  const { result } = renderHook(() => useAgentTasks('root'));
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
  await act(async () => result.current.stop('task'));
  expect(result.current.error).toBeDefined();
  await act(async () => result.current.stop('task'));
  expect(vi.mocked(stopAgentTask).mock.calls[0]).toEqual(vi.mocked(stopAgentTask).mock.calls[1]);
  expect(result.current.snapshot?.revision).toBe(1);
});

it('keeps the stop-all operation ID when a previous observer receives an older receipt', async () => {
  vi.mocked(getAgentTaskTree).mockImplementation(async (root) => tree(root, 'epoch', 1));
  vi.mocked(observeAgentTaskTree).mockImplementation(() => new Promise(() => {}));
  const oldReceipt = Promise.withResolvers<void>();
  const currentReceipt = Promise.withResolvers<void>();
  vi.mocked(stopAgentTask)
    .mockReturnValueOnce(oldReceipt.promise)
    .mockReturnValueOnce(currentReceipt.promise)
    .mockResolvedValueOnce(undefined);
  const { result, rerender } = renderHook(({ root }) => useAgentTasks(root), {
    initialProps: { root: 'root-a' },
  });
  await waitFor(() => expect(result.current.snapshot?.rootSessionId).toBe('root-a'));
  act(() => void result.current.stop());
  rerender({ root: 'root-b' });
  rerender({ root: 'root-a' });
  await waitFor(() => expect(result.current.snapshot?.rootSessionId).toBe('root-a'));
  act(() => void result.current.stop());
  await act(async () => oldReceipt.resolve());
  await act(async () => currentReceipt.reject(new TypeError('receipt lost')));
  expect(result.current.error).toBeDefined();
  await act(async () => result.current.stop());
  const ids = vi.mocked(stopAgentTask).mock.calls.map(([, , operationId]) => operationId);
  expect(ids).toEqual([ids[0], ids[0], ids[0]]);
});
