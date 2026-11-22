import type { ExtensionCollector, ExtensionPoint } from './extension-point.js';
import { PluginError, type PluginErrorCode } from './plugin-errors.js';

/**
 * Typed service machinery for the plugin kernel.
 *
 * A {@link ServiceRef} is a typed, scoped reference; a plugin provides an
 * implementation with declared dependencies, and the {@link ServiceContainer}
 * resolves them lazily per scope. Dependency problems (missing, cyclic,
 * duplicate, scope-violating) are reported by {@link ServiceContainer.validate}
 * before anything runs, so a misconfigured plugin set fails fast instead of at
 * request time.
 */

/** Lifetime of a service instance. */
export type ServiceScope = 'root' | 'workspace' | 'session';

/** Coarser scopes rank lower; a service may only depend on an equal or coarser scope. */
const scopeRank: Record<ServiceScope, number> = { root: 0, workspace: 1, session: 2 };

/** The fixed key of the single root scope. */
export const rootScopeKey = 'root';

/** A typed, scoped reference to a service contract. */
export interface ServiceRef<T> {
  readonly id: string;
  readonly scope: ServiceScope;
  /** When true, many implementations are collected; {@link ServiceContainer.resolveAll}. */
  readonly multi: boolean;
  /** Phantom carrier of the service type; never set at runtime. */
  readonly __type?: T;
}

/** Defines a typed service reference. Scope defaults to `root`, single implementation. */
export function defineServiceRef<T>(spec: {
  id: string;
  scope?: ServiceScope;
  multi?: boolean;
}): ServiceRef<T> {
  return Object.freeze({
    id: spec.id,
    scope: spec.scope ?? 'root',
    multi: spec.multi ?? false,
  }) as ServiceRef<T>;
}

/** A named set of service dependencies declared by an implementation. */
export type DepMap = Readonly<Record<string, ServiceRef<unknown>>>;

/** Resolves a {@link DepMap} to the record of concrete service values. */
export type Resolved<D extends DepMap> = {
  readonly [K in keyof D]: D[K] extends ServiceRef<infer T> ? T : never;
};

/** Context handed to a service factory during instantiation. */
export interface ServiceInitContext {
  /** Aborted when the owning scope is disposed. */
  readonly signal: AbortSignal;
  /** The scope the instance belongs to. */
  readonly scope: ServiceScope;
  /** The scope key (`root`, or a workspace/session identifier). */
  readonly scopeKey: string;
  /** Collects contributions to an extension point this service owns. */
  readonly collect: ExtensionCollector;
}

/** A service implementation: dependencies, a factory and an optional disposer. */
export interface ServiceConsumer {
  readonly pluginId: string;
}

export interface ServiceImpl<T, D extends DepMap = DepMap> {
  readonly deps?: D;
  readonly factory: (deps: Resolved<D>, context: ServiceInitContext) => T | Promise<T>;
  readonly dispose?: (value: T) => void | Promise<void>;
  /** The provider's policy for a plugin consumer; host resolution remains raw. */
  readonly forConsumer?: (value: T, consumer: ServiceConsumer) => T | Promise<T>;
}

/** Removes a registration or instance; calling twice is a no-op. */
export type Disposer = () => void;

interface Registration {
  readonly ref: ServiceRef<unknown>;
  readonly impl: ServiceImpl<unknown, DepMap>;
  readonly pluginId: string;
}

/** A resolver bound to one scope instance; coarser deps delegate to the parent. */
export interface ScopeContext {
  readonly scope: ServiceScope;
  readonly key: string;
  readonly signal: AbortSignal;
  resolve<T>(ref: ServiceRef<T>): Promise<T>;
  resolveAll<T>(ref: ServiceRef<T>): Promise<readonly T[]>;
  /** Kernel-only resolution with a captured plugin identity. */
  resolveForPlugin<T>(ref: ServiceRef<T>, pluginId: string): Promise<T>;
  resolveAllForPlugin<T>(ref: ServiceRef<T>, pluginId: string): Promise<readonly T[]>;
  dispose(): Promise<void>;
}

function depsOf(registration: Registration): readonly ServiceRef<unknown>[] {
  const deps = registration.impl.deps;
  return deps === undefined ? [] : Object.values(deps);
}

/** Internal snapshot shared with PluginEnv's permission accounting. */
export function captureServiceRef<T>(ref: ServiceRef<T>): ServiceRef<T> {
  return Object.freeze({ id: ref.id, scope: ref.scope, multi: ref.multi });
}

