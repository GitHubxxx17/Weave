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
  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

describe('Studio Agent Chat', () => {
  it('renders the workspace with Chinese interface labels by default', () => {
    render(<App />);

    expect(screen.getByLabelText('工作区导航')).toBeTruthy();
    expect(screen.getByLabelText('会话列表')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Weave 项目/ })).toBeTruthy();
    expect(screen.getByText('weave', { selector: '.project-folder-name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Agent 工作台' })).toBeTruthy();
    expect(screen.getByLabelText('Agent 工作流')).toBeTruthy();
    expect(screen.getByLabelText('运行活动')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '会话状态' })).toBeTruthy();
    expect(screen.getByText('工作区访问')).toBeTruthy();
    expect(screen.getByText('本地模型')).toBeTruthy();
    expect(screen.queryByText('SESSION CONTEXT')).toBeNull();
    expect(screen.queryByText('LIVE TRACE')).toBeNull();
    expect(screen.queryByText('TOOL PIPELINE')).toBeNull();
    expect(screen.getByLabelText('发送消息')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('creates a project from a local folder and switches to its session list', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'demo-project' }),
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '创建项目' }));

    const dialog = screen.getByRole('dialog', { name: '创建项目' });
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));

    const projectNameInput = within(dialog).getByRole('textbox', { name: '项目名称' });
    await waitFor(() => {
      expect((projectNameInput as HTMLInputElement).value).toBe('demo-project');
      expect(
        within(dialog).getByText('demo-project', { selector: '.selected-folder-name' }),
      ).toBeTruthy();
    });

    fireEvent.change(projectNameInput, { target: { value: 'Demo 项目' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));

    expect(screen.getByRole('button', { name: /Demo 项目 项目/ })).toBeTruthy();
    expect(screen.getByText('demo-project', { selector: '.project-folder-name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /未命名会话/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Session event store/ })).toBeTruthy();
  });

  it('keeps sessions scoped to their project when switching projects', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'client-app' }),
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '创建项目' }));
    const dialog = screen.getByRole('dialog', { name: '创建项目' });
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    await waitFor(() => {
      expect(
        (within(dialog).getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value,
      ).toBe('client-app');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    expect(screen.getAllByRole('button', { name: /未命名会话/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /client-app 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Weave/ }));

    expect(screen.getByRole('button', { name: /Session event store/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起项目 client-app' }));
    expect(screen.queryByRole('button', { name: /未命名会话/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /client-app/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开项目 client-app' }));

    expect(screen.getAllByRole('button', { name: /未命名会话/ })).toHaveLength(2);
    expect(
      screen
        .getByRole('button', { name: '项目：client-app' })
        .classList.contains('project-tree-project'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: /client-app 项目/ })).toBeTruthy();
    expect(screen.getByText(/会话 #/)).toBeTruthy();
  });

  it('renders all projects as an expandable tree with sessions nested beneath each project', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'client-app' }),
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '创建项目' }));
    const dialog = screen.getByRole('dialog', { name: '创建项目' });
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    await waitFor(() => {
      expect(
        (within(dialog).getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value,
      ).toBe('client-app');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));

    const projectTree = screen.getByRole('tree', { name: '项目树' });
    expect(within(projectTree).getByRole('button', { name: '项目：Weave' })).toBeTruthy();
    expect(within(projectTree).getByRole('button', { name: '项目：client-app' })).toBeTruthy();
    expect(within(projectTree).getByRole('button', { name: /Session event store/ })).toBeTruthy();
    expect(within(projectTree).getByRole('button', { name: /未命名会话/ })).toBeTruthy();

    fireEvent.click(within(projectTree).getByRole('button', { name: '收起项目 Weave' }));

    expect(within(projectTree).queryByRole('button', { name: /Session event store/ })).toBeNull();
    expect(within(projectTree).getByRole('button', { name: /未命名会话/ })).toBeTruthy();

    fireEvent.click(within(projectTree).getByRole('button', { name: '展开项目 Weave' }));
    fireEvent.click(within(projectTree).getByRole('button', { name: /Session event store/ }));

    expect(screen.getByText('会话 #event-store')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Weave 项目/ })).toBeTruthy();
  });

  it('does not show a selection state for project nodes', () => {
    render(<App />);

    const projectButton = screen.getByRole('button', { name: '项目：Weave' });

    expect(projectButton.classList.contains('project-tree-project-active')).toBe(false);
    expect(projectButton.querySelector('.menu-check')).toBeNull();
    expect(screen.getByRole('button', { name: /本地 Agent 演示/ })).toBeTruthy();
  });

  it('edits a session title from the session action buttons', () => {
    render(<App />);

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    expect(sessionRow).toBeTruthy();

    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '编辑会话',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: '编辑会话' });
    const titleInput = within(dialog).getByRole('textbox', { name: '会话标题' });
    expect((titleInput as HTMLInputElement).value).toBe('Session event store');

    fireEvent.change(titleInput, { target: { value: '会话事件存储' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存标题' }));

    expect(screen.getByRole('button', { name: /会话事件存储/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
  });

  it('keeps session actions hidden until a session row is focused', () => {
    render(<App />);

    const sessionButton = screen.getByRole('button', { name: /本地 Agent 演示/ });
    const sessionRow = sessionButton.closest('.session-tree-item');
    expect(sessionRow).toBeTruthy();

    const actions = sessionRow?.querySelector('.session-actions');
    const statusDot = sessionRow?.querySelector('.session-dot');
    expect(actions?.parentElement).toBe(sessionRow);
    expect(statusDot?.parentElement).toBe(sessionRow);
    expect(actions?.getAttribute('role')).toBe('group');
    expect(actions?.getAttribute('aria-label')).toBe('会话操作');

    const actionButtons = within(actions as HTMLElement).getAllByRole('button');
    expect(actionButtons).toHaveLength(2);
    expect(
      actionButtons.every((button) => button.classList.contains('session-action-button')),
    ).toBe(true);
  });

  it('keeps the active session status dot beside, not inside, the session button', () => {
    render(<App />);

    const sessionRow = screen
      .getByRole('button', { name: /本地 Agent 演示/ })
      .closest('.session-tree-item');
    const sessionButton = within(sessionRow as HTMLElement).getByRole('button', {
      name: /本地 Agent 演示/,
    });
    const statusDot = sessionRow?.querySelector('.session-dot');
    const actions = sessionRow?.querySelector('.session-actions');

    expect(statusDot).toBeTruthy();
    expect(statusDot?.parentElement).toBe(sessionRow);
    expect(statusDot?.parentElement).not.toBe(sessionButton);
    expect(actions?.parentElement).toBe(sessionRow);
  });

  it('archives a session and exposes it in the archive area', () => {
    render(<App />);

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    expect(sessionRow).toBeTruthy();

    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '归档会话',
      }),
    );

    expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '归档' }));

    const archiveView = screen.getByRole('region', { name: '归档' });
    expect(within(archiveView).getByText('Session event store')).toBeTruthy();
    expect(
      within(archiveView).getByRole('button', { name: '恢复会话 Session event store' }),
    ).toBeTruthy();
    expect(
      within(archiveView).getByRole('button', { name: '永久删除会话 Session event store' }),
    ).toBeTruthy();
  });

  it('restores an archived session back to its project', () => {
    render(<App />);

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '归档会话',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复会话 Session event store' }));

    expect(screen.getByRole('button', { name: /Session event store/ })).toBeTruthy();
    expect(screen.getByRole('tree', { name: '项目树' })).toBeTruthy();
  });

  it('permanently deletes a session only after it is archived', () => {
    render(<App />);

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '归档会话',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除会话 Session event store' }));

    const dialog = screen.getByRole('dialog', { name: '永久删除会话' });
    expect(within(dialog).getByText(/无法恢复/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认永久删除' }));

    expect(screen.queryByText('Session event store')).toBeNull();
  });

  it('submits a message and renders streamed assistant text', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'reasoning-delta', text: '先分析。' });
      handlers.onEvent({ type: 'text-delta', text: '你好，' });
      handlers.onEvent({ type: 'text-delta', text: '这是 Weave。' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-1' });
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '介绍一下 Weave' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('介绍一下 Weave')).toBeTruthy();
    expect(await screen.findByText('你好，这是 Weave。')).toBeTruthy();
    expect(screen.getByText('先分析。')).toBeTruthy();
    expect(screen.getByText('已完成', { selector: '.run-status' })).toBeTruthy();
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

  it('creates a local session and makes it the active conversation', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    expect(screen.getByRole('button', { name: /未命名会话/ })).toBeTruthy();
    expect(screen.getByLabelText(/^会话 #\d+$/)).toBeTruthy();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('switches sessions and sends the request with the selected session id', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: '当前会话的回复' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-session-switch' });
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));

    expect(screen.getByText('会话 #event-store')).toBeTruthy();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '在当前会话中提问' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('当前会话的回复')).toBeTruthy();
    expect(streamAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-event-store' }),
      expect.objectContaining({ onEvent: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));

    expect(screen.getByText('会话 #local')).toBeTruthy();
    expect(screen.queryByText('当前会话的回复')).toBeNull();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('keeps a new session unavailable for switching while a run is active', () => {
    streamAgentRunMock.mockImplementation(
      () =>
        new Promise<void>(() => {
          // Keep the run active so session controls remain disabled.
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '保持运行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect((screen.getByRole('button', { name: '新建会话' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: /Session event store/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: /Weave 项目/ }) as HTMLButtonElement).disabled).toBe(
      true,
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
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '搜索 SSE' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('workspace.search')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: '工具调用' })).getByText('已完成', {
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
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '触发错误' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('Agent run failed')).toBeTruthy();
    expect(screen.queryByText(/secret\.ts|\/Users\/mi\/private/)).toBeNull();
    expect(
      within(screen.getByRole('region', { name: '运行错误' })).getByText('错误', {
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
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '取消这次运行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止运行' }));

    await waitFor(() => {
      expect(abortObserved).toBe(true);
      expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '取消后继续发送' },
    });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText('已取消')).toBeTruthy();
    expect(screen.getByText('本次运行已取消')).toBeTruthy();
  });

  it('does not submit a second message while streaming', () => {
    streamAgentRunMock.mockImplementation(
      () =>
        new Promise<void>(() => {
          // Keep the first run active so the duplicate-submit guard is observable.
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '只发送一次' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.submit(screen.getByLabelText('发送消息').closest('form') as HTMLFormElement);

    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it('switches product navigation views', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '项目' }));

    const projectView = screen.getByRole('region', { name: '项目' });
    expect(within(projectView).getByRole('heading', { name: '项目' })).toBeTruthy();
    expect(within(projectView).getByRole('button', { name: '创建项目' })).toBeTruthy();
    expect(
      within(projectView).getByText('Weave', { selector: '.project-overview-item strong' }),
    ).toBeTruthy();
    expect(
      within(projectView).getByText('weave', { selector: '.project-folder-name' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '工作台' }).getAttribute('aria-current')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '工作台' }));

    expect(screen.getByRole('heading', { name: 'Agent 工作台' })).toBeTruthy();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('filters sessions from the search control', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /搜索会话/ }));
    const searchInput = screen.getByRole('searchbox', { name: '搜索会话' });

    fireEvent.change(searchInput, { target: { value: 'Foundation' } });

    expect(screen.getByRole('tree', { name: '项目树' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '项目：Weave' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Foundation 设计/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    expect(screen.queryByText('没有匹配的会话')).toBeNull();
  });

  it('toggles the activity panel and opens the model menu', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '收起上下文' }));

    expect(screen.queryByLabelText('运行活动')).toBeNull();
    const headerActions = document.querySelector('.header-actions');
    expect(headerActions).toBeTruthy();
    const headerButtons = within(headerActions as HTMLElement).getAllByRole('button');
    expect(headerButtons.at(-1)?.getAttribute('aria-label')).toBe('显示上下文');

    fireEvent.click(screen.getByRole('button', { name: '显示上下文' }));
    fireEvent.click(screen.getByRole('button', { name: '本地模型' }));

    expect(screen.getByRole('menu', { name: '选择模型' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }));

    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.queryByRole('menu', { name: '选择模型' })).toBeNull();
  });

  it('opens the permission and context menus', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '工作区访问' }));
    expect(screen.getByRole('menu', { name: '权限模式' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '仅查看' }));
    expect(screen.getByText('仅查看')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '添加上下文' }));
    expect(screen.getByRole('menu', { name: '添加上下文' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Git 变更' }));
    expect(screen.getByText('Git 变更')).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '第一轮' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '停止运行' }));
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '第二轮' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

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
      expect(screen.getByText('已完成', { selector: '.run-status' })).toBeTruthy();
    });
  });
});
