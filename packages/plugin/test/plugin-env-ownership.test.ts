import { describe, expect, it } from 'vitest';
import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { defineServiceRef } from '../src/service.js';
import type { ServiceHandle } from '../src/plugin-env.js';

const manifest = (id: string) => ({
  id,
  name: id,
  version: '0.1.0',
  apiVersion: '1.0.0',
  capabilities: ['tool'] as const,
});

describe('plugin environment service consumer identity', () => {
  it('binds direct use and supplied dependency services to the plugin that consumes them', async () => {
    const writer = defineServiceRef<string>({ id: 'writer' });
    const service = defineServiceRef<string>({ id: 'provided' });
    let direct!: ServiceHandle<string>;
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('host'),
        setup(env) {
          env.provide(writer, {
            factory: () => 'raw',
            forConsumer: (_value, consumer) => consumer.pluginId,
          });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('consumer'),
        setup(env) {
          direct = env.use(defineServiceRef({ id: writer.id }));
          env.provide(service, { deps: { writer }, factory: ({ writer }) => writer });
        },
      }),
    );
    const generation = await kernel.seal();
    expect(await direct.get()).toBe('consumer');
    expect(await generation.resolve(service)).toBe('consumer');
    expect(await generation.resolve(writer)).toBe('raw');
    await kernel.dispose();
  });
});

describe('captured environment service references', () => {
  it('cannot change a permitted service handle into another service after setup', async () => {
    const allowed = defineServiceRef<string>({ id: 'allowed' }),
      secret = defineServiceRef<string>({ id: 'secret' });
    let handle!: ServiceHandle<string>;
    const request = { ...allowed };
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('host'),
        setup(env) {
          env.provide(allowed, { factory: () => 'allowed' });
          env.provide(secret, { factory: () => 'secret' });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: { ...manifest('reader'), contributes: {}, permissions: ['service:allowed'] },
        setup(env) {
          handle = env.use(request);
        },
      }),
    );
    const generation = await kernel.seal();
    Object.assign(request, { id: secret.id });
    expect(await handle.get()).toBe('allowed');
    expect(await generation.resolve(secret)).toBe('secret');
    await kernel.dispose();
  });
});

describe('captured environment dependency permissions', () => {
  it('checks the same captured dependency metadata that its factory receives', async () => {
    const allowed = defineServiceRef<string>({ id: 'allowed' }),
      secret = defineServiceRef<string>({ id: 'secret' }),
      provided = defineServiceRef<string>({ id: 'provided' });
    const kernel = createPluginKernel();
    let reads = 0;
    await kernel.register(
      definePlugin({
        manifest: manifest('host'),
        setup(env) {
          env.provide(allowed, { factory: () => 'allowed' });
          env.provide(secret, { factory: () => 'secret' });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: {
          ...manifest('reader'),
          contributes: { services: ['provided'] },
          permissions: ['service:allowed'],
        },
        setup(env) {
          env.provide(provided, {
            get deps() {
              return { value: ++reads === 1 ? allowed : secret };
            },
            factory: ({ value }) => value,
          });
        },
      }),
    );
    const generation = await kernel.seal();
    expect(await generation.resolve(provided)).toBe('allowed');
    expect(reads).toBe(1);
    await kernel.dispose();
  });
});