/** Internal snapshot: permission accounting and resolution use the same deps. */
export function captureServiceImpl<T, D extends DepMap>(
  impl: ServiceImpl<T, D>,
): ServiceImpl<T, D> {
  const { deps, factory, dispose, forConsumer } = impl;
  return Object.freeze({
    ...(deps === undefined
      ? {}
      : {
          deps: Object.freeze(
            Object.fromEntries(
              Object.entries(deps).map(([name, dep]) => [name, captureServiceRef(dep)]),
            ),
          ) as D,
        }),
    factory,
    ...(dispose === undefined ? {} : { dispose }),
    ...(forConsumer === undefined ? {} : { forConsumer }),
  });
}

function assertMatchingRef(request: ServiceRef<unknown>, actual: ServiceRef<unknown>): void {
  if (request.scope !== actual.scope || request.multi !== actual.multi) {
    throw new PluginError(
      'plugin-service-scope-violation',
      `Service "${actual.id}" reference does not match its registered scope or multiplicity`,
    );
  }
}

/** Holds service registrations and resolves them lazily per scope. */
export class ServiceContainer {
  readonly #registrations = new Map<string, Registration[]>();
  #rootScope: ScopeContextImpl | undefined;
  readonly #rootAbort = new AbortController();
  readonly #collect: ExtensionCollector;

  constructor(options: { collect?: ExtensionCollector } = {}) {
    this.#collect = options.collect ?? (<T>(_point: ExtensionPoint<T>, api: T): T => api);
  }

  /** Registers one implementation of `ref`. Returns a disposer that unregisters it. */
  register<T, D extends DepMap>(
    ref: ServiceRef<T>,
    impl: ServiceImpl<T, D>,
    pluginId: string,
  ): Disposer {
    const capturedRef = captureServiceRef(ref);
    const capturedImpl = captureServiceImpl(impl);
    const registration: Registration = Object.freeze({
      ref: capturedRef,
      impl: capturedImpl as unknown as ServiceImpl<unknown, DepMap>,
      pluginId,
    });
    const existing = this.#registrations.get(capturedRef.id);
    if (existing === undefined) {
      this.#registrations.set(capturedRef.id, [registration]);
    } else {
      existing.push(registration);
    }
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const list = this.#registrations.get(capturedRef.id);
      if (list === undefined) {
        return;
      }
      const index = list.indexOf(registration);
      if (index >= 0) {
        list.splice(index, 1);
      }
      if (list.length === 0) {
        this.#registrations.delete(capturedRef.id);
      }
    };
  }

  /** Validates the whole registration set; throws the first structural problem. */
  validate(): void {
    this.#checkDuplicatesAndScope();
    this.#checkMissingAndCycles();
  }

  #checkDuplicatesAndScope(): void {
    for (const [id, list] of this.#registrations) {
      const first = list[0];
      if (first === undefined) {
        continue;
      }
      if (!first.ref.multi && list.length > 1) {
        // The last to register is the one that made it a duplicate.
        const latest = list[list.length - 1];
        throw new PluginError(
          'plugin-service-duplicate',
          `Service "${id}" has ${list.length} implementations but is single-implementation ` +
            `(from plugins ${list.map((item) => item.pluginId).join(', ')})`,
          { pluginId: latest?.pluginId },
        );
      }
      for (const registration of list) {
        assertMatchingRef(registration.ref, first.ref);
        for (const dep of depsOf(registration)) {
          if (scopeRank[dep.scope] > scopeRank[registration.ref.scope]) {
            throw new PluginError(
              'plugin-service-scope-violation',
              `Service "${id}" (${registration.ref.scope}) from plugin "${registration.pluginId}" ` +
                `cannot depend on finer-scoped service "${dep.id}" (${dep.scope})`,
              { pluginId: registration.pluginId },
            );
          }
        }
      }
    }
  }

  #checkMissingAndCycles(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    const walk = (id: string, requiredBy: string | undefined, requiredByPlugin?: string): void => {
      const list = this.#registrations.get(id);
      if (list === undefined || list.length === 0) {
        throw new PluginError(
          'plugin-service-missing-dependency',
          requiredBy === undefined
            ? `Service "${id}" has no implementation`
            : `Service "${id}" required by "${requiredBy}" has no implementation`,
          { pluginId: requiredByPlugin },
        );
      }
      if (visited.has(id)) {
        return;
      }
      if (visiting.has(id)) {
        const cycle = [...stack.slice(stack.indexOf(id)), id].join(' -> ');
        throw new PluginError('plugin-service-cycle', `Service dependency cycle: ${cycle}`);
      }
      visiting.add(id);
      stack.push(id);
      for (const registration of list) {
        for (const dep of depsOf(registration)) {
          const target = this.#registrations.get(dep.id)?.[0];
          if (target !== undefined) assertMatchingRef(dep, target.ref);
          walk(dep.id, id, registration.pluginId);
        }
      }
      stack.pop();
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.#registrations.keys()) {
      walk(id, undefined);
    }
  }

  /** The lazily-created root scope. */
  rootScope(): ScopeContext {
    if (this.#rootScope === undefined) {
      this.#rootScope = new ScopeContextImpl(
        'root',
        rootScopeKey,
        this.#rootAbort.signal,
        this,
        undefined,
        this.#collect,
      );
    }
    return this.#rootScope;
  }

  /** Creates a child scope (`workspace` or `session`) under `parent`. */
  createScope(scope: 'workspace' | 'session', key: string, parent: ScopeContext): ScopeContext {
    return new ScopeContextImpl(
      scope,
      key,
      parent.signal,
      this,
      parent as ScopeContextImpl,
      this.#collect,
    );
  }

  /** Disposes the root scope and every instance created under it. */
  async dispose(): Promise<void> {
    this.#rootAbort.abort();
    if (this.#rootScope !== undefined) {
      await this.#rootScope.dispose();
      this.#rootScope = undefined;
    }
  }

  /** Internal: registrations for a reference id, in registration order. */
  registrationsFor(id: string): readonly Registration[] {
    return this.#registrations.get(id) ?? [];
  }
}

