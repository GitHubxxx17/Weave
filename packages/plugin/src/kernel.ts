import { pluginApiVersion } from './constants.js';
import {
  assertEngineSupported,
  assertHostVersion,
  assertServicePermissions,
  createServiceUsage,
  type ServiceUsage,
} from './declaration.js';
import { ExtensionRegistry } from './extension-point.js';
import { HookRegistry } from './hook.js';
import { requiresHookConfirmation } from './hook-risk.js';
import { pluginManifestSchema, type PluginManifest } from './manifest.js';
import { attributePluginError, PluginError } from './plugin-errors.js';
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

/** The names a plugin has put into the kernel, by kind. */
export interface PluginContributed {
  readonly tools: readonly string[];
  readonly providers: readonly string[];
  readonly promptSections: readonly string[];
  /** Session event types, `<pluginId>/<name>`. */
  readonly events: readonly string[];
  /** Slash command names. */
  readonly commands: readonly string[];
  readonly skills: readonly string[];
  readonly panels: readonly string[];
  /** Ids of the hooks the plugin subscribed to. */
  readonly hooks: readonly string[];
  readonly services: readonly string[];
}

/** One loaded plugin: its manifest and what it has actually contributed so far. */
export interface PluginInfo {
  readonly manifest: PluginManifest;
  /**
   * What the plugin added. Services are known once `setup` ran; the other kinds
   * only once an owner has collected the extension point, so read this after
   * the host has resolved the owner services.
   */
  readonly contributed: PluginContributed;
  /**
   * High-risk hooks the plugin subscribed to without declaring them. They stay
   * inactive until the user confirms them; see {@link PluginKernelOptions}.
   */
  readonly pendingHooks: readonly string[];
}

/** An immutable view of the active plugin set, resolving root-scoped services. */
export interface Generation {
  readonly id: number;
  readonly pluginIds: readonly string[];
  /** The loaded plugins with what they contributed; see {@link PluginInfo.contributed}. */
  plugins(): readonly PluginInfo[];
  resolve<T>(ref: ServiceRef<T>): Promise<T>;
  resolveAll<T>(ref: ServiceRef<T>): Promise<readonly T[]>;
}

/** The typed plugin kernel. */
export interface PluginKernel {
  /** Runs a plugin's `setup`, collecting its registrations. */
  register(plugin: KernelPlugin): Promise<void>;
  /** Validates the dependency graph and returns the sealed generation. */
  seal(): Promise<Generation>;
  /** The loaded plugins in registration order, with what they contributed. */
  plugins(): readonly PluginInfo[];
  readonly extensions: ExtensionRegistry;
  readonly hooks: HookRegistry;
  /** Unloads every plugin (reverse order) and disposes all services. */
  dispose(): Promise<void>;
}

interface LoadedPlugin {
  readonly plugin: KernelPlugin;
  readonly manifest: PluginManifest;
  readonly usage: ServiceUsage;
  pendingHooks: readonly string[];
  readonly disposers: (() => void)[];
  readonly abort: AbortController;
}

export interface PluginKernelOptions {
  readonly apiVersion?: string;
  /**
   * The host's Weave version, a full `x.y.z`. Plugins that declare
   * `engines.weave` are rejected when it is missing or not in their range.
   */
  readonly hostVersion?: string | undefined;
  /**
   * Decides whether the user confirmed a hook a plugin subscribed to without
   * declaring it in `contributes.hooks`. Only hooks that
   * {@link requiresHookConfirmation} names are asked about; the rest keep
   * their behaviour. Without this option nothing is held, so embedded kernels
   * that trust all their plugins are unchanged. Unconfirmed handlers stay
   * registered but receive no dispatch.
   */
  readonly hookConfirmation?:
    | {
        /**
         * Whether the plugin is subject to confirmation. Defaults to every
         * plugin. For a governed plugin an undeclared high-risk subscription
         * registers (held) even when `contributes` is present and omits it;
         * ungoverned plugins keep the plain declaration check.
         */
        governs?(pluginId: string): boolean;
        isConfirmed(pluginId: string, hookId: string): boolean;
      }
    | undefined;
}

/** Manifest parsing detached every container; freeze only that host-owned copy. */
function freezeManifest<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeManifest(child);
    Object.freeze(value);
  }
  return value;
}

