import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  definePlugin,
  promptSectionsExtensionPoint,
  toolsExtensionPoint,
  type KernelPlugin,
  type WeavePlugin,
} from '@weave/plugin';
import { createApp } from '../src/app.js';
import { pluginListResponseSchema } from '../src/plugin-catalog.js';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  listServerPlugins,
  registerServerPlugins,
} from '../src/runtime.js';

const echoPlugin: WeavePlugin = {
  manifest: {
    id: 'server-echo',
    name: 'Server Echo',
    version: '1.2.3',
    apiVersion: '1.0.0',
    description: '回显文本',
    capabilities: ['tool'],
  },
  setup(context) {
    context.registerTool({
      name: 'echo',
      description: '回显文本',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({}),
      execute: () => 'echo',
    });
  },
};

const noteKernelPlugin: KernelPlugin = definePlugin({
  manifest: {
    id: 'note-kernel',
    name: 'Note Kernel',
    version: '0.4.0',
    apiVersion: '1.0.0',
    capabilities: ['tool', 'prompt', 'event'],
    host: 'mcp',
    contributes: {
      tools: ['note'],
      promptSections: ['note-style'],
      events: ['note-kernel/note-added'],
    },
    permissions: ['workspace:read'],
  },
  setup(env) {
    env.defineEvent('note-added', { schema: z.object({ text: z.string() }) });
    env.contribute(toolsExtensionPoint, (api) =>
      api.addTool({
        name: 'note',
        description: '记笔记',
        parameters: { type: 'object', properties: {} },
        inputSchema: z.object({}),
        execute: () => 'noted',
      }),
    );
    env.contribute(promptSectionsExtensionPoint, (api) =>
      api.addSection({ id: 'note-style', order: 5, text: '记笔记时保持简短。' }),
    );
  },
});

async function getPlugins(runtime: ReturnType<typeof createServerRuntime>) {
  const response = await createApp(runtime, {
    pluginCatalog: () => listServerPlugins(runtime),
  }).request('/plugins');
  expect(response.status).toBe(200);
  return pluginListResponseSchema.parse(await response.json()).plugins;
}

describe('GET /plugins', () => {
  it('lists nothing when the app has no catalog', async () => {
    const runtime = createServerRuntime();

    const response = await createApp(runtime).request('/plugins');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plugins: [] });
  });

  it('lists nothing before an Agent Runner exists', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      expect(await getPlugins(runtime)).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('lists builtin, registered and kernel plugins in registration order with their origin', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      await registerServerPlugins(runtime, [echoPlugin]);
      await createServerAgentRunner(runtime, { kernelPlugins: [noteKernelPlugin] });

      const plugins = await getPlugins(runtime);

      expect(plugins.map((plugin) => [plugin.id, plugin.origin])).toEqual([
        ['tool-registry', 'builtin'],
        ['provider-registry', 'builtin'],
        ['event-registry', 'builtin'],
        ['host-services', 'builtin'],
        ['server-echo', 'registered'],
        ['server-tool-host', 'builtin'],
        ['note-kernel', 'kernel'],
      ]);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('reports the manifest of a plugin and what it actually provides', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      await registerServerPlugins(runtime, [echoPlugin]);
      await createServerAgentRunner(runtime, { kernelPlugins: [noteKernelPlugin] });

      const byId = new Map((await getPlugins(runtime)).map((plugin) => [plugin.id, plugin]));

      expect(byId.get('server-echo')).toEqual({
        id: 'server-echo',
        name: 'Server Echo',
        version: '1.2.3',
        description: '回显文本',
        origin: 'registered',
        host: 'in-process',
        capabilities: ['tool'],
        provides: {
          tools: ['echo'],
          providers: [],
          promptSections: [],
          events: [],
          services: [],
        },
      });
      expect(byId.get('note-kernel')).toEqual({
        id: 'note-kernel',
        name: 'Note Kernel',
        version: '0.4.0',
        origin: 'kernel',
        host: 'mcp',
        capabilities: ['tool', 'prompt', 'event'],
        contributes: {
          tools: ['note'],
          promptSections: ['note-style'],
          events: ['note-kernel/note-added'],
        },
        permissions: ['workspace:read'],
        provides: {
          tools: ['note'],
          providers: [],
          promptSections: ['note-style'],
          events: ['note-kernel/note-added'],
          services: [],
        },
      });
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('reports the services and tools of the server builtins', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      await createServerAgentRunner(runtime);

      const byId = new Map((await getPlugins(runtime)).map((plugin) => [plugin.id, plugin]));

      expect(byId.get('tool-registry')?.provides.services).toEqual(['weave.tools.registry']);
      expect(byId.get('provider-registry')?.provides.services).toEqual(['weave.llm.registry']);
      expect(byId.get('event-registry')?.provides.services).toEqual([
        'weave.session.plugin-events',
      ]);
      expect(byId.get('host-services')).toMatchObject({
        contributes: { services: ['weave.approval.broker', 'weave.session.store'] },
        provides: { services: ['weave.approval.broker', 'weave.session.store'] },
      });
      expect(byId.get('server-tool-host')?.provides).toMatchObject({
        tools: ['recall', 'update_plan'],
        services: ['weave.tools.pipeline'],
      });
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
