// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnFileReview } from '../src/features/file-undo/turn-file-review.js';
const review = {
  turnId: 't',
  files: [
    { path: 'a.ts', existedBefore: true, previousContent: 'before', afterContent: 'after' },
    {
      path: 'legacy',
      existedBefore: true,
      previousContent: 'old',
      unavailableReason: 'legacy-snapshot',
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('loads review on demand and requires a second explicit confirmation before restoring', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(review)))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          projectId: 'p',
          turnId: 't',
          operationId: 'op',
          requestId: 'req',
          results: [
            { path: 'a.ts', status: 'restored', reason: 'restored-before-state' },
            { path: 'legacy', status: 'unavailable', reason: 'legacy-snapshot' },
          ],
        }),
      ),
    )
    .mockResolvedValue(new Response(JSON.stringify(review)));
  vi.stubGlobal('fetch', fetchMock);
  render(<TurnFileReview projectId="p" sessionId="s" turnId="t" disabled={false} />);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '审阅本轮文件' }));
  await screen.findByText('a.ts');
  expect(screen.getByText(/旧快照缺少成功写入证明/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '撤销本轮文件改动' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/其他进程或后续修改/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  await screen.findByText(/已恢复/);
  expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
  const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
  expect(body).toMatchObject({
    turnId: 't',
    operationId: expect.any(String),
    requestId: expect.any(String),
  });
});
it('retains exact request identity after an ambiguous network failure', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(review)))
    .mockRejectedValueOnce(Error('offline'))
    .mockRejectedValueOnce(Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  render(<TurnFileReview projectId="p" sessionId="s" turnId="t" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '审阅本轮文件' }));
  await screen.findByText('a.ts');
  fireEvent.click(screen.getByRole('button', { name: '撤销本轮文件改动' }));
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重试原请求' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[2]?.[1]?.body);
});

it('resumes a durable pending operation with its original request identity after remount', async () => {
  const pending = {
    ...review,
    operation: {
      projectId: 'p',
      turnId: 't',
      operationId: 'pending-op',
      requestId: 'pending-request',
      status: 'pending',
      results: [{ path: 'a.ts', status: 'restored', reason: 'restored-before-state' }],
    },
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(pending)))
    .mockRejectedValueOnce(Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  render(<TurnFileReview projectId="p" sessionId="s" turnId="t" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '审阅本轮文件' }));
  await screen.findByRole('button', { name: '继续未完成请求' });
  fireEvent.click(screen.getByRole('button', { name: '继续未完成请求' }));
  await screen.findByRole('alert');
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
    turnId: 't',
    operationId: 'pending-op',
    requestId: 'pending-request',
  });
});
