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
  /** Provides a service implementation. Returns a disposer. */
  provide<T, D extends DepMap>(ref: ServiceRef<T>, impl: ServiceImpl<T, D>): Disposer;
  /** Consumes a service; `get()` resolves lazily after the kernel is sealed. */
  use<T>(ref: ServiceRef<T>): ServiceHandle<T>;
  /** Contributes into an extension point. Returns a disposer. */
  contribute<T>(point: ExtensionPoint<T>, contributor: (api: T) => void): Disposer;
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
}

/** Builds the `env` passed to one plugin's `setup`, tracking its registrations. */
export function createPluginEnv(deps: PluginEnvDeps): PluginEnv {
  const { manifest, signal, container, extensions, hooks, track } = deps;
  const pluginId = manifest.id;

  const tracked = (disposer: Disposer): Disposer => {
    track(disposer);
    return disposer;
  };

  return {
    manifest,
    signal,
    provide(ref, impl) {
      return tracked(container.register(ref, impl, pluginId));
    },
    use(ref) {
      return {
        get: () => container.rootScope().resolve(ref),
      };
    },
    contribute(point, contributor) {
      return tracked(extensions.contribute(point, contributor, pluginId));
    },
    onHook(hook, handler) {
      return tracked(hooks.on(hook, handler, pluginId));
    },
  };
}
