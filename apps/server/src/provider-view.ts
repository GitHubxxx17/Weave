import type { LlmProviderRegistry } from '@weave/llm';

/** Combines live host settings with one generation's isolated plugin clients. */
export function createProviderView(
  host: LlmProviderRegistry,
  plugins: () => LlmProviderRegistry | undefined,
  writes: 'host' | 'plugins',
  assertRegistration?: (id: string) => void,
): LlmProviderRegistry {
  const target = (): LlmProviderRegistry => {
    const registry = writes === 'host' ? host : plugins();
    if (registry === undefined) throw new Error('Plugin provider registry is unavailable');
    return registry;
  };
  const assertWritable = (id: string): void => {
    const other = writes === 'host' ? plugins() : host;
    if (other?.getDescriptor(id) !== undefined) {
      throw new Error(`Provider "${id}" conflicts with an existing registration`);
    }
  };
  return Object.freeze({
    register(provider) {
      assertRegistration?.(provider.id);
      assertWritable(provider.id);
      target().register(provider);
    },
    replace(provider) {
      assertWritable(provider.id);
      target().replace(provider);
    },
    remove(id) {
      return target().remove(id);
    },
    get(id) {
      return plugins()?.get(id) ?? host.get(id);
    },
    getDescriptor(id) {
      return plugins()?.getDescriptor(id) ?? host.getDescriptor(id);
    },
    list() {
      return Object.freeze([...host.list(), ...(plugins()?.list() ?? [])]);
    },
  } satisfies LlmProviderRegistry);
}
