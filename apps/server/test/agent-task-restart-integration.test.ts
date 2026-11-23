import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  agentTaskExecutionIdentity,
  agentTaskExecutionInput,
  agentTaskOrigin,
  agentTaskRequestDigest,
} from '@weave/runtime';
import {
  agentTaskFactDigest,
  createSqliteSessionEventStore,
  type AgentTaskAccepted,
  type NewSessionEvent,
} from '@weave/session';
import { createSqliteProjectStore } from '@weave/workspace';
import { startServer } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';

async function seedRestartPrefixes(filename: string) {
  const store = createSqliteSessionEventStore({ filename });
  const projects = createSqliteProjectStore({ filename });
  const root = randomUUID();
  const stages = ['missing', 'unattached', 'queued', 'running'] as const;
  try {
    const project = await projects.createProject({ name: 'Recovery', folderName: 'recovery' });
    const tasks = stages.map((stage): AgentTaskAccepted => {
      const taskId = randomUUID();
      const request = { title: stage, prompt: `Review ${stage}`, access: 'read-only' } as const;
      return {
        version: 1,
        taskId,
        rootSessionId: root,
        parentSessionId: root,
        parentExecutionId: 'parent-execution',
        parentTurnId: 'parent-turn',
        parentToolCallId: `spawn-${stage}`,
        childSessionId: randomUUID(),
        childExecutionId: randomUUID(),
        childTurnId: randomUUID(),
        childUserMessageId: randomUUID(),
        requestId: `agent-task:${taskId}`,
        requestDigest: agentTaskRequestDigest(request),
        depth: 1,
        ...request,
        settings: {
          provider: 'fixture',
          model: 'fixture',
          permissionMode: 'ask',
          useProviderDefaults: false,
        },
        tools: [],
        project: { projectId: project.id, folderRevision: project.folderRevision },
      };
    });
    const parentInput = agentTaskExecutionInput(tasks[0]!);
    await store.append(root, [
      { type: 'session.created', payload: { title: 'Parent' } },
      {
        type: 'execution.accepted',
        payload: {
          executionId: 'parent-execution',
          turnId: 'parent-turn',
          userMessageId: 'parent-message',
          requestId: 'parent-request',
          requestDigest: agentTaskFactDigest(parentInput),
          input: parentInput,
        },
      },
      {
        type: 'message.created',
        payload: { messageId: 'parent-message', message: parentInput.userMessage },
      },
      {
        type: 'turn.started',
        payload: {
          executionId: 'parent-execution',
          turnId: 'parent-turn',
          userMessageId: 'parent-message',
        },
      },
      {
        type: 'step.started',
        payload: { turnId: 'parent-turn', stepId: 'tool-step', kind: 'tool' },
      },
    ]);
    await projects.attachSession(project.id, root);

    for (const [index, task] of tasks.entries()) {
      const stage = stages[index];
      const [, acceptance] = await store.append(root, [
        {
          type: 'tool-call.created',
          payload: {
            turnId: task.parentTurnId,
            stepId: 'tool-step',
            toolCall: {
              id: task.parentToolCallId,
              name: 'agent_spawn',
              arguments: JSON.stringify({
                title: task.title,
                prompt: task.prompt,
                access: task.access,
              }),
            },
          },
        },
        { type: 'agent.task.accepted', payload: task },
      ]);
      if (stage === 'missing') continue;
      const events: NewSessionEvent[] = [
        { type: 'session.created', payload: { title: task.title } },
        { type: 'agent.task.origin', payload: agentTaskOrigin(task, acceptance!.sequence) },
      ];
      if (stage === 'unattached') {
        await store.append(task.childSessionId, events);
        await store.append(root, [
          {
            type: 'agent.task.cancel-requested',
            payload: {
              version: 1,
              taskId: task.taskId,
              operationId: 'parent-stop',
              reason: 'parent-stop',
            },
          },
        ]);
        continue;
      }
      const { sessionId, ...identity } = agentTaskExecutionIdentity(task);
      const input = agentTaskExecutionInput(task);
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
      if (stage === 'running')
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
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Durable partial answer' }],
              },
            },
          },
        );
      await store.append(sessionId, events);
      await projects.attachSession(project.id, sessionId);
    }
    return { root, projectId: project.id, tasks };
  } finally {
    await store.close();
    await projects.close();
  }
}

