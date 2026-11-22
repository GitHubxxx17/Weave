import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlmProviderRegistry, createMockLlmClient } from '@weave/llm';
import {
  approvalBrokerRef,
  definePlugin,
  promptSectionsExtensionPoint,
  sessionStoreRef,
  toolsExtensionPoint,
  type KernelPlugin,
  type PluginApprovalBroker,
  type PluginManifest,
  type ProjectedPluginEventHandle,
  type ServiceHandle,
  type WeavePlugin,
} from '@weave/plugin';
import { projectSession, type SessionEventStore } from '@weave/session';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
  registerServerPlugins,
} from '../src/runtime.js';

function manifest(id: string, over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
    ...over,
  };
}

/** A trusted plugin that registers one tool named `<id>-tool`. */
function toolPlugin(id: string, dispose?: () => void): WeavePlugin {
  return {
    manifest: manifest(id),
    setup(context) {
      context.registerTool({
        name: `${id}-tool`,
        description: `Tool of ${id}`,
        parameters: { type: 'object', properties: {} },
        inputSchema: z.object({}),
        execute: () => 'ok',
      });
    },
    ...(dispose === undefined ? {} : { dispose }),
  };
}

async function startRuntime() {
  const runtime = createServerRuntime();
  await runtime.start();
  return runtime;
}

