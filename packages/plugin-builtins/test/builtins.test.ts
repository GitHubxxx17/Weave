import { createMockLlmClient } from '@weave/llm';
import {
  createPluginKernel,
  definePlugin,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  toolRegistryRef,
  toolsExtensionPoint,
  type PluginManifest,
} from '@weave/plugin';
import { createUpdatePlanTool, updatePlanToolName } from '@weave/runtime';
import { describe, expect, it } from 'vitest';

import { providerRegistryPlugin, toolRegistryPlugin } from '../src/index.js';

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
