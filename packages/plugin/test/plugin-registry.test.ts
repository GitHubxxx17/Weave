import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createLlmProviderRegistry,
  createMockLlmClient,
  type LlmProviderRegistration,
} from '@weave/llm';
import { createToolRegistry, type ToolDefinition } from '@weave/runtime';
import { createPluginRegistry, type PluginRegistry, type WeavePlugin } from '../src/index.js';

const validManifest = {
  id: 'example-tools',
  name: 'Example Tools',
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['tool', 'llm-provider'],
} as const;

const echoTool: ToolDefinition<{ text: string }, string> = {
  name: 'echo',
  description: 'Echoes text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
};

const anotherTool: ToolDefinition<Record<string, never>, string> = {
  name: 'another',
  description: 'Another tool',
  parameters: { type: 'object', properties: {} },
  inputSchema: z.object({}),
  execute: () => 'another',
};

function createProvider(id: string): LlmProviderRegistration {
  return {
    id,
    label: id,
    type: 'mock',
    client: createMockLlmClient([]),
  };
}

function createTestRegistry(): {
  registry: PluginRegistry;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  providerRegistry: ReturnType<typeof createLlmProviderRegistry>;
} {
  const toolRegistry = createToolRegistry();
  const providerRegistry = createLlmProviderRegistry();

  return {
    registry: createPluginRegistry({
      toolRegistry,
      providerRegistry,
    }),
    toolRegistry,
    providerRegistry,
  };
}

describe('Plugin Registry', () => {
  it('registers a plugin and exposes a secret-free frozen snapshot', async () => {
    const { registry } = createTestRegistry();
    const plugin: WeavePlugin = {
      manifest: validManifest,
      setup(context) {
        context.registerTool(echoTool);
        context.registerProvider({
          ...createProvider('local-model'),
          client: createMockLlmClient([]),
        });
      },
    };

    const snapshot = await registry.register(plugin);

    expect(snapshot).toEqual({
      ...validManifest,
      tools: ['echo'],
      providers: ['local-model'],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
    expect(registry.get('example-tools')).toBe(snapshot);
  });

  it('rejects unsupported API versions before setup executes', async () => {
    const { registry } = createTestRegistry();
    const setup = vi.fn();

    await expect(
      registry.register({
        manifest: { ...validManifest, apiVersion: '2.0.0' },
        setup,
      }),
    ).rejects.toMatchObject({ code: 'plugin-api-version-unsupported' });

    expect(setup).not.toHaveBeenCalled();
  });

  it('does not leave Tool or Provider registrations after setup fails', async () => {
    const { registry, toolRegistry, providerRegistry } = createTestRegistry();

    await expect(
      registry.register({
        manifest: validManifest,
        setup(context) {
          context.registerTool(echoTool);
          context.registerProvider(createProvider('local-model'));
          throw new Error('setup failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'plugin-setup-failed' });

    expect(toolRegistry.get('echo')).toBeUndefined();
    expect(providerRegistry.get('local-model')).toBeUndefined();
    expect(registry.get('example-tools')).toBeUndefined();
  });

  it('rejects conflicts before committing any staged registration', async () => {
    const { registry, toolRegistry } = createTestRegistry();
    toolRegistry.register(echoTool);

    await expect(
      registry.register({
        manifest: { ...validManifest, id: 'conflict-plugin' },
        setup(context) {
          context.registerTool(echoTool);
          context.registerTool(anotherTool);
        },
      }),
    ).rejects.toMatchObject({ code: 'plugin-registration-conflict' });

    expect(toolRegistry.get('another')).toBeUndefined();
    expect(registry.get('conflict-plugin')).toBeUndefined();
  });

  it('rejects duplicate plugin ids before setup executes', async () => {
    const { registry } = createTestRegistry();
    await registry.register({ manifest: validManifest, setup: () => undefined });
    const setup = vi.fn();

    await expect(
      registry.register({
        manifest: validManifest,
        setup,
      }),
    ).rejects.toMatchObject({ code: 'plugin-duplicate-id' });
    expect(setup).not.toHaveBeenCalled();
  });

  it('disposes plugins in reverse registration order and aggregates failures', async () => {
    const { registry } = createTestRegistry();
    const disposeOrder: string[] = [];
    const createPlugin = (id: string, dispose: () => void): WeavePlugin => ({
      manifest: {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
      },
      setup(context) {
        context.registerTool({
          name: `${id}-tool`,
          description: 'Lifecycle test tool',
          parameters: { type: 'object', properties: {} },
          inputSchema: z.object({}),
          execute: () => 'ok',
        });
      },
      dispose,
    });

    await registry.register(
      createPlugin('first', () => {
        disposeOrder.push('first');
        throw new Error('first dispose failed');
      }),
    );
    await registry.register(
      createPlugin('second', () => {
        disposeOrder.push('second');
        throw new Error('second dispose failed');
      }),
    );
    await registry.register(
      createPlugin('third', () => {
        disposeOrder.push('third');
      }),
    );

    let caught: unknown;
    try {
      await registry.dispose();
    } catch (error: unknown) {
      caught = error;
    }

    expect(disposeOrder).toEqual(['third', 'second', 'first']);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(registry.list()).toEqual([]);
  });

  it('rejects a plugin whose engines the host does not satisfy before setup executes', async () => {
    const registry = createPluginRegistry({
      toolRegistry: createToolRegistry(),
      providerRegistry: createLlmProviderRegistry(),
      hostVersion: '1.2.0',
    });
    const setup = vi.fn();

    await expect(
      registry.register({
        manifest: { ...validManifest, engines: { weave: '>=2.0.0' } },
        setup,
      }),
    ).rejects.toMatchObject({ code: 'plugin-engine-unsupported' });

    expect(setup).not.toHaveBeenCalled();
    expect(registry.get('example-tools')).toBeUndefined();
  });

  it('registers a plugin whose engines the host satisfies', async () => {
    const registry = createPluginRegistry({
      toolRegistry: createToolRegistry(),
      providerRegistry: createLlmProviderRegistry(),
      hostVersion: '1.2.0',
    });

    await expect(
      registry.register({
        manifest: { ...validManifest, engines: { weave: '^1.0.0' } },
        setup: () => undefined,
      }),
    ).resolves.toMatchObject({ id: 'example-tools' });
  });

  it('rejects a plugin that declares engines when the host declared no version', async () => {
    const { registry } = createTestRegistry();

    await expect(
      registry.register({
        manifest: { ...validManifest, engines: { weave: '*' } },
        setup: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'plugin-engine-unsupported' });
  });

  it('rejects a host version that is not a full x.y.z', () => {
    expect(() =>
      createPluginRegistry({
        toolRegistry: createToolRegistry(),
        providerRegistry: createLlmProviderRegistry(),
        hostVersion: '1.2',
      }),
    ).toThrowError(TypeError);
  });

  it('does not commit a Tool that the manifest contributes list leaves out', async () => {
    const { registry, toolRegistry } = createTestRegistry();

    await expect(
      registry.register({
        manifest: { ...validManifest, contributes: { tools: ['another'] } },
        setup(context) {
          context.registerTool(echoTool);
        },
      }),
    ).rejects.toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });

    expect(toolRegistry.get('echo')).toBeUndefined();
    expect(registry.get('example-tools')).toBeUndefined();
  });
});
