import { PluginError } from './plugin-errors.js';

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
}

/** A service implementation: dependencies, a factory and an optional disposer. */
export interface ServiceImpl<T, D extends DepMap = DepMap> {
  readonly deps?: D;
  readonly factory: (deps: Resolved<D>, context: ServiceInitContext) => T | Promise<T>;
  readonly dispose?: (value: T) => void | Promise<void>;
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
  dispose(): Promise<void>;
}

function depsOf(registration: Registration): readonly ServiceRef<unknown>[] {
  const deps = registration.impl.deps;
  return deps === undefined ? [] : Object.values(deps);
}

/** Holds service registrations and resolves them lazily per scope. */
export class ServiceContainer {
  readonly #registrations = new Map<string, Registration[]>();
  #rootScope: ScopeContextImpl | undefined;
  readonly #rootAbort = new AbortController();

  /** Registers one implementation of `ref`. Returns a disposer that unregisters it. */
  register<T, D extends DepMap>(
    ref: ServiceRef<T>,
    impl: ServiceImpl<T, D>,
    pluginId: string,
  ): Disposer {
    const registration: Registration = {
      ref,
      impl: impl as unknown as ServiceImpl<unknown, DepMap>,
      pluginId,
    };
    const existing = this.#registrations.get(ref.id);
    if (existing === undefined) {
      this.#registrations.set(ref.id, [registration]);
    } else {
      existing.push(registration);
    }
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const list = this.#registrations.get(ref.id);
      if (list === undefined) {
        return;
      }
      const index = list.indexOf(registration);
      if (index >= 0) {
        list.splice(index, 1);
      }
      if (list.length === 0) {
        this.#registrations.delete(ref.id);
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
        throw new PluginError(
          'plugin-service-duplicate',
          `Service "${id}" has ${list.length} implementations but is single-implementation ` +
            `(from plugins ${list.map((item) => item.pluginId).join(', ')})`,
        );
      }
      for (const registration of list) {
        for (const dep of depsOf(registration)) {
          if (scopeRank[dep.scope] > scopeRank[registration.ref.scope]) {
            throw new PluginError(
              'plugin-service-scope-violation',
              `Service "${id}" (${registration.ref.scope}) from plugin "${registration.pluginId}" ` +
                `cannot depend on finer-scoped service "${dep.id}" (${dep.scope})`,
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

    const walk = (id: string, requiredBy: string | undefined): void => {
      const list = this.#registrations.get(id);
      if (list === undefined || list.length === 0) {
        throw new PluginError(
          'plugin-service-missing-dependency',
          requiredBy === undefined
            ? `Service "${id}" has no implementation`
            : `Service "${id}" required by "${requiredBy}" has no implementation`,
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
          walk(dep.id, id);
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
      );
    }
    return this.#rootScope;
  }

  /** Creates a child scope (`workspace` or `session`) under `parent`. */
  createScope(scope: 'workspace' | 'session', key: string, parent: ScopeContext): ScopeContext {
    return new ScopeContextImpl(scope, key, parent.signal, this, parent as ScopeContextImpl);
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

class ScopeContextImpl implements ScopeContext {
  readonly scope: ServiceScope;
  readonly key: string;
  readonly signal: AbortSignal;
  readonly #container: ServiceContainer;
  readonly #parent: ScopeContextImpl | undefined;
  readonly #instances = new Map<string, Promise<unknown>>();
  readonly #live: LiveInstance[] = [];
  readonly #abort = new AbortController();

  constructor(
    scope: ServiceScope,
    key: string,
    parentSignal: AbortSignal,
    container: ServiceContainer,
    parent: ScopeContextImpl | undefined,
  ) {
    this.scope = scope;
    this.key = key;
    this.#container = container;
    this.#parent = parent;
    if (parentSignal.aborted) {
      this.#abort.abort();
    } else {
      parentSignal.addEventListener('abort', () => this.#abort.abort(), { once: true });
    }
    this.signal = this.#abort.signal;
  }

  async resolve<T>(ref: ServiceRef<T>): Promise<T> {
    const all = await this.resolveAll(ref);
    const value = all[all.length - 1];
    if (value === undefined && all.length === 0) {
      throw new PluginError(
        'plugin-service-missing-dependency',
        `Service "${ref.id}" has no implementation`,
      );
    }
    return value as T;
  }

  async resolveAll<T>(ref: ServiceRef<T>): Promise<readonly T[]> {
    const refRank = scopeRank[ref.scope];
    const myRank = scopeRank[this.scope];
    if (refRank < myRank) {
      if (this.#parent === undefined) {
        throw new PluginError(
          'plugin-service-scope-violation',
          `Service "${ref.id}" (${ref.scope}) cannot be resolved from scope "${this.scope}"`,
        );
      }
      return this.#parent.resolveAll(ref);
    }
    if (refRank > myRank) {
      throw new PluginError(
        'plugin-service-scope-violation',
        `Service "${ref.id}" (${ref.scope}) is finer-scoped than the resolving scope "${this.scope}"`,
      );
    }
    const registrations = this.#container.registrationsFor(ref.id);
    const values = await Promise.all(
      registrations.map((registration, index) => this.#instantiate(ref, registration, index)),
    );
    return values as readonly T[];
  }

  #instantiate(
    ref: ServiceRef<unknown>,
    registration: Registration,
    index: number,
  ): Promise<unknown> {
    const cacheKey = `${ref.id}#${String(index)}`;
    const cached = this.#instances.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const promise = (async () => {
      const deps = registration.impl.deps ?? {};
      const resolvedEntries = await Promise.all(
        Object.entries(deps).map(
          async ([name, depRef]) => [name, await this.resolve(depRef)] as const,
        ),
      );
      const resolved = Object.fromEntries(resolvedEntries) as Resolved<DepMap>;
      const value = await registration.impl.factory(resolved, {
        signal: this.signal,
        scope: this.scope,
        scopeKey: this.key,
      });
      this.#live.push({
        value,
        ...(registration.impl.dispose === undefined
          ? {}
          : { dispose: registration.impl.dispose as (value: unknown) => void | Promise<void> }),
      });
      return value;
    })();
    this.#instances.set(cacheKey, promise);
    return promise;
  }

  async dispose(): Promise<void> {
    this.#abort.abort();
    const errors: unknown[] = [];
    for (let index = this.#live.length - 1; index >= 0; index -= 1) {
      const instance = this.#live[index];
      if (instance?.dispose === undefined) {
        continue;
      }
      try {
        await instance.dispose(instance.value);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    this.#live.length = 0;
    this.#instances.clear();
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Service disposal failed');
    }
  }
}
