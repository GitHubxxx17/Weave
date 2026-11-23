// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStreamError, streamAgentRun } from '../src/features/agent/agent-stream.js';
import { App } from '../src/app/App.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';
import type { AgentStreamHandlers } from '../src/features/agent/agent-types.js';
import type { AgentTaskView } from '../src/features/tasks/task-types.js';
import {
  planningRef,
  planningSkill,
  projectSkill,
  skillCatalog,
} from './support/skill-fixtures.js';
import { disabledManagedCatalog } from './support/disabled-managed-catalog.js';
import {
  managedCatalog,
  managedPluginId,
  managedPreview,
} from './support/managed-plugin-fixtures.js';

vi.mock('../src/features/agent/agent-stream.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/agent/agent-stream.js')>(
    '../src/features/agent/agent-stream.js',
  );

  return {
    ...actual,
    streamAgentRun: vi.fn(),
  };
});

const terminalMocks = vi.hoisted(() => ({
  instance: {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      return terminalMocks.instance;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

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
  options?: {
    readonly emptyWorkspace?: boolean;
    readonly emptyProject?: boolean;
    readonly commands?: readonly Record<string, unknown>[];
  },
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
          {
            role: 'user',
            content: [
              { type: 'text', text: '看这张历史图' },
              { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
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
    const queueMatch = /^\/sessions\/([^/]+)\/executions\/queue(?:\/(events))?$/.exec(requestPath);
    if (queueMatch !== null && method === 'GET') {
      if (queueMatch[2] === 'events')
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      return Response.json({
        sessionId: queueMatch[1],
        revision: 0,
        cursor: `epoch:${queueMatch[1]}:0`,
        active: null,
        queued: [],
        scheduler: 'ready',
        limits: { sessionQueued: 10, globalQueued: 100 },
      });
    }
    if (/^\/sessions\/[^/]+\/executions$/.test(requestPath) && method === 'GET')
      return Response.json([]);
    const managed = disabledManagedCatalog(requestPath, init);
    if (managed !== undefined) return managed;
    if (requestPath === '/mcp' && method === 'GET') {
      return new Response(
        JSON.stringify({ error: { code: 'mcp-management-disabled', message: 'MCP disabled' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    if (requestPath === '/plugins' && method === 'GET') {
      return new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestPath === '/plugins/marketplace' && method === 'GET') {
      return Response.json({
        schemaVersion: 1,
        hostVersion: '0.0.0',
        communityStatus: 'unconfigured',
        entries: [],
      });
    }
    if (requestPath === '/commands') {
      return new Response(JSON.stringify({ commands: options?.commands ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
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

function openInstalledPlugins(): void {
  fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
  fireEvent.click(screen.getByRole('tab', { name: '已安装' }));
}

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
  vi.unstubAllGlobals();
});

describe('Agent Tasks in Studio', () => {
  const root = sessionIds.local;
  const task: AgentTaskView = {
    taskId: '00000000-0000-4000-8000-000000000001',
    rootSessionId: root,
    parentSessionId: root,
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
    pendingApprovalIds: ['child-approval'],
    pendingApprovalCount: 1,
  };
  const approval = {
    approvalId: 'child-approval',
    toolCallId: 'child-tool',
    sessionId: task.childSessionId,
    executionId: task.childExecutionId,
    turnId: task.childTurnId,
    toolName: 'workspace.search',
    operation: 'tool.execute',
    summary: '查询变更文件',
    risk: 'low',
    inputSummary: {},
    status: 'pending',
    createdAt: '2026-11-23T00:00:01.000Z',
  };

  function installTasks(
    options: {
      listChild?: boolean;
      delayDetail?: Promise<void>;
      tasks?: readonly AgentTaskView[];
    } = {},
  ): void {
    const fallback = fetchMock.getMockImplementation()!;
    const tasks = options.tasks ?? [task];
    const snapshot = {
      tasks,
      cursor: 'tree-1',
      epoch: 'epoch',
      revision: 1,
      rootSessionId: root,
      changed: true,
      totalCount: tasks.length,
      truncated: false,
    };
    function eventStream(event: string, value: unknown): Response {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://weave.local').pathname;
      if (path === '/projects' && options.listChild) {
        const response: Response = await fallback(input, init);
        const body = await response.json();
        body.projects[0].sessions.push(sessionSummary(task.childSessionId, task.title));
        return Response.json(body);
      }
      if (path === `/sessions/${task.childSessionId}`) {
        await options.delayDetail;
        return Response.json({
          ...sessionDetail(task.childSessionId, task.title, [
            {
              role: 'assistant',
              turnId: task.childTurnId,
              content: [],
              toolCalls: [
                {
                  id: approval.toolCallId,
                  name: approval.toolName,
                  arguments: '{"query":"child only"}',
                },
              ],
            },
            {
              role: 'assistant',
              turnId: task.childTurnId,
              content: [{ type: 'text', text: '子任务输出' }],
            },
          ]),
          taskOrigin: { taskId: task.taskId, rootSessionId: root, parentSessionId: root },
        });
      }
      if (path === `/sessions/${root}/tasks/events`) return eventStream('tasks', snapshot);
      if (path === `/sessions/${root}/tasks`) return Response.json(snapshot);
      if (
        path === `/sessions/${root}/tasks/${task.taskId}/cancel` ||
        path === `/sessions/${root}/tasks/stop-all`
      ) {
        return Response.json({ tasks: [task] }, { status: 202 });
      }
      if (path === '/approvals/stream')
        return eventStream('approval.snapshot', {
          approvals: [
            approval,
            {
              ...approval,
              approvalId: 'wrong-execution',
              summary: '其他执行审批',
              executionId: 'mismatch',
            },
            { ...approval, approvalId: 'wrong-turn', summary: '其他轮次审批', turnId: 'mismatch' },
          ],
        });
      if (path === '/approvals/child-approval/reject')
        return Response.json({ ...approval, status: 'rejected' });
      return fallback(input, init);
    });
  }

  it('keeps the parent draft and one task stream while opening a previously unlisted child', async () => {
    const detail = Promise.withResolvers<void>();
    installTasks({ delayDetail: detail.promise });
    await renderApp();
    const taskDisclosure = await screen.findByText('并行子任务（1） · 有待审批');
    (taskDisclosure.parentElement as HTMLDetailsElement).open = true;
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '先保留这条草稿' } });
    fireEvent.change(screen.getByLabelText('委派说明'), { target: { value: '检查覆盖范围' } });
    fireEvent.click(screen.getByRole('button', { name: '添加到会话草稿' }));
    const draft = (screen.getByLabelText('发送消息') as HTMLTextAreaElement).value;
    expect(draft).toContain(
      '先保留这条草稿\n\n请将以下工作委派给子任务，访问权限为只读（read-only）',
    );
    expect(streamAgentRunMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '打开子会话：检查变更' }));
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(draft);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/tasks/events')),
    ).toHaveLength(1);
    await act(async () => detail.resolve());
    await screen.findByText('子任务输出');
    expect(screen.getByText('子会话只读。返回父会话继续发送。')).toBeTruthy();
    expect(screen.queryByLabelText('发送消息')).toBeNull();
    fireEvent.submit(screen.getByText('子会话只读。返回父会话继续发送。').closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: '停止子任务' }));
    fireEvent.click(screen.getByRole('button', { name: '返回父会话' }));
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(draft);
    (screen.getByText('并行子任务（1） · 有待审批').parentElement as HTMLDetailsElement).open =
      true;
    fireEvent.click(screen.getByRole('button', { name: '停止全部子任务' }));
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/tasks/events')),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([input]) => String(input)),
    ).toEqual([
      `/sessions/${root}/tasks/${task.taskId}/cancel`,
      `/sessions/${root}/tasks/stop-all`,
    ]);
    expect(streamAgentRunMock).not.toHaveBeenCalled();
  });

  it('opens the exact durable message through its merged Turn card', async () => {
    const pointer = {
      sessionId: task.childSessionId,
      executionId: task.childExecutionId,
      turnId: task.childTurnId,
      messageId: `${task.childSessionId}-message-2`,
      terminalSequence: 4,
    };
    installTasks({
      tasks: [
        {
          ...task,
          status: 'failed',
          settledAt: '2026-11-23T00:00:08.000Z',
          resultKind: 'partial',
          reason: 'agent-step-limit',
          preview: '预览',
          result: pointer,
          pendingApprovalIds: [],
          pendingApprovalCount: 0,
        },
      ],
    });
    const scrolls: string[] = [];
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        scrolls.push(this.id);
      },
    });
    try {
      await renderApp();
      const disclosure = await screen.findByText('并行子任务（1）');
      (disclosure.parentElement as HTMLDetailsElement).open = true;
      fireEvent.click(screen.getByRole('button', { name: '查看全文：检查变更' }));
      await waitFor(() => expect(scrolls).toContain(`message-${pointer.turnId}`));
      expect(screen.getByText('子任务输出')).toBeTruthy();
    } finally {
      if (previousScroll === undefined)
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
    }
  });

  it('shows only exactly attributed child approvals in the parent and locates the tool call', async () => {
    installTasks();
    await renderApp();
    const card = await screen.findByRole('article', { name: '待审批：查询变更文件' });
    expect(screen.queryByText('其他执行审批')).toBeNull();
    expect(screen.queryByText('其他轮次审批')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '查看参数' }));
    await screen.findByText('子任务输出');
    await waitFor(() =>
      expect(document.activeElement?.hasAttribute('data-tool-parameters')).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: '返回父会话' }));
    fireEvent.click(
      within(screen.getByRole('article', { name: '待审批：查询变更文件' })).getByRole('button', {
        name: '拒绝工具调用',
      }),
    );
    await waitFor(() => expect(screen.queryByText('查询变更文件')).toBeNull());
    const requests = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/approvals/'),
    );
    expect(requests.map(([input]) => input)).toEqual([
      '/approvals/stream',
      '/approvals/child-approval/reject',
    ]);
  });

  it('waits for Session Detail before enabling a refreshed child composer', async () => {
    let finishDetail!: () => void;
    const delayDetail = new Promise<void>((resolve) => {
      finishDetail = resolve;
    });
    installTasks({ listChild: true, delayDetail });
    render(<App />);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => String(input) === `/sessions/${task.childSessionId}`,
        ),
      ).toBe(true),
    );
    expect(screen.queryByLabelText('发送消息')).toBeNull();
    await act(async () => finishDetail());
    await screen.findByText('子会话只读。返回父会话继续发送。');
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回父会话' }));
    expect(await screen.findByLabelText('发送消息')).toBeTruthy();
    expect(
      fetchMock.mock.calls
        .filter(([input]) => String(input).includes('/tasks/events'))
        .map(([input]) => input),
    ).toEqual([`/sessions/${root}/tasks/events`]);
  });
});

