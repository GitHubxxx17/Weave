import { createLlmProviderRegistry, type LlmProviderRegistry } from '@weave/llm';
import {
  definePlugin,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';

/**
 * Builtin plugin that owns the `weave.llm.providers` extension point: it
 * provides the LLM provider registry and, at resolve time (after the kernel is
 * sealed), registers every provider other plugins contributed. Replaceable like
 * any builtin, but typically present in every profile.
 */
export const providerRegistryPlugin: KernelPlugin = definePlugin({
  manifest: {
    id: 'provider-registry',
    name: 'Provider Registry',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['llm-provider'],
  },
  setup(env) {
    env.provide(llmProviderRegistryRef, {
      factory: (_deps, context): LlmProviderRegistry => {
        const registry = createLlmProviderRegistry();
        context.collect(llmProvidersExtensionPoint, {
          addProvider: (registration) => registry.register(registration),
        });
        return registry;
      },
    });
  },
});
