import { type LlmProviderRegistry } from '@weave/llm';
import {
  adaptLegacyPlugin,
  PluginError,
  type AdaptedLegacyPlugin,
  type KernelPlugin,
  type PluginKernel,
  type PluginSnapshot,
  type WeavePlugin,
} from '@weave/plugin';
import { type SessionEventStore } from '@weave/session';
import { type Runtime, type RuntimeService, type ToolRegistry } from '@weave/runtime';
import { type PluginListItem } from './plugin-catalog.js';

/**
 * What the Server keeps for one Runtime between `createServerRuntime` and the
 * Agent Runner: the registries the runner reads, the plugins registered for
 * it, and the kernels it assembled, so they can be disposed together.
 */
export interface ServerHost {
  /** The Tool Registry the Agent Runner executes from; plugin tools are collected into it. */
  readonly toolRegistry: ToolRegistry;
  /** The provider registry; plugin providers are collected into it. */
  readonly providerRegistry: LlmProviderRegistry;
  /** The Runtime service holding the Session Store. */
  readonly sessionStoreService: RuntimeService<SessionEventStore>;
  /**
   * Registers a trusted in-process plugin (the `registerTool` / `registerProvider`
   * form). It is validated now and contributes when the Agent Runner is created.
   */
  registerPlugin(plugin: WeavePlugin): Promise<PluginSnapshot>;
  /** The registered plugins as kernel plugins, in registration order. */
  registeredPlugins(): readonly KernelPlugin[];
  /** Closes plugin registration; the Agent Runner calls this once it has taken the set. */
  lockPlugins(): void;
  /** Keeps an Agent Runner's kernel so it is disposed with the host. */
  trackKernel(kernel: PluginKernel): void;
  /** The plugins loaded for the most recently created Agent Runner. */
  plugins(): readonly PluginListItem[];
  /** Records the plugins an Agent Runner was assembled with. */
  setPlugins(plugins: readonly PluginListItem[]): void;
  /** Disposes the kernels and every registered plugin, last registered first. */
  dispose(): Promise<void>;
}

/** A Runtime created by `createServerRuntime`, carrying its {@link ServerHost}. */
export interface ServerRuntime extends Runtime {
  readonly serverHost: ServerHost;
}

export interface ServerHostOptions {
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: LlmProviderRegistry;
  readonly sessionStoreService: RuntimeService<SessionEventStore>;
}

function conflict(kind: 'Tool' | 'Provider', name: string, pluginId: string): PluginError {
  return new PluginError(
    'plugin-registration-conflict',
    `${kind} "${name}" from plugin "${pluginId}" conflicts with an existing registration`,
  );
}

/** Creates the {@link ServerHost} for one Server Runtime. */
export function createServerHost(options: ServerHostOptions): ServerHost {
  const { toolRegistry, providerRegistry, sessionStoreService } = options;
  const registered: AdaptedLegacyPlugin[] = [];
  const kernels: PluginKernel[] = [];
  let locked = false;
  let loadedPlugins: readonly PluginListItem[] = [];
  let pending: Promise<unknown> = Promise.resolve();

  // Registrations are checked against each other, so they run one at a time.
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertNoConflicts = (snapshot: PluginSnapshot): void => {
    for (const tool of snapshot.tools) {
      if (
        toolRegistry.get(tool) !== undefined ||
        registered.some((other) => other.snapshot.tools.includes(tool))
      ) {
        throw conflict('Tool', tool, snapshot.id);
      }
    }
    for (const provider of snapshot.providers) {
      if (
        providerRegistry.getDescriptor(provider) !== undefined ||
        registered.some((other) => other.snapshot.providers.includes(provider))
      ) {
        throw conflict('Provider', provider, snapshot.id);
      }
    }
  };

  return {
    toolRegistry,
    providerRegistry,
    sessionStoreService,

    registerPlugin: (plugin) =>
      enqueue(async () => {
        if (locked) {
          throw new Error('Plugins must be registered before the Agent Runner is created');
        }
        const adapted = await adaptLegacyPlugin(plugin, {
          beforeSetup: (manifest) => {
            if (registered.some((other) => other.snapshot.id === manifest.id)) {
              throw new PluginError(
                'plugin-duplicate-id',
                `Plugin "${manifest.id}" is already registered`,
              );
            }
          },
        });
        assertNoConflicts(adapted.snapshot);
        registered.push(adapted);
        return adapted.snapshot;
      }),

    registeredPlugins: () => registered.map((adapted) => adapted.plugin),

    lockPlugins() {
      locked = true;
    },

    trackKernel(kernel) {
      kernels.push(kernel);
    },

    plugins: () => loadedPlugins,

    setPlugins(plugins) {
      loadedPlugins = plugins;
    },

    async dispose() {
      await pending;
      const errors: unknown[] = [];
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error: unknown) {
          errors.push(error);
        }
      };

      for (let index = kernels.length - 1; index >= 0; index -= 1) {
        const kernel = kernels[index];
        if (kernel !== undefined) {
          await attempt(() => kernel.dispose());
        }
      }
      // A plugin registered after the last kernel was assembled, or before any
      // runner existed, was never handed to a kernel. Its dispose runs at most
      // once, so this is a no-op for the ones a kernel already disposed.
      for (let index = registered.length - 1; index >= 0; index -= 1) {
        const adapted = registered[index];
        if (adapted !== undefined) {
          await attempt(async () => {
            try {
              await adapted.plugin.dispose?.();
            } catch (error: unknown) {
              throw new PluginError(
                'plugin-dispose-failed',
                `Plugin "${adapted.snapshot.id}" dispose failed`,
                { cause: error },
              );
            }
          });
        }
      }
      kernels.length = 0;
      registered.length = 0;
      loadedPlugins = [];

      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Plugin disposal failed', { cause: errors[0] });
      }
    },
  };
}

/** Gets the {@link ServerHost} of a Runtime created by `createServerRuntime`. */
export function serverHostOf(runtime: Runtime): ServerHost {
  const host = (runtime as Partial<ServerRuntime>).serverHost;
  if (host === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }
  return host;
}