describe('Studio Agent Chat', () => {
  it.each([false, true])(
    'reads the plugin catalog at startup without writes (restored=%s)',
    async (restored) => {
      if (restored) {
        localStorage.setItem(
          'weave.studio.panelTabs.v2',
          JSON.stringify({
            tabs: [{ id: 'plugins', kind: 'plugins' }],
            active: 'plugins',
            pinned: [],
          }),
        );
      }
      await renderApp();
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/plugins')),
        ).toHaveLength(1),
      );
      const pluginCalls = fetchMock.mock.calls.filter(
        ([input]) => String(input).includes('/plugins') && String(input) !== '/plugins/panels',
      );
      expect(pluginCalls.map(([input, init]) => [String(input), init?.method])).toEqual([
        ['/plugins', 'GET'],
        ['/plugins/managed', 'GET'],
      ]);
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('refreshes marketplace observations with GET only on every navigation and leaves reload explicit', async () => {
    await renderApp();
    const catalogReads = (): number =>
      fetchMock.mock.calls.filter(([input]) => String(input) === '/plugins').length;
    expect(catalogReads()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
    await waitFor(() => expect(catalogReads()).toBe(2));
    expect(screen.getByRole('button', { name: '插件市场' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('complementary', { name: '会话列表' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '已安装' }));
    await screen.findByRole('region', { name: '插件' });
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(screen.queryByRole('region', { name: '插件' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
    await waitFor(() => expect(catalogReads()).toBe(3));
    expect(
      fetchMock.mock.calls
        .filter(([input]) => String(input).startsWith('/plugins'))
        .every(([, init]) => init?.method === 'GET'),
    ).toBe(true);
  });

  it.each([false, true])(
    'reloads extensions only from the explicit action (local management=%s)',
    async (localManagement) => {
      const baseFetch = fetchMock;
      const local = {
        directory: '/plugins',
        exists: true,
        truncated: false,
        trustSequence: 0,
        generation: { id: 1, acceptingRuns: true, plugins: [] },
      };
      const catalog = { plugins: [], ...(localManagement ? { local } : {}) };
      const routes = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/plugins') return Promise.resolve(Response.json(catalog));
        if (String(input) === '/plugins/reload')
          return Promise.resolve(
            Response.json({ ...catalog, result: { generation: 1, unchanged: true, failed: [] } }),
          );
        return baseFetch(input, init);
      });
      vi.stubGlobal('fetch', routes);
      await renderApp();
      openInstalledPlugins();
      const reload = await screen.findByRole<HTMLButtonElement>('button', {
        name: /重新发现并加载扩展/,
      });
      await waitFor(() => expect(reload.disabled).toBe(false));
      expect(
        routes.mock.calls
          .filter(([input]) => String(input).startsWith('/plugins'))
          .every(([, init]) => init?.method === 'GET'),
      ).toBe(true);
      const before = routes.mock.calls.filter(([input]) => String(input) === '/plugins').length;
      fireEvent.click(reload);
      if (localManagement) {
        await waitFor(() =>
          expect(
            routes.mock.calls.filter(
              ([input, init]) => String(input) === '/plugins/reload' && init?.method === 'POST',
            ),
          ).toHaveLength(1),
        );
      } else {
        await waitFor(() =>
          expect(routes.mock.calls.filter(([input]) => String(input) === '/plugins')).toHaveLength(
            before + 1,
          ),
        );
        expect(
          routes.mock.calls
            .filter(([input]) => String(input).startsWith('/plugins'))
            .every(([, init]) => init?.method === 'GET'),
        ).toBe(true);
      }
    },
  );

  it('keeps managed plugin observations across marketplace navigation without keeping import forms mounted', async () => {
    const routes = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET') {
        if (String(input) === '/plugins/managed')
          return Promise.resolve(Response.json(managedCatalog));
        if (String(input) === '/plugins')
          return Promise.resolve(
            Response.json({ plugins: [], generation: managedCatalog.generation }),
          );
      }
      return fetchMock(input, init);
    });
    vi.stubGlobal('fetch', routes);
    await renderApp();
    openInstalledPlugins();
    await screen.findByText(managedPluginId, { selector: '.plugin-name' });
    fireEvent.change(screen.getByRole('textbox', { name: '插件来源目录' }), {
      target: { value: '/local/source' },
    });
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(screen.queryByRole('region', { name: '受管插件' })).toBeNull();
    openInstalledPlugins();
    await screen.findByText(managedPluginId, { selector: '.plugin-name' });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '插件来源目录' }).value).toBe('');
    expect(
      routes.mock.calls
        .filter(([input]) => String(input).startsWith('/plugins'))
        .every(([, init]) => init?.method === 'GET'),
    ).toBe(true);
  });

  it('retains the unresolved management gate and exact import request after leaving the marketplace', async () => {
    const baseFetch = fetchMock;
    const imports: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://weave.local').pathname;
        if (path === '/plugins/managed' && init?.method === 'GET')
          return Promise.resolve(Response.json(managedCatalog));
        if (path === '/plugins' && init?.method === 'GET')
          return Promise.resolve(
            Response.json({ plugins: [], generation: managedCatalog.generation }),
          );
        if (path === '/plugins/managed/preview')
          return Promise.resolve(
            Response.json({
              ...managedPreview,
              expectedInstallSequence: 4,
              expiresAt: '2099-01-01T00:00:00.000Z',
            }),
          );
        if (path === '/plugins/managed/import') {
          imports.push(init!);
          return Promise.resolve(
            Response.json(
              { error: { code: 'plugin-authority-busy', message: '结果未知' } },
              { status: 503 },
            ),
          );
        }
        return baseFetch(input, init);
      }),
    );
    await renderApp();
    openInstalledPlugins();
    const path = await screen.findByRole('textbox', { name: '插件来源目录' });
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' }).disabled).toBe(
        false,
      ),
    );
    fireEvent.change(path, { target: { value: '/local/source' } });
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await screen.findByRole('button', { name: '重试原请求' });
    expect(imports).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    openInstalledPlugins();
    const retry = await screen.findByRole('button', { name: '重试原请求' });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' }).disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /重新发现并加载扩展/ }).disabled,
    ).toBe(true);
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole('button', { name: '确认重试' }));
    await waitFor(() => expect(imports).toHaveLength(2));
    expect(imports[1]).toEqual(imports[0]);
    expect(JSON.parse(String(imports[0]?.body)).requestId).toBeTruthy();
  });

  it('shows pending plugin reviews on the left marketplace entry', async () => {
    const baseFetch = fetchMock;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/plugins')
          return Promise.resolve(
            Response.json({
              plugins: [
                {
                  id: 'review-me',
                  name: 'Review Me',
                  version: '1.0.0',
                  origin: 'local',
                  host: 'in-process',
                  state: 'pending-trust',
                  capabilities: [],
                  provides: {
                    tools: [],
                    providers: [],
                    promptSections: [],
                    events: [],
                    commands: [],
                    hooks: [],
                    services: [],
                  },
                },
              ],
            }),
          );
        return baseFetch(input, init);
      }),
    );
    await renderApp();
    const nav = screen.getByRole('button', { name: '插件市场' });
    expect(await within(nav).findByLabelText('1 个插件待审阅')).toBeTruthy();
    expect(nav.hasAttribute('data-plugin-navigation')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    expect(screen.queryByRole('menuitem', { name: /插件/ })).toBeNull();
  });

  it('keeps the active stream and draft mounted while managing Memory', async () => {
    let handlers: AgentStreamHandlers | undefined;
    let signal: AbortSignal | undefined;
    streamAgentRunMock.mockImplementation((_request, next, options) => {
      handlers = next;
      signal = options?.signal;
      return new Promise<void>(() => undefined);
    });
    const workspaceFetch = fetchMock;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/memory/scopes')
          return Promise.resolve(
            Response.json({
              scopes: [
                {
                  scope: { kind: 'user' },
                  name: '个人记忆',
                  access: { scope: { kind: 'user' }, level: 'disabled', settingRevision: 0 },
                },
              ],
            }),
          );
        if (String(input).startsWith('/memory/records?'))
          return Promise.resolve(Response.json({ records: [] }));
        return workspaceFetch(input, init);
      }),
    );
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'keep running' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(handlers).toBeDefined());
    const draft = screen.getByLabelText<HTMLTextAreaElement>('发送消息');
    fireEvent.change(draft, { target: { value: 'my preserved draft' } });
    const chat = screen.getByRole('region', { name: '智能对话' });
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(await screen.findByRole('region', { name: '长期记忆' })).toBeDefined();
    expect(chat.isConnected).toBe(true);
    expect(signal?.aborted).toBe(false);
    act(() => handlers?.onEvent({ type: 'text-delta', text: 'Memory navigation stream event' }));
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(screen.getByRole('region', { name: '智能对话' })).toBe(chat);
    expect(screen.getByLabelText('发送消息')).toBe(draft);
    expect(draft.value).toBe('my preserved draft');
    expect(screen.getByText('Memory navigation stream event')).toBeDefined();
    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the active conversation draft, stream and preview DOM across marketplace navigation', async () => {
    let handlers: AgentStreamHandlers | undefined;
    let signal: AbortSignal | undefined;
    streamAgentRunMock.mockImplementation((_request, next, options) => {
      handlers = next;
      signal = options?.signal;
      return new Promise<void>(() => undefined);
    });
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '后台继续运行' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(handlers).toBeDefined());
    const draft = screen.getByLabelText<HTMLTextAreaElement>('发送消息');
    fireEvent.change(draft, { target: { value: '返回后继续编辑' } });
    const chat = screen.getByRole('region', { name: '智能对话' });
    const workflow = screen.getByLabelText('Agent 工作流');
    Object.defineProperties(workflow, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    workflow.scrollTop = 800;
    fireEvent.scroll(workflow);
    workflow.scrollTop = 137;
    fireEvent.scroll(workflow);
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '预览' }));
    const preview = screen.getByRole('region', { name: '预览' });
    fireEvent.change(within(preview).getByRole('textbox', { name: '预览网址' }), {
      target: { value: 'localhost:5173' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: '打开' }));
    const frame = preview.querySelector('iframe');
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整面板宽度' }), {
      key: 'ArrowLeft',
    });
    const layout = localStorage.getItem('weave.studio.panelTabs.v2');
    const width = localStorage.getItem('weave.studio.sidePanelWidth');
    fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
    expect(screen.queryByRole('region', { name: '智能对话' })).toBeNull();
    expect(chat.isConnected).toBe(true);
    expect(document.querySelector('#message-input')).toBe(draft);
    expect(document.querySelector('.preview-panel iframe')).toBe(frame);
    expect(signal?.aborted).toBe(false);
    act(() => handlers?.onEvent({ type: 'text-delta', text: '市场浏览时仍然收到回复' }));
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(screen.getByRole('region', { name: '智能对话' })).toBe(chat);
    expect(screen.getByLabelText('Agent 工作流')).toBe(workflow);
    expect(workflow.scrollTop).toBe(137);
    expect(screen.getByLabelText<HTMLTextAreaElement>('发送消息').value).toBe('返回后继续编辑');
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    expect(screen.getByText('市场浏览时仍然收到回复')).toBeTruthy();
    expect(document.querySelector('.preview-panel iframe')).toBe(frame);
    expect(screen.getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem('weave.studio.panelTabs.v2')).toBe(layout);
    expect(localStorage.getItem('weave.studio.sidePanelWidth')).toBe(width);
    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);
    expect(streamAgentRunMock.mock.calls[0]?.[0].sessionId).toBe(sessionIds.local);
  });

  it('retains the desktop terminal connection and output while the marketplace is open', async () => {
    const terminal = {
      create: vi.fn(async () => ({ id: 'term-market' })),
      write: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn<(listener: (payload: { id: string; data: string }) => void) => () => void>(
        () => () => undefined,
      ),
      onExit: vi.fn(() => () => undefined),
    };
    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:1', terminal };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
    await waitFor(() => expect(terminal.onData).toHaveBeenCalledTimes(1));
    const surface = document.querySelector('.terminal-surface');
    fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
    expect(terminal.dispose).not.toHaveBeenCalled();
    act(() => terminal.onData.mock.calls[0]?.[0]({ id: 'term-market', data: '后台输出\r\n' }));
    expect(terminalMocks.instance.write).toHaveBeenCalledWith('后台输出\r\n');
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(document.querySelector('.terminal-surface')).toBe(surface);
    expect(terminal.create).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: '终端' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the panel collapse preference when returning from the marketplace', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '收起上下文' }));
    fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(screen.queryByRole('complementary', { name: '运行活动' })).toBeNull();
    expect(screen.getByRole('button', { name: '显示上下文' })).toBeTruthy();
  });

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
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
      reasoningEffort: 'medium',
      skills: [],
    });

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

  it('renders an image attached to a historical user message after reload', async () => {
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /Foundation 设计/ }));

    const historyImage = (await screen.findByAltText('已发送的图片')) as HTMLImageElement;
    expect(historyImage.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    const userItem = historyImage.closest('.timeline-item-user') as HTMLElement;
    expect(within(userItem).getByText('看这张历史图')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
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
      expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    });
  });

  it('offers immediate plugin decisions when another session is streaming and keeps the selected session idle', async () => {
    const baseFetch = fetchMock;
    const manifest = {
      id: 'local-example',
      name: 'Local Example',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: [],
      contributes: {},
      permissions: [],
    };
    const digest = 'a'.repeat(64);
    const pluginCatalog = {
      plugins: [
        {
          ...manifest,
          host: 'in-process',
          origin: 'local',
          state: 'loaded',
          provides: {
            tools: [],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            hooks: [],
            services: [],
          },
          local: {
            directory: '/plugins/local-example',
            enabled: true,
            digest,
            manifest,
            trusted: { digest, trustedAt: 'today', manifest },
            active: { generation: 1, digest, manifest },
          },
        },
      ],
      local: {
        directory: '/plugins',
        exists: true,
        truncated: false,
        trustSequence: 1,
        generation: { id: 1, acceptingRuns: true, plugins: [] },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/plugins' || String(input) === '/plugins/reload') {
          return new Response(
            JSON.stringify(
              init?.method === 'POST'
                ? { ...pluginCatalog, result: { generation: 1, unchanged: true, failed: [] } }
                : pluginCatalog,
            ),
            { status: 200 },
          );
        }
        return baseFetch(input, init);
      }),
    );
    streamAgentRunMock.mockImplementation(() => new Promise<void>(() => undefined));
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '保持运行' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '清空运行状态' }));
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
    openInstalledPlugins();
    await screen.findByText('Local Example', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('Local Example', { selector: '.plugin-name' }));
    const disable = screen.getByRole('button', { name: '停用' });
    await waitFor(() => expect((disable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(disable);
    expect(screen.getByRole('checkbox', { name: '立即生效（取消进行中的回合）' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '工作台' }));
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(within(screen.getByRole('region', { name: '概览' })).queryByText('运行中')).toBeNull();
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

  it('shows an MCP tool error as a failed step while the model completes its reply', async () => {
    const name = 'mcp_docs_search_1234567890abcdef';
    const content = `Tool "${name}" failed (tool-execution-failed). mcp-tool-error: query rejected`;
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({
        type: 'tool-call',
        toolCall: { id: 'mcp-failed', name, arguments: '{"query":"missing"}' },
      });
      handlers.onEvent({
        type: 'tool-result',
        result: { toolCallId: 'mcp-failed', name, content, truncated: false },
        status: 'failed',
        errorCode: 'tool-execution-failed',
      });
      handlers.onEvent({ type: 'text-delta', text: '我会修正查询' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-mcp-failed' });
    });
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '查询文档' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('我会修正查询')).toBeTruthy();
    const step = screen.getByText(name).closest('.tool-step') as HTMLDetailsElement;
    expect(step.classList.contains('tool-step-failed')).toBe(true);
    expect(within(step).getByTitle('失败')).toBeTruthy();
    expect(within(step).getByText(content)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '工具' }));
    expect(
      within(screen.getByRole('region', { name: '工具调用' })).getByTitle('失败'),
    ).toBeTruthy();
  });

  it('locates and focuses the approved call parameters through both collapsed detail levels', async () => {
    const name = 'mcp_docs_search_1234567890abcdef';
    const workspaceFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/approvals/stream')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: approval.snapshot\ndata: ${JSON.stringify({
                    approvals: [
                      {
                        approvalId: 'mcp-approval',
                        toolCallId: 'call-2',
                        toolName: name,
                        operation: 'mcp.call_tool',
                        summary: '查询第二个目标',
                        risk: 'high',
                        inputSummary: { serverId: 'docs', argumentBytes: 32, fields: ['query'] },
                        sessionId: sessionIds.local,
                        status: 'pending',
                        createdAt: '2026-11-21T08:00:00.000Z',
                      },
                    ],
                  })}\n\n`,
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return workspaceFetch(input, init);
    });
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      for (const [id, query] of [
        ['call-1', 'first private query'],
        ['call-2', 'second private query'],
      ]) {
        handlers.onEvent({
          type: 'tool-call',
          toolCall: { id: id!, name, arguments: JSON.stringify({ query }) },
        });
      }
      handlers.onEvent({ type: 'completed', turnId: 'turn-inspect' });
    });
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      await renderApp();
      fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '比较两个查询' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      const approval = await screen.findByRole('article', { name: '待审批：查询第二个目标' });
      const process = screen.getByRole('group', { name: '本轮过程' }) as HTMLDetailsElement;
      fireEvent.click(within(process).getByText('2 次工具调用'));
      await waitFor(() => expect(process.open).toBe(false));
      const steps = Array.from(process.querySelectorAll<HTMLDetailsElement>('.tool-step'));
      expect(steps).toHaveLength(2);
      expect(steps.every((step) => !step.open)).toBe(true);
      expect(approval.textContent).not.toContain('second private query');

      fireEvent.click(within(approval).getByRole('button', { name: '查看参数' }));

      await waitFor(() => expect(process.open).toBe(true));
      expect(steps[0]!.open).toBe(false);
      expect(steps[1]!.open).toBe(true);
      const parameters = steps[1]!.querySelector<HTMLElement>('.tool-step-code')!;
      expect(parameters.textContent).toContain('second private query');
      expect(parameters.textContent).not.toContain('first private query');
      expect(document.activeElement).toBe(parameters);
      expect(scrollIntoView.mock.contexts).toContain(parameters);

      fireEvent.click(screen.getByRole('tab', { name: '工具' }));
      const panel = screen.getByRole('region', { name: '工具调用' });
      expect(
        Array.from(panel.querySelectorAll<HTMLDetailsElement>('.tool-step')).every(
          (step) => !step.open,
        ),
      ).toBe(true);
      const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      if (previousScroll)
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
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
    expect(screen.queryByText('本次运行失败，请查看运行错误')).toBeNull();
    expect(screen.queryByText(/secret\.ts|\/Users\/mi\/private/)).toBeNull();
    expect(
      within(screen.getByRole('region', { name: '运行错误' })).getByText('错误', {
        selector: '.status-badge',
      }),
    ).toBeTruthy();
  });

  it('accepts repeated queued messages while running without adding premature conversation rows or clearing newer edits', async () => {
    const baseFetch = fetchMock;
    let publish: (state: unknown) => void = () => undefined;
    const active = {
      executionId: 'active-q',
      requestId: 'active-r',
      sessionId: sessionIds.local,
      turnId: 'active-t',
      userMessageId: 'active-u',
      createdAt: '2026-11-23T00:00:00.000Z',
      status: 'running',
      cursor: 'epoch:active-q:1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/executions/queue/events`) && url.includes(sessionIds.local))
          return new Response(
            new ReadableStream({
              start(controller) {
                publish = (state) =>
                  controller.enqueue(
                    new TextEncoder().encode(`event: queue\ndata: ${JSON.stringify(state)}\n\n`),
                  );
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        if (url.endsWith('/executions/active-q'))
          return Response.json({
            ...active,
            events: [{ type: 'text-delta', text: 'current answer' }],
            input: {
              provider: 'mock',
              model: 'demo',
              permissionMode: 'ask',
              userMessage: { role: 'user', content: [{ type: 'text', text: 'active question' }] },
            },
          });
        if (url.includes('/active-q/events'))
          return new Response(new ReadableStream(), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        return baseFetch(input, init);
      }),
    );
    await renderApp();
    const state = {
      sessionId: sessionIds.local,
      revision: 2,
      cursor: `epoch:${sessionIds.local}:2`,
      active,
      queued: [],
      scheduler: 'ready',
      limits: { sessionQueued: 10, globalQueued: 100 },
    };
    act(() => publish(state));
    await screen.findByText('current answer');
    let receipt: AgentStreamHandlers | undefined;
    let release: () => void = () => undefined;
    streamAgentRunMock.mockImplementation((request, handlers) => {
      receipt = handlers;
      return new Promise<void>((resolve) => {
        release = () => {
          const { sessionId, ...input } = request;
          handlers.onReceipt?.({
            ...active,
            executionId: 'queued-1',
            requestId: 'r1',
            turnId: 't1',
            userMessageId: 'u1',
            sessionId,
            status: 'queued',
            cursor: 'epoch:queued-1:0',
            input: { ...input, permissionMode: 'ask' },
            events: [],
          });
          resolve();
        };
      });
    });
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'queued first' } });
    fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
    expect((screen.getByRole('button', { name: '加入队列' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(document.querySelector('.message-list')?.textContent).not.toContain('queued first');
    act(() =>
      publish({
        ...state,
        revision: 3,
        cursor: `epoch:${sessionIds.local}:3`,
        queued: [
          {
            ...active,
            executionId: 'queued-1',
            requestId: 'r1',
            turnId: 't1',
            userMessageId: 'u1',
            status: 'queued',
            cursor: 'epoch:queued-1:0',
            preview: 'queued first',
            provider: 'mock',
            model: 'demo',
            imageCount: 0,
            skillCount: 0,
            fileCount: 0,
          },
        ],
      }),
    );
    await screen.findByText('待执行 1/10');
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'newer draft' } });
    await act(async () => release());
    expect(receipt).toBeDefined();
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe('newer draft');
    expect(document.querySelector('.message-list')?.textContent).not.toContain('queued first');
    expect(screen.getByText('current answer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
    expect(streamAgentRunMock).toHaveBeenCalledTimes(2);
    await act(async () => release());
  });

  it('preserves the next execution overlay and exact Stop target while the previous terminal history read is pending', async () => {
    const baseFetch = fetchMock;
    let publishQueue: (state: unknown) => void = () => undefined;
    let publishOld: (value: string) => void = () => undefined;
    let releaseHistory: () => void = () => undefined;
    let terminal = false;
    let historyWaiting = false;
    let nextReads = 0;
    const execution = (id: string, text: string): AgentExecutionSnapshot => ({
      executionId: id,
      requestId: `${id}-r`,
      sessionId: sessionIds.local,
      turnId: `${id}-t`,
      userMessageId: `${id}-u`,
      createdAt: '2026-11-23T00:00:00.000Z',
      status: 'running',
      cursor: `epoch:${id}:1`,
      input: {
        provider: 'mock',
        model: 'demo',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: `${id} question` }] },
      },
      events: [{ type: 'text-delta', text }],
    });
    const old = execution('handoff-old', 'old live answer');
    const next = execution('handoff-next', 'next live answer');
    const queue = (snapshot: AgentExecutionSnapshot, sequence: number) => {
      const { input: _input, events: _events, ...active } = snapshot;
      void _input;
      void _events;
      return {
        sessionId: sessionIds.local,
        revision: sequence,
        cursor: `epoch:${sessionIds.local}:${sequence}`,
        active,
        queued: [],
        scheduler: 'ready',
        limits: { sessionQueued: 10, globalQueued: 100 },
      };
    };
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/sessions/${sessionIds.local}/executions/queue/events`)
        return new Response(
          new ReadableStream({
            start(controller) {
              publishQueue = (state) =>
                controller.enqueue(
                  new TextEncoder().encode(`event: queue\ndata: ${JSON.stringify(state)}\n\n`),
                );
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      if (url.endsWith('/executions/handoff-old')) return Response.json(old);
      if (url.includes('/handoff-old/events'))
        return new Response(
          new ReadableStream({
            start(controller) {
              publishOld = (value) => controller.enqueue(new TextEncoder().encode(value));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      if (url.endsWith('/executions/handoff-next')) {
        if (++nextReads === 1) throw new TypeError('temporarily offline');
        return Response.json(next);
      }
      if (url.includes('/handoff-next/events'))
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      if (url.endsWith('/handoff-next/cancel'))
        return Response.json({ ...next, status: 'cancelling' });
      if (terminal && url === `/sessions/${sessionIds.local}`)
        return new Promise<Response>((resolve) => {
          historyWaiting = true;
          releaseHistory = () =>
            resolve(
              Response.json({
                ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
                  {
                    role: 'user',
                    turnId: old.turnId,
                    content: [{ type: 'text', text: 'handoff-old question' }],
                  },
                  {
                    role: 'assistant',
                    turnId: old.turnId,
                    content: [{ type: 'text', text: 'old durable answer' }],
                  },
                  {
                    role: 'assistant',
                    turnId: 'missed-t',
                    content: [{ type: 'text', text: 'unseen durable middle' }],
                  },
                  {
                    role: 'user',
                    turnId: next.turnId,
                    content: [{ type: 'text', text: 'handoff-next question' }],
                  },
                  {
                    role: 'assistant',
                    turnId: next.turnId,
                    content: [{ type: 'text', text: 'stale durable next' }],
                  },
                ]),
                lastSequence: 30,
                turns: [
                  {
                    turnId: old.turnId,
                    userMessageId: old.userMessageId,
                    status: 'completed',
                    startedAt: old.createdAt,
                  },
                  { turnId: 'missed-t', status: 'completed', startedAt: old.createdAt },
                  {
                    turnId: next.turnId,
                    userMessageId: next.userMessageId,
                    status: 'running',
                    startedAt: next.createdAt,
                  },
                ],
              }),
            );
        });
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', api);
    await renderApp();
    act(() => publishQueue(queue(old, 2)));
    await screen.findByText('old live answer');
    act(() => {
      terminal = true;
      publishOld(
        'event: status\ndata: {"cursor":"epoch:handoff-old:2","status":"completed","durableThroughSequence":30}\n\n',
      );
    });
    await waitFor(() => expect(historyWaiting).toBe(true));
    act(() => publishQueue(queue(next, 3)));
    await screen.findByText('next live answer');
    await act(async () => releaseHistory());
    await screen.findByText('old durable answer');
    expect(screen.getByText('unseen durable middle')).toBeTruthy();
    expect(screen.queryByText('stale durable next')).toBeNull();
    expect(screen.getAllByText('next live answer')).toHaveLength(1);
    expect(screen.getAllByText('handoff-next question')).toHaveLength(1);
    const renderedAnswers = [...document.querySelectorAll('.timeline-item-assistant')].map(
      (element) => element.textContent,
    );
    expect(renderedAnswers.findIndex((text) => text?.includes('old durable answer'))).toBeLessThan(
      renderedAnswers.findIndex((text) => text?.includes('next live answer')),
    );
    expect(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: '审阅本轮文件' })
        .every((button) => button.disabled),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '停止本轮及派生任务' }));
    await waitFor(() =>
      expect(api.mock.calls.some(([url]) => String(url).endsWith('/handoff-next/cancel'))).toBe(
        true,
      ),
    );
    expect(api.mock.calls.some(([url]) => String(url).endsWith('/handoff-old/cancel'))).toBe(false);
    expect(
      api.mock.calls.filter(([url]) => String(url).includes('/handoff-next/events')),
    ).toHaveLength(1);
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps newer reconciled %s history and status when an earlier terminal read returns late',
    async (nextStatus) => {
      const baseFetch = fetchMock;
      let publishQueue: (state: unknown) => void = () => undefined;
      const publishExecution = new Map<string, (value: string) => void>();
      let releaseOld: () => void = () => undefined;
      let historyReads = 0;
      const execution = (id: string): AgentExecutionSnapshot => ({
        executionId: id,
        requestId: `${id}-r`,
        sessionId: sessionIds.local,
        turnId: `${id}-t`,
        userMessageId: `${id}-u`,
        createdAt: '2026-11-23T00:00:00.000Z',
        status: 'running',
        cursor: `epoch:${id}:1`,
        input: {
          provider: 'mock',
          model: 'demo',
          permissionMode: 'ask',
          userMessage: { role: 'user', content: [{ type: 'text', text: `${id} question` }] },
        },
        events: [{ type: 'text-delta', text: `${id} live answer` }],
      });
      const old = execution('late-old');
      const next = execution('late-next');
      const queue = (snapshot: AgentExecutionSnapshot | null, sequence: number) => {
        const active =
          snapshot === null
            ? null
            : {
                executionId: snapshot.executionId,
                requestId: snapshot.requestId,
                sessionId: snapshot.sessionId,
                turnId: snapshot.turnId,
                userMessageId: snapshot.userMessageId,
                createdAt: snapshot.createdAt,
                status: snapshot.status,
                cursor: snapshot.cursor,
              };
        return {
          sessionId: sessionIds.local,
          revision: sequence,
          cursor: `epoch:${sessionIds.local}:${sequence}`,
          active,
          queued: [],
          scheduler: 'ready',
          limits: { sessionQueued: 10, globalQueued: 100 },
        };
      };
      const detail = (newer: boolean) => ({
        ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
          {
            role: 'user',
            turnId: old.turnId,
            content: [{ type: 'text', text: 'late-old question' }],
          },
          {
            role: 'assistant',
            turnId: old.turnId,
            content: [{ type: 'text', text: 'old canonical answer' }],
          },
          ...(newer
            ? [
                {
                  role: 'assistant',
                  turnId: 'middle-t',
                  content: [{ type: 'text', text: 'canonical middle answer' }],
                },
                {
                  role: 'user',
                  turnId: next.turnId,
                  content: [{ type: 'text', text: 'late-next question' }],
                },
                {
                  role: 'assistant',
                  turnId: next.turnId,
                  content: [{ type: 'text', text: 'new canonical answer' }],
                },
              ]
            : []),
        ]),
        lastSequence: newer ? 60 : 30,
        turns: [
          {
            turnId: old.turnId,
            userMessageId: old.userMessageId,
            status: 'completed',
            startedAt: old.createdAt,
          },
          ...(newer
            ? [
                { turnId: 'middle-t', status: 'completed', startedAt: old.createdAt },
                {
                  turnId: next.turnId,
                  userMessageId: next.userMessageId,
                  status: nextStatus,
                  startedAt: next.createdAt,
                },
              ]
            : []),
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === `/sessions/${sessionIds.local}/executions/queue/events`)
            return new Response(
              new ReadableStream({
                start(controller) {
                  publishQueue = (state) =>
                    controller.enqueue(
                      new TextEncoder().encode(`event: queue\ndata: ${JSON.stringify(state)}\n\n`),
                    );
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          if (url.endsWith('/executions/late-old')) return Response.json(old);
          if (url.endsWith('/executions/late-next')) return Response.json(next);
          const id = url.includes('/late-old/events')
            ? old.executionId
            : url.includes('/late-next/events')
              ? next.executionId
              : undefined;
          if (id !== undefined)
            return new Response(
              new ReadableStream({
                start(controller) {
                  publishExecution.set(id, (value) =>
                    controller.enqueue(new TextEncoder().encode(value)),
                  );
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          if (url === `/sessions/${sessionIds.local}` && publishExecution.has(old.executionId)) {
            if (++historyReads === 1)
              return new Promise<Response>((resolve) => {
                releaseOld = () => resolve(Response.json(detail(false)));
              });
            return Response.json(detail(true));
          }
          return baseFetch(input, init);
        }),
      );
      await renderApp();
      act(() => publishQueue(queue(old, 2)));
      await screen.findByText('late-old live answer');
      act(() =>
        publishExecution.get(old.executionId)?.(
          'event: status\ndata: {"cursor":"epoch:late-old:2","status":"completed","durableThroughSequence":30}\n\n',
        ),
      );
      await waitFor(() => expect(historyReads).toBe(1));
      act(() => publishQueue(queue(next, 3)));
      await screen.findByText('late-next live answer');
      act(() => {
        publishQueue(queue(null, 4));
        publishExecution.get(next.executionId)?.(
          `event: status\ndata: ${JSON.stringify({ cursor: 'epoch:late-next:2', status: nextStatus, durableThroughSequence: 60 })}\n\n`,
        );
      });
      await screen.findByText('new canonical answer');
      const label = nextStatus === 'failed' ? '出错' : '已取消';
      await waitFor(() =>
        expect(screen.getByText(label, { selector: '.run-status' })).toBeTruthy(),
      );
      expect(screen.getByText('canonical middle answer')).toBeTruthy();
      await act(async () => releaseOld());
      expect(screen.getAllByText('new canonical answer')).toHaveLength(1);
      expect(screen.getAllByText('canonical middle answer')).toHaveLength(1);
      expect(screen.getAllByText('old canonical answer')).toHaveLength(1);
      expect(screen.queryByText('late-old live answer')).toBeNull();
      expect(screen.getByText(label, { selector: '.run-status' })).toBeTruthy();
      const answers = [...document.querySelectorAll('.timeline-item-assistant')].map(
        (entry) => entry.textContent,
      );
      expect(answers.findIndex((text) => text?.includes('old canonical answer'))).toBeLessThan(
        answers.findIndex((text) => text?.includes('new canonical answer')),
      );
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: '审阅本轮文件' })
          .some((button) => button.disabled),
      ).toBe(false);
      expect(historyReads).toBe(2);
    },
  );

  it('accepts an inactive Session receipt without observing it and recovers only after returning', async () => {
    const baseFetch = fetchMock;
    let callbacks: AgentStreamHandlers | undefined;
    let resolveAdmission: () => void = () => undefined;
    const execution: AgentExecutionSnapshot = {
      executionId: 'inactive-receipt',
      requestId: 'inactive-r',
      sessionId: sessionIds.local,
      turnId: 'inactive-t',
      userMessageId: 'inactive-u',
      createdAt: '2026-11-23T00:00:00.000Z',
      status: 'running',
      cursor: 'epoch:inactive-receipt:1',
      events: [{ type: 'text-delta', text: 'recovered inactive answer' }],
      input: {
        provider: 'mock',
        model: 'demo',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'accepted original draft' }] },
      },
    };
    let accepted = false;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (accepted && url === `/sessions/${sessionIds.local}/executions/queue`) {
        const { input: _input, events: _events, ...active } = execution;
        void _input;
        void _events;
        return Response.json({
          sessionId: sessionIds.local,
          revision: 3,
          cursor: `epoch:${sessionIds.local}:3`,
          active,
          queued: [],
          scheduler: 'ready',
          limits: { sessionQueued: 10, globalQueued: 100 },
        });
      }
      if (url.endsWith('/executions/inactive-receipt')) return Response.json(execution);
      if (url.includes('/inactive-receipt/events'))
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', api);
    streamAgentRunMock.mockImplementationOnce((_request, handlers) => {
      callbacks = handlers;
      return new Promise<void>((resolve) => {
        resolveAdmission = resolve;
      });
    });
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: 'accepted original draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(callbacks).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: 'keep active Session draft' },
    });
    await act(async () => {
      accepted = true;
      callbacks?.onReceipt?.(execution);
      resolveAdmission();
    });
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
      'keep active Session draft',
    );
    expect(api.mock.calls.some(([url]) => String(url).includes('/inactive-receipt'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    await screen.findByText('recovered inactive answer');
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe('');
    expect(
      api.mock.calls.filter(([url]) => String(url).includes('/inactive-receipt/events')),
    ).toHaveLength(1);
    expect(api.mock.calls.some(([url]) => String(url).endsWith('/inactive-receipt/cancel'))).toBe(
      false,
    );
  });

  it('keeps the highest applied Session history when a previous navigation read returns late', async () => {
    const baseFetch = fetchMock;
    let reads = 0;
    let releaseOld: () => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input) === `/sessions/${sessionIds.local}` &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          reads += 1;
          if (reads === 2)
            return new Promise<Response>((resolve) => {
              releaseOld = () =>
                resolve(
                  Response.json({
                    ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
                      {
                        role: 'assistant',
                        turnId: 'navigation-old',
                        content: [{ type: 'text', text: 'stale navigation answer' }],
                      },
                    ]),
                    lastSequence: 30,
                  }),
                );
            });
          if (reads === 3)
            return Response.json({
              ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
                {
                  role: 'assistant',
                  turnId: 'navigation-new',
                  content: [{ type: 'text', text: 'newest navigation answer' }],
                },
              ]),
              lastSequence: 60,
            });
        }
        return baseFetch(input, init);
      }),
    );
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Session event store/ }).closest('.session-tree-item')
          ?.className,
      ).toContain('active'),
    );
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    await screen.findByText('newest navigation answer');
    await act(async () => releaseOld());
    expect(screen.getByText('newest navigation answer')).toBeTruthy();
    expect(screen.queryByText('stale navigation answer')).toBeNull();
  });

  it('preserves the draft and current answer when queue admission is rejected at capacity', async () => {
    const baseFetch = fetchMock;
    const execution: AgentExecutionSnapshot = {
      executionId: 'capacity-active',
      requestId: 'capacity-r',
      sessionId: sessionIds.local,
      turnId: 'capacity-t',
      userMessageId: 'capacity-u',
      createdAt: '2026-11-23T00:00:00.000Z',
      status: 'running',
      cursor: 'epoch:capacity-active:1',
      events: [{ type: 'text-delta', text: 'keep current answer' }],
      input: {
        provider: 'mock',
        model: 'demo',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'current question' }] },
      },
    };
    const { input: _input, events: _events, ...active } = execution;
    void _input;
    void _events;
    const state = {
      sessionId: sessionIds.local,
      revision: 2,
      cursor: `epoch:${sessionIds.local}:2`,
      active,
      queued: [],
      scheduler: 'ready',
      limits: { sessionQueued: 10, globalQueued: 100 },
    };
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/sessions/${sessionIds.local}/executions/queue`) return Response.json(state);
      if (url.endsWith('/executions/capacity-active')) return Response.json(execution);
      if (url.includes('/capacity-active/events'))
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', api);
    streamAgentRunMock.mockRejectedValueOnce(new AgentStreamError('execution-queue-full', 'full'));
    await renderApp();
    await screen.findByText('keep current answer');
    const reads = api.mock.calls.filter(([url]) =>
      String(url).endsWith('/executions/queue'),
    ).length;
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'keep queued draft' } });
    fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
    await screen.findByText('待执行队列已满，请稍后再试。草稿已保留。');
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
      'keep queued draft',
    );
    expect(screen.getByText('keep current answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    expect(document.querySelector('.message-list')?.textContent).not.toContain('keep queued draft');
    await waitFor(() =>
      expect(
        api.mock.calls.filter(([url]) => String(url).endsWith('/executions/queue')).length,
      ).toBeGreaterThan(reads),
    );
  });

  it('copies queued input after an explicit choice without overwriting late draft edits or cancelling the original', async () => {
    const baseFetch = fetchMock;
    let release: () => void = () => undefined;
    const queued: AgentExecutionSnapshot = {
      executionId: 'copy-q',
      requestId: 'copy-r',
      sessionId: sessionIds.local,
      turnId: 'copy-t',
      userMessageId: 'copy-u',
      createdAt: '2026-11-23T00:00:00.000Z',
      status: 'queued',
      cursor: 'epoch:copy-q:0',
      events: [],
      effectiveSettings: { useProviderDefaults: false, temperature: 0.23, maxTokens: 321 },
      input: {
        provider: 'mock',
        model: 'weave-local-demo',
        permissionMode: 'trust',
        reasoningEffort: 'high',
        skills: [planningRef],
        userMessage: {
          role: 'user',
          content: [
            { type: 'text', text: 'copied queue text' },
            { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          ],
        },
      },
    };
    const { input: _input, events: _events, effectiveSettings: _settings, ...summary } = queued;
    void _settings;
    void _input;
    void _events;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/sessions/${sessionIds.local}/executions/queue`)
        return Response.json({
          sessionId: sessionIds.local,
          revision: 2,
          cursor: `epoch:${sessionIds.local}:2`,
          active: null,
          queued: [
            {
              ...summary,
              preview: 'copied queue text',
              provider: 'mock',
              model: 'weave-local-demo',
              imageCount: 1,
              skillCount: 1,
              fileCount: 0,
            },
          ],
          scheduler: 'ready',
          limits: { sessionQueued: 10, globalQueued: 100 },
        });
      if (url.endsWith('/executions/copy-q'))
        return new Promise<Response>((resolve) => {
          release = () => resolve(Response.json(queued));
        });
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', api);
    await renderApp();
    await screen.findByRole('button', { name: '复制第 1 条消息到草稿' });
    fireEvent.click(screen.getByRole('button', { name: '复制第 1 条消息到草稿' }));
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: 'typed while fetching' },
    });
    await act(async () => release());
    const dialog = await screen.findByRole('dialog', { name: '复制队列消息' });
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
      'typed while fetching',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '追加到草稿' }));
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
      'typed while fetching\n\ncopied queue text',
    );
    expect(
      screen.getByText('已复制到草稿，原消息仍在队列中。再次发送会读取当前项目文件。'),
    ).toBeTruthy();
    streamAgentRunMock.mockImplementationOnce(async (request, handlers) => {
      const { sessionId, ...input } = request;
      handlers.onReceipt?.({
        ...queued,
        executionId: 'copy-new',
        requestId: 'copy-new-r',
        sessionId,
        input: { ...input, permissionMode: input.permissionMode ?? 'ask' },
        cursor: 'epoch:copy-new:0',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalledOnce());
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
      temperature: 0.23,
      maxTokens: 321,
      useProviderDefaults: false,
      permissionMode: 'trust',
      reasoningEffort: 'high',
      skills: [planningRef],
    });
    expect(api.mock.calls.some(([url]) => String(url).includes('/cancel'))).toBe(false);
  });

  it('keeps Stop pending before receipt and confirms cancellation only after the durable waterline', async () => {
    let handlers: AgentStreamHandlers | undefined;
    let resolveRun: () => void = () => undefined;
    let signal: AbortSignal | undefined;
    let durable = false;
    const execution: AgentExecutionSnapshot = {
      executionId: 'execution-stop',
      requestId: 'request-stop',
      sessionId: sessionIds.local,
      turnId: 'turn-stop',
      userMessageId: 'user-stop',
      createdAt: '2026-11-23T00:00:00.000Z',
      input: {
        provider: 'demo',
        model: 'demo-model',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: '取消这次运行' }] },
      },
      events: [{ type: 'text-delta', text: 'partial answer' }],
      status: 'running',
      cursor: 'epoch:execution-stop:1',
    };
    const baseFetch = fetchMock;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/execution-stop/cancel'))
        return Response.json({
          ...execution,
          status: 'cancelling',
          cursor: 'epoch:execution-stop:2',
        });
      if (durable && String(input) === `/sessions/${sessionIds.local}`)
        return Response.json({
          ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
            {
              role: 'user',
              messageId: 'user-stop',
              turnId: 'turn-stop',
              content: [{ type: 'text', text: '取消这次运行' }],
            },
            {
              role: 'assistant',
              turnId: 'turn-stop',
              content: [{ type: 'text', text: 'partial answer' }],
            },
          ]),
          lastSequence: 20,
          turns: [
            {
              turnId: 'turn-stop',
              userMessageId: 'user-stop',
              startedAt: execution.createdAt,
              status: 'cancelled',
            },
          ],
        });
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', api);
    streamAgentRunMock.mockImplementation((_request, callbacks, options) => {
      handlers = callbacks;
      signal = options?.signal;
      return new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
    });
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '取消这次运行' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '停止本轮及派生任务' }));
    expect(document.querySelector('.message-list')?.textContent).not.toContain('取消这次运行');
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    act(() => {
      handlers?.onReceipt?.(execution);
      handlers?.onSnapshot?.(execution);
    });
    await waitFor(() =>
      expect(api.mock.calls.some(([url]) => String(url).endsWith('/execution-stop/cancel'))).toBe(
        true,
      ),
    );
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    act(() => {
      handlers?.onStatus?.({
        cursor: 'epoch:execution-stop:3',
        status: 'cancelled',
        durableThroughSequence: 20,
      });
      resolveRun();
    });
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    durable = true;
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy(), {
      timeout: 3000,
    });
    expect(signal?.aborted).toBe(false);
    expect(screen.getAllByText('partial answer')).toHaveLength(1);
  });

  it('recovers a running execution on refresh, replaces durable partial output and unsubscribes without cancel', async () => {
    const execution: AgentExecutionSnapshot = {
      executionId: 'execution-refresh',
      requestId: 'request-refresh',
      sessionId: sessionIds.local,
      turnId: 'turn-refresh',
      userMessageId: 'user-refresh',
      createdAt: '2026-11-23T00:00:00.000Z',
      input: {
        provider: 'demo',
        model: 'demo-model',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'recovered question' }] },
      },
      events: [{ type: 'text-delta', text: 'whole recovered answer' }],
      status: 'running',
      cursor: 'epoch:execution-refresh:1',
    };
    const baseFetch = fetchMock;
    const cancelReader = vi.fn();
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/sessions/${sessionIds.local}/executions`) {
        const { input: _, events: __, ...summary } = execution;
        void _;
        void __;
        return Response.json([summary]);
      }
      if (url === `/sessions/${sessionIds.local}/executions/execution-refresh`)
        return Response.json(execution);
      if (url.includes('/execution-refresh/events'))
        return new Response(new ReadableStream({ cancel: cancelReader }), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      if (url === `/sessions/${sessionIds.local}`)
        return Response.json(
          sessionDetail(sessionIds.local, '本地 Agent 演示', [
            {
              role: 'user',
              turnId: 'turn-refresh',
              messageId: 'user-refresh',
              content: [{ type: 'text', text: 'recovered question' }],
            },
            {
              role: 'assistant',
              turnId: 'turn-refresh',
              content: [{ type: 'text', text: 'whole ' }],
            },
          ]),
        );
      return baseFetch(input, init);
    });
    vi.stubGlobal('fetch', api);
    await renderApp();
    await waitFor(() => expect(screen.getByText('whole recovered answer')).toBeTruthy());
    expect(screen.getAllByText('recovered question')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
    expect(streamAgentRunMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
    await waitFor(() => expect(cancelReader).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    await screen.findByText('whole recovered answer');
    expect(
      api.mock.calls.filter(([url]) => String(url).includes('/execution-refresh/events')),
    ).toHaveLength(2);
    cleanup();
    await waitFor(() => expect(cancelReader).toHaveBeenCalledTimes(2));
    expect(api.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
  });

  it.each(['epoch', 'restart'])(
    'uses the production client to recover terminal sequence zero in %s epoch and waits for durable history',
    async (terminalEpoch) => {
      streamAgentRunMock.mockImplementationOnce(async (request, handlers, options) => {
        const actual = await vi.importActual<
          typeof import('../src/features/agent/agent-stream.js')
        >('../src/features/agent/agent-stream.js');
        await actual.streamAgentRun(request, handlers, options);
      });
      const baseFetch = fetchMock;
      let durable = false;
      let releaseTerminal: (() => void) | undefined;
      let requestId = '';
      let observations = 0;
      const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/sessions/${sessionIds.local}/executions` && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            requestId: string;
            input: AgentExecutionSnapshot['input'];
          };
          requestId = body.requestId;
          return Response.json({
            ...body,
            executionId: 'real-client',
            sessionId: sessionIds.local,
            turnId: 'real-turn',
            userMessageId: 'real-user',
            createdAt: '2026-11-23T00:00:00.000Z',
            status: 'running',
            cursor: 'epoch:real-client:1',
            events: [{ type: 'text-delta', text: 'live exact text' }],
          });
        }
        if (url.includes('/real-client/events')) {
          observations += 1;
          if (observations === 1)
            return new Response(
              new ReadableStream({
                start(controller) {
                  releaseTerminal = () => controller.close();
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          return new Response(
            `event: snapshot\ndata: ${JSON.stringify({
              type: 'snapshot',
              snapshot: {
                executionId: 'real-client',
                requestId,
                sessionId: sessionIds.local,
                turnId: 'real-turn',
                userMessageId: 'real-user',
                createdAt: '2026-11-23T00:00:00.000Z',
                input: {
                  provider: 'mock',
                  model: 'weave-local-demo',
                  permissionMode: 'ask',
                  userMessage: { role: 'user', content: [{ type: 'text', text: 'real question' }] },
                },
                status: 'completed',
                cursor: `${terminalEpoch}:real-client:0`,
                events: [],
                durableThroughSequence: 99,
              },
            })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        if (durable && url === `/sessions/${sessionIds.local}`)
          return Response.json({
            ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
              {
                role: 'user',
                turnId: 'real-turn',
                messageId: 'real-user',
                content: [{ type: 'text', text: 'real question' }],
              },
              {
                role: 'assistant',
                turnId: 'real-turn',
                content: [{ type: 'text', text: 'durable exact text' }],
              },
            ]),
            lastSequence: 99,
            turns: [
              {
                turnId: 'real-turn',
                userMessageId: 'real-user',
                startedAt: '2026-11-23T00:00:00.000Z',
                status: 'completed',
              },
            ],
          });
        if (url === `/sessions/${sessionIds.local}`)
          return Response.json({
            ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
              { role: 'user', content: [{ type: 'text', text: 'unbound historical question' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'unbound historical answer' }] },
              {
                role: 'assistant',
                turnId: 'previous-turn',
                content: [{ type: 'text', text: 'previous completed answer' }],
              },
            ]),
            turns: [
              {
                turnId: 'previous-turn',
                status: 'completed',
                startedAt: '2026-11-22T00:00:00.000Z',
              },
            ],
          });
        return baseFetch(input, init);
      });
      vi.stubGlobal('fetch', api);
      await renderApp();
      fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'real question' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await screen.findByText('live exact text');
      expect(screen.getByText('unbound historical answer')).toBeTruthy();
      act(() => releaseTerminal?.());
      await waitFor(() => expect(observations).toBe(2));
      expect(screen.getByText('live exact text')).toBeTruthy();
      expect(screen.getByRole('button', { name: '停止本轮及派生任务' })).toBeTruthy();
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: '审阅本轮文件' })
          .every((button) => button.disabled),
      ).toBe(true);
      durable = true;
      await screen.findByText('durable exact text');
      expect(screen.queryByText('live exact text')).toBeNull();
      expect(screen.getAllByText('real question')).toHaveLength(1);
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: '审阅本轮文件' })
          .some((button) => button.disabled),
      ).toBe(false);
      expect(api.mock.calls.some(([url]) => String(url).includes('/agent/runs/stream'))).toBe(
        false,
      );
    },
  );

  it('recovers an accepted-but-never-started interrupted execution from its durable watermark', async () => {
    const execution: AgentExecutionSnapshot = {
      executionId: 'never-started',
      requestId: 'request-restart',
      sessionId: sessionIds.local,
      turnId: 'turn-never-started',
      userMessageId: 'user-never-started',
      createdAt: '2026-11-23T00:00:00.000Z',
      input: {
        provider: 'demo',
        model: 'demo-model',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'not started' }] },
      },
      events: [],
      status: 'interrupted',
      durableThroughSequence: 20,
      cursor: 'new-epoch:never-started:0',
    };
    const baseFetch = fetchMock;
    let detailReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/sessions/${sessionIds.local}/executions`) {
          const { input: _, events: __, ...summary } = execution;
          void _;
          void __;
          return Response.json([summary]);
        }
        if (url === `/sessions/${sessionIds.local}/executions/never-started`)
          return Response.json(execution);
        if (url === `/sessions/${sessionIds.local}`)
          return Response.json({
            ...sessionDetail(sessionIds.local, '本地 Agent 演示'),
            lastSequence: ++detailReads === 1 ? 1 : 20,
          });
        return baseFetch(input, init);
      }),
    );
    await renderApp();
    await waitFor(() => expect(detailReads).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
    expect(screen.queryByText('not started')).toBeNull();
    expect(screen.getByText('出错', { selector: '.run-status' })).toBeTruthy();
    expect(streamAgentRunMock).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'detaches the old observer and recovers its durable %s turn when returning to the Session',
    async (terminalStatus) => {
      let resolveStream: () => void = () => undefined;
      let callbacks: AgentStreamHandlers | undefined;
      let ended = false;
      const baseFetch = fetchMock;
      const reads: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (
            ended &&
            url === `/sessions/${sessionIds.local}` &&
            (init?.method ?? 'GET') === 'GET'
          ) {
            reads.push(url);
            return new Response(
              JSON.stringify({
                ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
                  {
                    role: 'user',
                    turnId: 'durable-new-turn',
                    messageId: 'durable-user',
                    content: [{ type: 'text', text: 'durable question' }],
                  },
                ]),
                lastSequence: 30,
                turns: [
                  {
                    turnId: 'durable-new-turn',
                    userMessageId: 'durable-user',
                    status: terminalStatus,
                    startedAt: new Date(Date.now() + 1000).toISOString(),
                    completedAt: new Date(Date.now() + 2000).toISOString(),
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return baseFetch(input, init);
        }),
      );
      streamAgentRunMock.mockImplementation(
        (_request, handlers) =>
          new Promise<void>((resolve) => {
            resolveStream = resolve;
            callbacks = handlers;
            handlers.onReceipt?.({
              executionId: 'durable-execution',
              requestId: 'durable-request',
              sessionId: sessionIds.local,
              turnId: 'durable-new-turn',
              userMessageId: 'durable-user',
              createdAt: '2026-11-23T00:00:00.000Z',
              status: 'running',
              cursor: 'epoch:durable-execution:1',
              input: {
                provider: 'demo',
                model: 'demo',
                permissionMode: 'ask',
                userMessage: { role: 'user', content: [{ type: 'text', text: '结束后校准' }] },
              },
              events: [],
            });
            handlers.onEvent({ type: 'text-delta', text: 'live partial' });
          }),
      );
      await renderApp();
      fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '结束后校准' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
      await act(async () => {
        ended = true;
        callbacks?.onStatus?.({
          cursor: 'epoch:durable-execution:2',
          status: terminalStatus,
          durableThroughSequence: 30,
        });
        resolveStream();
      });
      expect(reads).toEqual([]);
      expect(screen.queryByTitle('运行中')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
      await screen.findByText('durable question');
      expect(reads).toEqual([`/sessions/${sessionIds.local}`]);
      const expectedLabel =
        terminalStatus === 'completed'
          ? '已完成'
          : terminalStatus === 'cancelled'
            ? '已取消'
            : '出错';
      expect(screen.getByText(expectedLabel, { selector: '.run-status' })).toBeTruthy();
      expect(screen.queryByText('live partial')).toBeNull();
      expect(screen.queryByRole('button', { name: '停止本轮及派生任务' })).toBeNull();
    },
  );

  it('reads durable provenance after a completed event without replacing streamed messages', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'completed', turnId: 'complete' });
    });
    await renderApp();
    const before = fetchMock.mock.calls.filter(
      ([url]) => String(url) === `/sessions/${sessionIds.local}`,
    ).length;
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '正常完成' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('已完成', { selector: '.run-status' });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === `/sessions/${sessionIds.local}`),
    ).toHaveLength(before + 1);
    expect(screen.getByText('正常完成')).toBeTruthy();
  });

  it('keeps receipt-less output unconfirmed rather than guessing a Turn from history', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: '保留未确认内容' });
    });
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '校准失败' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/无法确认会话终态/);
    expect(screen.getByText('保留未确认内容')).toBeTruthy();
    expect(screen.queryByText('已取消')).toBeNull();
    expect(screen.queryByText('已完成', { selector: '.run-status' })).toBeNull();
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
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.4' } });
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

  it('ignores late events and errors after a settled run is replaced', async () => {
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
    act(() => {
      runs[0]?.handlers.onEvent({ type: 'completed', turnId: 'first-turn' });
      runs[0]?.reject(new Error('first ended'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
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

  it('attaches an image and sends it as an image content part', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: '这是一张图表。' });
      handlers.onEvent({ type: 'completed', turnId: 'turn-image' });
    });

    await renderApp();

    const file = new File(['hello'], 'chart.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('选择图片文件'), { target: { files: [file] } });

    // The staged thumbnail uses the file name as its alt text.
    expect(await screen.findByAltText('chart.png')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '看这张图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('这是一张图表。')).toBeTruthy();
    // The sent user message renders the image, and the composer thumbnail clears.
    const sentImage = (await screen.findByAltText('已发送的图片')) as HTMLImageElement;
    expect(sentImage.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(screen.queryByAltText('chart.png')).toBeNull();

    expect(streamAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          ],
        },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('allows sending when only an image is attached, with no text', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'completed', turnId: 'turn-image-only' });
    });

    await renderApp();

    const sendButton = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    const file = new File(['hello'], 'photo.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('选择图片文件'), { target: { files: [file] } });
    expect(await screen.findByAltText('photo.png')).toBeTruthy();
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(streamAgentRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessage: {
            role: 'user',
            content: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
          },
        }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it('opens an enlarged preview when a message image is clicked, closable by button and Escape', async () => {
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'completed', turnId: 'turn-preview' });
    });

    await renderApp();

    const file = new File(['hello'], 'preview.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('选择图片文件'), { target: { files: [file] } });
    expect(await screen.findByAltText('preview.png')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await screen.findByAltText('已发送的图片');
    expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull();

    // Clicking the thumbnail opens the lightbox with the full-size image.
    fireEvent.click(screen.getByRole('button', { name: '放大查看图片' }));
    const dialog = await screen.findByRole('dialog', { name: '图片预览' });
    expect((within(dialog).getByAltText('图片预览') as HTMLImageElement).getAttribute('src')).toBe(
      'data:image/png;base64,aGVsbG8=',
    );

    // The close button dismisses it.
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull());

    // Reopening and pressing Escape also dismisses it.
    fireEvent.click(screen.getByRole('button', { name: '放大查看图片' }));
    expect(await screen.findByRole('dialog', { name: '图片预览' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull());
  });

  describe('slash commands from plugins', () => {
    const recap = {
      name: 'recap',
      title: '回顾进展',
      description: '总结目前为止做了什么',
      prompt: '请回顾目前的进展：\n$ARGUMENTS',
      pluginId: 'recap-kit',
    };
    const review = {
      name: 'review',
      title: '审查改动',
      prompt: '请审查这些改动',
      pluginId: 'recap-kit',
    };

    async function renderWithCommands(): Promise<HTMLTextAreaElement> {
      fetchMock = createWorkspaceFetchMock(undefined, { commands: [recap, review] });
      vi.stubGlobal('fetch', fetchMock);
      await renderApp();
      return screen.getByLabelText('发送消息') as HTMLTextAreaElement;
    }

    it('lists the commands while the draft is a slash and narrows them as it is typed', async () => {
      const input = await renderWithCommands();
      expect(screen.queryByRole('listbox')).toBeNull();

      fireEvent.change(input, { target: { value: '/' } });
      const list = await screen.findByRole('listbox', { name: '斜杠命令' });
      expect(within(list).getAllByRole('option')).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledWith(
        '/commands',
        expect.objectContaining({ method: 'GET' }),
      );

      fireEvent.change(input, { target: { value: '/rec' } });
      await waitFor(() => {
        const options = within(screen.getByRole('listbox', { name: '斜杠命令' })).getAllByRole(
          'option',
        );
        expect(options).toHaveLength(1);
        expect(within(options[0] as HTMLElement).getByText('回顾进展')).toBeTruthy();
      });

      fireEvent.change(input, { target: { value: '/rec 已经有参数' } });
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('puts the chosen command into the draft with the caret where the arguments go', async () => {
      const input = await renderWithCommands();
      fireEvent.change(input, { target: { value: '/rec' } });

      fireEvent.mouseDown(await screen.findByRole('option', { name: /回顾进展/ }));

      expect(input.value).toBe('请回顾目前的进展：\n');
      expect(input.selectionStart).toBe(input.value.length);
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(streamAgentRunMock).not.toHaveBeenCalled();
    });

    it('moves through the list with the arrow keys and takes the highlighted command on Enter', async () => {
      const input = await renderWithCommands();
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByRole('listbox', { name: '斜杠命令' });

      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(input.value).toBe('请审查这些改动');
      expect(streamAgentRunMock).not.toHaveBeenCalled();
    });

    it('closes the list on Escape and opens it again when typing continues', async () => {
      const input = await renderWithCommands();
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByRole('listbox', { name: '斜杠命令' });

      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(input.value).toBe('/');

      fireEvent.change(input, { target: { value: '/r' } });
      expect(await screen.findByRole('listbox', { name: '斜杠命令' })).toBeTruthy();
    });

    it('expands a typed command with its arguments before sending', async () => {
      streamAgentRunMock.mockImplementation(async (_request, handlers) => {
        handlers.onEvent({ type: 'completed', turnId: 'turn-command' });
      });
      const input = await renderWithCommands();
      // The list is requested when the draft starts with a slash.
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByRole('listbox', { name: '斜杠命令' });

      fireEvent.change(input, { target: { value: '/recap 登录页和注册页' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      expect((await screen.findAllByText(/请回顾目前的进展：/)).length).toBeGreaterThan(0);
      expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: '请回顾目前的进展：\n登录页和注册页' }],
        },
      });
    });

    it('sends a slash word nobody contributed as typed', async () => {
      streamAgentRunMock.mockImplementation(async (_request, handlers) => {
        handlers.onEvent({ type: 'completed', turnId: 'turn-unknown-command' });
      });
      const input = await renderWithCommands();
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByRole('listbox', { name: '斜杠命令' });

      fireEvent.change(input, { target: { value: '/unknown 参数' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
      expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
        userMessage: { content: [{ type: 'text', text: '/unknown 参数' }] },
      });
    });
  });
});

describe('Session Skills', () => {
  function useSkillsRoutes(): void {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (/\/sessions\/[^/]+\/skills$/.test(url)) return Response.json(skillCatalog());
      if (url.endsWith('/skills/preview')) {
        return Response.json({
          schemaVersion: 1,
          skill: planningSkill,
          instructions: '先核对项目约束，再列出步骤。',
        });
      }
      return base(input, init);
    });
  }

  it('keeps selected Skills in their own Session and previews inert instructions', async () => {
    useSkillsRoutes();
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'completed', turnId: 'skill-turn' });
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    const picker = await screen.findByRole('dialog', { name: '技能' });
    await within(picker).findByText(planningSkill.description);
    fireEvent.click(within(picker).getByRole('button', { name: '预览 weave-planning' }));
    expect(await within(picker).findByText('先核对项目约束，再列出步骤。')).toBeTruthy();
    fireEvent.click(within(picker).getByRole('checkbox', { name: /weave-planning/ }));
    fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
    expect(screen.getByRole('button', { name: '移除技能 weave-planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    expect(screen.queryByRole('button', { name: '移除技能 weave-planning' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    expect(screen.getByRole('button', { name: '移除技能 weave-planning' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '使用计划' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: sessionIds.local,
      skills: [planningRef],
    });
    expect(screen.queryByRole('button', { name: '移除技能 weave-planning' })).toBeNull();
    expect(screen.getByText(/已选择.*weave-planning/)).toBeTruthy();
  });

  it('retries the full image, settings and exact Skill snapshot without clearing the new draft', async () => {
    useSkillsRoutes();
    let n = 0;
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'text-delta', text: `快照回答 ${++n}` });
      handlers.onEvent({ type: 'completed', turnId: `snapshot-${n}` });
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    const picker = await screen.findByRole('dialog', { name: '技能' });
    fireEvent.click(await within(picker).findByRole('checkbox', { name: /weave-planning/ }));
    fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
    fireEvent.change(screen.getByLabelText('选择图片文件'), {
      target: { files: [new File(['hello'], 'snapshot.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('snapshot.png');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('快照回答 1');
    const original = streamAgentRunMock.mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('button', { name: '模型与强度' }));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '模型与强度' }));
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '下一轮草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    const next = await screen.findByRole('dialog', { name: '技能' });
    fireEvent.click(await within(next).findByRole('checkbox', { name: /review-code/ }));
    fireEvent.click(within(next).getByRole('button', { name: '关闭技能' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('快照回答 2');
    expect(streamAgentRunMock.mock.calls[1]?.[0]).toEqual(original);
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe('下一轮草稿');
    expect(screen.getByRole('button', { name: '移除技能 review-code' })).toBeTruthy();
  });

  it('reconstructs exact retry and honest Skill provenance from durable history', async () => {
    useSkillsRoutes();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/sessions/${sessionIds.local}`) {
        return Response.json({
          ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
            {
              role: 'user',
              turnId: 'history-skills',
              content: [
                { type: 'text', text: '前文' },
                { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
                { type: 'text', text: '后文' },
              ],
            },
            {
              role: 'assistant',
              turnId: 'history-skills',
              content: [{ type: 'text', text: '历史技能回答' }],
            },
          ]),
          turns: [
            {
              turnId: 'history-skills',
              userMessageId: `${sessionIds.local}-message-1`,
              status: 'completed',
              startedAt: '2026-11-22T00:00:00Z',
              request: {
                provider: 'mock',
                model: 'original-model',
                useProviderDefaults: false,
                temperature: 0.2,
                maxTokens: 777,
                reasoningEffort: 'low',
                permissionMode: 'ask',
              },
              skills: {
                requested: [planningRef],
                applications: [
                  { skill: planningSkill, invocation: 'user', placement: 0, delivery: 'prepared' },
                  {
                    skill: projectSkill,
                    invocation: 'model',
                    placement: 1,
                    delivery: 'prepared',
                    toolCallId: 'read-one',
                  },
                ],
                failures: [],
              },
            },
          ],
        });
      }
      return base(input, init);
    });
    streamAgentRunMock.mockImplementation(async (_request, handlers) =>
      handlers.onEvent({ type: 'completed', turnId: 'history-retry' }),
    );
    await renderApp();
    await screen.findByText('历史技能回答');
    expect(screen.getByText(/已加入指令.*weave-planning/)).toBeTruthy();
    expect(screen.getByText(/已准备.*review-code/)).toBeTruthy();
    expect(screen.queryByText(/已交付.*review-code/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toEqual({
      sessionId: sessionIds.local,
      userMessage: {
        role: 'user',
        content: [
          { type: 'text', text: '前文' },
          { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          { type: 'text', text: '后文' },
        ],
      },
      provider: 'mock',
      model: 'original-model',
      useProviderDefaults: false,
      temperature: 0.2,
      maxTokens: 777,
      reasoningEffort: 'low',
      permissionMode: 'ask',
      skills: [planningRef],
    });
  });
});

