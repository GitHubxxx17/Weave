import {
  definePlugin,
  toolRegistryRef,
  toolsExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';
import { createToolRegistry, type ToolRegistry } from '@weave/runtime';

export interface ToolRegistryPluginOptions {
  /** A registry the host already owns. A fresh one is created for each kernel when omitted. */
  readonly registry?: ToolRegistry | undefined;
  /**
   * What happens when a contributed tool's name is already taken: `error`
   * (the default) lets the registry reject it, `skip` keeps the tool that is
   * already there. A host that reuses one registry across kernels needs `skip`
   * so replaying the same contributions is harmless.
   */
  readonly existing?: 'error' | 'skip' | undefined;
}

/**
 * Creates the builtin plugin that owns the `weave.tools` extension point: it
 * provides the Tool Registry and, at resolve time (after the kernel is
 * sealed), registers every tool other plugins contributed. The shared Tool
 * Pipeline reads tools from this registry.
 */
export function createToolRegistryPlugin(options: ToolRegistryPluginOptions = {}): KernelPlugin {
  return definePlugin({
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
          const registry = options.registry ?? createToolRegistry();
          context.collect(toolsExtensionPoint, {
            addTool: (tool) => {
              if (options.existing === 'skip' && registry.get(tool.name) !== undefined) {
                return;
              }
              registry.register(tool);
            },
          });
          return registry;
        },
      });
    },
  });
}

/** The default Tool Registry owner: a fresh registry per kernel, duplicates rejected. */
export const toolRegistryPlugin: KernelPlugin = createToolRegistryPlugin();
