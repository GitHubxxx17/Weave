import { type KernelPlugin, type PluginEnv } from '@weave/plugin';

import { PluginHostError } from './errors.js';

/** The resources owned by one loaded plugin instance and assembly attempt. */
export interface PluginLifecycle {
  readonly plugin: KernelPlugin;
  dispose(): Promise<void>;
  normalize(error: unknown): unknown;
  readonly cleanupErrors: readonly unknown[];
}

/** Wraps one module so the kernel and host share its cleanup ownership. */
export function createPluginLifecycle(
  original: KernelPlugin,
  setupTimeoutMs: number,
): PluginLifecycle {
  const abort = new AbortController();
  const timeout = new Error(`Plugin "${original.manifest.id}" setup exceeded ${setupTimeoutMs}ms`);
  let invalid = false;
  let cleanup: Promise<void> | undefined;
  const cleanupErrors: unknown[] = [];

  function invalidate(reason?: unknown): void {
    invalid = true;
    abort.abort(reason);
  }

  function assertActive(signal: AbortSignal): void {
    if (invalid || signal.aborted) {
      throw new Error(`Plugin "${original.manifest.id}" environment is no longer active`);
    }
  }

  function guardEnv(env: PluginEnv): PluginEnv {
    const signal = AbortSignal.any([env.signal, abort.signal]);
    // A function proxy keeps generic/overloaded signatures and binds every
    // forwarded call to the original env, including calls detached by plugins.
    const guard = <T extends (...args: never[]) => unknown>(method: T): T =>
      new Proxy(method, {
        apply(target, _receiver, args: unknown[]) {
          assertActive(signal);
          return Reflect.apply(target, env, args);
        },
      });
    return {
      manifest: env.manifest,
      signal,
      provide: guard(env.provide),
      use: guard(env.use),
      contribute: guard(env.contribute),
      defineEvent: guard(env.defineEvent),
      onHook: guard(env.onHook),
    };
  }

  function dispose(): Promise<void> {
    invalidate();
    cleanup ??= Promise.resolve().then(async () => {
      try {
        await original.dispose?.();
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    });
    return cleanup;
  }

  async function setup(env: PluginEnv): Promise<void> {
    assertActive(env.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => {
        invalidate(timeout);
        reject(timeout);
      }, setupTimeoutMs);
    });
    const pending = Promise.resolve().then(() => original.setup(guardEnv(env)));
    try {
      // The race observes a late rejection, without awaiting setup after the
      // deadline. The kernel sees rejection now and rolls registrations back.
      await Promise.race([pending, deadline]);
    } catch (error: unknown) {
      invalidate(error);
      void dispose();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function normalize(error: unknown): unknown {
    const visited = new Set<Error>();
    let current = error;
    while (current instanceof Error && !visited.has(current)) {
      if (current === timeout) {
        return new PluginHostError('plugin-setup-timeout', timeout.message, {
          cause: error,
          pluginId: original.manifest.id,
        });
      }
      visited.add(current);
      current = current.cause;
    }
    return error;
  }

  return {
    plugin: {
      manifest: original.manifest,
      setup,
      dispose,
    },
    dispose,
    normalize,
    get cleanupErrors() {
      return Object.freeze([...cleanupErrors]);
    },
  };
}