/** Creates an empty plugin kernel. */
export function createPluginKernel(options: PluginKernelOptions = {}): PluginKernel {
  const expectedApiVersion = options.apiVersion ?? pluginApiVersion;
  const hostVersion = options.hostVersion;
  assertHostVersion(hostVersion);
  const extensions = new ExtensionRegistry();
  const hooks = new HookRegistry();
  const container = new ServiceContainer({
    collect: (point, api) => extensions.collect(point, api),
  });
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
    const manifest = freezeManifest(parsedManifest.data);
    if (manifest.apiVersion !== expectedApiVersion) {
      throw new PluginError(
        'plugin-api-version-unsupported',
        `Plugin "${manifest.id}" requires API version "${manifest.apiVersion}", expected "${expectedApiVersion}"`,
        { pluginId: manifest.id },
      );
    }
    assertEngineSupported(manifest, hostVersion);
    if (loaded.has(manifest.id)) {
      throw new PluginError(
        'plugin-duplicate-id',
        `Plugin "${manifest.id}" is already registered`,
        { pluginId: manifest.id },
      );
    }

    const abort = new AbortController();
    const disposers: (() => void)[] = [];
    const usage = createServiceUsage();
    const entry: LoadedPlugin = { plugin, manifest, usage, disposers, abort, pendingHooks: [] };
    const confirmation =
      options.hookConfirmation !== undefined &&
      (options.hookConfirmation.governs?.(manifest.id) ?? true)
        ? options.hookConfirmation
        : undefined;
    const env = createPluginEnv({
      manifest,
      signal: abort.signal,
      container,
      extensions,
      hooks,
      track: (disposer) => disposers.push(disposer),
      usage,
      ...(confirmation === undefined ? {} : { holdsUndeclaredHook: requiresHookConfirmation }),
    });

    try {
      await plugin.setup(env);
      assertServicePermissions(manifest, usage);
      usage.closed = true;
      if (confirmation !== undefined) {
        const declaredHooks = manifest.contributes?.hooks ?? [];
        const pending = [...usage.hooks].filter(
          (hookId) =>
            requiresHookConfirmation(hookId) &&
            !declaredHooks.includes(hookId) &&
            !confirmation.isConfirmed(manifest.id, hookId),
        );
        for (const hookId of pending) hooks.hold(hookId, manifest.id);
        entry.pendingHooks = Object.freeze(pending);
      }
    } catch (error: unknown) {
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        disposers[index]?.();
      }
      abort.abort();
      if (error instanceof PluginError) {
        // A plugin error the plugin's own code raised, such as a bad event name,
        // still belongs to this plugin.
        if (error.pluginId !== undefined && error.pluginId !== manifest.id) {
          throw new PluginError(error.code, error.message, { cause: error, pluginId: manifest.id });
        }
        throw attributePluginError(error, manifest.id, `Plugin "${manifest.id}" setup failed`);
      }
      throw new PluginError('plugin-setup-failed', `Plugin "${manifest.id}" setup failed`, {
        cause: error,
        pluginId: manifest.id,
      });
    }

    loaded.set(manifest.id, entry);
    order.push(entry);
  }

  function plugins(): readonly PluginInfo[] {
    return Object.freeze(
      order.map((entry): PluginInfo => {
        const collected = extensions.collected(entry.manifest.id);
        return Object.freeze({
          manifest: entry.manifest,
          contributed: Object.freeze({
            tools: Object.freeze(collected.tools),
            providers: Object.freeze(collected.providers),
            promptSections: Object.freeze(collected.promptSections),
            events: Object.freeze(collected.events),
            commands: Object.freeze(collected.commands),
            skills: Object.freeze(collected.skills),
            panels: Object.freeze(collected.panels),
            hooks: Object.freeze([...entry.usage.hooks]),
            services: Object.freeze([...entry.usage.provided]),
          }),
          pendingHooks: entry.pendingHooks,
        });
      }),
    );
  }

  async function seal(): Promise<Generation> {
    if (!sealed) {
      container.validate();
      sealed = true;
      generationId += 1;
    }
    const root = container.rootScope();
    const pluginIds = Object.freeze(order.map((entry) => entry.manifest.id));
    return {
      id: generationId,
      pluginIds,
      plugins,
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
          new PluginError('plugin-dispose-failed', `Plugin "${entry.manifest.id}" dispose failed`, {
            cause: error,
            pluginId: entry.manifest.id,
          }),
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

  return { register, seal, plugins, extensions, hooks, dispose };
}
