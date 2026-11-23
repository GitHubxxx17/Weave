import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  agentTaskFactDigest,
  createInMemorySessionEventStore,
  createSqliteSessionEventStore,
  type AgentTaskAccepted,
  type NewSessionEvent,
  type SessionEventStore,
} from '@weave/session';
import {
  agentTaskExecutionIdentity,
  agentTaskExecutionInput,
  agentTaskOrigin,
  agentTaskRequestDigest,
  createAgentExecutionService,
  createAgentTaskService,
  getBoundTaskExecutionPort,
} from '../src/index.js';

type ChildStage = 'missing' | 'created' | 'queued' | 'running' | 'terminal' | 'wrong-origin';

async function seed(store: SessionEventStore, stage: ChildStage, cancel = false) {
  const request = { title: 'Review', prompt: 'Review the patch', access: 'read-only' } as const;
  const taskId = randomUUID();
  const task: AgentTaskAccepted = {
    version: 1,
    taskId,
    rootSessionId: `root-${taskId}`,
    parentSessionId: `root-${taskId}`,
    parentExecutionId: 'parent-exec',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'spawn-call',
    childSessionId: randomUUID(),
    childExecutionId: randomUUID(),
    childTurnId: randomUUID(),
    childUserMessageId: randomUUID(),
    requestId: `agent-task:${taskId}`,
    requestDigest: agentTaskRequestDigest(request),
    depth: 1,
    ...request,
    settings: {
      provider: 'mock',
      model: 'test',
      permissionMode: 'ask',
      useProviderDefaults: false,
    },
    tools: [],
    project: { projectId: 'project', folderRevision: 0 },
  };
  const input = agentTaskExecutionInput(task);
  const parent = await store.append(task.rootSessionId, [
    { type: 'session.created', payload: {} },
    {
      type: 'execution.accepted',
      payload: {
        executionId: task.parentExecutionId,
        turnId: task.parentTurnId,
        userMessageId: 'parent-message',
        requestId: 'parent-request',
        requestDigest: agentTaskFactDigest(input),
        input,
      },
    },
    {
      type: 'message.created',
      payload: { messageId: 'parent-message', message: input.userMessage },
    },
    {
      type: 'turn.started',
      payload: {
        executionId: task.parentExecutionId,
        turnId: task.parentTurnId,
        userMessageId: 'parent-message',
      },
    },
    {
      type: 'step.started',
      payload: { turnId: task.parentTurnId, stepId: 'tool-step', kind: 'tool' },
    },
    {
      type: 'tool-call.created',
      payload: {
        turnId: task.parentTurnId,
        stepId: 'tool-step',
        toolCall: {
          id: task.parentToolCallId,
          name: 'agent_spawn',
          arguments: JSON.stringify(request),
        },
      },
    },
    { type: 'agent.task.accepted', payload: task },
  ]);
  if (cancel)
    await store.append(task.rootSessionId, [
      {
        type: 'agent.task.cancel-requested',
        payload: { version: 1, taskId, operationId: 'parent-stop', reason: 'parent-stop' },
      },
      {
        type: 'agent.task.cancel-requested',
        payload: { version: 1, taskId, operationId: 'shutdown', reason: 'shutdown' },
      },
    ]);
  if (stage === 'missing') return task;
  const sequence = parent.at(-1)!.sequence;
  const { sessionId, ...identity } = agentTaskExecutionIdentity(task);
  const events: NewSessionEvent[] = [
    { type: 'session.created', payload: { title: task.title } },
    {
      type: 'agent.task.origin',
      payload: agentTaskOrigin(task, stage === 'wrong-origin' ? sequence + 1 : sequence),
    },
  ];
  if (stage !== 'created' && stage !== 'wrong-origin') {
    events.push({
      type: 'execution.accepted',
      payload: {
        ...identity,
        dispatch: 'queued',
        requestDigest: agentTaskFactDigest(input),
        input,
        runInput: input,
      },
    });
    if (stage !== 'queued')
      events.push(
        { type: 'execution.claimed', payload: { executionId: task.childExecutionId } },
        {
          type: 'message.created',
          payload: { messageId: task.childUserMessageId, message: input.userMessage },
        },
        {
          type: 'turn.started',
          payload: {
            executionId: task.childExecutionId,
            turnId: task.childTurnId,
            userMessageId: task.childUserMessageId,
          },
        },
        {
          type: 'message.created',
          payload: {
            messageId: 'partial-message',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Durable answer' }] },
          },
        },
      );
    if (stage === 'terminal')
      events.push(
        { type: 'turn.completed', payload: { turnId: task.childTurnId, status: 'completed' } },
        {
          type: 'execution.finished',
          payload: { executionId: task.childExecutionId, status: 'completed' },
        },
      );
  }
  await store.append(sessionId, events);
  return task;
}

