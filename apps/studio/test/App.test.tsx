// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const projectId = 'project-weave';
const sessionIds = {
  local: 'session-local',
  eventStore: 'session-event-store',
  foundation: 'session-foundation',
};

function sessionSummary(id: string, title: string, archivedAt?: string): Record<string, unknown> {
  return {
    id,
    title,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    lastSequence: 1,
  };
}

function sessionDetail(
  id: string,
  title: string,
  messages: readonly Record<string, unknown>[] = [],
  archivedAt?: string,
  failedToolCallIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const builtMessages = messages.map((message, index) => ({
    ...message,
    messageId: `${id}-message-${index + 1}`,
    sequence: index + 2,
    occurredAt: `2026-11-16T${String(index + 8).padStart(2, '0')}:30:00.000Z`,
  }));
  const turnIds = [
    ...new Set(
      builtMessages
        .map((message) => message.turnId)
        .filter((turnId): turnId is string => typeof turnId === 'string'),
    ),
  ];
  const toolResultsFor = (turnId: string): { toolCallId: string; status: string }[] =>
    builtMessages
      .filter((message) => message.role === 'assistant' && message.turnId === turnId)
      .flatMap((message) =>
        (((message as { toolCalls?: { id: string }[] }).toolCalls ?? []) as { id: string }[]).map(
          (toolCall) => ({
            toolCallId: toolCall.id,
            status: failedToolCallIds.has(toolCall.id) ? 'failed' : 'completed',
          }),
        ),
      );
  return {
    ...sessionSummary(id, title, archivedAt),
    messages: builtMessages,
    turns: turnIds.map((turnId) => ({
      turnId,
      status: 'completed',
      startedAt: '2026-11-16T08:30:00.000Z',
      completedAt: '2026-11-16T08:30:18.600Z',
      model: 'deepseek-flash',
      usage: { inputTokens: 12400, outputTokens: 860, cacheReadTokens: 10044 },
      context: {
        windowTokens: 128000,
        sentTokens: 24000,
        ratio: 24000 / 128000,
        trimmed: false,
        categories: {
          system: 500,
          tools: 300,
          userMessages: 1200,
          assistantText: 1800,
          assistantReasoning: 0,
          toolCalls: 200,
          toolResults: 20000,
          skeleton: 0,
        },
      },
      modelSteps: [],
      toolResults: toolResultsFor(turnId),
      toolCalls: 0,
      failedToolCalls: 0,
    })),
  };
}

