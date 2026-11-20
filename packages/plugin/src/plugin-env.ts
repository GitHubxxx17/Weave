import { assertNameDeclared, assertServiceUse, type ServiceUsage } from './declaration.js';
import { type PluginManifest } from './manifest.js';
import {
  type DecideHandler,
  type Hook,
  type HookRegistry,
  type ObserveHandler,
  type WrapHandler,
} from './hook.js';
import { type ExtensionPoint, type ExtensionRegistry } from './extension-point.js';
import {
  createPluginEventDefinition,
  type PluginEventHandle,
  type PluginEventProjection,
  type PluginEventSpec,
  type ProjectedPluginEventHandle,
  type ProjectedPluginEventSpec,
} from './plugin-events.js';
import { eventsExtensionPoint } from './seams.js';
import {
  type DepMap,
  type Disposer,
  type ServiceContainer,
  type ServiceImpl,
  type ServiceRef,
} from './service.js';

/** A lazy accessor for a service a plugin consumes. */
export interface ServiceHandle<T> {
  /** Resolves the service from the root scope. */
  get(): Promise<T>;
}

/** The capabilities exposed to a kernel plugin during `setup`. */
export interface PluginEnv {
  readonly manifest: PluginManifest;
  /** Aborted when the plugin is unloaded or its generation is replaced. */
  readonly signal: AbortSignal;
  /**
   * Provides a service implementation. Returns a disposer. A plugin that
   * declared `contributes` may only provide the services it lists there.
   */
  provide<T, D extends DepMap>(ref: ServiceRef<T>, impl: ServiceImpl<T, D>): Disposer;
  /**
   * Consumes a service; `get()` resolves lazily after the kernel is sealed. A
   * plugin that declared `permissions` may only use services it grants as
   * `service:<id>`, which is checked once `setup` has finished.
   */
  use<T>(ref: ServiceRef<T>): ServiceHandle<T>;
  /**
   * Contributes into an extension point. Returns a disposer. A governed point
   * requires the matching capability, and the names a plugin that declared
   * `contributes` adds must be listed there.
   */
  contribute<T>(point: ExtensionPoint<T>, contributor: (api: T) => void): Disposer;
  /**
   * Defines one of this plugin's Session events, `<pluginId>/<name>`, and
   * returns a handle for building events to append. With a `project` the
   * handle also folds a Session's events into a state. Needs the `event`
   * capability, and a plugin that declared `contributes` must list the full
   * type under `events`. The host's event registry takes the definition once
   * the kernel is sealed; until then nothing can append the event.
   */
  defineEvent<P extends Record<string, unknown>>(
    name: string,
    spec: PluginEventSpec<P>,
  ): PluginEventHandle<P>;
  defineEvent<P extends Record<string, unknown>, S>(
    name: string,
    spec: ProjectedPluginEventSpec<P, S>,
  ): ProjectedPluginEventHandle<P, S>;
  /** Registers a hook handler. Returns a disposer. */
  onHook<I, O>(
    hook: Hook<I, O>,
    handler: ObserveHandler<I> | WrapHandler<I, O> | DecideHandler<I>,
  ): Disposer;
}

/** Dependencies the kernel wires into each plugin's {@link PluginEnv}. */
export interface PluginEnvDeps {
  readonly manifest: PluginManifest;
  readonly signal: AbortSignal;
  readonly container: ServiceContainer;
  readonly extensions: ExtensionRegistry;
  readonly hooks: HookRegistry;
  /** Records a disposer so the kernel can reclaim it when the plugin unloads. */
  readonly track: (disposer: Disposer) => void;
  /**
   * Records the services the plugin provides and uses, so the kernel can check
   * them against the manifest's `permissions` once `setup` has finished.
   */
  readonly usage?: ServiceUsage | undefined;
}

/** Builds the `env` passed to one plugin's `setup`, tracking its registrations. */
export function createPluginEnv(deps: PluginEnvDeps): PluginEnv {
  const { manifest, signal, container, extensions, hooks, track, usage } = deps;
  const pluginId = manifest.id;

  const tracked = (disposer: Disposer): Disposer => {
    track(disposer);
    return disposer;
  };

  const defineEvent = ((
    name: string,
    spec: PluginEventSpec<Record<string, unknown>> & {
      readonly project?: PluginEventProjection<Record<string, unknown>, unknown>;
    },
  ) => {
    const { definition, handle } = createPluginEventDefinition(pluginId, name, spec);
    tracked(
      extensions.contribute(
        eventsExtensionPoint,
        (api) => api.addEvent(definition),
        pluginId,
        manifest,
      ),
    );
    return handle;
  }) as PluginEnv['defineEvent'];

  return {
    manifest,
    signal,
    provide(ref, impl) {
      assertNameDeclared(pluginId, manifest.contributes, 'services', ref.id);
      usage?.provided.add(ref.id);
      for (const dependency of Object.values(impl.deps ?? {})) {
        usage?.used.add(dependency.id);
      }
      return tracked(container.register(ref, impl, pluginId));
    },
    use(ref) {
      if (usage !== undefined) {
        if (usage.closed) {
          assertServiceUse(manifest, usage, ref.id);
        }
        usage.used.add(ref.id);
      }
      return {
        get: () => container.rootScope().resolve(ref),
      };
    },
    contribute(point, contributor) {
      return tracked(extensions.contribute(point, contributor, pluginId, manifest));
    },
    defineEvent,
    onHook(hook, handler) {
      assertNameDeclared(pluginId, manifest.contributes, 'hooks', hook.id);
      usage?.hooks.add(hook.id);
      return tracked(hooks.on(hook, handler, pluginId));
    },
  };
}