interface LiveInstance {
  readonly value: unknown;
  readonly dispose?: (value: unknown) => void | Promise<void>;
}

interface CollectedFailure {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly pluginId: string | undefined;
  readonly cause: unknown;
  readonly stack: string | undefined;
}

class ScopeContextImpl implements ScopeContext {
  readonly scope: ServiceScope;
  readonly key: string;
  readonly signal: AbortSignal;
  readonly #container: ServiceContainer;
  readonly #parent: ScopeContextImpl | undefined;
  readonly #collect: ExtensionCollector;
  readonly #instances = new Map<Registration, Promise<unknown>>();
  readonly #views = new Map<Registration, Map<string, Promise<unknown>>>();
  readonly #live: LiveInstance[] = [];
  readonly #abort = new AbortController();
  #closed = false;
  #disposal: Promise<void> | undefined;

  constructor(
    scope: ServiceScope,
    key: string,
    parentSignal: AbortSignal,
    container: ServiceContainer,
    parent: ScopeContextImpl | undefined,
    collect: ExtensionCollector,
  ) {
    this.scope = scope;
    this.key = key;
    this.#container = container;
    this.#parent = parent;
    this.#collect = collect;
    if (parentSignal.aborted) this.#abort.abort();
    else parentSignal.addEventListener('abort', () => this.#abort.abort(), { once: true });
    this.signal = this.#abort.signal;
  }

  #assertOpen(): void {
    if (this.#closed || this.signal.aborted) {
      throw new PluginError(
        'plugin-service-scope-violation',
        `Service scope "${this.key}" is disposed`,
      );
    }
  }

  async resolve<T>(ref: ServiceRef<T>): Promise<T> {
    return this.#last(ref, await this.#resolveAll(ref));
  }

  resolveAll<T>(ref: ServiceRef<T>): Promise<readonly T[]> {
    return this.#resolveAll(ref);
  }

  async resolveForPlugin<T>(ref: ServiceRef<T>, pluginId: string): Promise<T> {
    return this.#last(ref, await this.#resolveAll(ref, pluginId));
  }

  resolveAllForPlugin<T>(ref: ServiceRef<T>, pluginId: string): Promise<readonly T[]> {
    return this.#resolveAll(ref, pluginId);
  }

