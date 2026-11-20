import { createLlmProviderRegistry, createMockLlmClient } from '@weave/llm';
import {
  approvalBrokerRef,
  createPluginKernel,
  definePlugin,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  sessionStoreRef,
  toolRegistryRef,
  toolsExtensionPoint,
  type PluginManifest,
} from '@weave/plugin';
import {
  createApprovalBroker,
  createToolRegistry,
  createUpdatePlanTool,
  updatePlanToolName,
  type SessionEventStore,
} from '@weave/runtime';
import { describe, expect, it } from 'vitest';

import {
  createProviderRegistryPlugin,
  createToolRegistryPlugin,
  hostServicesPlugin,
  providerRegistryPlugin,
  toolRegistryPlugin,
} from '../src/index.js';

function manifest(id: string, capability: 'tool' | 'llm-provider'): PluginManifest {
  return { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: [capability] };
}

describe('builtin owner plugins', () => {
  it('provider-registry registers every contributed provider', async () => {
    const kernel = createPluginKernel();
    await kernel.register(providerRegistryPlugin);
    await kernel.register(
      definePlugin({
        manifest: manifest('mock-provider', 'llm-provider'),
        setup(env) {
          env.contribute(llmProvidersExtensionPoint, (api) =>
            api.addProvider({
              id: 'mock',
              label: 'Mock',
              type: 'mock',
              client: createMockLlmClient([]),
            }),
          );
        },
      }),
    );
    const generation = await kernel.seal();
    const registry = await generation.resolve(llmProviderRegistryRef);
    expect(registry.getDescriptor('mock')).toBeDefined();
    await kernel.dispose();
  });

  it('tool-registry registers every contributed tool', async () => {
    const kernel = createPluginKernel();
    await kernel.register(toolRegistryPlugin);
    await kernel.register(
      definePlugin({
        manifest: manifest('plan-tool', 'tool'),
        setup(env) {
          env.contribute(toolsExtensionPoint, (api) => api.addTool(createUpdatePlanTool()));
        },
      }),
    );
    const generation = await kernel.seal();
    const registry = await generation.resolve(toolRegistryRef);
    expect(registry.get(updatePlanToolName)).toBeDefined();
    await kernel.dispose();
  });
});

describe('host-owned registries', () => {
  const planTool = (id: string) =>
    definePlugin({
      manifest: manifest(id, 'tool'),
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) => api.addTool(createUpdatePlanTool()));
      },
    });
  const mockProvider = (id: string) =>
    definePlugin({
      manifest: manifest(`provider-${id}`, 'llm-provider'),
      setup(env) {
        env.contribute(llmProvidersExtensionPoint, (api) =>
          api.addProvider({ id, label: id, type: 'mock', client: createMockLlmClient([]) }),
        );
      },
    });

  it('registers contributed tools into the registry the host passes in', async () => {
    const registry = createToolRegistry();
    const kernel = createPluginKernel();
    await kernel.register(createToolRegistryPlugin({ registry }));
    await kernel.register(planTool('plan-tool'));

    const generation = await kernel.seal();

    expect(await generation.resolve(toolRegistryRef)).toBe(registry);
    expect(registry.get(updatePlanToolName)).toBeDefined();
    await kernel.dispose();
  });

  it('rejects a taken tool name by default and keeps the existing tool with existing: skip', async () => {
    const existing = createUpdatePlanTool();
    const run = async (existingPolicy?: 'skip') => {
      const registry = createToolRegistry();
      registry.register(existing);
      const kernel = createPluginKernel();
      await kernel.register(
        createToolRegistryPlugin({
          registry,
          ...(existingPolicy === undefined ? {} : { existing: existingPolicy }),
        }),
      );
      await kernel.register(planTool('plan-tool'));
      const generation = await kernel.seal();
      try {
        await generation.resolve(toolRegistryRef);
        return registry;
      } finally {
        await kernel.dispose();
      }
    };

    await expect(run()).rejects.toThrow();
    expect((await run('skip')).get(updatePlanToolName)).toBe(existing);
  });

  it('registers contributed providers into the registry the host passes in', async () => {
    const registry = createLlmProviderRegistry();
    const kernel = createPluginKernel();
    await kernel.register(createProviderRegistryPlugin({ registry }));
    await kernel.register(mockProvider('mock'));

    const generation = await kernel.seal();

    expect(await generation.resolve(llmProviderRegistryRef)).toBe(registry);
    expect(registry.getDescriptor('mock')).toBeDefined();
    await kernel.dispose();
  });

  it('rejects a taken provider id by default and keeps the existing provider with existing: skip', async () => {
    const run = async (existingPolicy?: 'skip') => {
      const registry = createLlmProviderRegistry();
      registry.register({
        id: 'mock',
        label: 'First',
        type: 'mock',
        client: createMockLlmClient([]),
      });
      const kernel = createPluginKernel();
      await kernel.register(
        createProviderRegistryPlugin({
          registry,
          ...(existingPolicy === undefined ? {} : { existing: existingPolicy }),
        }),
      );
      await kernel.register(mockProvider('mock'));
      const generation = await kernel.seal();
      try {
        await generation.resolve(llmProviderRegistryRef);
        return registry;
      } finally {
        await kernel.dispose();
      }
    };

    await expect(run()).rejects.toThrow();
    expect((await run('skip')).getDescriptor('mock')?.label).toBe('First');
  });
});

describe('host services', () => {
  it('hands out the instances the host owns, not copies', async () => {
    const approvalBroker = createApprovalBroker();
    const sessionStore = {} as SessionEventStore;
    const kernel = createPluginKernel();
    await kernel.register(hostServicesPlugin({ approvalBroker, sessionStore }));

    const generation = await kernel.seal();

    expect(await generation.resolve(approvalBrokerRef)).toBe(approvalBroker);
    expect(await generation.resolve(sessionStoreRef)).toBe(sessionStore);
    await kernel.dispose();
  });

  it('provides only the services it was given and lists exactly those', async () => {
    const approvalBroker = createApprovalBroker();
    const plugin = hostServicesPlugin({ approvalBroker });
    const kernel = createPluginKernel();
    await kernel.register(plugin);

    const generation = await kernel.seal();

    expect(plugin.manifest.contributes).toEqual({ services: [approvalBrokerRef.id] });
    await expect(generation.resolve(sessionStoreRef)).rejects.toThrow();
    await kernel.dispose();
  });
});