describe('Server host', () => {
  it('collects the providers of a registered plugin when the Agent Runner is created', async () => {
    const providerRegistry = createLlmProviderRegistry();
    const runtime = createServerRuntime({
      providerSettings: {
        registry: providerRegistry,
        providers: providerRegistry.list(),
        defaultProvider: 'mock',
      },
    });
    await runtime.start();

    try {
      await registerServerPlugins(runtime, [
        {
          manifest: manifest('provider-plugin', { capabilities: ['llm-provider'] }),
          setup(context) {
            context.registerProvider({
              id: 'plugin-mock',
              label: 'Plugin Mock',
              type: 'mock',
              client: createMockLlmClient([]),
            });
          },
        },
      ]);
      expect(providerRegistry.getDescriptor('plugin-mock')).toBeUndefined();

      await createServerAgentRunner(runtime);

      expect(runtime.serverHost.providerRegistry.getDescriptor('plugin-mock')).toBeDefined();
      expect(providerRegistry.getDescriptor('plugin-mock')).toBeUndefined();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('returns the snapshot of each registered plugin', async () => {
    const runtime = await startRuntime();

    try {
      const snapshots = await registerServerPlugins(runtime, [toolPlugin('first')]);

      expect(snapshots).toEqual([
        expect.objectContaining({ id: 'first', tools: ['first-tool'], providers: [] }),
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it('rejects a plugin id that is already registered before its setup runs', async () => {
    const runtime = await startRuntime();
    await registerServerPlugins(runtime, [toolPlugin('first')]);
    const setup = vi.fn();

    try {
      await expect(
        registerServerPlugins(runtime, [{ ...toolPlugin('first'), setup }]),
      ).rejects.toMatchObject({ code: 'plugin-duplicate-id' });
      expect(setup).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it('rejects a tool or provider that another registered plugin already owns', async () => {
    const runtime = await startRuntime();
    await registerServerPlugins(runtime, [toolPlugin('first')]);

    try {
      await expect(
        registerServerPlugins(runtime, [
          {
            ...toolPlugin('second'),
            setup(context) {
              context.registerTool({
                name: 'first-tool',
                description: 'Clashes with the first plugin',
                parameters: { type: 'object', properties: {} },
                inputSchema: z.object({}),
                execute: () => 'ok',
              });
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'plugin-registration-conflict' });
    } finally {
      await runtime.stop();
    }
  });

  it('rejects registering a plugin after the Agent Runner was created', async () => {
    const runtime = await startRuntime();

    try {
      await createServerAgentRunner(runtime);

      await expect(registerServerPlugins(runtime, [toolPlugin('late')])).rejects.toThrowError(
        'Plugins must be registered before the Agent Runner is created',
      );
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('puts registered plugin tools ahead of the server tools, then kernel plugin tools', async () => {
    const runtime = await startRuntime();
    const kernelPlugin: KernelPlugin = definePlugin({
      manifest: manifest('kernel-tool'),
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) =>
          api.addTool({
            name: 'kernel-tool',
            description: 'Kernel tool',
            parameters: { type: 'object', properties: {} },
            inputSchema: z.object({}),
            execute: () => 'ok',
          }),
        );
      },
    });

    try {
      await registerServerPlugins(runtime, [toolPlugin('first'), toolPlugin('second')]);
      await createServerAgentRunner(runtime, { kernelPlugins: [kernelPlugin] });

      expect(runtime.serverHost.toolRegistry.list().map((tool) => tool.name)).toEqual([
        'first-tool',
        'second-tool',
        'recall',
        'update_plan',
        'read_skill',
        'read_skill_resource',
        'kernel-tool',
      ]);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('lets kernel plugins use a view of the Approval Broker the Server owns and read its Session Store', async () => {
    const runtime = await startRuntime();
    const seen: Promise<unknown>[] = [];
    const probe: KernelPlugin = definePlugin({
      manifest: manifest('probe', { capabilities: ['prompt'] }),
      setup(env) {
        const store = env.use(sessionStoreRef);
        const broker = env.use(approvalBrokerRef);
        // Contributions are replayed once the kernel is sealed, when services resolve.
        env.contribute(promptSectionsExtensionPoint, () => {
          seen.push(store.get(), broker.get());
        });
      },
    });

    try {
      await createServerAgentRunner(runtime, { kernelPlugins: [probe] });
      const serverStore = getServerSessionStore(runtime);
      await serverStore.append('session-1', [{ type: 'session.created', payload: {} }]);

      const [store, broker] = await Promise.all(seen);
      expect(await (store as SessionEventStore).read('session-1')).toEqual(
        await serverStore.read('session-1'),
      );
      // A plugin sees the Server's requests but gets no way to decide them.
      const view = broker as PluginApprovalBroker;
      const serverBroker = runtime.get(approvalBrokerService);
      expect(view).not.toBe(serverBroker);
      expect(Object.keys(view).sort()).toEqual(['get', 'list', 'request', 'subscribe']);
      expect(view.list()).toEqual(serverBroker.list());
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  describe('plugin events', () => {
    const entrySchema = z.object({ text: z.string().min(1) });

    interface Journal {
      readonly handle: ProjectedPluginEventHandle<{ text: string }, readonly string[]>;
      readonly store: () => Promise<SessionEventStore>;
      readonly plugin: KernelPlugin;
    }

    function journal(): Journal {
      let handle: Journal['handle'] | undefined;
      let store: ServiceHandle<SessionEventStore> | undefined;
      const plugin = definePlugin({
        manifest: manifest('journal', { capabilities: ['event'] }),
        setup(env) {
          handle = env.defineEvent('entry-added', {
            schema: entrySchema,
            project: {
              initial: () => [],
              apply: (entries, event) => [...entries, event.payload.text],
            },
          });
          store = env.use(sessionStoreRef);
        },
      });
      return {
        plugin,
        get handle() {
          if (handle === undefined) {
            throw new Error('The journal plugin has not been set up');
          }
          return handle;
        },
        store: () => {
          if (store === undefined) {
            throw new Error('The journal plugin has not been set up');
          }
          return store.get();
        },
      };
    }

    it('records a plugin event in the Server Session Store and projects it back', async () => {
      const runtime = await startRuntime();
      const entries = journal();

      try {
        await createServerAgentRunner(runtime, { kernelPlugins: [entries.plugin] });
        const store = await entries.store();

        await store.append('session-1', [
          entries.handle.create({ text: 'first' }),
          entries.handle.create({ text: 'second' }),
        ]);

        const stored = await getServerSessionStore(runtime).read('session-1');
        expect(stored.map((event) => [event.type, event.payload])).toEqual([
          ['journal/entry-added', { text: 'first' }],
          ['journal/entry-added', { text: 'second' }],
        ]);
        expect(entries.handle.project(await store.read('session-1'))).toEqual(['first', 'second']);
      } finally {
        await disposeServerPlugins(runtime);
        await runtime.stop();
      }
    });

    it('refuses core events and payloads the plugin schema rejects, writing nothing', async () => {
      const runtime = await startRuntime();
      const entries = journal();

      try {
        await createServerAgentRunner(runtime, { kernelPlugins: [entries.plugin] });
        const store = await entries.store();

        await expect(
          store.append('session-1', [{ type: 'session.created', payload: {} }]),
        ).rejects.toMatchObject({ code: 'plugin-event-unknown' });
        await expect(
          store.append('session-1', [{ type: 'journal/entry-added', payload: { text: '' } }]),
        ).rejects.toMatchObject({ code: 'plugin-event-invalid' });
        await expect(
          store.append('session-1', [{ type: 'other/entry-added', payload: { text: 'x' } }]),
        ).rejects.toMatchObject({ code: 'plugin-event-invalid', pluginId: 'journal' });
        await expect(
          store.append('session-1', [{ type: 'journal/unknown', payload: { text: 'x' } }]),
        ).rejects.toMatchObject({ code: 'plugin-event-unknown', pluginId: 'journal' });

        expect(await getServerSessionStore(runtime).read('session-1')).toEqual([]);
      } finally {
        await disposeServerPlugins(runtime);
        await runtime.stop();
      }
    });

    it('keeps the events in the log, and the Session readable, after the plugin is gone', async () => {
      const runtime = await startRuntime();
      const entries = journal();

      try {
        await createServerAgentRunner(runtime, { kernelPlugins: [entries.plugin] });
        const store = await entries.store();
        await getServerSessionStore(runtime).append('session-1', [
          { type: 'session.created', payload: { title: 'Notes' } },
        ]);
        await store.append('session-1', [entries.handle.create({ text: 'kept' })]);

        await disposeServerPlugins(runtime);

        // Nothing registers the plugin's event any more, yet the log still holds
        // it and the Session projects as before.
        const log = await getServerSessionStore(runtime).read('session-1');
        expect(log.map((event) => event.type)).toEqual(['session.created', 'journal/entry-added']);
        expect(projectSession(log).title).toBe('Notes');
      } finally {
        await runtime.stop();
      }
    });
  });

  it('disposes registered plugins last registered first, once, with or without a runner', async () => {
    const order: string[] = [];
    const withRunner = await startRuntime();
    await registerServerPlugins(withRunner, [
      toolPlugin('first', () => order.push('first')),
      toolPlugin('second', () => order.push('second')),
    ]);
    await createServerAgentRunner(withRunner);

    await disposeServerPlugins(withRunner);
    await withRunner.stop();
    expect(order).toEqual(['second', 'first']);

    order.length = 0;
    const withoutRunner = await startRuntime();
    await registerServerPlugins(withoutRunner, [
      toolPlugin('third', () => order.push('third')),
      toolPlugin('fourth', () => order.push('fourth')),
    ]);

    await disposeServerPlugins(withoutRunner);
    await withoutRunner.stop();
    expect(order).toEqual(['fourth', 'third']);
  });

  it('disposes the kernel plugins of every Agent Runner with the Server', async () => {
    const runtime = await startRuntime();
    const dispose = vi.fn();
    const kernelPlugin: KernelPlugin = definePlugin({
      manifest: manifest('kernel-plugin'),
      setup: () => undefined,
      dispose,
    });
    await createServerAgentRunner(runtime, { kernelPlugins: [kernelPlugin] });

    await disposeServerPlugins(runtime);
    await runtime.stop();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the kernel when assembling the Agent Runner fails', async () => {
    const runtime = await startRuntime();
    const dispose = vi.fn();
    const first: KernelPlugin = definePlugin({
      manifest: manifest('first-kernel'),
      setup: () => undefined,
      dispose,
    });
    const broken: KernelPlugin = definePlugin({
      manifest: manifest('broken-kernel'),
      setup() {
        throw new Error('setup failed');
      },
    });

    try {
      await expect(
        createServerAgentRunner(runtime, { kernelPlugins: [first, broken] }),
      ).rejects.toMatchObject({ code: 'plugin-setup-failed' });
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await runtime.stop();
    }
  });

  it('refuses a Runtime that was not created by createServerRuntime', async () => {
    const { createRuntime } = await import('@weave/runtime');
    const plain = createRuntime();

    await expect(registerServerPlugins(plain, [])).rejects.toThrowError(
      'Server Runtime was not created by createServerRuntime',
    );
    expect(() => getServerSessionStore(plain)).toThrowError();
  });
});