  #last<T>(ref: ServiceRef<T>, all: readonly T[]): T {
    if (all.length === 0) {
      throw new PluginError(
        'plugin-service-missing-dependency',
        `Service "${ref.id}" has no implementation`,
      );
    }
    return all[all.length - 1] as T;
  }

  async #resolveAll<T>(request: ServiceRef<T>, pluginId?: string): Promise<readonly T[]> {
    this.#assertOpen();
    const ref = captureServiceRef(request);
    const registrations = this.#container.registrationsFor(ref.id);
    const actual = registrations[0]?.ref;
    if (actual === undefined) return [];
    for (const registration of registrations) assertMatchingRef(ref, registration.ref);
    const refRank = scopeRank[actual.scope];
    const myRank = scopeRank[this.scope];
    if (refRank < myRank) {
      if (this.#parent === undefined) {
        throw new PluginError(
          'plugin-service-scope-violation',
          `Service "${actual.id}" cannot be resolved from scope "${this.scope}"`,
        );
      }
      const values = await this.#parent.#resolveAll(ref, pluginId);
      this.#assertOpen();
      return values;
    }
    if (refRank > myRank) {
      throw new PluginError(
        'plugin-service-scope-violation',
        `Service "${actual.id}" (${actual.scope}) is finer-scoped than the resolving scope "${this.scope}"`,
      );
    }
    const values = await Promise.all(
      registrations.map((registration) =>
        pluginId === undefined
          ? this.#instantiate(registration)
          : this.#forConsumer(registration, pluginId),
      ),
    );
    this.#assertOpen();
    return values as readonly T[];
  }

  #forConsumer(registration: Registration, pluginId: string): Promise<unknown> {
    let consumers = this.#views.get(registration);
    if (consumers === undefined) {
      consumers = new Map();
      this.#views.set(registration, consumers);
    }
    const cached = consumers.get(pluginId);
    if (cached !== undefined) return cached;
    const promise = (async () => {
      // Factory/dependency failures retain their own attribution; only this
      // policy's failure belongs to the consumer rather than its provider.
      const value = await this.#instantiate(registration);
      this.#assertOpen();
      const policy = registration.impl.forConsumer;
      if (policy === undefined) return value;
      let view: unknown;
      try {
        view = await policy(value, Object.freeze({ pluginId }));
      } catch (cause: unknown) {
        throw new PluginError(
          'plugin-contribution-failed',
          `Service "${registration.ref.id}" rejected consumer "${pluginId}"`,
          { cause, pluginId },
        );
      }
      this.#assertOpen();
      return view;
    })();
    consumers.set(pluginId, promise);
    return promise;
  }

  #instantiate(registration: Registration): Promise<unknown> {
    const cached = this.#instances.get(registration);
    if (cached !== undefined) return cached;
    const promise = (async () => {
      const deps = registration.impl.deps ?? {};
      const resolvedEntries = await Promise.all(
        Object.entries(deps).map(
          async ([name, depRef]) =>
            [name, await this.resolveForPlugin(depRef, registration.pluginId)] as const,
        ),
      );
      this.#assertOpen();
      const resolved = Object.fromEntries(resolvedEntries) as Resolved<DepMap>;
      // Only an exception actually thrown by this invocation's collector can
      // preserve another contributor's attribution through the factory.
      const collectedFailures = new Map<unknown, CollectedFailure>();
      const collect: ExtensionCollector = (point, api) => {
        try {
          return this.#collect(point, api);
        } catch (error: unknown) {
          if (error instanceof PluginError && !collectedFailures.has(error)) {
            collectedFailures.set(error, {
              code: error.code,
              message: error.message,
              pluginId: error.pluginId,
              cause: error.cause,
              stack: error.stack,
            });
          }
          throw error;
        }
      };
      let value: unknown;
      try {
        value = await registration.impl.factory(resolved, {
          signal: this.signal,
          scope: this.scope,
          scopeKey: this.key,
          collect,
        });
      } catch (error: unknown) {
        const captured = collectedFailures.get(error);
        if (captured !== undefined) {
          const copy = new PluginError(captured.code, captured.message, {
            pluginId: captured.pluginId ?? registration.pluginId,
            ...(captured.cause === undefined ? {} : { cause: captured.cause }),
          });
          if (captured.stack !== undefined) copy.stack = captured.stack;
          throw copy;
        }
        if (error instanceof PluginError) {
          throw new PluginError(error.code, error.message, {
            pluginId: registration.pluginId,
            cause: error,
          });
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new PluginError(
          'plugin-contribution-failed',
          `Service "${registration.ref.id}" from plugin "${registration.pluginId}" failed to initialise: ${detail}`,
          { pluginId: registration.pluginId, cause: error },
        );
      }
      if (this.#closed || this.signal.aborted) {
        await registration.impl.dispose?.(value);
        this.#assertOpen();
      }
      this.#live.push({
        value,
        ...(registration.impl.dispose === undefined ? {} : { dispose: registration.impl.dispose }),
      });
      return value;
    })();
    this.#instances.set(registration, promise);
    return promise;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    this.#disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    this.#closed = true;
    // Abort listeners and raw disposers may reenter dispose synchronously.
    // Publish the shared promise before either callback can run.
    this.#abort.abort();
    void this.#disposeLive().then(resolveDisposal, rejectDisposal);
    return this.#disposal;
  }

  async #disposeLive(): Promise<void> {
    const errors: unknown[] = [];
    for (let index = this.#live.length - 1; index >= 0; index -= 1) {
      const instance = this.#live[index];
      if (instance?.dispose === undefined) continue;
      try {
        await instance.dispose(instance.value);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    this.#live.length = 0;
    this.#instances.clear();
    this.#views.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Service disposal failed');
  }
}
