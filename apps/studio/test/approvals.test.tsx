// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decideApproval,
  readCommandSummary,
  readEditFileSummary,
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
  sessionId: 'session-1',
  status: 'pending',
  createdAt: '2026-11-17T08:00:00.000Z',
};

const longCommand = `echo ${'很长的测试命令 '.repeat(30)}&& git status --short`;

const pendingCommand: ApprovalRequest = {
  approvalId: 'approval-2',
  toolCallId: 'call-2',
  toolName: 'run_command',
  operation: 'shell.run_command',
  summary: `运行命令：${longCommand.slice(0, 120)}…`,
  risk: 'high',
  inputSummary: { command: longCommand, cwd: 'packages/app', timeoutMs: 120_000 },
  status: 'pending',
  createdAt: '2026-11-19T02:00:00.000Z',
};

const pendingEdit: ApprovalRequest = {
  approvalId: 'approval-3',
  toolCallId: 'call-3',
  toolName: 'edit_file',
  operation: 'workspace.edit_file',
  summary: '编辑 Workspace 文件 src/app.ts',
  risk: 'medium',
  inputSummary: {
    path: 'src/app.ts',
    replacements: 1,
    linesAdded: 1,
    linesRemoved: 1,
    diff: '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 20;',
    diffTruncated: false,
  },
  status: 'pending',
  createdAt: '2026-11-19T02:00:00.000Z',
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

  it('reads command and edit summaries only for their own operations', () => {
    expect(readCommandSummary(pendingCommand)).toEqual({
      command: longCommand,
      cwd: 'packages/app',
      timeoutMs: 120_000,
    });
    expect(readCommandSummary({ ...pendingCommand, operation: 'other' })).toBeUndefined();
    expect(readCommandSummary({ ...pendingCommand, inputSummary: { command: 1 } })).toBeUndefined();
    expect(readEditFileSummary(pendingEdit)).toMatchObject({
      path: 'src/app.ts',
      linesAdded: 1,
      diffTruncated: false,
    });
    expect(readEditFileSummary(pendingWrite)).toBeUndefined();
  });
});

describe('ApprovalPanel', () => {
  it('renders nothing without pending approvals', () => {
    const { container } = render(<ApprovalPanel pending={[]} onDecide={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('opens the exact tool call through its callback', () => {
    const onInspectToolCall = vi.fn();
    const approval: ApprovalRequest = {
      ...pendingWrite,
      toolCallId: 'mcp-call-2',
      toolName: 'mcp_docs_search_1234567890abcdef',
      operation: 'mcp.call_tool',
      summary: '调用 docs search',
      inputSummary: { serverId: 'docs', argumentBytes: 24, fields: ['query'] },
    };
    render(
      <ApprovalPanel
        pending={[approval]}
        onDecide={vi.fn()}
        onInspectToolCall={onInspectToolCall}
      />,
    );

    const card = screen.getByRole('article', { name: '待审批：调用 docs search' });
    fireEvent.click(within(card).getByRole('button', { name: '查看参数' }));
    expect(onInspectToolCall).toHaveBeenCalledWith('mcp-call-2');
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

  it('expands a command approval to show the full command, folder and timeout', () => {
    render(<ApprovalPanel pending={[pendingCommand]} onDecide={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: '展开' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.approval-card-content')).toBeNull();

    fireEvent.click(toggle);

    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    const content = document.getElementById(collapse.getAttribute('aria-controls') ?? '');
    expect(content?.querySelector('pre.approval-code')?.textContent).toBe(longCommand);
    expect(content?.textContent).toContain('工作目录 packages/app · 超时 2 分钟');

    fireEvent.click(collapse);
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy();
    expect(document.querySelector('.approval-card-content')).toBeNull();
  });

  it('shows the diff of an edit with added and removed lines marked', () => {
    render(<ApprovalPanel pending={[pendingEdit]} onDecide={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '展开' }));

    expect(screen.getByText('@@ -1,2 +1,2 @@').className).toContain('approval-diff-hunk');
    expect(screen.getByText('-const b = 2;').className).toContain('approval-diff-removed');
    expect(screen.getByText('+const b = 20;').className).toContain('approval-diff-added');
    expect(screen.getByText(/替换 1 处 · 新增 1 行，删除 1 行/)).toBeTruthy();
  });

  it('lists write details and shows the summary of other tools as JSON', () => {
    const overwrite: ApprovalRequest = {
      ...pendingWrite,
      inputSummary: {
        path: 'notes.md',
        bytes: 12,
        lines: 1,
        overwrite: true,
        previousBytes: 2048,
        previousLines: 80,
        createdDirectories: [],
      },
    };
    const pluginApproval: ApprovalRequest = {
      ...pendingWrite,
      approvalId: 'approval-4',
      toolCallId: 'call-4',
      toolName: 'deploy',
      operation: 'plugin.deploy',
      summary: '部署到预发环境',
      inputSummary: { target: 'staging' },
    };
    render(<ApprovalPanel pending={[overwrite, pluginApproval]} onDecide={vi.fn()} />);
    const [writeToggle, pluginToggle] = screen.getAllByRole('button', { name: '展开' });

    fireEvent.click(writeToggle!);
    expect(screen.getByText('新内容 12 B，1 行')).toBeTruthy();
    expect(screen.getByText('覆盖前 2.0 KB，80 行')).toBeTruthy();

    fireEvent.click(pluginToggle!);
    expect(screen.getByText(/"target": "staging"/)).toBeTruthy();
  });

  it('shows no toggle when the summary has nothing more to show', () => {
    render(
      <ApprovalPanel
        pending={[
          { ...pendingWrite, operation: 'plugin.noop', toolName: 'noop', inputSummary: {} },
        ]}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '展开' })).toBeNull();
  });
});
