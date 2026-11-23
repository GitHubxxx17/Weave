import { AsyncLocalStorage } from 'node:async_hooks';
import { createLlmProviderRegistry } from '@weave/llm';
import { agentTaskSpawnInputSchema } from '@weave/protocol';
import {
  createAgentExecutionService,
  createAgentTaskService,
  getBoundTaskExecutionPort,
} from '@weave/runtime';
import { createInMemoryProjectStore } from '@weave/workspace';
import { expect, it, vi } from 'vitest';
import { createAgentTaskHost } from '../src/agent-task-composition.js';
import { createAgentTaskWorkspaceBindings } from '../src/agent-task-workspace.js';
import { ManagedGenerationOwnershipError } from '../src/extension-authority-errors.js';
import { createProjectFolderAuthority } from '../src/project-folder-authority.js';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
} from '../src/runtime.js';

it.each([
  ['immediate', 'Project admission'],
  ['immediate', 'Runner Session read'],
  ['ordinary', 'Project admission'],
  ['ordinary', 'Runner Session read'],
  ['ordinary', 'Turn append acknowledgement'],
  ['ordinary', 'Provider stream'],
  ['ownership loss', 'Generation guard'],
] as const)(
  'settles %s Generation withdrawal during %s and disposes cleanly',
  async (withdrawal, boundary) => {
    const childPrompt = 'Review the child patch.';
    const root = 'root';
    const entered = Promise.withResolvers<string>();
    const proceed = Promise.withResolvers<void>();
    const childCalls = vi.fn();
    let rootCalls = 0;
    const registry = createLlmProviderRegistry();
    registry.register({
      id: 'test',
      label: 'Test',
      type: 'mock',
      client: {
        async *stream({ messages }) {
          if (
            messages.some(
              ({ role, content }) =>
                role === 'user' &&
                content.some((part) => part.type === 'text' && part.text === childPrompt),
            )
          ) {
            childCalls();
            if (boundary === 'Provider stream') {
              const childSessionId = runnerSession.getStore();
              if (childSessionId === undefined) throw new Error('Missing child Runner context');
              await holdChild(childSessionId);
            }
          } else if (rootCalls++ === 0) {
            yield { type: 'tool-call-start', id: 'spawn', name: 'agent_spawn' };
            yield {
              type: 'tool-call-delta',
              id: 'spawn',
              argumentsDelta: JSON.stringify({ title: 'Review', prompt: childPrompt }),
            };
            yield { type: 'finish', reason: 'tool-call' };
            return;
          }
          yield { type: 'text-delta', text: 'Done.' };
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const runtime = createServerRuntime({
      providerSettings: { registry, providers: registry.list(), defaultProvider: 'test' },
    });
    const projects = createInMemoryProjectStore();
    const project = await projects.createProject({ name: 'Test', folderName: 'test' });
    await projects.attachSession(project.id, root);
    const folders = createProjectFolderAuthority(projects);
    const workspace = createAgentTaskWorkspaceBindings(folders);
    const runnerSession = new AsyncLocalStorage<string>();
    let held = false;
    async function holdChild(sessionId: string): Promise<void> {
      if (held || sessionId === root) return;
      held = true;
      entered.resolve(sessionId);
      await proceed.promise;
    }
    if (boundary === 'Project admission') {
      const resolveRoot = workspace.resolveRoot;
      vi.spyOn(workspace, 'resolveRoot').mockImplementation(async (sessionId, authority) => {
        await holdChild(sessionId);
        return resolveRoot(sessionId, authority);
      });
    }
    await runtime.start();
    const store = getServerSessionStore(runtime);
    await store.append(root, [{ type: 'session.created', payload: {} }]);
    runtime.serverHost.hostTools().register({
      name: 'agent_spawn',
      description: 'Starts an independent task',
      parameters: {},
      inputSchema: agentTaskSpawnInputSchema,
      execute: (input, context) => tasks.spawn(input, context),
    });
    const runner = await createServerAgentRunner(runtime, {
      agentTaskWorkspace: workspace,
      skillsDirectory: false,
    });
    const controller = runtime.serverHost.controller()!;
    const generation = controller.current();
    const guardReached = vi.fn();
    let finalAdmission = false;
    if (boundary === 'Generation guard') {
      const assertRunCurrent = workspace.assertRunCurrent;
      vi.spyOn(workspace, 'assertRunCurrent').mockImplementation((sessionId, authority) => {
        assertRunCurrent(sessionId, authority);
        if (sessionId !== root) finalAdmission = true;
      });
      Object.defineProperty(generation, 'assertCanStartSync', {
        value: () => {
          if (!finalAdmission) return;
          guardReached();
          controller.abortRetainedWorkBatch([generation], new ManagedGenerationOwnershipError());
          throw new Error('Managed Generation guard denied admission');
        },
      });
    }
    const read = store.read.bind(store);
    if (boundary !== 'Project admission') {
      const original = controller.current().runner;
      const run = original.run.bind(original);
      vi.spyOn(original, 'run').mockImplementation((request, scope) => {
        const iterator = run(request, scope)[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => runnerSession.run(request.sessionId, () => iterator.next()),
            return: () => iterator.return!(),
          }),
        };
      });
      if (boundary === 'Runner Session read' || boundary === 'Generation guard') {
        vi.spyOn(store, 'read').mockImplementation(async (sessionId, options) => {
          if (runnerSession.getStore() === sessionId) await holdChild(sessionId);
          return read(sessionId, options);
        });
      }
    }
    if (boundary === 'Turn append acknowledgement') {
      const append = store.append.bind(store);
      vi.spyOn(store, 'append').mockImplementation(async (sessionId, events) => {
        const appended = await append(sessionId, events);
        if (events.some(({ type }) => type === 'turn.started')) await holdChild(sessionId);
        return appended;
      });
    }
    const execution = createAgentExecutionService({
      runner,
      sessionStore: store,
      admit: async () => {},
    });
    const tasks = createAgentTaskService({
      sessionStore: store,
      execution: getBoundTaskExecutionPort(execution),
      host: createAgentTaskHost({
        sessionStore: store,
        projectStore: projects,
        projectFolders: folders,
        workspace,
      }),
    });
    try {
      await execution.launch(root, {
        requestId: 'parent',
        input: {
          provider: 'test',
          model: 'test',
          permissionMode: 'ask',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'Delegate a review.' }] },
        },
      });
      const child = await entered.promise;
      await expect.poll(async () => (await execution.list(root))[0]?.status).toBe('completed');
      const before = await read(child);
      const started = boundary === 'Turn append acknowledgement' || boundary === 'Provider stream';
      expect(before.some(({ type }) => type === 'execution.claimed')).toBe(true);
      expect(before.some(({ type }) => type === 'turn.started')).toBe(started);

      const reason = new Error('Generation withdrawn');
      if (withdrawal === 'immediate') controller.abortActiveRuns(reason);
      else if (withdrawal === 'ordinary') controller.closeRetainedStarts(generation, reason);
      proceed.resolve();

      const expected = started
        ? { status: 'completed' }
        : {
            status: 'cancelled',
            reason: withdrawal === 'ownership loss' ? 'ownership-lost' : 'generation-revoked',
          };
      await expect
        .poll(() => tasks.snapshot(root)[0])
        .toMatchObject({
          childSessionId: child,
          ...expected,
        });
      const events = await read(child);
      const terminal = events.find(({ type }) => type === 'execution.finished');
      expect(terminal?.payload).toMatchObject(expected);
      expect(events.some(({ type }) => type === 'turn.started')).toBe(started);
      expect(childCalls).toHaveBeenCalledTimes(started ? 1 : 0);
      expect(guardReached).toHaveBeenCalledTimes(boundary === 'Generation guard' ? 1 : 0);
    } finally {
      proceed.resolve();
      tasks.closeSync();
      await tasks.drain();
      execution.closeSync();
      await execution.drain();
      folders.closeSync();
      try {
        await disposeServerPlugins(runtime);
      } finally {
        await runtime.stop();
        await projects.close();
      }
    }
  },
);
