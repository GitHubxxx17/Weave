import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '../src/plugin-errors.js';
import { ServiceContainer, defineServiceRef } from '../src/service.js';

describe('defineServiceRef', () => {
  it('defaults to root scope and single implementation', () => {
    const ref = defineServiceRef({ id: 'a' });
    expect(ref.scope).toBe('root');
    expect(ref.multi).toBe(false);
  });
});

describe('ServiceContainer root resolution', () => {
  it('resolves and memoizes a root service', async () => {
    const ref = defineServiceRef<{ n: number }>({ id: 'svc.a' });
    const container = new ServiceContainer();
    const factory = vi.fn(() => ({ n: 1 }));
    container.register(ref, { factory }, 'p');
    container.validate();
    const root = container.rootScope();
    const first = await root.resolve(ref);
    const second = await root.resolve(ref);
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('resolves declared dependencies and passes them to the factory', async () => {
    const aRef = defineServiceRef<number>({ id: 'a' });
    const bRef = defineServiceRef<number>({ id: 'b' });
    const container = new ServiceContainer();
    container.register(aRef, { factory: () => 2 }, 'p');
    container.register(bRef, { deps: { a: aRef }, factory: ({ a }) => a + 3 }, 'p');
    container.validate();
    expect(await container.rootScope().resolve(bRef)).toBe(5);
  });
});

describe('ServiceContainer.validate', () => {
  it('throws on a missing dependency', () => {
    const aRef = defineServiceRef<number>({ id: 'a' });
    const bRef = defineServiceRef<number>({ id: 'b' });
    const container = new ServiceContainer();
    container.register(bRef, { deps: { a: aRef }, factory: () => 1 }, 'p');
    try {
      container.validate();
      throw new Error('expected validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe('plugin-service-missing-dependency');
    }
  });

  it('throws on a dependency cycle', () => {
    const aRef = defineServiceRef<number>({ id: 'a' });
    const bRef = defineServiceRef<number>({ id: 'b' });
    const container = new ServiceContainer();
    container.register(aRef, { deps: { b: bRef }, factory: () => 1 }, 'p');
    container.register(bRef, { deps: { a: aRef }, factory: () => 1 }, 'p');
    try {
      container.validate();
      throw new Error('expected validation to throw');
    } catch (error) {
      expect((error as PluginError).code).toBe('plugin-service-cycle');
    }
  });

  it('throws on duplicate single-implementation and allows multi', () => {
    const single = defineServiceRef<number>({ id: 's' });
    const multi = defineServiceRef<number>({ id: 'm', multi: true });
    const single1 = new ServiceContainer();
    single1.register(single, { factory: () => 1 }, 'p1');
    single1.register(single, { factory: () => 2 }, 'p2');
    expect(() => single1.validate()).toThrowError(/single-implementation/);
    const multi1 = new ServiceContainer();
    multi1.register(multi, { factory: () => 1 }, 'p1');
    multi1.register(multi, { factory: () => 2 }, 'p2');
    expect(() => multi1.validate()).not.toThrow();
  });

  it('rejects depending on a finer scope', () => {
    const rootRef = defineServiceRef<number>({ id: 'r', scope: 'root' });
    const sessionRef = defineServiceRef<number>({ id: 's', scope: 'session' });
    const container = new ServiceContainer();
    container.register(rootRef, { deps: { s: sessionRef }, factory: () => 1 }, 'p');
    container.register(sessionRef, { factory: () => 1 }, 'p');
    try {
      container.validate();
      throw new Error('expected validation to throw');
    } catch (error) {
      expect((error as PluginError).code).toBe('plugin-service-scope-violation');
    }
  });
});

describe('ServiceContainer multi and scopes', () => {
  it('resolveAll returns all implementations in registration order', async () => {
    const ref = defineServiceRef<number>({ id: 'm', multi: true });
    const container = new ServiceContainer();
    container.register(ref, { factory: () => 1 }, 'p1');
    container.register(ref, { factory: () => 2 }, 'p2');
    container.validate();
    expect(await container.rootScope().resolveAll(ref)).toEqual([1, 2]);
  });

  it('instantiates a session service in a session scope and disposes it', async () => {
    const rootRef = defineServiceRef<number>({ id: 'cfg', scope: 'root' });
    const sessionRef = defineServiceRef<{ id: string }>({ id: 'sess', scope: 'session' });
    const disposed: string[] = [];
    const container = new ServiceContainer();
    container.register(rootRef, { factory: () => 10 }, 'p');
    container.register(
      sessionRef,
      {
        deps: { cfg: rootRef },
        factory: ({ cfg }, context) => ({ id: `${context.scopeKey}:${String(cfg)}` }),
        dispose: (value) => {
          disposed.push(value.id);
        },
      },
      'p',
    );
    container.validate();
    const session = container.createScope('session', 'sess-1', container.rootScope());
    const value = await session.resolve(sessionRef);
    expect(value.id).toBe('sess-1:10');
    await session.dispose();
    expect(disposed).toEqual(['sess-1:10']);
  });

  it('rejects resolving a finer-scoped service from the root scope', async () => {
    const sessionRef = defineServiceRef<number>({ id: 'sess', scope: 'session' });
    const container = new ServiceContainer();
    container.register(sessionRef, { factory: () => 1 }, 'p');
    container.validate();
    await expect(container.rootScope().resolve(sessionRef)).rejects.toBeInstanceOf(PluginError);
  });

  it('disposes root services on container dispose', async () => {
    const ref = defineServiceRef<number>({ id: 'a' });
    const disposed: number[] = [];
    const container = new ServiceContainer();
    container.register(
      ref,
      {
        factory: () => 7,
        dispose: (value) => {
          disposed.push(value);
        },
      },
      'p',
    );
    container.validate();
    await container.rootScope().resolve(ref);
    await container.dispose();
    expect(disposed).toEqual([7]);
  });
});

describe('consumer-bound service views', () => {
  it('keeps host resolution raw and caches distinct concurrent consumer views', async () => {
    const ref = defineServiceRef<{ owner: string }>({ id: 'writer' });
    const raw = { owner: 'host' };
    const calls: string[] = [];
    const disposed: unknown[] = [];
    const container = new ServiceContainer();
    container.register(
      ref,
      {
        factory: () => raw,
        forConsumer: async (value, consumer) => {
          calls.push(consumer.pluginId);
          await Promise.resolve();
          return { owner: `${value.owner}:${consumer.pluginId}` };
        },
        dispose: (value) => {
          disposed.push(value);
        },
      },
      'host',
    );
    const scope = container.rootScope();
    expect(await scope.resolve(ref)).toBe(raw);
    const [first, concurrent] = await Promise.all([
      scope.resolveForPlugin(ref, 'first'),
      scope.resolveForPlugin(ref, 'first'),
    ]);
    expect(first).toBe(concurrent);
    expect(first.owner).toBe('host:first');
    expect((await scope.resolveForPlugin(ref, 'second')).owner).toBe('host:second');
    expect(calls).toEqual(['first', 'second']);
    await scope.dispose();
    expect(disposed).toEqual([raw]);
  });

  it('binds factory dependencies to their provider rather than the outer requester', async () => {
    const ref = defineServiceRef<string>({ id: 'writer' });
    const service = defineServiceRef<string>({ id: 'provided' });
    const container = new ServiceContainer();
    container.register(
      ref,
      { factory: () => 'raw', forConsumer: (_value, consumer) => consumer.pluginId },
      'host',
    );
    container.register(
      service,
      { deps: { writer: ref }, factory: ({ writer }) => writer },
      'provider',
    );
    expect(await container.rootScope().resolveForPlugin(service, 'outer')).toBe('provider');
  });

  it('uses actual registration policies for recreated same-id references', async () => {
    const ref = defineServiceRef<string>({ id: 'writer' });
    const container = new ServiceContainer();
    container.register(
      ref,
      { factory: () => 'raw', forConsumer: (_value, consumer) => consumer.pluginId },
      'host',
    );
    expect(
      await container.rootScope().resolveForPlugin(defineServiceRef({ id: ref.id }), 'reader'),
    ).toBe('reader');
    await expect(container.rootScope().resolve({ ...ref, scope: 'session' })).rejects.toMatchObject(
      { code: 'plugin-service-scope-violation' },
    );
    await expect(container.rootScope().resolve({ ...ref, multi: true })).rejects.toMatchObject({
      code: 'plugin-service-scope-violation',
    });
  });

  it('rejects a requesting root alias of a session service', async () => {
    const ref = defineServiceRef<string>({ id: 'session', scope: 'session' });
    const container = new ServiceContainer();
    let calls = 0;
    container.register(
      ref,
      {
        factory: () => {
          calls++;
          return 'value';
        },
      },
      'host',
    );
    await expect(container.rootScope().resolve({ ...ref, scope: 'root' })).rejects.toMatchObject({
      code: 'plugin-service-scope-violation',
    });
    expect(calls).toBe(0);
  });

  it('maps every multi implementation in its owning parent scope', async () => {
    const ref = defineServiceRef<string>({ id: 'multi', multi: true });
    const container = new ServiceContainer();
    for (const raw of ['one', 'two'])
      container.register(
        ref,
        { factory: () => raw, forConsumer: (value, c) => `${value}:${c.pluginId}` },
        raw,
      );
    const root = container.rootScope();
    const child = container.createScope('session', 's', root);
    expect(await child.resolveAllForPlugin(ref, 'reader')).toEqual(['one:reader', 'two:reader']);
    expect(await root.resolveAll(ref)).toEqual(['one', 'two']);
    expect(await child.resolveForPlugin(ref, 'reader')).toBe(
      await root.resolveForPlugin(ref, 'reader'),
    );
  });

  it('captures registration reference, dependency and callback metadata', async () => {
    const ref = { id: 'captured', scope: 'root', multi: false } as const;
    const dependency = { id: 'dependency', scope: 'root', multi: false } as const;
    const deps = { value: dependency };
    const disposed: string[] = [];
    const impl = {
      deps,
      factory: ({ value }: { value: string }) => `old:${value}`,
      forConsumer: (value: string, c: { pluginId: string }) => `${value}:${c.pluginId}`,
      dispose: (value: string) => {
        disposed.push(value);
      },
    };
    const container = new ServiceContainer();
    container.register(dependency, { factory: () => 'dependency' }, 'host');
    container.register(ref, impl, 'provider');
    Object.assign(ref, { id: 'mutated', scope: 'session', multi: true });
    Object.assign(dependency, { id: 'missing', scope: 'session' });
    Object.assign(impl, {
      factory: () => 'new',
      forConsumer: () => 'unbound',
      dispose: () => {
        throw new Error('changed disposer');
      },
    });
    deps.value = defineServiceRef({ id: 'missing' });
    container.validate();
    expect(
      await container.rootScope().resolveForPlugin(defineServiceRef({ id: 'captured' }), 'reader'),
    ).toBe('old:dependency:reader');
    await container.dispose();
    expect(disposed).toEqual(['old:dependency']);
  });

  it('keys raw instances by registration identity after a prior multi entry is removed', async () => {
    const ref = defineServiceRef<object>({ id: 'multi', multi: true });
    const first = {},
      second = {};
    const container = new ServiceContainer();
    const remove = container.register(ref, { factory: () => first }, 'first');
    container.register(ref, { factory: () => second }, 'second');
    expect(await container.rootScope().resolveAll(ref)).toEqual([first, second]);
    remove();
    expect((await container.rootScope().resolveAll(ref))[0]).toBe(second);
  });

  it('attributes a cached consumer-policy rejection to the actual consumer', async () => {
    const ref = defineServiceRef<string>({ id: 'ref' });
    const source = new PluginError('plugin-permission-denied', 'no', { pluginId: 'claimed-other' });
    const container = new ServiceContainer();
    let calls = 0;
    container.register(
      ref,
      {
        factory: () => 'raw',
        forConsumer: () => {
          calls++;
          throw source;
        },
      },
      'provider',
    );
    const scope = container.rootScope();
    for (let i = 0; i < 2; i++)
      await expect(scope.resolveForPlugin(ref, 'actual')).rejects.toMatchObject({
        pluginId: 'actual',
        cause: source,
      });
    expect(calls).toBe(1);
    expect(await scope.resolve(ref)).toBe('raw');
  });

  it('preserves factory failures attribution instead of replacing it with requester', async () => {
    const ref = defineServiceRef<string>({ id: 'ref' });
    const container = new ServiceContainer();
    container.register(
      ref,
      {
        factory: () => {
          throw new Error('factory');
        },
        forConsumer: (value) => value,
      },
      'provider',
    );
    await expect(container.rootScope().resolveForPlugin(ref, 'actual')).rejects.toMatchObject({
      pluginId: 'provider',
    });
  });

  it('rejects resolution after scope disposal and late consumer view publication', async () => {
    const ref = defineServiceRef<string>({ id: 'ref' });
    let finish!: (value: string) => void;
    const container = new ServiceContainer();
    container.register(
      ref,
      {
        factory: () => 'raw',
        forConsumer: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      },
      'provider',
    );
    const scope = container.rootScope();
    const pending = scope.resolveForPlugin(ref, 'actual');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scope.dispose();
    finish('late view');
    await expect(pending).rejects.toMatchObject({ code: 'plugin-service-scope-violation' });
    await expect(scope.resolve(ref)).rejects.toMatchObject({
      code: 'plugin-service-scope-violation',
    });
    await expect(scope.resolveForPlugin(ref, 'actual')).rejects.toMatchObject({
      code: 'plugin-service-scope-violation',
    });
  });

  it('leaves an ordinary service value identity unchanged for consumers', async () => {
    const ref = defineServiceRef<object>({ id: 'ref' }),
      raw = {};
    const container = new ServiceContainer();
    container.register(ref, { factory: () => raw }, 'provider');
    expect(await container.rootScope().resolveForPlugin(ref, 'reader')).toBe(raw);
  });
});

describe('service resolution closure and captured authority', () => {
  it('does not start a factory after a pending dependency resolves into a disposed scope', async () => {
    const dependency = defineServiceRef<string>({ id: 'dependency' });
    const target = defineServiceRef<string>({ id: 'target' });
    const container = new ServiceContainer();
    let finish!: (value: string) => void;
    let factories = 0;
    const disposed: string[] = [];
    container.register(
      dependency,
      {
        factory: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        dispose: (value) => {
          disposed.push(value);
        },
      },
      'dependency-owner',
    );
    container.register(
      target,
      {
        deps: { dependency },
        factory: () => {
          factories++;
          return 'target';
        },
      },
      'provider',
    );
    const scope = container.rootScope();
    const pending = scope.resolve(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scope.dispose();
    finish('late dependency');
    await expect(pending).rejects.toMatchObject({ code: 'plugin-service-scope-violation' });
    expect(factories).toBe(0);
    expect(disposed).toEqual(['late dependency']);
  });

  it('rejects all registrations of an id with inconsistent metadata', () => {
    const first = defineServiceRef<string>({ id: 'same', multi: true });
    const container = new ServiceContainer();
    container.register(first, { factory: () => 'root' }, 'one');
    container.register({ ...first, scope: 'session' }, { factory: () => 'session' }, 'two');
    expect(() => container.validate()).toThrowError(
      expect.objectContaining({ code: 'plugin-service-scope-violation' }),
    );
  });

  it('preserves dependency consumer failures instead of attributing them to the outer requester', async () => {
    const dependency = defineServiceRef<string>({ id: 'dependency' });
    const target = defineServiceRef<string>({ id: 'target' });
    const container = new ServiceContainer();
    container.register(
      dependency,
      {
        factory: () => 'raw',
        forConsumer: () => {
          throw new Error('policy');
        },
      },
      'dependency-owner',
    );
    container.register(
      target,
      { deps: { dependency }, factory: ({ dependency }) => dependency },
      'provider',
    );
    await expect(container.rootScope().resolveForPlugin(target, 'outer')).rejects.toMatchObject({
      pluginId: 'provider',
    });
  });

  it('rejects new resolution from a child after its parent closes', async () => {
    const ref = defineServiceRef<string>({ id: 'root' });
    const container = new ServiceContainer();
    container.register(ref, { factory: () => 'raw' }, 'provider');
    const parent = container.rootScope(),
      child = container.createScope('session', 'child', parent);
    await parent.dispose();
    await expect(child.resolveForPlugin(ref, 'consumer')).rejects.toMatchObject({
      code: 'plugin-service-scope-violation',
    });
  });
});

describe('reentrant scope disposal', () => {
  it('disposes a raw instance once when its abort listener reenters dispose', async () => {
    const container = new ServiceContainer();
    const ref = defineServiceRef<object>({ id: 'raw' });
    const scope = container.rootScope();
    let calls = 0;
    let reentered: Promise<void> | undefined;
    container.register(
      ref,
      {
        factory: (_deps, { signal }) => {
          signal.addEventListener('abort', () => {
            reentered = scope.dispose();
          });
          return {};
        },
        dispose: () => {
          calls += 1;
        },
      },
      'provider',
    );
    await scope.resolveForPlugin(ref, 'consumer');
    const disposal = scope.dispose();
    expect(reentered).toBe(disposal);
    await disposal;
    await reentered;
    expect(calls).toBe(1);
  });
});

describe('factory error execution provenance', () => {
  it.each(['host', 'consumer'] as const)(
    'forces direct factory errors to their actual provider through %s resolution',
    async (mode) => {
      const ref = defineServiceRef<string>({ id: 'claimed-provider' });
      const source = new PluginError('plugin-permission-denied', 'claimed failure', {
        pluginId: 'innocent',
      });
      const container = new ServiceContainer();
      let calls = 0;
      container.register(
        ref,
        {
          factory: () => {
            calls++;
            throw source;
          },
        },
        'actual-provider',
      );
      const root = container.rootScope();
      const resolve = () =>
        mode === 'host' ? root.resolve(ref) : root.resolveForPlugin(ref, 'outer-consumer');
      for (let i = 0; i < 2; i++)
        await expect(resolve()).rejects.toMatchObject({
          code: source.code,
          message: source.message,
          pluginId: 'actual-provider',
          cause: source,
        });
      expect(calls).toBe(1);
    },
  );

  it('captures collector provenance before a factory can mutate the propagated error', async () => {
    const ref = defineServiceRef<string>({ id: 'collector-owner' });
    const source = new PluginError('plugin-registration-conflict', 'actual conflict', {
      pluginId: 'actual-contributor',
    });
    const container = new ServiceContainer({
      collect: () => {
        throw source;
      },
    });
    container.register(
      ref,
      {
        factory: (_deps, context) => {
          try {
            context.collect({ id: 'point', singleSlot: false }, {});
          } catch (error) {
            Object.assign(error as object, {
              pluginId: 'innocent',
              code: 'plugin-invalid-definition',
              message: 'forged message',
            });
            throw error;
          }
          return 'never';
        },
      },
      'owner-provider',
    );
    await expect(container.rootScope().resolve(ref)).rejects.toMatchObject({
      code: 'plugin-registration-conflict',
      message: 'actual conflict',
      pluginId: 'actual-contributor',
    });
  });

  it('does not treat a copied error as a collector exception from this invocation', async () => {
    const ref = defineServiceRef<string>({ id: 'collector-owner' });
    const source = new PluginError('plugin-registration-conflict', 'actual conflict', {
      pluginId: 'actual-contributor',
    });
    const container = new ServiceContainer({
      collect: () => {
        throw source;
      },
    });
    let copied: PluginError | undefined;
    container.register(
      ref,
      {
        factory: (_deps, context) => {
          try {
            context.collect({ id: 'point', singleSlot: false }, {});
          } catch {
            copied = new PluginError(source.code, source.message, { pluginId: source.pluginId });
            throw copied;
          }
          return 'never';
        },
      },
      'owner-provider',
    );
    const error = await container
      .rootScope()
      .resolve(ref)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ pluginId: 'owner-provider', cause: copied });
  });
});
