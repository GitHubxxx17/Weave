import { pluginApiVersion } from './constants.js';
import { ExtensionRegistry } from './extension-point.js';
import { HookRegistry } from './hook.js';
import { pluginManifestSchema, type PluginManifest } from './manifest.js';
import { PluginError } from './plugin-errors.js';
import { createPluginEnv, type PluginEnv } from './plugin-env.js';
import { ServiceContainer, type ServiceRef } from './service.js';

/**
 * The plugin kernel assembles typed services, extension points and hooks that
 * plugins register during `setup`, validates the dependency graph, and exposes
 * a sealed {@link Generation} the host resolves services from. It owns no
 * product behaviour; everything is contributed by plugins.
 *
 * This is the typed kernel path. The legacy `createPluginRegistry` (tools and
 * providers) stays available during migration.
 */

/** A kernel plugin: a manifest plus a `setup` that registers through `env`. */
export interface KernelPlugin {
  readonly manifest: PluginManifest;
  setup(env: PluginEnv): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Identity helper for authoring a kernel plugin. */
export function definePlugin(plugin: KernelPlugin): KernelPlugin {
  return plugin;
}

/** An immutable view of the active plugin set, resolving root-scoped services. */
export interface Generation {
  readonly id: number;
  readonly pluginIds: readonly string[];
  resolve<T>(ref: ServiceRef<T>): Promise<T>;
  resolveAll<T>(ref: ServiceRef<T>): Promise<readonly T[]>;
}

/** The typed plugin kernel. */
export interface PluginKernel {
  /** Runs a plugin's `setup`, collecting its registrations. */
  register(plugin: KernelPlugin): Promise<void>;
  /** Validates the dependency graph and returns the sealed generation. */
  seal(): Promise<Generation>;
  readonly extensions: ExtensionRegistry;
  readonly hooks: HookRegistry;
  /** Unloads every plugin (reverse order) and disposes all services. */
  dispose(): Promise<void>;
}

interface LoadedPlugin {
  readonly plugin: KernelPlugin;
  readonly disposers: (() => void)[];
  readonly abort: AbortController;
}

export interface PluginKernelOptions {
  readonly apiVersion?: string;
}

/** Creates an empty plugin kernel. */
export function createPluginKernel(options: PluginKernelOptions = {}): PluginKernel {
  const expectedApiVersion = options.apiVersion ?? pluginApiVersion;
  const container = new ServiceContainer();
  const extensions = new ExtensionRegistry();
  const hooks = new HookRegistry();
  const loaded = new Map<string, LoadedPlugin>();
  const order: LoadedPlugin[] = [];
  let sealed = false;
  let generationId = 0;

  async function register(plugin: KernelPlugin): Promise<void> {
    if (sealed) {
      throw new PluginError(
        'plugin-setup-failed',
        'Cannot register a plugin after the kernel is sealed',
      );
    }
    const parsedManifest = pluginManifestSchema.safeParse(plugin.manifest);
    if (!parsedManifest.success) {
      throw new PluginError('plugin-invalid-manifest', 'Plugin Manifest is invalid', {
        cause: parsedManifest.error,
      });
    }
    const manifest = parsedManifest.data;
    if (manifest.apiVersion !== expectedApiVersion) {
      throw new PluginError(
        'plugin-api-version-unsupported',
        `Plugin "${manifest.id}" requires API version "${manifest.apiVersion}", expected "${expectedApiVersion}"`,
      );
    }
    if (loaded.has(manifest.id)) {
      throw new PluginError('plugin-duplicate-id', `Plugin "${manifest.id}" is already registered`);
    }

    const abort = new AbortController();
    const disposers: (() => void)[] = [];
    const entry: LoadedPlugin = { plugin, disposers, abort };
    const env = createPluginEnv({
      manifest,
      signal: abort.signal,
      container,
      extensions,
      hooks,
      track: (disposer) => disposers.push(disposer),
    });

    try {
      await plugin.setup(env);
    } catch (error: unknown) {
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        disposers[index]?.();
      }
      abort.abort();
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError('plugin-setup-failed', `Plugin "${manifest.id}" setup failed`, {
        cause: error,
      });
    }

    loaded.set(manifest.id, entry);
    order.push(entry);
  }

  async function seal(): Promise<Generation> {
    if (!sealed) {
      container.validate();
      sealed = true;
      generationId += 1;
    }
    const root = container.rootScope();
    const pluginIds = Object.freeze(order.map((entry) => entry.plugin.manifest.id));
    return {
      id: generationId,
      pluginIds,
      resolve: (ref) => root.resolve(ref),
      resolveAll: (ref) => root.resolveAll(ref),
    };
  }

  async function dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const entry = order[index];
      if (entry === undefined) {
        continue;
      }
      try {
        await entry.plugin.dispose?.();
      } catch (error: unknown) {
        errors.push(
          new PluginError(
            'plugin-dispose-failed',
            `Plugin "${entry.plugin.manifest.id}" dispose failed`,
            { cause: error },
          ),
        );
      }
      for (let d = entry.disposers.length - 1; d >= 0; d -= 1) {
        entry.disposers[d]?.();
      }
      entry.abort.abort();
    }
    order.length = 0;
    loaded.clear();
    try {
      await container.dispose();
    } catch (error: unknown) {
      errors.push(error);
    }
    sealed = false;
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Plugin kernel disposal failed');
    }
  }

  return { register, seal, extensions, hooks, dispose };
}
