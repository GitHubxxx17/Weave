import { describe, expect, it } from 'vitest';
import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createSessionService } from '../src/session-service.js';
import { createServerShutdown } from '../src/server-shutdown.js';

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

describe('execution lifecycle coordination', () => {
  it.each(['archive', 'delete'] as const)(
    'checks %s under the shared idle gate before durable lifecycle mutation',
    async (operation) => {
      const store = createInMemorySessionEventStore();
      const projects = createInMemoryProjectStore();
      const project = await projects.createProject({ name: 'gate', folderName: 'gate' });
      let busy = true;
      const service = createSessionService({
        projectStore: projects,
        sessionStore: store,
        withSessionIdle: async <T>(_sessionId: string, run: () => Promise<T>) => {
          if (busy) throw new Error('execution-busy');
          return run();
        },
      } as never);
      const session = await service.create(project.id);
      try {
        await expect(service[operation](session.id)).rejects.toThrow('execution-busy');
        expect(
          (await store.read(session.id)).some(
            (event) => event.type === `session.${operation === 'archive' ? 'archived' : 'deleted'}`,
          ),
        ).toBe(false);
        busy = false;
        expect(await service[operation](session.id)).toMatchObject({ id: session.id });
      } finally {
        await projects.close();
        await store.close();
      }
    },
  );

  it('closes admission first and drains execution terminal writes before disposing Generation and stores', async () => {
    const actions: string[] = [];
    const terminal = deferred();
    const shutdown = createServerShutdown({
      resources: () =>
        ({
          agentExecutionService: {
            closeSync() {
              actions.push('close-admission');
            },
            async drain() {
              actions.push('drain-start');
              await terminal.promise;
              actions.push('terminal-written');
            },
          },
        }) as never,
      async disposeHost() {
        actions.push('dispose-host');
      },
      async stopRuntime() {
        actions.push('store-close');
      },
      closeProjectStore() {},
      closeProviderSettingsStore() {},
      closeManualTrustStore() {},
      closeMcpAuthorityStore() {},
    });
    const stopping = shutdown.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions[0]).toBe('close-admission');
    expect(actions).not.toContain('dispose-host');
    expect(actions).not.toContain('store-close');
    terminal.resolve();
    await stopping;
    expect(actions.indexOf('terminal-written')).toBeLessThan(actions.indexOf('dispose-host'));
    expect(actions.indexOf('terminal-written')).toBeLessThan(actions.indexOf('store-close'));
  });
});

it('maps a lifecycle busy claim to HTTP 409', async () => {
  const { AgentExecutionError, createRuntime } = await import('@weave/runtime');
  const { createApp } = await import('../src/app.js');
  const runtime = createRuntime();
  await runtime.start();
  const store = createInMemorySessionEventStore();
  const projects = createInMemoryProjectStore();
  const project = await projects.createProject({ name: 'busy', folderName: 'busy' });
  const service = createSessionService({
    projectStore: projects,
    sessionStore: store,
    withSessionIdle: async () => {
      throw new AgentExecutionError('execution-busy', 'Execution is active');
    },
  });
  try {
    const session = await service.create(project.id);
    const response = await createApp(runtime, { sessionService: service }).request(
      `/sessions/${session.id}/archive`,
      { method: 'POST' },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'execution-busy' } });
  } finally {
    await runtime.stop();
    await store.close();
    await projects.close();
  }
});
