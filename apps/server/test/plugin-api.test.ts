import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  commandsExtensionPoint,
  definePlugin,
  promptSectionsExtensionPoint,
  toolResultHook,
  toolsExtensionPoint,
  type KernelPlugin,
  type WeavePlugin,
} from '@weave/plugin';
import { createApp } from '../src/app.js';
import { commandListResponseSchema, pluginListResponseSchema } from '../src/plugin-catalog.js';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  listServerCommands,
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
    capabilities: ['tool', 'prompt', 'event', 'command'],
    host: 'mcp',
    contributes: {
      tools: ['note'],
      promptSections: ['note-style'],
      events: ['note-kernel/note-added'],
      commands: ['summarize'],
      hooks: ['weave.tools.result'],
    },
    permissions: ['workspace:read'],
  },
  setup(env) {
    env.defineEvent('note-added', { schema: z.object({ text: z.string() }) });
    env.onHook(toolResultHook, () => undefined);
    env.contribute(commandsExtensionPoint, (api) =>
      api.addCommand({
        name: 'summarize',
        title: '总结要点',
        description: '把当前内容总结成要点',
        prompt: '请把下面的内容总结成要点：\n$ARGUMENTS',
      }),
    );
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
          commands: [],
          hooks: [],
          services: [],
        },
      });
      expect(byId.get('note-kernel')).toEqual({
        id: 'note-kernel',
        name: 'Note Kernel',
        version: '0.4.0',
        origin: 'kernel',
        host: 'mcp',
        capabilities: ['tool', 'prompt', 'event', 'command'],
        contributes: {
          tools: ['note'],
          promptSections: ['note-style'],
          events: ['note-kernel/note-added'],
          commands: ['summarize'],
          hooks: ['weave.tools.result'],
        },
        permissions: ['workspace:read'],
        provides: {
          tools: ['note'],
          providers: [],
          promptSections: ['note-style'],
          events: ['note-kernel/note-added'],
          commands: ['summarize'],
          hooks: ['weave.tools.result'],
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

describe('GET /commands', () => {
  const commandPlugin = (id: string, names: readonly string[]): KernelPlugin =>
    definePlugin({
      manifest: {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['command'],
      },
      setup(env) {
        env.contribute(commandsExtensionPoint, (api) => {
          for (const name of names) {
            api.addCommand({ name, title: `Command ${name}`, prompt: `Do ${name}: $ARGUMENTS` });
          }
        });
      },
    });

  async function getCommands(runtime: ReturnType<typeof createServerRuntime>) {
    const response = await createApp(runtime, {
      commandCatalog: () => listServerCommands(runtime),
    }).request('/commands');
    expect(response.status).toBe(200);
    return commandListResponseSchema.parse(await response.json()).commands;
  }

  it('lists nothing when the app has no catalog', async () => {
    const runtime = createServerRuntime();

    const response = await createApp(runtime).request('/commands');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [] });
  });

  it('lists nothing before an Agent Runner exists', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      expect(await getCommands(runtime)).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('lists every contributed command with its plugin, in registration order', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      await createServerAgentRunner(runtime, {
        kernelPlugins: [noteKernelPlugin, commandPlugin('review-kit', ['review', 'explain'])],
      });

      expect(await getCommands(runtime)).toEqual([
        {
          name: 'summarize',
          title: '总结要点',
          description: '把当前内容总结成要点',
          prompt: '请把下面的内容总结成要点：\n$ARGUMENTS',
          pluginId: 'note-kernel',
        },
        {
          name: 'review',
          title: 'Command review',
          prompt: 'Do review: $ARGUMENTS',
          pluginId: 'review-kit',
        },
        {
          name: 'explain',
          title: 'Command explain',
          prompt: 'Do explain: $ARGUMENTS',
          pluginId: 'review-kit',
        },
      ]);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('refuses to assemble when two plugins contribute the same command name', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      await expect(
        createServerAgentRunner(runtime, {
          kernelPlugins: [
            commandPlugin('first-kit', ['review']),
            commandPlugin('second-kit', ['review']),
          ],
        }),
      ).rejects.toMatchObject({
        code: 'plugin-registration-conflict',
        message: expect.stringContaining('first-kit, second-kit'),
      });
      expect(listServerCommands(runtime)).toEqual([]);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
