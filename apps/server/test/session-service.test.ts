import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore, WorkspaceStoreError } from '@weave/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionService,
  type SessionService,
  type SessionServiceOptions,
} from '../src/session-service.js';

const resources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

async function createContext(overrides?: Partial<SessionServiceOptions>): Promise<{
  service: SessionService;
  projectStore: Awaited<ReturnType<typeof createInMemoryProjectStore>>;
  sessionStore: ReturnType<typeof createInMemorySessionEventStore>;
}> {
  const projectStore = createInMemoryProjectStore();
  const sessionStore = createInMemorySessionEventStore();
  resources.push(projectStore, sessionStore);
  const service = createSessionService({
    projectStore,
    sessionStore,
    ...overrides,
  });
  return { service, projectStore, sessionStore };
}

describe('Session Service', () => {
  it('returns per-Turn usage, model, timing, and the Turn of each reply', async () => {
    const { service, projectStore, sessionStore } = await createContext();
    const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });
    const session = await service.create(project.id);
    await sessionStore.append(session.id, [
      {
        type: 'message.created',
        payload: {
          messageId: 'user-1',
          message: { role: 'user', content: [{ type: 'text', text: '读文件' }] },
        },
      },
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
      {
        type: 'step.started',
        payload: {
          turnId: 'turn-1',
          stepId: 'm1',
          kind: 'model',
          provider: 'deepseek',
          model: 'flash',
        },
      },
      {
        type: 'step.completed',
        payload: {
          turnId: 'turn-1',
          stepId: 'm1',
          status: 'completed',
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
        },
      },
      { type: 'step.started', payload: { turnId: 'turn-1', stepId: 't1', kind: 'tool' } },
      {
        type: 'tool-call.created',
        payload: {
          turnId: 'turn-1',
          stepId: 't1',
          toolCall: { id: 'call-1', name: 'read_file', arguments: '{}' },
        },
      },
      {
        type: 'tool-result.created',
        payload: {
          turnId: 'turn-1',
          stepId: 't1',
          toolCallId: 'call-1',
          name: 'read_file',
          content: 'missing',
          truncated: false,
          status: 'failed',
          errorCode: 'tool-execution-failed',
        },
      },
      { type: 'step.completed', payload: { turnId: 'turn-1', stepId: 't1', status: 'failed' } },
      {
        type: 'step.started',
        payload: {
          turnId: 'turn-1',
          stepId: 'm2',
          kind: 'model',
          provider: 'deepseek',
          model: 'flash',
        },
      },
      {
        type: 'message.created',
        payload: {
          messageId: 'assistant-1',
          message: { role: 'assistant', content: [{ type: 'text', text: '文件不存在' }] },
        },
      },
      {
        type: 'step.completed',
        payload: {
          turnId: 'turn-1',
          stepId: 'm2',
          status: 'completed',
          usage: { inputTokens: 120, outputTokens: 6, cacheReadTokens: 96 },
        },
      },
      { type: 'turn.completed', payload: { turnId: 'turn-1', status: 'completed' } },
    ]);

    const detail = await service.get(session.id);

    expect(detail.messages.map((message) => message.turnId)).toEqual([undefined, 'turn-1']);
    expect(detail.turns).toEqual([
      expect.objectContaining({
        turnId: 'turn-1',
        status: 'completed',
        provider: 'deepseek',
        model: 'flash',
        usage: { inputTokens: 220, outputTokens: 16, cacheReadTokens: 96 },
        toolCalls: 1,
        failedToolCalls: 1,
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      }),
    ]);
    expect(detail.turns[0]?.modelSteps).toHaveLength(2);
  });

  it('surfaces the latest task plan on the Turn summary', async () => {
    const { service, projectStore, sessionStore } = await createContext();
    const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });
    const session = await service.create(project.id);
    const plan = {
      explanation: '两步',
      items: [
        { step: '读取', status: 'completed' },
        { step: '写入', status: 'in_progress' },
      ],
    };
    await sessionStore.append(session.id, [
      {
        type: 'message.created',
        payload: {
          messageId: 'user-1',
          message: { role: 'user', content: [{ type: 'text', text: '做计划' }] },
        },
      },
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
      { type: 'step.started', payload: { turnId: 'turn-1', stepId: 'm1', kind: 'model' } },
      { type: 'step.completed', payload: { turnId: 'turn-1', stepId: 'm1', status: 'completed' } },
      { type: 'step.started', payload: { turnId: 'turn-1', stepId: 't1', kind: 'tool' } },
      {
        type: 'tool-call.created',
        payload: {
          turnId: 'turn-1',
          stepId: 't1',
          toolCall: { id: 'call-1', name: 'update_plan', arguments: '{}' },
        },
      },
      {
        type: 'tool-result.created',
        payload: {
          turnId: 'turn-1',
          stepId: 't1',
          toolCallId: 'call-1',
          name: 'update_plan',
          content: '已记录计划',
          truncated: false,
          status: 'completed',
        },
      },
      {
        type: 'step.completed',
        payload: { turnId: 'turn-1', stepId: 't1', status: 'completed', plan },
      },
      { type: 'turn.completed', payload: { turnId: 'turn-1', status: 'completed' } },
    ]);

    const detail = await service.get(session.id);
    expect(detail.turns[0]?.plan).toEqual(plan);
  });

  it('creates a Session and attaches it to a Project', async () => {
    const { service, projectStore } = await createContext();
    const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });

    const session = await service.create(project.id, '测试会话');

    expect(session).toMatchObject({
      id: expect.any(String),
      title: '测试会话',
      messages: [],
      archivedAt: undefined,
      deletedAt: undefined,
    });
    expect(await projectStore.listSessionRefs(project.id)).toHaveLength(1);
  });

  it('compensates with a delete tombstone when attachment fails', async () => {
    const projectStore = createInMemoryProjectStore();
    const sessionStore = createInMemorySessionEventStore();
    resources.push(projectStore, sessionStore);
    const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });
    const failingProjectStore = {
      ...projectStore,
      async attachSession(): Promise<never> {
        throw new WorkspaceStoreError('workspace-session-already-attached', '关系创建失败');
      },
    };
    let createdSessionId: string | undefined;
    const recordingSessionStore = {
      ...sessionStore,
      async append(
        sessionId: string,
        events: Parameters<typeof sessionStore.append>[1],
      ): ReturnType<typeof sessionStore.append> {
        createdSessionId = sessionId;
        return sessionStore.append(sessionId, events);
      },
    };
    const service = createSessionService({
      projectStore: failingProjectStore,
      sessionStore: recordingSessionStore,
    });

    await expect(service.create(project.id, '补偿测试')).rejects.toMatchObject({
      code: 'workspace-session-already-attached',
    });

    expect(createdSessionId).toBeDefined();
    expect((await sessionStore.read(createdSessionId!)).map((event) => event.type)).toEqual([
      'session.created',
      'session.deleted',
    ]);
  });

  it('changes lifecycle state and rejects Agent execution when unavailable', async () => {
    const { service, projectStore, sessionStore } = await createContext();
    const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });
    const session = await service.create(project.id, '生命周期测试');

    await service.rename(session.id, '新标题');
    await service.archive(session.id);
    await expect(service.assertRunnable(session.id)).rejects.toMatchObject({
      code: 'session-archived',
    });

    await service.restore(session.id);
    await service.delete(session.id);
    await expect(service.assertRunnable(session.id)).rejects.toMatchObject({
      code: 'session-deleted',
    });
    await expect(service.restore(session.id)).rejects.toMatchObject({
      code: 'session-deleted',
    });

    const detail = await service.get(session.id);
    expect(detail).toMatchObject({
      title: '新标题',
      deletedAt: expect.any(String),
    });
    expect((await sessionStore.read(session.id)).map((event) => event.type)).toEqual([
      'session.created',
      'session.renamed',
      'session.archived',
      'session.restored',
      'session.deleted',
    ]);
  });

  it('lists valid sessions and warnings for damaged Session events', async () => {
    const { service, projectStore, sessionStore } = await createContext();
    const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });
    const valid = await service.create(project.id, '有效会话');
    await sessionStore.append('damaged', [
      { type: 'session.created', payload: {} },
      { type: 'session.restored', payload: {} },
    ]);
    await projectStore.attachSession(project.id, 'damaged');

    const result = await service.listProjectSessions(project.id);

    expect(result.sessions.map((item) => item.id)).toEqual([valid.id]);
    expect(result.warnings).toEqual([{ code: 'session-projection-invalid', sessionId: 'damaged' }]);
  });
});