it('recovers attached and unattached task prefixes before listening and never resumes model work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-task-restart-'));
  const databaseFile = join(directory, 'state.db');
  const providerFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('Cold recovery must never call the provider');
  });
  const options = {
    databaseFile,
    pluginsDirectory: false as const,
    skillsDirectory: false as const,
    fetch: providerFetch,
    environment: {
      WEAVE_LLM_PROVIDERS: JSON.stringify([
        {
          id: 'fixture',
          label: 'Recovery fixture',
          type: 'openai-compatible',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-only',
          defaultModel: 'fixture',
        },
      ]),
    },
  };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const {
      root,
      projectId,
      tasks: [missing, unattached, queued, running],
    } = await seedRestartPrefixes(databaseFile);
    const ids = [
      root,
      missing!.childSessionId,
      unattached!.childSessionId,
      queued!.childSessionId,
      running!.childSessionId,
    ];
    const read = (path: string) => fetch(`http://127.0.0.1:${server!.port}${path}`);
    const readLogs = () => {
      const store = getServerSessionStore(server!.runtime);
      return Promise.all(ids.map((id) => store.read(id)));
    };
    server = await startServer(0, options);
    const response = await read(`/sessions/${root}/tasks`);
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first).toMatchObject({
      rootSessionId: root,
      totalCount: 4,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          taskId: missing!.taskId,
          status: 'interrupted',
          reason: 'preparation-interrupted',
          resultKind: 'none',
        }),
        expect.objectContaining({
          taskId: unattached!.taskId,
          status: 'cancelled',
          reason: 'parent-stop',
          resultKind: 'none',
        }),
        expect.objectContaining({
          taskId: queued!.taskId,
          status: 'interrupted',
          reason: 'child-interrupted',
          resultKind: 'none',
        }),
        expect.objectContaining({
          taskId: running!.taskId,
          status: 'interrupted',
          reason: 'child-interrupted',
          resultKind: 'partial',
          preview: 'Durable partial answer',
          result: expect.objectContaining({
            messageId: 'partial-message',
            sessionId: running!.childSessionId,
          }),
        }),
      ]),
    });
    const logs = await readLogs();
    const [parent, missingLog, unattachedLog, queuedLog, runningLog] = logs;
    expect(parent!.filter(({ type }) => type === 'agent.task.accepted')).toHaveLength(4);
    expect(parent!.filter(({ type }) => type === 'agent.task.dispatched')).toHaveLength(2);
    expect(parent!.filter(({ type }) => type === 'agent.task.settled')).toHaveLength(4);
    expect(missingLog).toEqual([]);
    expect(unattachedLog!.map(({ type }) => type)).toEqual([
      'session.created',
      'agent.task.origin',
    ]);
    expect(queuedLog!.map(({ type }) => type)).toEqual([
      'session.created',
      'agent.task.origin',
      'execution.accepted',
      'execution.finished',
    ]);
    for (const child of [queuedLog!, runningLog!]) {
      expect(child.filter(({ type }) => type === 'execution.accepted')).toHaveLength(1);
      expect(child.filter(({ type }) => type === 'agent.task.origin')).toHaveLength(1);
      expect(child.at(-1)).toMatchObject({
        type: 'execution.finished',
        payload: { status: 'interrupted', reason: 'server-restarted' },
      });
    }
    expect(runningLog!.filter(({ type }) => type === 'turn.started')).toHaveLength(1);
    const projects = await read('/projects');
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({
      projects: [
        {
          id: projectId,
          sessions: expect.arrayContaining([
            expect.objectContaining({ id: root, title: 'Parent', lastSequence: parent!.length }),
          ]),
        },
      ],
    });
    const projectStore = createSqliteProjectStore({ filename: databaseFile });
    try {
      expect(
        (await projectStore.listSessionRefs(projectId)).map(({ sessionId }) => sessionId).sort(),
      ).toEqual([root, queued!.childSessionId, running!.childSessionId].sort());
    } finally {
      await projectStore.close();
    }
    const blocked = await fetch(
      `http://127.0.0.1:${server.port}/sessions/${running!.childSessionId}/executions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: 'manual-child-retry',
          input: agentTaskExecutionInput(running!),
        }),
      },
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: 'execution-task-session-read-only' },
    });
    expect(providerFetch).not.toHaveBeenCalled();

    await server.stop();
    server = undefined;
    server = await startServer(0, options);
    const reopened = await read(`/sessions/${root}/tasks`);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ tasks: first.tasks });
    expect(await readLogs()).toEqual(logs);
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
