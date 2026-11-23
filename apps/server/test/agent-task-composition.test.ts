import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSessionEventStore } from '@weave/session';
import { createLlmProviderRegistry } from '@weave/llm';
import { agentTaskSpawnInputSchema } from '@weave/protocol';
import {
  createAgentExecutionService,
  createAgentTaskService,
  getBoundTaskExecutionPort,
} from '@weave/runtime';
import { createInMemoryProjectStore, createSqliteProjectStore } from '@weave/workspace';
import { expect, it, vi } from 'vitest';
import { createAgentTaskHost } from '../src/agent-task-composition.js';
import { createAgentTaskWorkspaceBindings } from '../src/agent-task-workspace.js';
import { createSessionService } from '../src/session-service.js';
import { createProjectFolderAuthority } from '../src/project-folder-authority.js';
import {
  assembleServerGeneration,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
  replaceServerGeneration,
} from '../src/runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  { storage: 'memory', action: 'reload' },
  { storage: 'sqlite', action: 'reload' },
  { storage: 'memory', action: 'cancel' },
  { storage: 'sqlite', action: 'folder' },
  { storage: 'memory', action: 'revoke' },
  { storage: 'memory', action: 'incarnation' },
  { storage: 'memory', action: 'provider-update' },
  { storage: 'memory', action: 'provider-delete' },
  { storage: 'sqlite', action: 'provider-readd' },
] as const)(
  'materializes or fences a native child in $storage after $action',
  async ({ storage, action }) => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-task-host-'));
    const filename = join(directory, 'state.db');
    const registry = createLlmProviderRegistry();
    const childStarted = deferred();
    const finishChild = deferred();
    const createEntered = deferred();
    const allowCreate = deferred();
    const childRequests: string[] = [];
    let parentCalls = 0;
    registry.register({
      id: 'test',
      label: 'Test',
      type: 'mock',
      client: {
        async *stream(request) {
          const text = JSON.stringify(request.messages);
          if (
            request.messages.some(
              (message) =>
                message.role === 'user' &&
                message.content.some(
                  (part) => part.type === 'text' && part.text === 'Review the child patch.',
                ),
            )
          ) {
            childRequests.push(text);
            expect(request.tools?.some((tool) => tool.name === 'agent_spawn')).toBe(false);
            childStarted.resolve();
            await finishChild.promise;
            yield { type: 'text-delta', text: 'Child complete.' };
            yield { type: 'finish', reason: 'stop' };
          } else if (parentCalls++ === 0) {
            yield { type: 'tool-call-start', id: 'spawn', name: 'agent_spawn' };
            yield {
              type: 'tool-call-delta',
              id: 'spawn',
              argumentsDelta: JSON.stringify({
                title: 'Review',
                prompt: 'Review the child patch.',
              }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            yield { type: 'text-delta', text: 'Parent continues.' };
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
    const runtime = createServerRuntime({
      ...(storage === 'sqlite'
        ? { sessionStoreFactory: () => createSqliteSessionEventStore({ filename }) }
        : {}),
      providerSettings: { registry, providers: registry.list(), defaultProvider: 'test' },
    });
    const projects =
      storage === 'sqlite' ? createSqliteProjectStore({ filename }) : createInMemoryProjectStore();
    const folderPath = join(directory, 'project');
    await mkdir(folderPath);
    const project = await projects.createProject({ name: 'Test', folderName: 'test', folderPath });
    const folders = createProjectFolderAuthority(projects);
    const workspace = createAgentTaskWorkspaceBindings(folders);
    await runtime.start();
    const store = getServerSessionStore(runtime);
    await store.append('root', [{ type: 'session.created', payload: {} }]);
    await projects.attachSession(project.id, 'root');
    runtime.serverHost.hostTools().register({
      name: 'agent_spawn',
      description: 'Starts an independent task',
      parameters: {},
      inputSchema: agentTaskSpawnInputSchema,
      execute: async (input, context) => JSON.stringify(await tasks.spawn(input, context)),
    });
    const runnerOptions = { agentTaskWorkspace: workspace, skillsDirectory: false as const };
    const runner = await createServerAgentRunner(runtime, runnerOptions);
    const original = runtime.serverHost.controller()!.current();
    const originalRun = vi.spyOn(original.runner, 'run');
    const execution = createAgentExecutionService({
      runner,
      sessionStore: store,
      admit: async () => {},
    });
    const host = createAgentTaskHost({
      sessionStore: store,
      projectStore: projects,
      projectFolders: folders,
      workspace,
    });
    const tasks = createAgentTaskService({
      sessionStore: store,
      execution: getBoundTaskExecutionPort(execution),
      host: {
        ...host,
        async reserve(input) {
          const reservation = await host.reserve(input);
          return {
            ...reservation,
            async createExact(...args) {
              createEntered.resolve();
              await allowCreate.promise;
              return reservation.createExact(...args);
            },
          };
        },
      },
    });
    try {
      await execution.launch('root', {
        requestId: 'parent',
        input: {
          provider: 'test',
          model: 'test',
          permissionMode: 'ask',
          temperature: 0.2,
          maxTokens: 128,
          userMessage: { role: 'user', content: [{ type: 'text', text: 'Delegate a review.' }] },
        },
      });
      await createEntered.promise;
      await expect.poll(() => tasks.snapshot('root').length).toBe(1);
      expect(tasks.snapshot('root')[0]!.status).toBe('preparing');
      const accepted = (await store.read('root')).find(
        (event) => event.type === 'agent.task.accepted',
      );
      if (accepted?.type !== 'agent.task.accepted') throw new Error('Missing task');
      await expect.poll(async () => (await execution.list('root'))[0]?.status).toBe('completed');
      if (!['reload', 'provider-update', 'provider-delete', 'provider-readd'].includes(action)) {
        if (action === 'cancel')
          await tasks.requestCancel('root', [accepted.payload.taskId], 'cancel', 'task-cancelled');
        if (action === 'folder') await folders.updateFolder(project.id, undefined);
        if (action === 'revoke')
          runtime.serverHost.controller()!.closeRetainedStarts(original, new Error('revoked'));
        let replaced = false;
        if (action === 'incarnation') {
          const read = store.read.bind(store);
          vi.spyOn(store, 'read').mockImplementation(async (sessionId) => {
            const events = await read(sessionId);
            if (sessionId === accepted.payload.childSessionId && !replaced) {
              replaced = true;
              await rename(folderPath, `${folderPath}-old`);
              await mkdir(folderPath);
            }
            return events;
          });
        }
        allowCreate.resolve();
        await expect.poll(() => tasks.snapshot('root')[0]?.status).toBe('cancelled');
        expect(tasks.snapshot('root')[0]?.reason).toBe(
          action === 'revoke'
            ? 'generation-revoked'
            : action === 'folder' || action === 'incarnation'
              ? 'workspace-changed'
              : 'task-cancelled',
        );
        expect(await store.read(accepted.payload.childSessionId)).toHaveLength(0);
        if (action === 'incarnation') expect(replaced).toBe(true);
        expect(childRequests).toHaveLength(0);
        return;
      }
      const updatedStream = vi.fn(async function* (request) {
        expect(request.model).toBe('test');
        expect(request.temperature).toBe(0.2);
        expect(request.maxTokens).toBe(128);
        yield { type: 'text-delta' as const, text: 'Updated host connection.' };
        yield { type: 'finish' as const, reason: 'stop' as const };
      });
      if (action === 'reload') {
        await replaceServerGeneration(
          runtime,
          await assembleServerGeneration(runtime, runnerOptions),
        );
        expect(runtime.serverHost.controller()!.current()).not.toBe(original);
      } else if (action === 'provider-update') {
        registry.replace({
          id: 'test',
          label: 'Updated',
          type: 'mock',
          client: { stream: updatedStream },
          defaultModel: 'changed',
          temperature: 1.5,
          maxTokens: 2048,
        });
      } else {
        registry.remove('test');
        if (action === 'provider-readd')
          registry.register({
            id: 'test',
            label: 'Readded',
            type: 'mock',
            client: { stream: updatedStream },
            defaultModel: 'changed',
            temperature: 1.5,
            maxTokens: 2048,
          });
      }
      allowCreate.resolve();
      if (action !== 'reload') {
        await expect
          .poll(() => tasks.snapshot('root')[0]?.status)
          .toBe(action === 'provider-delete' ? 'failed' : 'completed');
        expect(childRequests).toHaveLength(0);
        expect(updatedStream).toHaveBeenCalledTimes(action === 'provider-delete' ? 0 : 1);
        const events = await store.read(accepted.payload.childSessionId);
        expect(events.filter((event) => event.type === 'execution.accepted')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'execution.finished')).toHaveLength(1);
        return;
      }
      await childStarted.promise;
      expect(
        originalRun.mock.calls.some(
          ([request]) => request.sessionId === accepted.payload.childSessionId,
        ),
      ).toBe(true);
      expect(
        (await store.read(accepted.payload.childSessionId)).slice(0, 2).map((event) => event.type),
      ).toEqual(['session.created', 'agent.task.origin']);
      const detail = await createSessionService({
        projectStore: projects,
        sessionStore: store,
      }).get(accepted.payload.childSessionId);
      expect(detail.taskOrigin).toEqual({
        taskId: accepted.payload.taskId,
        rootSessionId: 'root',
        parentSessionId: 'root',
      });
      expect(
        (await projects.listSessionRefs(project.id)).some(
          (ref) => ref.sessionId === accepted.payload.childSessionId,
        ),
      ).toBe(true);
      finishChild.resolve();
      await expect.poll(() => tasks.snapshot('root')[0]?.status).toBe('completed');
      expect(childRequests).toHaveLength(1);
      await expect(
        execution.launch(accepted.payload.childSessionId, {
          requestId: 'again',
          input: {
            provider: 'test',
            model: 'test',
            permissionMode: 'ask',
            userMessage: { role: 'user', content: [{ type: 'text', text: 'Again' }] },
          },
        }),
      ).rejects.toMatchObject({ code: 'execution-task-session-read-only' });
    } finally {
      allowCreate.resolve();
      finishChild.resolve();
      tasks.closeSync();
      await tasks.drain();
      execution.closeSync();
      await execution.drain();
      folders.closeSync();
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await projects.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
