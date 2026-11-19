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