it('disables exact retry for legacy history that lacks original request settings', async () => {
  await renderApp();
  fireEvent.click(screen.getByRole('button', { name: /Foundation 设计/ }));
  await screen.findByText('历史项目回答');
  const retry = screen.getByRole('button', { name: '重试' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(retry.title).toContain('未记录原始请求设置');
});

it('preserves unaccepted Skill picks when the Server rejects the submission', async () => {
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    /\/sessions\/[^/]+\/skills$/.test(String(input))
      ? Response.json(skillCatalog())
      : base(input, init),
  );
  streamAgentRunMock.mockRejectedValue(new AgentStreamError('skill-source-changed', '技能已变化'));
  await renderApp();
  fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
  const picker = await screen.findByRole('dialog', { name: '技能' });
  fireEvent.click(await within(picker).findByRole('checkbox', { name: /weave-planning/ }));
  fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
  fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '验证拒绝' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText(/技能已变化/);
  expect(screen.getByRole('button', { name: '移除技能 weave-planning' })).toBeTruthy();
});

it('leaves next-turn Skill selections intact when delayed transport acceptance belongs to an earlier revision', async () => {
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    /\/sessions\/[^/]+\/skills$/.test(String(input))
      ? Response.json(skillCatalog())
      : base(input, init),
  );
  let accept: () => void = () => undefined;
  streamAgentRunMock.mockImplementation(
    (_request, handlers) =>
      new Promise<void>(() => {
        accept = () => handlers.onAccepted?.();
      }),
  );
  await renderApp();
  fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
  let picker = await screen.findByRole('dialog', { name: '技能' });
  fireEvent.click(await within(picker).findByRole('checkbox', { name: /weave-planning/ }));
  fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
  fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '第一轮快照' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
  picker = await screen.findByRole('dialog', { name: '技能' });
  fireEvent.click(await within(picker).findByRole('checkbox', { name: /review-code/ }));
  fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
  act(() => accept());
  expect(screen.getByRole('button', { name: '移除技能 review-code' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '移除技能 weave-planning' })).toBeNull();
  expect(streamAgentRunMock.mock.calls[0]?.[0].skills).toEqual([planningRef]);
});

