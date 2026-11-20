import {
  definePlugin,
  toolRegistryRef,
  toolsExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';
import { createToolRegistry, type ToolRegistry } from '@weave/runtime';

/**
 * Builtin plugin that owns the `weave.tools` extension point: it provides the
 * Tool Registry and, at resolve time, registers every tool other plugins
 * contributed. The shared Tool Pipeline reads tools from this registry.
 */
export const toolRegistryPlugin: KernelPlugin = definePlugin({
  manifest: {
    id: 'tool-registry',
    name: 'Tool Registry',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
  },
  setup(env) {
    env.provide(toolRegistryRef, {
      factory: (_deps, context): ToolRegistry => {
        const registry = createToolRegistry();
        context.collect(toolsExtensionPoint, {
          addTool: (tool) => registry.register(tool),
        });
        return registry;
      },
    });
  },
});
