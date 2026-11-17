// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decideApproval,
  readWriteFileSummary,
  subscribeApprovals,
  type ApprovalRequest,
} from '../src/features/approvals/approval-api.js';
import { ApprovalPanel } from '../src/features/approvals/approval-panel.js';

const pendingWrite: ApprovalRequest = {
  approvalId: 'approval-1',
  toolCallId: 'call-1',
  toolName: 'write_file',
  operation: 'workspace.write_file',
  summary: '写入 Workspace 文件 notes.md',
  risk: 'high',
  inputSummary: { path: 'notes.md', bytes: 12, overwrite: true },
  status: 'pending',
  createdAt: '2026-11-17T08:00:00.000Z',
};

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

afterEach(() => {
  cleanup();
  delete window.weaveDesktop;
});

describe('Approval API client', () => {
  it('applies the snapshot and live updates from the stream', async () => {
    const controller = new AbortController();
    const snapshots: (readonly ApprovalRequest[])[] = [];
    const updates: ApprovalRequest[] = [];
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `event: approval.snapshot\ndata: ${JSON.stringify({ approvals: [pendingWrite] })}\n\n`,
        `event: approval.resolved\ndata: ${JSON.stringify({ ...pendingWrite, status: 'approved' })}\n\n`,
        'event: approval.created\ndata: {"broken":true}\n\n',
      ]),
    );

    const done = subscribeApprovals(
      {
        onSnapshot: (approvals) => {
          snapshots.push(approvals);
        },
        onUpdate: (approval) => {
          updates.push(approval);
          controller.abort();
        },
      },
      { signal: controller.signal, fetch: fetchMock, retryDelayMs: 1 },
    );
    await done;

    expect(fetchMock).toHaveBeenCalledWith(
      '/approvals/stream',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(snapshots).toEqual([[pendingWrite]]);
    expect(updates).toEqual([{ ...pendingWrite, status: 'approved' }]);
  });

  it('posts a decision to the desktop Server URL and validates the response', async () => {
    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:46321' };
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ...pendingWrite, status: 'rejected' })),
    );

    await expect(
      decideApproval('approval-1', 'reject', { reason: '不需要', fetch: fetchMock }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:46321/approvals/approval-1/reject',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: '不需要' }) }),
    );
  });

  it('surfaces Server error codes', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'approval-already-resolved', message: '已处理' } }),
          { status: 409 },
        ),
    );

    await expect(
      decideApproval('approval-1', 'approve', { fetch: fetchMock }),
    ).rejects.toMatchObject({ code: 'approval-already-resolved' });
  });

  it('reads only the redacted write_file summary', () => {
    expect(readWriteFileSummary(pendingWrite)).toEqual({
      path: 'notes.md',
      bytes: 12,
      overwrite: true,
    });
    expect(readWriteFileSummary({ ...pendingWrite, operation: 'other' })).toBeUndefined();
  });
});

describe('ApprovalPanel', () => {
  it('renders nothing without pending approvals', () => {
    const { container } = render(<ApprovalPanel pending={[]} onDecide={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the write summary and forwards approve and reject', async () => {
    const onDecide = vi.fn(async () => undefined);
    render(<ApprovalPanel pending={[pendingWrite]} onDecide={onDecide} />);

    expect(screen.getByText('Agent 请求写入文件')).toBeTruthy();
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(screen.getByText('覆盖已有文件')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '同意写入' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approval-1', 'approve'));
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('forwards a rejection', async () => {
    const onDecide = vi.fn(async () => undefined);
    render(<ApprovalPanel pending={[pendingWrite]} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approval-1', 'reject'));
  });

  it('shows a decision error and lets the user retry', async () => {
    const onDecide = vi.fn(async () => {
      throw new Error('已处理');
    });
    render(<ApprovalPanel pending={[pendingWrite]} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole('button', { name: '同意写入' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: '同意写入' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
