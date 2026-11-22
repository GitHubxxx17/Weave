import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmProviderRegistry } from '@weave/llm';
import {
  commandsExtensionPoint,
  definePlugin,
  defineServiceRef,
  pluginEventsRef,
  sessionStoreRef,
  toolsExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';
import { createApprovalBroker, createToolRegistry } from '@weave/runtime';
import { createInMemorySessionEventStore, type SessionEventStore } from '@weave/session';
import { assembleAgentKernel } from '../src/agent-kernel.js';

async function assemble(plugins: readonly KernelPlugin[], store: SessionEventStore) {
  return assembleAgentKernel({
    toolRegistry: createToolRegistry(),
    providerRegistry: createLlmProviderRegistry(),
    approvalBroker: createApprovalBroker(),
    sessionStore: store,
    timeoutMs: 1_000,
    registeredPlugins: [],
    kernelPlugins: plugins,
  });
}

describe('Server plugin ownership boundary', () => {
  it('keeps captured registration errors when author manifest access later fails', async () => {
    const store = createInMemorySessionEventStore();
    let reads = 0;
    let disposed = 0;
    const plugin: KernelPlugin = {
      get manifest() {
        reads++;
        if (reads > 1) throw new Error('Author manifest was read again after setup');
        return {
          id: 'stable-owner',
          name: 'Stable',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
        };
      },
      setup() {
        throw new Error('Original setup failure');
      },
      dispose() {
        disposed++;
      },
    };
    try {
      await expect(assemble([plugin], store)).rejects.toMatchObject({
        code: 'plugin-setup-failed',
        pluginId: 'stable-owner',
        cause: expect.objectContaining({ message: 'Original setup failure' }),
      });
      expect(reads).toBe(1);
      expect(disposed).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('lists only the accepted command owner after another contributor catches a duplicate', async () => {
    const store = createInMemorySessionEventStore();
    const contributor = (id: string, catchDuplicate: boolean) =>
      definePlugin({
        manifest: {
          id,
          name: id,
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['command'],
          contributes: { commands: ['report'] },
          permissions: [],
        },
        setup(env) {
          env.contribute(commandsExtensionPoint, (api) => {
            try {
              api.addCommand({ name: 'report', title: id, prompt: `Report for ${id}` });
            } catch (error: unknown) {
              if (!catchDuplicate) throw error;
            }
          });
        },
      });
    const assembled = await assemble(
      [contributor('first', false), contributor('second', true)],
      store,
    );
    try {
      expect(assembled.commands).toEqual([
        { name: 'report', title: 'first', prompt: 'Report for first', pluginId: 'first' },
      ]);
      expect(assembled.plugins.find((plugin) => plugin.id === 'second')?.provides.commands).toEqual(
        [],
      );
    } finally {
      await assembled.kernel.dispose();
      await store.close();
    }
  });

  it('binds direct and dependency writers while own events run through the shared Pipeline', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('owner-session', [
      { type: 'session.created', payload: { title: 'Owners' } },
    ]);
    const owner = definePlugin({
      manifest: {
        id: 'owner-a',
        name: 'Owner A',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['event', 'tool'],
        contributes: {
          events: ['owner-a/report'],
          tools: ['own_report'],
        },
        permissions: ['service:weave.session.store'],
      },
      setup(env) {
        const event = env.defineEvent('report', { schema: z.object({ text: z.string() }) });
        const writer = env.use(sessionStoreRef);
        env.contribute(toolsExtensionPoint, (api) => {
          api.addTool({
            name: 'own_report',
            description: 'Record report',
            parameters: { type: 'object' },
            inputSchema: z.object({}),
            async execute() {
              await (
                await writer.get()
              ).append('owner-session', [event.create({ text: 'pipeline report' })]);
              return 'recorded';
            },
          });
        });
      },
    });
    let direct!: () => Promise<SessionEventStore>;
    let dep!: () => Promise<SessionEventStore>;
    let reader!: () => Promise<unknown>;
    const observer = definePlugin({
      manifest: {
        id: 'owner-b',
        name: 'Owner B',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['event'],
        contributes: { services: ['owner-b.writer'] },
        permissions: [
          'service:weave.session.store',
          'service:weave.session.plugin-events',
          'service:owner-b.writer',
        ],
      },
      setup(env) {
        const storeHandle = env.use(sessionStoreRef);
        const readerHandle = env.use(pluginEventsRef);
        const ownDep = defineServiceRef<SessionEventStore>({ id: 'owner-b.writer' });
        env.provide(ownDep, {
          deps: { store: sessionStoreRef },
          factory: ({ store: value }) => value,
        });
        const dependency = env.use(ownDep);
        direct = () => storeHandle.get();
        dep = () => dependency.get();
        reader = () => readerHandle.get();
      },
    });
    // owner-b provides a factory so dependency resolution must use its provider identity too.
    const assembled = await assemble([owner, observer], store);
    try {
      expect(
        await assembled.toolPipeline.execute({
          toolCallId: 'report',
          name: 'own_report',
          arguments: '{}',
        }),
      ).toMatchObject({ content: 'recorded' });
      for (const resolve of [direct, dep]) {
        const writer = await resolve();
        await expect(
          writer.append('owner-session', [{ type: 'owner-a/report', payload: { text: 'forged' } }]),
        ).rejects.toMatchObject({ code: 'plugin-event-invalid', pluginId: 'owner-b' });
        await expect(
          writer.append('owner-session', [{ type: 'owner-b/undeclared', payload: {} }]),
        ).rejects.toMatchObject({ code: 'plugin-event-unknown' });
      }
      const events = (await reader()) as {
        get(type: string): unknown;
        list(): unknown;
        define?: unknown;
      };
      expect(events.define).toBeUndefined();
      expect(events.get('owner-a/report')).toEqual({
        type: 'owner-a/report',
        hasProjection: false,
      });
      expect(await store.read('owner-session')).toEqual([
        expect.objectContaining({ type: 'session.created' }),
        expect.objectContaining({ type: 'owner-a/report', payload: { text: 'pipeline report' } }),
      ]);
    } finally {
      await assembled.kernel.dispose();
    }
    // Plugin unloading does not erase historical Session facts or close the host store.
    expect((await store.read('owner-session')).map((event) => event.type)).toEqual([
      'session.created',
      'owner-a/report',
    ]);
    await store.close();
  });
});
