import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmProviderRegistry } from '@weave/llm';
import type { KernelPlugin } from '@weave/plugin';
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
import { createExtensionCoordinator } from '../src/extension-coordinator.js';
import type { ExtensionIdentity, ExtensionSourceSnapshot } from '../src/extension-types.js';
import { createProjectFolderAuthority } from '../src/project-folder-authority.js';
import {
  assembleServerGeneration,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
} from '../src/runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  { revoke: 'immediate withdrawal', reason: 'generation-revoked' },
  { revoke: 'retired managed ownership loss', reason: 'ownership-lost' },
] as const)('settles a running child with $reason after $revoke', async ({ revoke, reason }) => {
  const folderPath = await mkdtemp(join(tmpdir(), 'weave-task-revocation-'));
  const finishProvider = deferred();
  const registry = createLlmProviderRegistry();
  const childPrompt = 'Check the running child';
  let parentCalls = 0;
  let childSignal: AbortSignal | undefined;
  let providerStarted = false;
  let providerCleaning = false;
  registry.register({
    id: 'test',
    label: 'Test',
    type: 'mock',
    client: {
      async *stream(request, options) {
        const isChild = request.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content.some((part) => part.type === 'text' && part.text === childPrompt),
        );
        if (isChild) {
          const signal = options?.signal;
          if (signal === undefined) throw new Error('Missing child provider abort signal');
          childSignal = signal;
          try {
            yield { type: 'text-delta', text: 'Work started' };
            providerStarted = true;
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            providerCleaning = true;
            await finishProvider.promise;
          }
        } else if (parentCalls++ === 0) {
          yield { type: 'tool-call-start', id: 'spawn', name: 'agent_spawn' };
          yield {
            type: 'tool-call-delta',
            id: 'spawn',
            argumentsDelta: JSON.stringify({ title: 'Check', prompt: childPrompt }),
          };
          yield { type: 'finish', reason: 'tool-call' };
        } else {
          yield { type: 'text-delta', text: 'Parent finished' };
          yield { type: 'finish', reason: 'stop' };
        }
      },
    },
  });
  const runtime = createServerRuntime({
    providerSettings: { registry, providers: registry.list(), defaultProvider: 'test' },
  });
  const projects = createInMemoryProjectStore();
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
  const identity: ExtensionIdentity = {
    pluginId: 'managed-test',
    identity: 'first',
    origin: 'managed',
  };
  const plugin: KernelPlugin = {
    manifest: {
      id: identity.pluginId,
      name: 'Managed Test',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'],
      contributes: {},
    },
    setup() {},
    dispose: vi.fn(async () => {}),
  };
  let authority: ExtensionSourceSnapshot = {
    stamp: { revision: 1, trustSequence: 1 },
    eligible: [identity],
  };
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    assemble: (kernelPlugins) =>
      assembleServerGeneration(runtime, { ...runnerOptions, kernelPlugins }),
    sources: [
      () => ({
        id: 'managed',
        snapshot: () => authority,
        async refresh() {},
        async prepare(stamp) {
          return {
            stamp,
            items: authority.eligible.map((item) => ({ ...item, plugin, dispose: async () => {} })),
            failures: [],
            async recheck() {
              return authority.stamp.revision === stamp.revision;
            },
            async dispose() {},
          };
        },
        async close() {},
      }),
    ],
  });
  try {
    const loaded = await coordinator.reload();
    expect(loaded.members.map(({ pluginId }) => pluginId)).toEqual([identity.pluginId]);
    const original = runtime.serverHost.controller()!.current();
    const originalRun = vi.spyOn(original.runner, 'run');
    await execution.launch('root', {
      requestId: 'parent',
      input: {
        provider: 'test',
        model: 'test',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Start a child' }] },
      },
    });
    await expect.poll(() => providerStarted).toBe(true);
    await expect.poll(async () => (await execution.list('root'))[0]?.status).toBe('completed');
    const task = tasks.snapshot('root')[0]!;
    expect(task.status).toBe('running');
    expect(
      originalRun.mock.calls.some(([request]) => request.sessionId === task.childSessionId),
    ).toBe(true);

    authority = { stamp: { revision: 2, trustSequence: 2 }, eligible: [] };
    const immediate = revoke === 'immediate withdrawal';
    coordinator.observeAuthorityBatchSync(
      new Map([
        [
          'managed',
          {
            snapshot: authority,
            affectedIds: [identity.pluginId],
            immediate,
          },
        ],
      ]),
    );
    if (!immediate) {
      const baseline = await coordinator.reload();
      expect(baseline.generation.id).toBeGreaterThan(original.id);
      expect(baseline.members).toEqual([]);
      expect(childSignal?.aborted).toBe(false);
      coordinator.blockManagedOwnershipLossSync();
      expect(coordinator.generationSnapshot().acceptingRuns).toBe(true);
    }
    await expect.poll(() => providerCleaning).toBe(true);
    await expect
      .poll(async () =>
        (await store.read('root'))
          .filter((event) => event.type === 'agent.task.cancel-requested')
          .map(({ payload }) => payload.reason),
      )
      .toEqual([reason]);
    expect((await store.read('root')).some(({ type }) => type === 'agent.task.settled')).toBe(
      false,
    );
    expect(
      (await store.read(task.childSessionId)).some(({ type }) => type === 'execution.finished'),
    ).toBe(false);
    expect(plugin.dispose).not.toHaveBeenCalled();
    finishProvider.resolve();
    await expect
      .poll(() => tasks.snapshot('root')[0])
      .toMatchObject({ status: 'cancelled', reason });
    expect(
      (await store.read('root')).find(({ type }) => type === 'agent.task.settled'),
    ).toMatchObject({
      payload: { settlement: { phase: 'execution', status: 'cancelled', reason } },
    });
    expect(
      (await store.read(task.childSessionId)).find(({ type }) => type === 'execution.finished'),
    ).toMatchObject({
      payload: { status: 'cancelled' },
    });
    if (!immediate) await expect.poll(() => vi.mocked(plugin.dispose!).mock.calls.length).toBe(1);
  } finally {
    finishProvider.resolve();
    tasks.closeSync();
    await tasks.drain();
    execution.closeSync();
    await execution.drain();
    folders.closeSync();
    await coordinator.dispose();
    await disposeServerPlugins(runtime);
    await runtime.stop();
    await projects.close();
    await rm(folderPath, { recursive: true, force: true });
  }
});