it('keeps requested and failed Skill facts on the exact user card after a pre-model error', async () => {
  const base = fetchMock.getMockImplementation()!;
  let fail = false;
  const returned = () => ({
    ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
      { role: 'user', turnId: 'failed-skill', content: [{ type: 'text', text: '同文问题' }] },
    ]),
    lastSequence: 31,
    turns: [
      {
        turnId: 'failed-skill',
        userMessageId: `${sessionIds.local}-message-1`,
        status: 'failed',
        startedAt: new Date(Date.now() + 1000).toISOString(),
        request: { provider: 'mock', model: 'weave-local-demo', permissionMode: 'ask' },
        skills: {
          requested: [planningRef],
          applications: [],
          failures: [
            {
              skill: planningRef,
              stage: 'selection',
              code: 'skill-source-changed',
              toolCallId: 'model-read-failed',
            },
          ],
        },
      },
    ],
  });
  fetchMock.mockImplementation(async (input, init) => {
    if (/\/sessions\/[^/]+\/skills$/.test(String(input))) return Response.json(skillCatalog());
    if (fail && String(input) === `/sessions/${sessionIds.local}`) return Response.json(returned());
    return base(input, init);
  });
  streamAgentRunMock.mockImplementation(async (request, handlers) => {
    const { sessionId, ...input } = request;
    handlers.onReceipt?.({
      executionId: 'skill-execution',
      requestId: 'skill-request',
      sessionId,
      turnId: 'failed-skill',
      userMessageId: `${sessionIds.local}-message-1`,
      createdAt: '2026-11-23T00:00:00.000Z',
      cursor: 'epoch:skill-execution:1',
      status: 'running',
      input: { ...input, permissionMode: input.permissionMode ?? 'ask' },
      events: [],
    });
    fail = true;
    handlers.onStatus?.({
      cursor: 'epoch:skill-execution:2',
      status: 'failed',
      durableThroughSequence: 31,
      error: { code: 'skill-source-changed', message: '原引用过期' },
    });
  });
  await renderApp();
  fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
  const picker = await screen.findByRole('dialog', { name: '技能' });
  fireEvent.click(await within(picker).findByRole('checkbox', { name: /weave-planning/ }));
  fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
  fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '同文问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByText(/未生效.*weave-planning.*内容已变化/)).toBeTruthy();
  expect(screen.queryByText(/已加入指令.*weave-planning/)).toBeNull();
});