function runtime(
  store: SessionEventStore,
  unattached: readonly AgentTaskAccepted[] = [],
  tombstonedChildId?: string,
) {
  const run = vi.fn(() => {
    throw new Error('Recovery never runs a Provider');
  });
  const reserve = vi.fn(async () => {
    throw new Error('Recovery never retains a Generation');
  });
  const execution = createAgentExecutionService({
    sessionStore: store,
    runner: { run },
    admit: async () => {},
  });
  const tasks = createAgentTaskService({
    sessionStore: store,
    execution: getBoundTaskExecutionPort(execution),
    host: {
      reserve,
      projectRelation: async (task) => {
        if (task.childSessionId === tombstonedChildId) return 'tombstoned';
        return unattached.some(({ taskId }) => taskId === task.taskId) ? 'unattached' : 'attached';
      },
    },
  });
  return { tasks, execution, run, reserve };
}

describe('Agent task cold recovery', () => {
  it('recovers a confirmed stop batch before any per-task intent was written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-cold-task-stop-'));
    const filename = join(directory, 'sessions.sqlite');
    const before = createSqliteSessionEventStore({ filename });
    try {
      const task = await seed(before, 'created');
      await before.append(task.rootSessionId, [
        {
          type: 'agent.tasks.stop-requested',
          payload: { version: 1, operationId: 'stop-first', taskIds: [task.taskId] },
        },
      ]);
      await before.append(task.rootSessionId, [
        {
          type: 'agent.tasks.stop-requested',
          payload: { version: 1, operationId: 'stop-second', taskIds: [task.taskId] },
        },
      ]);
      await before.close();
      const store = createSqliteSessionEventStore({ filename });
      try {
        const { tasks, execution, reserve, run } = runtime(store, [task]);
        await tasks.recover([task.rootSessionId], (ids) => execution.recover(ids));
        const [recovered] = tasks.snapshot(task.rootSessionId);
        expect(recovered).toMatchObject({
          taskId: task.taskId,
          status: 'cancelled',
          reason: 'task-cancelled',
        });
        expect(await tasks.stopAll(task.rootSessionId, 'stop-second')).toEqual([recovered]);
        expect(
          (await store.read(task.rootSessionId)).filter(
            ({ type }) => type === 'agent.task.cancel-requested',
          ),
        ).toMatchObject([
          { payload: { taskId: task.taskId, operationId: 'stop-first', reason: 'task-cancelled' } },
        ]);
        expect(reserve).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
      } finally {
        await store.close();
      }
    } finally {
      await before.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('indexes discovered children before execution repair and settles exact facts across a SQLite restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-cold-tasks-'));
    const filename = join(directory, 'sessions.sqlite');
    const before = createSqliteSessionEventStore({ filename });
    try {
      const missing = await seed(before, 'missing');
      const created = await seed(before, 'created', true);
      const queued = await seed(before, 'queued');
      const running = await seed(before, 'running');
      const terminal = await seed(before, 'terminal', true);
      const foreign = await seed(before, 'wrong-origin');
      const all = [missing, created, queued, running, terminal, foreign];
      await before.close();
      const store = createSqliteSessionEventStore({ filename });
      try {
        const { tasks, execution, reserve, run } = runtime(store, [missing, created]);
        const recovered: string[] = [];
        await tasks.recover(
          [
            ...all.map(({ rootSessionId }) => rootSessionId),
            running.childSessionId,
            foreign.childSessionId,
          ],
          async (ids) => {
            expect(
              all.every(({ rootSessionId }) => tasks.snapshot(rootSessionId).length === 1),
            ).toBe(true);
            recovered.push(...ids);
            await execution.recover(ids);
          },
        );
        expect(recovered).toContain(running.childSessionId);
        expect(recovered).not.toContain(foreign.childSessionId);
        expect(tasks.snapshot(missing.rootSessionId)[0]).toMatchObject({
          status: 'interrupted',
          reason: 'preparation-interrupted',
        });
        expect(tasks.snapshot(created.rootSessionId)[0]).toMatchObject({
          status: 'cancelled',
          reason: 'parent-stop',
        });
        expect(tasks.snapshot(queued.rootSessionId)[0]).toMatchObject({
          status: 'interrupted',
          reason: 'child-interrupted',
        });
        expect(tasks.snapshot(running.rootSessionId)[0]).toMatchObject({
          status: 'interrupted',
          resultKind: 'partial',
          preview: 'Durable answer',
        });
        expect(tasks.snapshot(terminal.rootSessionId)[0]).toMatchObject({
          status: 'completed',
          resultKind: 'final-answer',
        });
        expect(tasks.snapshot(foreign.rootSessionId)[0]).toMatchObject({ status: 'blocked' });
        expect((await store.read(created.childSessionId)).map(({ type }) => type)).toEqual([
          'session.created',
          'agent.task.origin',
        ]);
        expect(reserve).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        await expect(
          tasks.withTaskSessionsIdle(foreign.childSessionId, async () => {}),
        ).rejects.toMatchObject({ code: 'agent-task-busy' });
        await expect(tasks.drain()).rejects.toThrow('Agent task drain is incomplete');
      } finally {
        await store.close();
      }
    } finally {
      await before.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries exact evidence and a lost recovery acknowledgement without relaunching the child', async () => {
    const actual = createInMemorySessionEventStore();
    const task = await seed(actual, 'running');
    let readUnavailable = true;
    let acknowledgementLost = true;
    const store: SessionEventStore = {
      ...actual,
      async read(id, options) {
        if (id === task.childSessionId && readUnavailable) throw new Error('Child unavailable');
        return actual.read(id, options);
      },
    };
    const { tasks, execution, reserve, run } = runtime(store);
    await tasks.recover([task.childSessionId, task.rootSessionId], async (ids) => {
      await execution.recover(ids);
      if (ids.includes(task.childSessionId) && acknowledgementLost) {
        acknowledgementLost = false;
        throw new Error('Execution recovery acknowledgement lost');
      }
    });
    expect(tasks.snapshot(task.rootSessionId)[0]?.status).toBe('blocked');
    readUnavailable = false;
    await tasks.retry();
    expect(tasks.snapshot(task.rootSessionId)[0]?.status).toBe('blocked');
    await tasks.retry();
    expect(tasks.snapshot(task.rootSessionId)[0]?.status).toBe('interrupted');
    expect(
      (await actual.read(task.childSessionId)).filter(({ type }) => type === 'execution.finished'),
    ).toHaveLength(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('hydrates a verified settled result on restart after the child is tombstoned', async () => {
    const store = createInMemorySessionEventStore();
    const task = await seed(store, 'terminal');
    const first = runtime(store);
    await first.tasks.recover([task.rootSessionId], (ids) => first.execution.recover(ids));
    const [result] = first.tasks.snapshot(task.rootSessionId);
    expect(result).toMatchObject({ status: 'completed', resultKind: 'final-answer' });
    await first.tasks.withTaskSessionsIdle(task.childSessionId, async () => {
      await store.append(task.childSessionId, [{ type: 'session.deleted', payload: {} }]);
    });
    const reopened = runtime(store, [], task.childSessionId);
    await reopened.tasks.recover([task.rootSessionId], (ids) => reopened.execution.recover(ids));
    expect(reopened.tasks.snapshot(task.rootSessionId)).toEqual([result]);
    expect(
      (await store.read(task.rootSessionId)).filter(({ type }) => type === 'agent.task.settled'),
    ).toHaveLength(1);
  });

  it('fails startup before execution recovery when a root prefix is unavailable', async () => {
    const actual = createInMemorySessionEventStore();
    const task = await seed(actual, 'missing');
    const { tasks } = runtime({
      ...actual,
      async read(id, options) {
        if (id === task.rootSessionId) throw new Error('Root unavailable');
        return actual.read(id, options);
      },
    });
    const recoverExecutions = vi.fn(async () => {});
    await expect(tasks.recover([task.rootSessionId], recoverExecutions)).rejects.toMatchObject({
      code: 'agent-task-persistence-error',
    });
    expect(recoverExecutions).not.toHaveBeenCalled();
  });
});
