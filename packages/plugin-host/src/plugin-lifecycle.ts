import { type KernelPlugin, type PluginEnv } from '@weave/plugin';

import { ExplicitLocalAuthorityError, PluginHostError } from './errors.js';

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
  attemptSignal?: AbortSignal,
  options?: { readonly drainSetupOnDispose?: boolean },
): PluginLifecycle {
  const abort = new AbortController();
  const timeout = new Error(`Plugin "${original.manifest.id}" setup exceeded ${setupTimeoutMs}ms`);
  let invalid = false;
  let cleanup: Promise<void> | undefined;
  let setupSettled: Promise<void> | undefined;
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
    const signals = [env.signal, abort.signal];
    if (attemptSignal !== undefined) signals.push(attemptSignal);
    const signal = AbortSignal.any(signals);
    assertActive(signal);
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
      if (setupSettled !== undefined) await setupSettled;
    });
    return cleanup;
  }

  async function setup(env: PluginEnv): Promise<void> {
    attemptSignal?.throwIfAborted();
    assertActive(env.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => {
        invalidate(timeout);
        reject(timeout);
      }, setupTimeoutMs);
    });
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (attemptSignal === undefined) return;
      onAbort = () => {
        invalidate(attemptSignal.reason);
        reject(attemptSignal.reason);
      };
      attemptSignal.addEventListener('abort', onAbort, { once: true });
    });
    let authorityFailure: ExplicitLocalAuthorityError | undefined;
    const pending = Promise.resolve().then(() => {
      const guardedEnv = guardEnv(env);
      try {
        return original.setup(guardedEnv);
      } catch (error: unknown) {
        // A guard can abort the attempt synchronously before throwing its marker.
        if (options?.drainSetupOnDispose && error instanceof ExplicitLocalAuthorityError) {
          authorityFailure = error;
        }
        throw error;
      }
    });
    if (options?.drainSetupOnDispose) {
      setupSettled = pending.then(
        () => undefined,
        () => undefined,
      );
    }
    try {
      // The race observes a late rejection, without awaiting setup after the
      // deadline. The kernel sees rejection now and rolls registrations back.
      await Promise.race([pending, deadline, cancelled]);
    } catch (error: unknown) {
      const failure = authorityFailure ?? error;
      invalidate(failure);
      void dispose();
      throw failure;
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) attemptSignal?.removeEventListener('abort', onAbort);
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