it('captures Provider sampling defaults in new immutable submissions for later exact retry', async () => {
  fetchMock = createWorkspaceFetchMock({
    providers: [
      {
        id: 'mock',
        label: '采样模型',
        type: 'mock',
        defaultModel: 'sampling',
        hasApiKey: false,
        editable: false,
        temperature: 0.4,
        maxTokens: 1024,
      },
    ],
    defaultProvider: 'mock',
    canManage: false,
  });
  vi.stubGlobal('fetch', fetchMock);
  streamAgentRunMock.mockImplementation(async (_request, handlers) =>
    handlers.onEvent({ type: 'completed', turnId: 'sampling-turn' }),
  );
  await renderApp();
  fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '记录采样参数' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
  expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
    temperature: 0.4,
    maxTokens: 1024,
  });
});

it('disables exact retry for history whose sampling still follows mutable Provider defaults', async () => {
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === `/sessions/${sessionIds.local}`)
      return Response.json({
        ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
          {
            role: 'user',
            turnId: 'old-defaults',
            content: [{ type: 'text', text: '未固定默认值' }],
          },
          {
            role: 'assistant',
            turnId: 'old-defaults',
            content: [{ type: 'text', text: '旧设置回答' }],
          },
        ]),
        turns: [
          {
            turnId: 'old-defaults',
            userMessageId: `${sessionIds.local}-message-1`,
            status: 'completed',
            startedAt: '2026-11-22T00:00:00Z',
            request: { provider: 'mock', model: 'old-model', permissionMode: 'ask' },
          },
        ],
      });
    return base(input, init);
  });
  await renderApp();
  await screen.findByText('旧设置回答');
  const retry = screen.getByRole('button', { name: '重试' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(retry.title).toContain('未记录');
});

