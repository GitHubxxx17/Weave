import { createLlmProviderRegistry, type LlmProviderRegistry } from '@weave/llm';
import {
  definePlugin,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';

export interface ProviderRegistryPluginOptions {
  /** A registry the host already owns. A fresh one is created for each kernel when omitted. */
  readonly registry?: LlmProviderRegistry | undefined;
  /**
   * What happens when a contributed provider's id is already taken: `error`
   * (the default) lets the registry reject it, `skip` keeps the provider that
   * is already there. A host that reuses one registry across kernels needs
   * `skip` so replaying the same contributions is harmless.
   */
  readonly existing?: 'error' | 'skip' | undefined;
}

/**
 * Creates the builtin plugin that owns the `weave.llm.providers` extension
 * point: it provides the LLM provider registry and, at resolve time (after the
 * kernel is sealed), registers every provider other plugins contributed.
 * Replaceable like any builtin, but typically present in every profile.
 */
export function createProviderRegistryPlugin(
  options: ProviderRegistryPluginOptions = {},
): KernelPlugin {
  return definePlugin({
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
          const registry = options.registry ?? createLlmProviderRegistry();
          context.collect(llmProvidersExtensionPoint, {
            addProvider: (registration) => {
              if (
                options.existing === 'skip' &&
                registry.getDescriptor(registration.id) !== undefined
              ) {
                return;
              }
              registry.register(registration);
            },
          });
          return registry;
        },
      });
    },
  });
}

/** The default provider registry owner: a fresh registry per kernel, duplicates rejected. */
export const providerRegistryPlugin: KernelPlugin = createProviderRegistryPlugin();
