import {
  createPluginEventRegistry,
  definePlugin,
  eventsExtensionPoint,
  pluginEventsRef,
  type KernelPlugin,
  type PluginEventRegistry,
} from '@weave/plugin';

export interface EventRegistryPluginOptions {
  /**
   * A registry the host already owns, for a host that needs to read it, for
   * example to give plugins a Session Store that checks their events. A fresh
   * one is created for each kernel when omitted.
   */
  readonly registry?: PluginEventRegistry | undefined;
}

/**
 * Creates the builtin plugin that owns the `weave.session.events` extension
 * point: it provides the plugin event registry and, at resolve time (after the
 * kernel is sealed), defines every event other plugins contributed. Defining a
 * type twice is rejected, so a host gives each kernel its own registry.
 */
export function createEventRegistryPlugin(options: EventRegistryPluginOptions = {}): KernelPlugin {
  return definePlugin({
    manifest: {
      id: 'event-registry',
      name: 'Event Registry',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['event'],
    },
    setup(env) {
      env.provide(pluginEventsRef, {
        factory: (_deps, context): PluginEventRegistry => {
          const registry = options.registry ?? createPluginEventRegistry();
          context.collect(eventsExtensionPoint, {
            addEvent: (definition) => registry.define(definition),
          });
          return registry;
        },
      });
    },
  });
}

/** The default plugin event registry owner: a fresh registry per kernel. */
export const eventRegistryPlugin: KernelPlugin = createEventRegistryPlugin();
