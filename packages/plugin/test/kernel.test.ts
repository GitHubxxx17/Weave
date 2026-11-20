import { describe, expect, it, vi } from 'vitest';

import { defineExtensionPoint } from '../src/extension-point.js';
import { defineHook } from '../src/hook.js';
import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import { PluginError } from '../src/plugin-errors.js';
import { defineServiceRef } from '../src/service.js';

function manifest(id: string, over: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: ['tool'], ...over };
}

describe('createPluginKernel', () => {
  it('runs setup and resolves a provided service through the sealed generation', async () => {
    const ref = defineServiceRef<number>({ id: 'answer' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('p'),
        setup(env) {
          env.provide(ref, { factory: () => 42 });
        },
      }),
    );
    const generation = await kernel.seal();
    expect(generation.pluginIds).toContain('p');
    expect(await generation.resolve(ref)).toBe(42);
    await kernel.dispose();
  });

  it('wires a dependency across two plugins', async () => {
    const aRef = defineServiceRef<number>({ id: 'a' });
    const bRef = defineServiceRef<number>({ id: 'b' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('pa'),
        setup(env) {
          env.provide(aRef, { factory: () => 2 });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('pb'),
        setup(env) {
          env.provide(bRef, { deps: { a: aRef }, factory: ({ a }) => a * 10 });
        },
      }),
    );
    const generation = await kernel.seal();
    expect(await generation.resolve(bRef)).toBe(20);
    await kernel.dispose();
  });

  it('seal throws when a dependency is missing', async () => {
    const aRef = defineServiceRef<number>({ id: 'a' });
    const bRef = defineServiceRef<number>({ id: 'b' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('pb'),
        setup(env) {
          env.provide(bRef, { deps: { a: aRef }, factory: () => 1 });
        },
      }),
    );
    await expect(kernel.seal()).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects a duplicate plugin id', async () => {
    const kernel = createPluginKernel();
    await kernel.register(definePlugin({ manifest: manifest('dup'), setup: () => undefined }));
    await expect(
      kernel.register(definePlugin({ manifest: manifest('dup'), setup: () => undefined })),
    ).rejects.toThrowError(/already registered/);
  });

  it('rejects an unsupported api version', async () => {
    const kernel = createPluginKernel();
    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('old', { apiVersion: '0.9.0' }),
          setup: () => undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('reclaims a plugin contributions and hooks on dispose', async () => {
    const point = defineExtensionPoint<{ add(name: string): void }>({ id: 'tools' });
    const hook = defineHook<number>({ id: 'h', mode: 'observe' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('p'),
        setup(env) {
          env.contribute(point, (api) => api.add('x'));
          env.onHook(hook, () => undefined);
        },
      }),
    );
    await kernel.seal();
    expect(kernel.extensions.count(point)).toBe(1);
    expect(kernel.hooks.count(hook)).toBe(1);
    await kernel.dispose();
    expect(kernel.extensions.count(point)).toBe(0);
    expect(kernel.hooks.count(hook)).toBe(0);
  });

  it('runs plugin.dispose on dispose', async () => {
    const disposed = vi.fn();
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({ manifest: manifest('p'), setup: () => undefined, dispose: disposed }),
    );
    await kernel.seal();
    await kernel.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('rejects registering after seal', async () => {
    const kernel = createPluginKernel();
    await kernel.seal();
    await expect(
      kernel.register(definePlugin({ manifest: manifest('late'), setup: () => undefined })),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('lets a service owner collect extension-point contributions, order-independent', async () => {
    const point = defineExtensionPoint<{ add(name: string): void }>({ id: 'items' });
    const collectedRef = defineServiceRef<string[]>({ id: 'collected' });
    const kernel = createPluginKernel();
    // Owner is registered BEFORE the contributor; collection still sees it.
    await kernel.register(
      definePlugin({
        manifest: manifest('owner'),
        setup(env) {
          env.provide(collectedRef, {
            factory: (_deps, context) => {
              const items: string[] = [];
              context.collect(point, { add: (name) => items.push(name) });
              return items;
            },
          });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('contrib'),
        setup(env) {
          env.contribute(point, (api) => api.add('x'));
        },
      }),
    );
    const generation = await kernel.seal();
    expect(await generation.resolve(collectedRef)).toEqual(['x']);
    await kernel.dispose();
  });

  it('rolls back registrations when setup throws', async () => {
    const ref = defineServiceRef<number>({ id: 'a' });
    const kernel = createPluginKernel();
    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('bad'),
          setup(env) {
            env.provide(ref, { factory: () => 1 });
            throw new Error('boom');
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PluginError);
    const generation = await kernel.seal();
    await expect(generation.resolve(ref)).rejects.toBeInstanceOf(PluginError);
  });
});