describe('declarative panel App integration', () => {
  const authority = { serverEpoch: 'a'.repeat(32), generation: 1, authorityEpoch: 1 };
  const panelRef = 'b'.repeat(32);
  const panelId = 'plugin:reporter/report';
  const definition = {
    schemaVersion: 1,
    id: 'report',
    title: 'Quality report',
    icon: 'info',
    placement: 'right',
    sources: [],
    blocks: [
      {
        id: 'form',
        type: 'form',
        fields: [{ id: 'target', type: 'text', label: 'Target', required: true, default: 'src' }],
        submit: { type: 'prepare-command', command: 'report', label: 'Prepare report' },
      },
    ],
  };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  function panelRoutes(
    prepare: (sessionId: string) => Promise<Response>,
    commands: readonly Record<string, unknown>[] = [],
  ): void {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/plugins/panels')
        return Response.json({
          ...authority,
          schemaVersion: 1,
          acceptingRuns: true,
          panels: [
            {
              panelId,
              panelRef,
              pluginId: 'reporter',
              pluginName: 'Reporter',
              pluginVersion: '1.0.0',
              state: 'available',
              definition,
            },
          ],
        });
      const match = path.match(/^\/sessions\/([^/]+)\/plugin-panels\/[^/]+(\/prepare-command)?$/);
      if (match)
        return match[2]
          ? prepare(match[1]!)
          : Response.json({
              ...authority,
              schemaVersion: 1,
              panelRef,
              panelId,
              sessionId: match[1],
              lastSequence: 1,
              state: 'ready',
              sources: [],
              blocks: [],
            });
      if (path === '/commands') return Response.json({ commands });
      if (/\/sessions\/[^/]+\/skills$/.test(path)) return Response.json(skillCatalog());
      return base(input, init);
    });
  }
  function prepared(sessionId: string, text: string): Response {
    return Response.json({
      ...authority,
      schemaVersion: 1,
      panelId,
      panelRef,
      sessionId,
      lastSequence: 1,
      formId: 'form',
      command: 'report',
      text,
      requiresUserSend: true,
    });
  }
  async function openPanel(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Quality report/ }));
    await screen.findByRole('button', { name: 'Prepare report' });
  }
  it('prepares into current edited draft with its image and Skill and sends literal text explicitly', async () => {
    const pending = deferred<Response>();
    panelRoutes(() => pending.promise);
    streamAgentRunMock.mockImplementation(async (_request, handlers) => {
      handlers.onAccepted?.();
      handlers.onEvent({ type: 'completed', turnId: 'prepared-turn' });
    });
    await renderApp();
    await openPanel();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'first' } });
    fireEvent.change(screen.getByLabelText('选择图片文件'), {
      target: { files: [new File(['hello'], 'panel.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('panel.png');
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    const picker = await screen.findByRole('dialog', { name: '技能' });
    fireEvent.click(await within(picker).findByRole('checkbox', { name: /weave-planning/ }));
    fireEvent.click(within(picker).getByRole('button', { name: '关闭技能' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare report' }));
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'first edited' } });
    await act(async () => pending.resolve(prepared(sessionIds.local, 'prepared')));
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
      'first edited\n\nprepared',
    );
    expect(screen.getByAltText('panel.png')).toBeTruthy();
    expect(screen.getByRole('button', { name: '移除技能 weave-planning' })).toBeTruthy();
    expect(streamAgentRunMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
      skills: [planningRef],
      userMessage: {
        content: [
          { type: 'text', text: 'first edited\n\nprepared' },
          { type: 'image', data: 'aGVsbG8=' },
        ],
      },
    });
  });
  it.each(['session', 'aba', 'route', 'collapse', 'tab'])(
    'rejects ignored-abort prepare after %s transition',
    async (transition) => {
      const pending = deferred<Response>();
      panelRoutes(() => pending.promise);
      await renderApp();
      await openPanel();
      fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'keep' } });
      fireEvent.click(screen.getByRole('button', { name: 'Prepare report' }));
      if (transition === 'session' || transition === 'aba') {
        fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
        if (transition === 'aba')
          fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
      }
      if (transition === 'route') {
        fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
        fireEvent.click(screen.getByRole('button', { name: '工作台' }));
      }
      if (transition === 'collapse') {
        fireEvent.click(screen.getByRole('button', { name: '收起上下文' }));
        fireEvent.click(screen.getByRole('button', { name: '显示上下文' }));
      }
      if (transition === 'tab') {
        fireEvent.click(screen.getByRole('tab', { name: '概览' }));
        fireEvent.click(screen.getByRole('tab', { name: 'Quality report' }));
      }
      await act(async () => pending.resolve(prepared(sessionIds.local, 'stale')));
      expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
        transition === 'session' ? '' : 'keep',
      );
      expect(streamAgentRunMock).not.toHaveBeenCalled();
    },
  );
  it('does not re-expand prepared slash text after ordinary editing', async () => {
    panelRoutes(
      async () => prepared(sessionIds.local, '/old-command frozen'),
      [
        {
          name: 'old-command',
          title: 'Replacement',
          prompt: 'replacement $ARGUMENTS',
          pluginId: 'replacement',
        },
      ],
    );
    streamAgentRunMock.mockImplementation(async (_r, h) =>
      h.onEvent({ type: 'completed', turnId: 'literal' }),
    );
    await renderApp();
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare report' }));
    await waitFor(() =>
      expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
        '/old-command frozen',
      ),
    );
    fireEvent.change(screen.getByLabelText('发送消息'), {
      target: { value: '/old-command frozen edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
    expect(streamAgentRunMock.mock.calls[0]?.[0].userMessage.content[0]).toEqual({
      type: 'text',
      text: '/old-command frozen edited',
    });
  });
  it('discards delayed image decode after Session ownership changes', async () => {
    let complete: (() => void) | undefined;
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:image/png;base64,aGVsbG8=';
        onload: (() => void) | null = null;
        readAsDataURL() {
          complete = () => this.onload?.();
        }
      },
    );
    await renderApp();
    fireEvent.change(screen.getByLabelText('选择图片文件'), {
      target: { files: [new File(['hello'], 'late.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: /Session event store/ }));
    await act(async () => complete?.());
    expect(screen.queryByAltText('late.png')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
    expect(screen.queryByAltText('late.png')).toBeNull();
  });
  it.each(['mouse', 'keyboard'])(
    'resets prepared literal mode on explicit %s command selection',
    async (method) => {
      panelRoutes(
        async () => prepared(sessionIds.local, '/old-command frozen'),
        [
          {
            name: 'old-command',
            title: 'Replacement',
            prompt: 'replacement $ARGUMENTS',
            pluginId: 'replacement',
          },
        ],
      );
      streamAgentRunMock.mockImplementation(async (_r, h) =>
        h.onEvent({ type: 'completed', turnId: 'selected' }),
      );
      await renderApp();
      await openPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Prepare report' }));
      await screen.findByText('已准备文本，请检查并点击发送', {
        selector: '.composer-prepared-status',
      });
      const input = screen.getByLabelText('发送消息');
      fireEvent.change(input, { target: { value: '/old-command' } });
      const option = await screen.findByRole('option', { name: /Replacement/ });
      if (method === 'mouse') fireEvent.mouseDown(option);
      else fireEvent.keyDown(input, { key: 'Enter' });
      expect(
        screen.queryByText('已准备文本，请检查并点击发送', {
          selector: '.composer-prepared-status',
        }),
      ).toBeNull();
      fireEvent.change(input, { target: { value: '/old-command manual' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
      expect(streamAgentRunMock.mock.calls[0]?.[0].userMessage.content[0]).toEqual({
        type: 'text',
        text: 'replacement manual',
      });
    },
  );
});

describe('provisional composer App sends', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  it.each(['unchanged', 'edited', 'switched'])(
    'handles %s provisional ownership while Session creation waits',
    async (mode) => {
      fetchMock = createWorkspaceFetchMock(undefined, { emptyProject: true });
      const base = fetchMock.getMockImplementation()!;
      const pending = deferred<Response>();
      let creationStarted = false;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === '/projects/project-empty/sessions' && init?.method === 'POST') {
          creationStarted = true;
          return pending.promise;
        }
        return base(input, init);
      });
      vi.stubGlobal('fetch', fetchMock);
      streamAgentRunMock.mockImplementation(async (_r, h) => {
        h.onAccepted?.();
        h.onEvent({ type: 'completed', turnId: 'provisional' });
      });
      await renderApp();
      fireEvent.click(screen.getByRole('button', { name: '项目' }));
      fireEvent.click(screen.getByRole('button', { name: '打开项目 Orbit' }));
      fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'captured' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(creationStarted).toBe(true));
      if (mode === 'edited')
        fireEvent.change(screen.getByLabelText('发送消息'), {
          target: { value: 'new provisional draft' },
        });
      if (mode === 'switched') {
        fireEvent.click(screen.getByRole('button', { name: /本地 Agent 演示/ }));
        fireEvent.change(screen.getByLabelText('发送消息'), {
          target: { value: 'other session draft' },
        });
      }
      await act(async () =>
        pending.resolve(Response.json(sessionDetail('session-created-delayed', 'Delayed'))),
      );
      await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalled());
      expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'session-created-delayed',
        userMessage: { content: [{ type: 'text', text: 'captured' }] },
      });
      expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
        mode === 'unchanged'
          ? ''
          : mode === 'edited'
            ? 'new provisional draft'
            : 'other session draft',
      );
      if (mode === 'unchanged')
        expect(
          screen.getByRole('button', { name: /Delayed/ }).closest('.session-tree-item')
            ?.className ?? '',
        ).toContain('active');
      if (mode === 'edited')
        expect(
          screen.queryByRole('button', { name: /Delayed/ })?.closest('.session-tree-item')
            ?.className ?? '',
        ).not.toContain('active');
    },
  );
  it('preserves text and image edits received before stream acceptance', async () => {
    let accept: (() => void) | undefined;
    const stream = deferred<void>();
    streamAgentRunMock.mockImplementation(async (_r, h) => {
      accept = () => h.onAccepted?.();
      await stream.promise;
      h.onEvent({ type: 'completed', turnId: 'delayed-accept' });
    });
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'captured' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(accept).toBeDefined());
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: 'newer' } });
    fireEvent.change(screen.getByLabelText('选择图片文件'), {
      target: { files: [new File(['hello'], 'newer.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('newer.png');
    await act(async () => accept?.());
    expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe('newer');
    expect(screen.getByAltText('newer.png')).toBeTruthy();
    await act(async () => stream.resolve());
  });
});

describe('explicit project file context', () => {
  function fileRoutes(): void {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.startsWith('/projects?') || path === '/projects') {
        const payload = await (await base(input, init)).json();
        return Response.json({
          ...payload,
          projects: payload.projects.map((p: Record<string, unknown>) => ({
            ...p,
            folderPath: '/test/project',
          })),
        });
      }
      if (path.endsWith('/tree'))
        return Response.json({
          files: ['a.ts', 'b.ts', ...Array.from({ length: 8 }, (_, i) => `extra-${i}.ts`)],
          source: 'walk',
          truncated: false,
        });
      if (path.includes('/file?'))
        return Response.json({
          path: 'a.ts',
          content: 'current value',
          bytes: 13,
          truncated: false,
        });
      return base(input, init);
    });
  }
  it('selects an explicit chip with Enter, sends file-only refs and preserves a newer draft file on receipt', async () => {
    fileRoutes();
    let receipt!: AgentStreamHandlers;
    let finish!: () => void;
    streamAgentRunMock.mockImplementation((_request, handlers) => {
      receipt = handlers;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await renderApp();
    const input = screen.getByLabelText('发送消息');
    fireEvent.change(input, { target: { value: '@a' } });
    await screen.findByRole('option', { name: 'a.ts' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(streamAgentRunMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '移除文件 a.ts' })).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalledTimes(1));
    expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
      userMessage: { content: [] },
      files: [{ path: 'a.ts' }],
    });
    fireEvent.change(input, { target: { value: '@b' } });
    fireEvent.click(await screen.findByRole('option', { name: 'b.ts' }));
    act(() => {
      receipt.onAccepted?.();
      finish();
    });
    expect(screen.getByRole('button', { name: '移除文件 b.ts' })).toBeTruthy();
  });
  it('keeps definite capture rejections editable with file chips intact', async () => {
    fileRoutes();
    streamAgentRunMock.mockRejectedValueOnce(
      new AgentStreamError('execution-file-capture-timeout', '文件读取超时，请重试'),
    );
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '添加项目文件' }));
    fireEvent.click(await screen.findByRole('option', { name: 'a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('文件读取超时，请重试。草稿已保留。');
    expect(screen.getByRole('button', { name: '移除文件 a.ts' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(streamAgentRunMock).toHaveBeenCalledTimes(1);
  });
  it('keeps a toolbar menu open when focus selection fires and avoids IME submission', async () => {
    fileRoutes();
    await renderApp();
    const input = screen.getByLabelText('发送消息');
    fireEvent.click(screen.getByRole('button', { name: '添加项目文件' }));
    fireEvent.select(input);
    await screen.findByRole('option', { name: 'a.ts' });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '@b' } });
    fireEvent.select(input);
    expect(screen.queryByRole('listbox', { name: '项目文件候选' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(streamAgentRunMock).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await screen.findByRole('option', { name: 'b.ts' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('button', { name: '移除文件 b.ts' })).toBeTruthy();
    expect(streamAgentRunMock).not.toHaveBeenCalled();
  });
  it('keeps Skill, slash and project file menus mutually exclusive', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/commands')
        return Response.json({
          commands: [
            { name: 'recap', title: '回顾进展', prompt: '回顾 $ARGUMENTS', pluginId: 'recap-kit' },
          ],
        });
      if (/\/sessions\/[^/]+\/skills$/.test(String(input))) return Response.json(skillCatalog());
      return base(input, init);
    });
    fileRoutes();
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    await screen.findByRole('dialog', { name: '技能' });
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '/' } });
    await screen.findByRole('listbox', { name: '斜杠命令' });
    expect(screen.queryByRole('dialog', { name: '技能' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加项目文件' }));
    await screen.findByRole('listbox', { name: '项目文件候选' });
    expect(screen.queryByRole('listbox', { name: '斜杠命令' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    await screen.findByRole('dialog', { name: '技能' });
    expect(screen.queryByRole('listbox', { name: '项目文件候选' })).toBeNull();
  });
  it('invalidates @ token offsets after quoting a reply into the draft', async () => {
    fileRoutes();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/sessions/${sessionIds.local}`)
        return Response.json(
          sessionDetail(sessionIds.local, '本地 Agent 演示', [
            {
              role: 'user',
              turnId: 'earlier',
              content: [{ type: 'text', text: 'earlier question' }],
            },
            {
              role: 'assistant',
              turnId: 'earlier',
              content: [{ type: 'text', text: 'quoted reply' }],
            },
            { role: 'user', turnId: 'later', content: [{ type: 'text', text: 'later question' }] },
            {
              role: 'assistant',
              turnId: 'later',
              content: [{ type: 'text', text: 'later reply' }],
            },
          ]),
        );
      return base(input, init);
    });
    await renderApp();
    await screen.findByText('quoted reply');
    const input = screen.getByLabelText('发送消息');
    fireEvent.change(input, { target: { value: '@a' } });
    await screen.findByRole('option', { name: 'a.ts' });
    fireEvent.click(screen.getByRole('button', { name: '引用' }));
    expect((input as HTMLTextAreaElement).value).toBe('> quoted reply\n\n@a');
    expect(screen.queryByRole('option', { name: 'a.ts' })).toBeNull();
    expect(screen.queryByRole('button', { name: '移除文件 a.ts' })).toBeNull();
  });
  it('shares one logical ref between @ selection and the file viewer add action', async () => {
    fileRoutes();
    await renderApp();
    const input = screen.getByLabelText('发送消息');
    fireEvent.change(input, { target: { value: '@a' } });
    await screen.findByRole('option', { name: 'a.ts' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('tab', { name: '文件' }));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'a.ts' }));
    expect(
      ((await screen.findByRole('button', { name: '已添加 a.ts' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByRole('button', { name: '移除文件 a.ts' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '移除文件 a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: '添加到消息 a.ts' }));
    expect(screen.getAllByRole('button', { name: '移除文件 a.ts' })).toHaveLength(1);
  });
  it('sends ordinary @path text without adding any logical file ref', async () => {
    fileRoutes();
    streamAgentRunMock.mockResolvedValue(undefined);
    await renderApp();
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '@a.ts' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalledOnce());
    expect(streamAgentRunMock.mock.calls[0]?.[0].files).toBeUndefined();
    expect(streamAgentRunMock.mock.calls[0]?.[0].userMessage.content).toEqual([
      { type: 'text', text: '@a.ts' },
    ]);
  });
  it.each(['append', 'replace', 'overflow', 'replace-open-token'])(
    'copies queued refs with %s semantics and keeps the original queued message',
    async (choice) => {
      fileRoutes();
      const base = fetchMock.getMockImplementation()!;
      const replacingToken = choice === 'replace-open-token';
      const refs =
        choice === 'overflow'
          ? Array.from({ length: 8 }, (_, i) => ({ path: `extra-${i}.ts` }))
          : [{ path: 'b.ts' }, { path: 'a.ts' }];
      const summary = {
        executionId: 'files-q',
        requestId: 'files-r',
        sessionId: sessionIds.local,
        turnId: 'files-t',
        userMessageId: 'files-u',
        createdAt: '2026-11-23T00:00:00Z',
        status: 'queued',
        cursor: 'epoch:files-q:0',
      };
      fetchMock.mockImplementation(async (input, init) => {
        const path = String(input);
        if (path.endsWith('/executions/queue'))
          return Response.json({
            sessionId: sessionIds.local,
            revision: 1,
            cursor: `epoch:${sessionIds.local}:1`,
            active: null,
            queued: [
              {
                ...summary,
                preview: 'queued files',
                provider: 'mock',
                model: 'm',
                imageCount: 0,
                skillCount: 0,
                fileCount: refs.length,
              },
            ],
            scheduler: 'ready',
            limits: { sessionQueued: 10, globalQueued: 100 },
          });
        if (path.endsWith('/executions/files-q'))
          return Response.json({
            ...summary,
            input: {
              userMessage: {
                role: 'user',
                content: replacingToken ? [{ type: 'text', text: 'queued message' }] : [],
              },
              provider: 'mock',
              model: 'm',
              permissionMode: 'ask',
              files: refs,
            },
            events: [],
          });
        return base(input, init);
      });
      await renderApp();
      fireEvent.click(screen.getByRole('button', { name: '添加项目文件' }));
      await screen.findByRole('option', { name: 'a.ts' });
      fireEvent.click(screen.getByRole('option', { name: 'a.ts' }));
      expect(screen.getByRole('button', { name: '移除文件 a.ts' })).toBeTruthy();
      if (replacingToken) {
        fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '@a' } });
        await screen.findByRole('option', { name: 'a.ts' });
      }
      fireEvent.click(await screen.findByRole('button', { name: '复制第 1 条消息到草稿' }));
      const dialog = await screen.findByRole('dialog', { name: '复制队列消息' });
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: choice === 'replace' || replacingToken ? '替换草稿' : '追加到草稿',
        }),
      );
      const draft = screen.getByLabelText('待发送文件');
      const paths = within(draft)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'));
      expect(paths).toEqual(
        choice === 'replace' || replacingToken
          ? ['移除文件 b.ts', '移除文件 a.ts']
          : choice === 'overflow'
            ? ['移除文件 a.ts']
            : ['移除文件 a.ts', '移除文件 b.ts'],
      );
      expect(
        screen.getByText(
          choice === 'overflow'
            ? '最多添加 8 个文件，请先移除文件后再复制。'
            : '已复制到草稿，原消息仍在队列中。再次发送会读取当前项目文件。',
        ),
      ).toBeTruthy();
      if (replacingToken) {
        expect((screen.getByLabelText('发送消息') as HTMLTextAreaElement).value).toBe(
          'queued message',
        );
        expect(screen.queryByRole('listbox', { name: '项目文件候选' })).toBeNull();
      }
      expect(screen.getByRole('button', { name: '复制第 1 条消息到草稿' })).toBeTruthy();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cancel'))).toBe(false);
    },
  );
  it.each(['failed', 'cancelled'])(
    'reconstructs ordered refs for a refreshed %s file-only Turn',
    async (status) => {
      const base = fetchMock.getMockImplementation()!;
      const summaries = ['b.ts', 'a.ts'].map((path) => ({
        path,
        encoding: 'utf-8',
        byteLength: 6,
        sha256: 'a'.repeat(64),
      }));
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === `/sessions/${sessionIds.local}`)
          return Response.json({
            ...sessionDetail(sessionIds.local, '本地 Agent 演示', [
              { role: 'user', turnId: 'files-history', content: [], fileAttachments: summaries },
              {
                role: 'assistant',
                turnId: 'files-history',
                content: [{ type: 'text', text: '原回答' }],
              },
            ]),
            turns: [
              {
                turnId: 'files-history',
                userMessageId: `${sessionIds.local}-message-1`,
                status,
                startedAt: '2026-11-23T00:00:00Z',
                request: {
                  provider: 'mock',
                  model: 'original-model',
                  useProviderDefaults: false,
                  permissionMode: 'ask',
                },
              },
            ],
          });
        return base(input, init);
      });
      streamAgentRunMock.mockResolvedValue(undefined);
      await renderApp();
      expect(await screen.findByLabelText('发送时快照')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
      await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalledTimes(1));
      expect(streamAgentRunMock.mock.calls[0]?.[0]).toMatchObject({
        userMessage: { content: [] },
        files: [{ path: 'b.ts' }, { path: 'a.ts' }],
      });
      expect(JSON.stringify(streamAgentRunMock.mock.calls[0]?.[0])).not.toContain('sha256');
      const firstRequestId = streamAgentRunMock.mock.calls[0]?.[2]?.requestId;
      expect(firstRequestId).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!);
      await waitFor(() => expect(streamAgentRunMock).toHaveBeenCalledTimes(2));
      expect(streamAgentRunMock.mock.calls[1]?.[2]?.requestId).not.toBe(firstRequestId);
    },
  );
});