function createWorkspaceFetchMock(
  providerSettings?: Record<string, unknown>,
  options?: { readonly emptyWorkspace?: boolean; readonly emptyProject?: boolean },
): ReturnType<typeof vi.fn> {
  const sessions = new Map<string, Record<string, unknown>>([
    [sessionIds.local, sessionDetail(sessionIds.local, '本地 Agent 演示')],
    [sessionIds.eventStore, sessionDetail(sessionIds.eventStore, 'Session event store')],
    [
      sessionIds.foundation,
      sessionDetail(
        sessionIds.foundation,
        'Foundation 设计',
        [
          { role: 'user', content: [{ type: 'text', text: '历史项目问题' }] },
          {
            role: 'assistant',
            turnId: 'turn-foundation',
            content: [{ type: 'reasoning', text: '历史思考过程' }],
            toolCalls: [
              { id: 'history-call', name: 'workspace.search', arguments: '{"query":"历史"}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'history-call',
            content: [{ type: 'text', text: '找到 2 个结果' }],
          },
          {
            role: 'assistant',
            turnId: 'turn-foundation',
            content: [
              { type: 'reasoning', text: '第二步思考' },
              { type: 'text', text: '历史项目回答' },
            ],
          },
        ],
        undefined,
        new Set(['history-call']),
      ),
    ],
  ]);
  const projects = options?.emptyWorkspace
    ? []
    : [
        {
          id: projectId,
          name: 'Weave',
          folderName: 'weave',
          createdAt: '2026-11-14T00:00:00.000Z',
          updatedAt: '2026-11-14T00:00:00.000Z',
          // Server returns sessions in creation order (oldest first); the UI
          // reverses to newest-first, so "local" here is the most recent and
          // becomes the default-selected session.
          sessions: [
            sessionSummary(sessionIds.foundation, 'Foundation 设计'),
            sessionSummary(sessionIds.eventStore, 'Session event store'),
            sessionSummary(sessionIds.local, '本地 Agent 演示'),
          ],
        },
        ...(options?.emptyProject === true
          ? [
              {
                id: 'project-empty',
                name: 'Orbit',
                folderName: 'orbit',
                createdAt: '2026-11-15T00:00:00.000Z',
                updatedAt: '2026-11-15T00:00:00.000Z',
                sessions: [] as ReturnType<typeof sessionSummary>[],
              },
            ]
          : []),
      ];
  let nextProjectId = 0;
  let nextSessionId = 0;
  let currentProviderSettings = providerSettings;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const requestPath = new URL(url, 'http://weave.local').pathname;
    if (requestPath === '/settings/providers') {
      if (currentProviderSettings === undefined) {
        return new Response(
          JSON.stringify({
            error: { code: 'provider-service-unavailable', message: 'Provider unavailable' },
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (method === 'GET') {
        return new Response(JSON.stringify(currentProviderSettings), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          id: string;
          label: string;
          type: 'openai-compatible';
          baseUrl: string;
          defaultModel: string;
          makeDefault: boolean;
        };
        const provider = {
          id: body.id,
          label: body.label,
          type: body.type,
          baseUrl: body.baseUrl,
          defaultModel: body.defaultModel,
          hasApiKey: true,
          editable: true,
        };
        currentProviderSettings = {
          providers: [...currentProviderSettings.providers, provider],
          defaultProvider: body.makeDefault ? body.id : currentProviderSettings.defaultProvider,
          canManage: true,
        };
        return new Response(JSON.stringify({ provider }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'not-found', message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const providerPatchMatch = requestPath.match(/^\/settings\/providers\/([^/]+)$/);
    if (providerPatchMatch !== null && currentProviderSettings !== undefined) {
      const providerId = decodeURIComponent(providerPatchMatch[1]!);
      const current = currentProviderSettings.providers.find(
        (provider) => provider.id === providerId,
      );
      if (current === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not-found', message: 'Not found' } }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as {
          label?: string;
          baseUrl?: string;
          defaultModel?: string;
          makeDefault?: boolean;
          clearApiKey?: boolean;
        };
        const provider = {
          ...current,
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
          ...(body.defaultModel === undefined ? {} : { defaultModel: body.defaultModel }),
          hasApiKey: body.clearApiKey === true ? false : current.hasApiKey,
        };
        currentProviderSettings = {
          ...currentProviderSettings,
          providers: currentProviderSettings.providers.map((item) =>
            item.id === providerId ? provider : item,
          ),
          defaultProvider:
            body.makeDefault === true ? providerId : currentProviderSettings.defaultProvider,
        };
        return new Response(JSON.stringify({ provider }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE') {
        currentProviderSettings = {
          ...currentProviderSettings,
          providers: currentProviderSettings.providers.filter((item) => item.id !== providerId),
          defaultProvider:
            currentProviderSettings.defaultProvider === providerId
              ? 'mock'
              : currentProviderSettings.defaultProvider,
        };
        return new Response(null, { status: 204 });
      }
    }
    const providerDefaultMatch = requestPath.match(/^\/settings\/providers\/([^/]+)\/default$/);
    if (
      providerDefaultMatch !== null &&
      method === 'POST' &&
      currentProviderSettings !== undefined
    ) {
      currentProviderSettings = {
        ...currentProviderSettings,
        defaultProvider: decodeURIComponent(providerDefaultMatch[1]!),
      };
      return new Response(JSON.stringify(currentProviderSettings), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (
      requestPath === '/projects' &&
      new URL(url, 'http://weave.local').searchParams.has('includeArchived')
    ) {
      return new Response(JSON.stringify({ projects, warnings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestPath === '/projects' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string; folderName: string };
      const project = {
        id: `project-created-${++nextProjectId}`,
        name: body.name,
        folderName: body.folderName,
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T00:00:00.000Z',
      };
      projects.push({ ...project, sessions: [] });
      return new Response(JSON.stringify(project), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    const projectSessionMatch = requestPath.match(/^\/projects\/([^/]+)\/sessions$/);
    const projectUpdateMatch = requestPath.match(/^\/projects\/([^/]+)$/);
    if (projectUpdateMatch !== null && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as {
        name?: string;
        folderPath?: string | null;
      };
      const project = projects.find(
        (candidate) => candidate.id === decodeURIComponent(projectUpdateMatch[1]!),
      );
      if (project === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'workspace-project-not-found', message: 'missing' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      if (body.name !== undefined) {
        project.name = body.name;
      }
      const updated = {
        id: project.id,
        name: project.name,
        folderName: project.folderName,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        ...(body.folderPath === null || body.folderPath === undefined
          ? {}
          : { folderPath: body.folderPath }),
      };
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (projectSessionMatch !== null && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { title?: string };
      const id = `session-created-${++nextSessionId}`;
      const detail = sessionDetail(id, body.title ?? '未命名会话');
      sessions.set(id, detail);
      const project = projects.find((candidate) => candidate.id === projectSessionMatch[1]);
      project?.sessions.unshift(sessionSummary(id, body.title ?? '未命名会话'));
      return new Response(JSON.stringify(detail), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    const sessionMatch = requestPath.match(/^\/sessions\/([^/]+)(?:\/(archive|restore))?$/);
    if (sessionMatch !== null) {
      const id = decodeURIComponent(sessionMatch[1]!);
      const current = sessions.get(id) ?? sessionDetail(id, '未命名会话');
      if (method === 'GET') {
        return new Response(JSON.stringify(current), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { title: string };
        const updated = { ...current, title: body.title };
        sessions.set(id, updated);
        return new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && sessionMatch[2] === 'archive') {
        const updated = { ...current, archivedAt: '2026-11-16T01:00:00.000Z' };
        sessions.set(id, updated);
        return new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && sessionMatch[2] === 'restore') {
        const updated = { ...current, archivedAt: undefined };
        sessions.set(id, updated);
        return new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE') {
        const updated = { ...current, deletedAt: '2026-11-16T02:00:00.000Z' };
        sessions.set(id, updated);
        return new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'not-found', message: 'Not found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
}

let fetchMock = createWorkspaceFetchMock();

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(screen.getByRole('region', { name: '智能对话' })).toBeTruthy());
}

beforeEach(() => {
  fetchMock = createWorkspaceFetchMock();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fetchMock.mockClear();
  localStorage.clear();
  Reflect.deleteProperty(window, 'showDirectoryPicker');
  Reflect.deleteProperty(window, 'weaveDesktop');
});

describe('Studio Agent Chat', () => {
  it('renders the workspace with Chinese interface labels by default', async () => {
    await renderApp();

    expect(screen.getByLabelText('工作区导航')).toBeTruthy();
    expect(screen.getByLabelText('会话列表')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Weave 项目/ })).toBeTruthy();
    expect(screen.getByText('weave', { selector: '.project-folder-name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '智能对话' })).toBeTruthy();
    expect(screen.getByLabelText('Agent 工作流')).toBeTruthy();
    expect(screen.getByLabelText('运行活动')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '概览' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '用量' })).toBeTruthy();
    expect(screen.getByText('常规')).toBeTruthy();
    expect(screen.getByText('本地模型')).toBeTruthy();
    expect(screen.queryByText('SESSION CONTEXT')).toBeNull();
    expect(screen.queryByText('LIVE TRACE')).toBeNull();
    expect(screen.queryByText('TOOL PIPELINE')).toBeNull();
    expect(screen.queryByText('feat/studio-ui-polish')).toBeNull();
    expect(screen.getByLabelText('发送消息')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('creates a project from a local folder and switches to its session list', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'demo-project' }),
    });

    await renderApp();
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

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '项目：Demo 项目' })).toBeTruthy();
      expect(screen.getByText('demo-project', { selector: '.project-folder-name' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /未命名会话/ })).toBeTruthy();
    });
    const projectTree = screen.getByRole('tree', { name: '项目树' });
    const createdProject = within(projectTree).getByRole('treeitem', {
      name: /Demo 项目/,
    });
    expect(within(createdProject).getByRole('button', { name: /未命名会话/ })).toBeTruthy();
  });

  function projectPostBodies(): unknown[] {
    return fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          String(url).endsWith('/projects') && (init as RequestInit | undefined)?.method === 'POST',
      )
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
  }

  it('sets the folder of an existing project from the project menu', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    expect(screen.getByText('未设置，Agent 不能读写文件')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /设置文件夹/ }));

    const dialog = screen.getByRole('dialog', { name: '设置项目文件夹' });
    const save = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '项目文件夹绝对路径' }), {
      target: { value: '/Users/me/weave' },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '设置项目文件夹' })).toBeNull(),
    );
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(String(patch?.[0])).toMatch(/\/projects\/[^/]+$/);
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      folderPath: '/Users/me/weave',
    });

    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    expect(
      within(screen.getByRole('menu', { name: '切换项目' })).getByText('/Users/me/weave'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: '概览' })).getByText('/Users/me/weave'),
    ).toBeTruthy();
  });

  it('points to the thinking block when the model returns only reasoning', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'reasoning-delta', text: 'Final answer: 可以读取。' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-reasoning-only' });
    });

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '能读文件吗' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(
      await screen.findByText(
        '模型没有单独输出正文，回答写在了上方的「思考过程」里，展开即可查看。',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Agent 没有返回文本')).toBeNull();
  });

  it('submits an absolute folder path typed in browser mode', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'demo-project' }),
    });

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '创建项目' }));
    const dialog = screen.getByRole('dialog', { name: '创建项目' });
    expect(within(dialog).getByText('未设置文件夹路径时，Agent 不能读写项目文件。')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value,
      ).toBe('demo-project'),
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: '文件夹绝对路径' }), {
      target: { value: '/Users/me/demo-project' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));

    await waitFor(() =>
      expect(projectPostBodies()).toContainEqual({
        name: 'demo-project',
        folderName: 'demo-project',
        folderPath: '/Users/me/demo-project',
      }),
    );
  });

  it('uses the desktop folder dialog path when the bridge provides one', async () => {
    const pickDirectory = vi.fn(async () => ({ path: '/Users/me/desk-app', name: 'desk-app' }));
    window.weaveDesktop = { isDesktop: true, serverUrl: '', pickDirectory };

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Weave 项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '创建项目' }));
    const dialog = screen.getByRole('dialog', { name: '创建项目' });
    expect(within(dialog).queryByRole('textbox', { name: '文件夹绝对路径' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    expect(await within(dialog).findByText('/Users/me/desk-app')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));

    await waitFor(() =>
      expect(projectPostBodies()).toContainEqual({
        name: 'desk-app',
        folderName: 'desk-app',
        folderPath: '/Users/me/desk-app',
      }),
    );
    expect(pickDirectory).toHaveBeenCalledTimes(1);
  });

  it('keeps sessions scoped to their project when switching projects', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'client-app' }),
    });

    await renderApp();
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
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /client-app 项目/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /未命名会话/ })).toHaveLength(2);
    });

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
    expect(screen.getByLabelText(/会话 #/)).toBeTruthy();
  });

  it('renders all projects as an expandable tree with sessions nested beneath each project', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'client-app' }),
    });

    await renderApp();
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
    await waitFor(() => {
      expect(within(projectTree).getByRole('button', { name: '项目：Weave' })).toBeTruthy();
      expect(within(projectTree).getByRole('button', { name: '项目：client-app' })).toBeTruthy();
      expect(within(projectTree).getByRole('button', { name: /Session event store/ })).toBeTruthy();
      expect(within(projectTree).getByRole('button', { name: /未命名会话/ })).toBeTruthy();
    });

    fireEvent.click(within(projectTree).getByRole('button', { name: '收起项目 Weave' }));

    expect(within(projectTree).queryByRole('button', { name: /Session event store/ })).toBeNull();
    expect(within(projectTree).getByRole('button', { name: /未命名会话/ })).toBeTruthy();

    fireEvent.click(within(projectTree).getByRole('button', { name: '展开项目 Weave' }));
    fireEvent.click(within(projectTree).getByRole('button', { name: /Session event store/ }));

    expect(screen.getByLabelText('会话 #event-store')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Weave 项目/ })).toBeTruthy();
  });

  it('does not show a selection state for project nodes', async () => {
    await renderApp();

    const projectButton = screen.getByRole('button', { name: '项目：Weave' });

    expect(projectButton.classList.contains('project-tree-project-active')).toBe(false);
    expect(projectButton.querySelector('.menu-check')).toBeNull();
    expect(screen.getByRole('button', { name: /本地 Agent 演示/ })).toBeTruthy();
  });

  it('edits a session title from the session action buttons', async () => {
    await renderApp();

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

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /会话事件存储/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    });
  });

  it('keeps session actions hidden until a session row is focused', async () => {
    await renderApp();

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

  it('keeps the active session status dot beside, not inside, the session button', async () => {
    await renderApp();

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

  it('archives a session and exposes it in the archive area', async () => {
    await renderApp();

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    expect(sessionRow).toBeTruthy();

    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '归档会话',
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: '归档' }));

    const archiveView = screen.getByRole('region', { name: '归档' });
    await waitFor(() => {
      expect(within(archiveView).getByText('Session event store')).toBeTruthy();
      expect(
        within(archiveView).getByRole('button', { name: '恢复会话 Session event store' }),
      ).toBeTruthy();
      expect(
        within(archiveView).getByRole('button', { name: '永久删除会话 Session event store' }),
      ).toBeTruthy();
    });
  });

  it('restores an archived session back to its project', async () => {
    await renderApp();

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '归档会话',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复会话 Session event store' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Session event store/ })).toBeTruthy();
      expect(screen.getByRole('tree', { name: '项目树' })).toBeTruthy();
    });
  });

  it('permanently deletes a session only after it is archived', async () => {
    await renderApp();

    const sessionRow = screen
      .getByRole('button', { name: /Session event store/ })
      .closest('.session-tree-item');
    fireEvent.click(
      within(sessionRow as HTMLElement).getByRole('button', {
        name: '归档会话',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    fireEvent.click(
      await screen.findByRole('button', { name: '永久删除会话 Session event store' }),
    );

    const dialog = screen.getByRole('dialog', { name: '永久删除会话' });
    expect(within(dialog).getByText(/无法恢复/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认永久删除' }));

    await waitFor(() => {
      expect(screen.queryByText('Session event store')).toBeNull();
    });
  });

  it('shows per-Turn usage under the reply and in the usage panel, with retry and quote', async () => {
    let run = 0;
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      run += 1;
      handlers.onEvent({
        type: 'usage',
        usage: { inputTokens: 12_400, outputTokens: 860, cacheReadTokens: 10_044 },
        provider: 'mock',
        model: 'weave-local-demo',
      });
      handlers.onEvent({ type: 'text-delta', text: `第 ${run} 次回答` });
      handlers.onEvent({ type: 'completed', turnId: `turn-usage-${run}` });
    });

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '统计 token' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const firstReply = (await screen.findByText('第 1 次回答')).closest('.timeline-item');
    expect(
      within(firstReply as HTMLElement).getByText(
        /weave-local-demo · 输入 12k（命中 81%） · 输出 860/,
      ),
    ).toBeTruthy();

    // The usage panel opens from its tab and shows the session-wide cache hit.
    fireEvent.click(screen.getByRole('tab', { name: '用量' }));
    const usage = screen.getByRole('region', { name: '用量' });
    expect(within(usage).getByText('缓存命中')).toBeTruthy();
    expect(within(within(usage).getByLabelText('用量趋势')).getAllByRole('listitem')).toHaveLength(
      1,
    );

    fireEvent.click(within(firstReply as HTMLElement).getByRole('button', { name: '重试' }));
    const secondReply = (await screen.findByText('第 2 次回答')).closest('.timeline-item');
    expect(streamAgentRunMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userMessage: { role: 'user', content: [{ type: 'text', text: '统计 token' }] },
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(screen.getByText('第 1 次回答')).toBeTruthy();
    expect(within(secondReply as HTMLElement).getByRole('button', { name: '重试' })).toBeTruthy();

    const earlierReply = screen.getByText('第 1 次回答').closest('.timeline-item') as HTMLElement;
    expect(within(earlierReply).queryByRole('button', { name: '重试' })).toBeNull();
    fireEvent.click(within(earlierReply).getByRole('button', { name: '引用' }));
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
      '> 第 1 次回答\n\n',
    );
    fireEvent.click(screen.getByRole('tab', { name: '用量' }));
    expect(
      within(
        within(screen.getByRole('region', { name: '用量' })).getByLabelText('用量趋势'),
      ).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it('submits a message and renders streamed assistant text', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'reasoning-delta', text: '先分析。' });
      handlers.onEvent({ type: 'text-delta', text: '你好，' });
      handlers.onEvent({ type: 'text-delta', text: '这是 Weave。' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-1' });
    });

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '介绍一下 Weave' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('介绍一下 Weave')).toBeTruthy();
    expect(await screen.findByText('你好，这是 Weave。')).toBeTruthy();
    const assistantItem = screen.getByText('你好，这是 Weave。').closest('.timeline-item');
    expect(assistantItem).toBeTruthy();
    expect(
      within(assistantItem as HTMLElement).getByRole('group', { name: '本轮过程' }),
    ).toBeTruthy();
    expect(within(assistantItem as HTMLElement).getByText('先分析。')).toBeTruthy();
    expect(
      (assistantItem as HTMLElement)
        .querySelector('.message-process')
        ?.nextElementSibling?.classList.contains('message'),
    ).toBe(true);
    expect(screen.getByText('已完成', { selector: '.run-status' })).toBeTruthy();
    expect(streamAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-local',
        provider: 'mock',
        model: 'weave-local-demo',
        permissionMode: 'ask',
      }),
      expect.objectContaining({ onEvent: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('sends medium reasoning effort by default and the selected level otherwise', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'completed', turnId: 'turn-effort' });
    });

    await renderApp();

    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '默认强度' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('默认强度')).toBeTruthy();
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({ reasoningEffort: 'medium' });

    fireEvent.click(screen.getByRole('button', { name: '模型与强度' }));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '高强度' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('高强度')).toBeTruthy();
    expect(streamAgentRunMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('submits with Enter and keeps Shift+Enter for a newline', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: '已发送' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-enter' });
    });

    await renderApp();
    const input = screen.getByLabelText('发送消息');
    fireEvent.change(input, { target: { value: '第一行' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect((input as HTMLTextAreaElement).value).toBe('第一行');

    fireEvent.change(input, { target: { value: '第一行\n第二行' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      const userMessage = [...document.querySelectorAll('.timeline-item-user .message p')].find(
        (element) => element.textContent === '第一行\n第二行',
      );
      expect(userMessage).toBeTruthy();
    });
    expect(await screen.findByText('已发送')).toBeTruthy();
  });

  it('creates a default project and session when starting from an empty workspace', async () => {
    fetchMock = createWorkspaceFetchMock(undefined, { emptyWorkspace: true });
    vi.stubGlobal('fetch', fetchMock);
    streamAgentRunMock.mockResolvedValue(undefined);

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '项目：Weave' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /未命名会话/ })).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Weave', folderName: 'weave' }),
      }),
    );
  });

  it('creates a default project and session when sending from an empty workspace', async () => {
    fetchMock = createWorkspaceFetchMock(undefined, { emptyWorkspace: true });
    vi.stubGlobal('fetch', fetchMock);
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: '已从空工作区发送' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-empty-workspace' });
    });

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '直接开始任务' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('已从空工作区发送')).toBeTruthy();
    expect(streamAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-created-1',
      }),
      expect.objectContaining({ onEvent: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Weave', folderName: 'weave' }),
      }),
    );
  });

  it('loads configured Providers and submits the selected Provider and default model', async () => {
    fetchMock = createWorkspaceFetchMock({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
          hasApiKey: false,
          editable: false,
        },
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          hasApiKey: true,
          editable: true,
        },
      ],
      defaultProvider: 'deepseek',
      canManage: false,
    });
    vi.stubGlobal('fetch', fetchMock);
    streamAgentRunMock.mockResolvedValue(undefined);

    await renderApp();
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '使用 DeepSeek' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(streamAgentRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'deepseek',
          model: 'deepseek-chat',
        }),
        expect.objectContaining({ onEvent: expect.any(Function) }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('creates a local session and makes it the active conversation', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /未命名会话/ })).toBeTruthy();
      expect(screen.getByLabelText(/^会话 #.+$/)).toBeTruthy();
      expect(screen.getByText('今天想完成什么？')).toBeTruthy();
    });
  });

  it('persists a generated title on the first message of an untitled session', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    await screen.findByText('今天想完成什么？');

    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '写一个博客网站' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) =>
          /\/sessions\/[^/]+$/.test(String(url)) &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
        title: '写一个博客网站',
      });
    });
  });

  it('switches sessions and sends the request with the selected session id', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: '当前会话的回复' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-session-switch' });
    });

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));

    expect(screen.getByLabelText('会话 #event-store')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('今天想完成什么？')).toBeTruthy();
    });

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

    expect(screen.getByLabelText('会话 #local')).toBeTruthy();
    expect(screen.queryByText('当前会话的回复')).toBeNull();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('merges a multi-step turn into one card with a footer after refresh', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /Foundation 设计/ }));

    expect(await screen.findByText('历史项目问题')).toBeTruthy();
    expect(screen.getByText('历史项目回答')).toBeTruthy();
    expect(screen.getByLabelText('会话 #foundation')).toBeTruthy();

    // Two assistant steps of the same turn collapse into a single card.
    const assistantCards = document.querySelectorAll('.timeline-item-assistant');
    expect(assistantCards).toHaveLength(1);
    const assistantItem = assistantCards[0] as HTMLElement;
    expect(within(assistantItem).getByText(/历史思考过程/)).toBeTruthy();
    expect(within(assistantItem).getByText(/第二步思考/)).toBeTruthy();
    expect(within(assistantItem).getByText('workspace.search')).toBeTruthy();
    expect(within(assistantItem).getByText('找到 2 个结果')).toBeTruthy();

    // The merged card carries a footer with model, usage and actions.
    expect(within(assistantItem).getByText(/deepseek-flash · 输入 12k/)).toBeTruthy();
    expect(within(assistantItem).getByRole('button', { name: '复制' })).toBeTruthy();
    expect(within(assistantItem).getByRole('button', { name: '重试' })).toBeTruthy();

    // The composer shows an inline context-window meter from the turn breakdown.
    expect(screen.getByRole('button', { name: /上下文窗口占用 19%/ })).toBeTruthy();

    // A tool that failed shows as failed after reload (status comes from the server,
    // no longer hardcoded to completed).
    expect(within(assistantItem).getByText('失败')).toBeTruthy();
  });

  it('lists sessions with the most recently created first', async () => {
    await renderApp();
    const eventStore = screen.getByRole('button', { name: /Session event store/ });
    const foundation = screen.getByRole('button', { name: /Foundation 设计/ });
    // The server returns creation order (foundation, eventStore, local); the UI
    // reverses it, so the newer eventStore appears above the older foundation.
    expect(
      eventStore.compareDocumentPosition(foundation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps tool steps collapsed until expanded', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Foundation 设计/ }));
    await screen.findByText('历史项目回答');

    const card = document.querySelector('.timeline-item-assistant') as HTMLElement;
    const toolStep = within(card)
      .getByText('workspace.search')
      .closest('details') as HTMLDetailsElement;
    expect(toolStep.open).toBe(false);
    expect(within(toolStep).getByText(/"query": "历史"/)).toBeTruthy();
  });

  it('renders durable message timestamps instead of a fixed relative label', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /Foundation 设计/ }));
    expect(await screen.findByText('历史项目问题')).toBeTruthy();

    const messageTimes = document.querySelectorAll('.message-meta time');
    expect(messageTimes.length).toBeGreaterThan(0);
    expect([...messageTimes].every((time) => time.textContent !== '刚刚')).toBe(true);
    expect(messageTimes[0]?.getAttribute('datetime')).toBeTruthy();
  });

  it('runs sessions concurrently and keeps run state independent across switches', async () => {
    streamAgentRunMock.mockImplementation(
      () =>
        new Promise<void>(() => {
          // Keep the first session's run active in the background.
        }),
    );

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '保持运行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // The active session is running, yet switching controls stay enabled.
    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '新建会话' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: /Session event store/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((screen.getByRole('button', { name: /Weave 项目/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // The running session shows a run indicator in the rail.
    expect(screen.getByTitle('运行中')).toBeTruthy();

    // Switching to another session shows it as idle (ready to send), not blocked.
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    });
    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);

    // Switching back shows the first session's run still in progress.
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy();
    });
  });

  it('streams two concurrent runs into their own sessions', async () => {
    const emitters = new Map<string, AgentStreamHandlers['onEvent']>();
    streamAgentRunMock.mockImplementation(
      (request, handlers) =>
        new Promise<void>(() => {
          emitters.set(request.sessionId, handlers.onEvent);
        }),
    );

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'A 消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // Switch to a second session and start a concurrent run there.
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'B 消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(emitters.size).toBe(2);
    });
    expect(streamAgentRunMock).toHaveBeenCalledTimes(2);

    // Each run's deltas land in its own session, regardless of which is viewed.
    act(() => {
      emitters.get(sessionIds.local)?.({ type: 'text-delta', text: 'A 的回复' });
      emitters.get(sessionIds.eventStore)?.({ type: 'text-delta', text: 'B 的回复' });
    });

    // Viewing the second session shows only its own reply.
    expect(await screen.findByText('B 的回复')).toBeTruthy();
    expect(screen.queryByText('A 的回复')).toBeNull();

    // Switching back shows the first run's reply (its live stream was not clobbered).
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    expect(await screen.findByText('A 的回复')).toBeTruthy();
    expect(screen.queryByText('B 的回复')).toBeNull();
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

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '搜索 SSE' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findAllByText('workspace.search')).not.toHaveLength(0);
    const assistantItem = document.querySelector('.timeline-item-assistant');
    expect(assistantItem).toBeTruthy();
    expect(
      within(assistantItem as HTMLElement).getByRole('group', { name: '本轮过程' }),
    ).toBeTruthy();
    expect(within(assistantItem as HTMLElement).getByText('workspace.search')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '工具' }));
    expect(
      within(screen.getByRole('region', { name: '工具调用' })).getByTitle('已完成'),
    ).toBeTruthy();
    expect(screen.getAllByText('2 matches')).not.toHaveLength(0);
    expect(screen.getAllByText(/"query": "SSE"/)).not.toHaveLength(0);
  });

  it('marks a tool result returned as a recoverable failure', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'read_file', arguments: '{"path":"missing.md"}' },
      });
      handlers.onEvent({
        type: 'tool-result',
        result: {
          toolCallId: 'call-1',
          name: 'read_file',
          content: 'Tool "read_file" failed (tool-execution-failed).',
          truncated: false,
        },
        status: 'failed',
        errorCode: 'tool-execution-failed',
      });
      handlers.onEvent({ type: 'text-delta', text: '文件不存在' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-3' });
    });

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '读文件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('文件不存在')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '工具' }));
    expect(
      within(screen.getByRole('region', { name: '工具调用' })).getByTitle('失败'),
    ).toBeTruthy();
  });

  it('keeps conversation and activity panel as independent scroll regions', async () => {
    await renderApp();

    expect(document.querySelector('.studio-shell')?.classList.contains('studio-shell-fixed')).toBe(
      true,
    );
    expect(screen.getByLabelText('Agent 工作流').classList.contains('conversation-scroll')).toBe(
      true,
    );
    expect(screen.getByLabelText('运行活动').querySelector('.activity-scroll')).toBeTruthy();
  });

  it('resizes the side panel by dragging or with the keyboard and remembers the width', async () => {
    localStorage.removeItem('weave.studio.sidePanelWidth');
    await renderApp();
    const shell = document.querySelector('.studio-shell') as HTMLElement;
    const resizer = screen.getByRole('separator', { name: '调整面板宽度' });
    expect(shell.style.getPropertyValue('--panel-width')).toBe('292px');

    // Dragging left widens the panel; the width is committed on release.
    fireEvent.pointerDown(resizer, { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 800, pointerId: 1 });
    expect(shell.style.getPropertyValue('--panel-width')).toBe('392px');
    fireEvent.pointerUp(resizer, { clientX: 800, pointerId: 1 });
    expect(resizer.getAttribute('aria-valuenow')).toBe('392');
    expect(localStorage.getItem('weave.studio.sidePanelWidth')).toBe('392');

    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(resizer.getAttribute('aria-valuenow')).toBe('376');
    fireEvent.keyDown(resizer, { key: 'Home' });
    expect(resizer.getAttribute('aria-valuenow')).toBe('260');
    fireEvent.doubleClick(resizer);
    expect(shell.style.getPropertyValue('--panel-width')).toBe('292px');
  });

  it('opens a panel tab from the add menu, closes it, and remembers the layout', async () => {
    await renderApp();

    // Four data tabs are pinned by default, so none shows a close button.
    expect(screen.getByRole('tab', { name: '概览' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '工具' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^关闭概览$/ })).toBeNull();

    // The add menu now lists preview and terminal as openable (no coming-soon).
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    const addMenu = screen.getByRole('menu', { name: '添加面板' });
    expect(within(addMenu).queryByText('即将推出')).toBeNull();
    const terminalItem = within(addMenu).getByRole('menuitem', { name: /终端/ });
    expect((terminalItem as HTMLButtonElement).disabled).toBe(false);
    const previewItem = within(addMenu).getByRole('menuitem', { name: /预览/ });
    expect((previewItem as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));

    // Unpin the 工具 tab via its context menu, then it can be closed.
    const toolsTab = screen.getByRole('tab', { name: '工具' }).closest('.panel-tab') as HTMLElement;
    fireEvent.contextMenu(toolsTab);
    fireEvent.click(screen.getByRole('menuitem', { name: '取消固定' }));
    fireEvent.click(within(toolsTab).getByRole('button', { name: '关闭工具' }));
    expect(screen.queryByRole('tab', { name: '工具' })).toBeNull();
    expect(
      (
        (JSON.parse(localStorage.getItem('weave.studio.panelTabs.v2') ?? '{}').tabs ?? []) as {
          kind: string;
        }[]
      ).map((tab) => tab.kind),
    ).not.toContain('tools');

    // Reopening from the add menu restores the tab and makes it active.
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: '添加面板' })).getByRole('menuitem', {
        name: /工具/,
      }),
    );
    expect(screen.getByRole('tab', { name: '工具' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens the preview panel, loads a URL, and keeps the iframe across tab switches', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: '添加面板' })).getByRole('menuitem', {
        name: /预览/,
      }),
    );

    const preview = screen.getByRole('region', { name: '预览' });
    const address = within(preview).getByRole('textbox', { name: '预览网址' });

    // A non-http scheme is rejected before any iframe loads.
    fireEvent.change(address, { target: { value: 'file:///etc/passwd' } });
    fireEvent.click(within(preview).getByRole('button', { name: '打开' }));
    expect(within(preview).getByRole('alert').textContent).toContain('只支持 http 和 https 网址');
    expect(preview.querySelector('iframe')).toBeNull();

    // A bare localhost host defaults to http and loads.
    fireEvent.change(address, { target: { value: 'localhost:5173' } });
    fireEvent.click(within(preview).getByRole('button', { name: '打开' }));
    const frame = preview.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('http://localhost:5173/');
    // The URL is persisted under a per-instance key so several preview tabs stay independent.
    let storedPreviewUrl: string | null = null;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('weave.studio.previewUrl')) {
        storedPreviewUrl = localStorage.getItem(key);
      }
    }
    expect(storedPreviewUrl).toBe('http://localhost:5173/');

    // Switching to another tab keeps the preview mounted (same iframe node).
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(screen.getByRole('region', { name: '概览' })).toBeTruthy();
    const frameAfter = document.querySelector('.preview-panel iframe');
    expect(frameAfter).toBe(frame);
  });

  it('shows a safe error without leaking implementation details', async () => {
    const error = new AgentStreamError('agent-step-limit', 'Agent run failed', {
      cause: '/Users/mi/private/secret.ts',
    });
    streamAgentRunMock.mockRejectedValue(error);

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '触发错误' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('Agent run failed')).toBeTruthy();
    expect(screen.getByText('本次运行失败，请查看运行错误')).toBeTruthy();
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

    await renderApp();
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

  it('does not submit a second message while streaming', async () => {
    streamAgentRunMock.mockImplementation(
      () =>
        new Promise<void>(() => {
          // Keep the first run active so the duplicate-submit guard is observable.
        }),
    );

    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '只发送一次' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.submit(screen.getByLabelText('发送消息').closest('form') as HTMLFormElement);

    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it('switches product navigation views', async () => {
    await renderApp();

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

    expect(screen.getByRole('region', { name: '智能对话' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('今天想完成什么？')).toBeTruthy();
    });
  });

  it('renames a project from the projects page without touching its folder', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    const projectView = screen.getByRole('region', { name: '项目' });
    fireEvent.click(within(projectView).getByRole('button', { name: '重命名项目 Weave' }));

    const dialog = screen.getByRole('dialog', { name: '重命名项目' });
    const input = within(dialog).getByRole('textbox', { name: '新的项目名称' });
    expect((input as HTMLInputElement).value).toBe('Weave');
    fireEvent.change(input, { target: { value: '  Weave Studio  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存项目名称' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名项目' })).toBeNull());
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      name: 'Weave Studio',
    });
    expect(
      within(projectView).getByText('Weave Studio', { selector: '.project-overview-item strong' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '项目：Weave Studio' })).toBeTruthy();
  });

  it('starts a session or opens a project from the projects page', async () => {
    fetchMock = createWorkspaceFetchMock(undefined, { emptyProject: true });
    vi.stubGlobal('fetch', fetchMock);
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    fireEvent.click(screen.getByRole('button', { name: '在 Weave 中新建会话' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '智能对话' })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/projects\/[^/]+\/sessions$/),
      expect.objectContaining({ method: 'POST' }),
    );

    // A project without sessions still opens, on a blank workbench.
    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    expect(screen.getAllByText('未设置文件夹路径')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '打开项目 Orbit' }));
    expect(screen.getByRole('region', { name: '智能对话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Orbit 项目/ })).toBeTruthy();
    expect(screen.getByText('今天想完成什么？')).toBeTruthy();
  });

  it('filters sessions from the search control', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /搜索会话/ }));
    const searchInput = screen.getByRole('searchbox', { name: '搜索会话' });

    fireEvent.change(searchInput, { target: { value: 'Foundation' } });

    expect(screen.getByRole('tree', { name: '项目树' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '项目：Weave' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Foundation 设计/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Session event store/ })).toBeNull();
    expect(screen.queryByText('没有匹配的会话')).toBeNull();
  });

  it('toggles the activity panel and opens the model menu', async () => {
    fetchMock = createWorkspaceFetchMock({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
          hasApiKey: false,
          editable: false,
        },
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          hasApiKey: true,
          editable: true,
        },
      ],
      defaultProvider: 'mock',
      canManage: false,
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: '收起上下文' }));

    // The panel stays mounted but is hidden and inert so it can animate out.
    const shell = document.querySelector('.studio-shell');
    expect(shell?.classList.contains('studio-shell-panel-collapsed')).toBe(true);
    expect(document.querySelector('.activity-panel')?.getAttribute('aria-hidden')).toBe('true');
    const headerActions = document.querySelector('.header-actions');
    expect(headerActions).toBeTruthy();
    const headerButtons = within(headerActions as HTMLElement).getAllByRole('button');
    expect(headerButtons.at(-1)?.getAttribute('aria-label')).toBe('显示上下文');

    fireEvent.click(screen.getByRole('button', { name: '显示上下文' }));
    expect(shell?.classList.contains('studio-shell-panel-collapsed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '模型与强度' }));

    expect(screen.getByRole('menu', { name: '选择模型' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }));

    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.queryByRole('menu', { name: '选择模型' })).toBeNull();
  });

  it('shows configured Providers in the settings view without exposing API keys', async () => {
    fetchMock = createWorkspaceFetchMock({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
          hasApiKey: false,
          editable: false,
        },
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          hasApiKey: true,
          editable: true,
        },
      ],
      defaultProvider: 'mock',
      canManage: false,
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    const settings = screen.getByRole('region', { name: '设置' });
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: '设置分类' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '模型服务' })).toBeTruthy();
    expect(within(settings).getByRole('heading', { name: '模型服务' })).toBeTruthy();
    expect(within(settings).getByText('已配置的服务')).toBeTruthy();
    expect(within(settings).getByText('DeepSeek')).toBeTruthy();
    expect(within(settings).getByText(/deepseek-chat/)).toBeTruthy();
    expect(within(settings).getByText(/浏览器开发模式下/)).toBeTruthy();
    expect(within(settings).queryByText('server-only-key')).toBeNull();
  });

  it('allows Desktop users to add a Provider without displaying the secret afterward', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321',
    };
    fetchMock = createWorkspaceFetchMock({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
          hasApiKey: false,
          editable: false,
        },
      ],
      defaultProvider: 'mock',
      canManage: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 AI 服务' }));
    fireEvent.change(screen.getByLabelText('显示名称'), {
      target: { value: 'DeepSeek' },
    });
    fireEvent.change(screen.getByLabelText('Provider ID'), {
      target: { value: 'deepseek' },
    });
    fireEvent.change(screen.getByLabelText('API 地址'), {
      target: { value: 'https://api.deepseek.com' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'deepseek-secret' },
    });
    fireEvent.change(screen.getByLabelText('默认模型'), {
      target: { value: 'deepseek-chat' },
    });
    fireEvent.change(screen.getByLabelText('温度'), { target: { value: '0.4' } });
    fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '1024' } });
    fireEvent.change(screen.getByLabelText('上下文窗口 token'), { target: { value: '32000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Provider' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:46321/settings/providers',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"apiKey":"deepseek-secret"'),
        }),
      );
    });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === 'http://127.0.0.1:46321/settings/providers' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toMatchObject({
      temperature: 0.4,
      maxTokens: 1024,
      contextWindowTokens: 32000,
    });
    await waitFor(() => expect(screen.getByText('DeepSeek')).toBeTruthy());
    expect(screen.queryByDisplayValue('deepseek-secret')).toBeNull();
  });

  it('prefills common Provider and model choices while keeping custom input available', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321',
    };
    fetchMock = createWorkspaceFetchMock({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
          hasApiKey: false,
          editable: false,
        },
      ],
      defaultProvider: 'mock',
      canManage: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 AI 服务' }));

    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }));

    expect((screen.getByLabelText('显示名称') as HTMLInputElement).value).toBe('DeepSeek');
    expect((screen.getByLabelText('Provider ID') as HTMLInputElement).value).toBe('deepseek');
    expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe(
      'https://api.deepseek.com',
    );
    expect(screen.getByRole('button', { name: '默认模型' }).textContent).toContain(
      'deepseek-flash',
    );

    fireEvent.click(screen.getByRole('button', { name: '默认模型' }));
    expect(screen.getByRole('menu', { name: '默认模型' }).parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-v4-pro' }));
    expect(screen.getByRole('button', { name: '默认模型' }).textContent).toContain(
      'deepseek-v4-pro',
    );
    expect(screen.queryByLabelText('自定义模型')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '默认模型' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '自定义模型' }));
    fireEvent.change(screen.getByLabelText('自定义模型'), {
      target: { value: 'deepseek-experimental' },
    });
    expect((screen.getByLabelText('自定义模型') as HTMLInputElement).value).toBe(
      'deepseek-experimental',
    );
    expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe(
      'https://api.deepseek.com',
    );

    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '自定义供应商' }));
    expect(screen.getByLabelText('自定义供应商名称')).toBeTruthy();
    expect(screen.getByLabelText('自定义模型')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('自定义供应商名称'), {
      target: { value: '内网模型' },
    });
    fireEvent.change(screen.getByLabelText('自定义模型'), {
      target: { value: 'internal-chat' },
    });
    expect((screen.getByLabelText('自定义供应商名称') as HTMLInputElement).value).toBe('内网模型');
    expect((screen.getByLabelText('自定义模型') as HTMLInputElement).value).toBe('internal-chat');
  });

  it('edits an existing Provider with an empty API key to keep the old secret', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321',
    };
    fetchMock = createWorkspaceFetchMock({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
          hasApiKey: false,
          editable: false,
        },
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          hasApiKey: true,
          editable: true,
        },
      ],
      defaultProvider: 'deepseek',
      canManage: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑 Provider DeepSeek' }));

    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '保存 Provider' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:46321/settings/providers/deepseek',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            label: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: '',
            defaultModel: 'deepseek-chat',
            makeDefault: true,
            contextWindowTokens: null,
            temperature: null,
            maxTokens: null,
          }),
        }),
      );
    });
  });

  it('opens the permission and context menus', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: '常规' }));
    expect(screen.getByRole('menu', { name: '权限模式' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /信任/ }));
    expect(screen.getByText('信任')).toBeTruthy();

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

    await renderApp();
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
