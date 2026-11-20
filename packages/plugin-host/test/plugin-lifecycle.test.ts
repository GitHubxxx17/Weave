import {
  createPluginKernel,
  defineExtensionPoint,
  defineHook,
  defineServiceRef,
  eventsExtensionPoint,
  type KernelPlugin,
  type PluginEnv,
  type PluginManifest,
} from '@weave/plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PluginHostError } from '../src/errors.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';

function manifest(id = 'local'): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool', 'event'],
  };
}

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const service = defineServiceRef<number>({ id: 'local.value' });
const point = defineExtensionPoint<{ add(value: number): void }>({ id: 'local.items' });
const hook = defineHook<number>({ id: 'local.hook', mode: 'observe' });

function contribute(env: PluginEnv): void {
  env.provide(service, { factory: () => 42 });
  env.contribute(point, (api) => api.add(1));
  env.onHook(hook, () => undefined);
  env.defineEvent('ready', { schema: z.object({ value: z.number() }) });
}

function rejectedEnvCalls(env: PluginEnv): void {
  expect(() => env.provide(service, { factory: () => 99 })).toThrow();
  expect(() => env.use(service)).toThrow();
  expect(() => env.contribute(point, (api) => api.add(99))).toThrow();
  expect(() => env.onHook(hook, () => undefined)).toThrow();
  expect(() => env.defineEvent('late', { schema: z.object({}) })).toThrow();
}

afterEach(() => vi.useRealTimers());

describe('createPluginLifecycle', () => {
  it('reuses one cleanup promise across kernel and host disposal', async () => {
    const calls: string[] = [];
    const original: KernelPlugin = {
      manifest: manifest(),
      setup() {
        expect(this).toBe(original);
        calls.push('setup');
      },
      dispose() {
        expect(this).toBe(original);
        calls.push('dispose');
      },
    };
    const lifecycle = createPluginLifecycle(original, 1_000);
    const kernel = createPluginKernel();
    await kernel.register(lifecycle.plugin);
    await kernel.seal();
    await kernel.dispose();
    const cleanup = lifecycle.dispose();
    expect(lifecycle.dispose()).toBe(cleanup);
    await cleanup;
    expect(calls).toEqual(['setup', 'dispose']);
    expect(lifecycle.cleanupErrors).toEqual([]);
  });

  it('invalidates the env and rolls every registration back when setup throws', async () => {
    const setupFailure = new Error('setup failed');
    const cleanupFailure = new Error('cleanup failed');
    let env!: PluginEnv;
    let disposals = 0;
    const lifecycle = createPluginLifecycle(
      {
        manifest: manifest(),
        setup(current) {
          env = current;
          contribute(env);
          throw setupFailure;
        },
        dispose() {
          disposals += 1;
          throw cleanupFailure;
        },
      },
      1_000,
    );
    const kernel = createPluginKernel();
    const failure = await kernel.register(lifecycle.plugin).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'plugin-setup-failed', cause: setupFailure });
    expect(lifecycle.normalize(failure)).toBe(failure);
    expect(disposals).toBe(1);
    expect(env.signal.aborted).toBe(true);
    rejectedEnvCalls(env);
    expect(kernel.plugins()).toEqual([]);
    expect(kernel.extensions.count(point)).toBe(0);
    expect(kernel.extensions.count(eventsExtensionPoint)).toBe(0);
    expect(kernel.hooks.count(hook)).toBe(0);
    const generation = await kernel.seal();
    await expect(generation.resolve(service)).rejects.toMatchObject({
      code: 'plugin-service-missing-dependency',
    });
    await lifecycle.dispose();
    await kernel.dispose();
    await lifecycle.dispose();
    expect(disposals).toBe(1);
    expect(lifecycle.cleanupErrors).toEqual([cleanupFailure]);
  });

  it('times out inside kernel registration while the original setup stays pending', async () => {
    vi.useFakeTimers();
    const setup = gate();
    const cleanup = gate();
    const calls: string[] = [];
    let env!: PluginEnv;
    const lifecycle = createPluginLifecycle(
      {
        manifest: manifest(),
        setup(current) {
          env = current;
          contribute(env);
          env.signal.addEventListener('abort', () => {
            calls.push('abort');
            rejectedEnvCalls(env);
          });
          return setup.promise;
        },
        dispose() {
          calls.push('dispose');
          return cleanup.promise;
        },
      },
      50,
    );
    const kernel = createPluginKernel();
    let settled = false;
    const registration = kernel.register(lifecycle.plugin).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const failure = await registration;
    expect(failure).toMatchObject({ code: 'plugin-setup-failed' });
    const normalized = lifecycle.normalize(new Error('outer', { cause: failure }));
    expect(normalized).toBeInstanceOf(PluginHostError);
    expect(normalized).toMatchObject({ code: 'plugin-setup-timeout', pluginId: 'local' });
    expect(calls).toEqual(['abort', 'dispose']);
    expect(env.signal.aborted).toBe(true);
    expect(kernel.plugins()).toEqual([]);
    expect(kernel.extensions.count(point)).toBe(0);
    expect(kernel.extensions.count(eventsExtensionPoint)).toBe(0);
    expect(kernel.hooks.count(hook)).toBe(0);
    const generation = await kernel.seal();
    await expect(generation.resolve(service)).rejects.toMatchObject({
      code: 'plugin-service-missing-dependency',
    });
    cleanup.resolve();
    await lifecycle.dispose();
    setup.reject(new Error('late setup rejection'));
    await vi.advanceTimersByTimeAsync(0);
    await kernel.dispose();
  });

  it('guards late setup registrations after a timeout and observes their rejection', async () => {
    vi.useFakeTimers();
    const resume = gate();
    const finished = gate();
    let lateFailure: unknown;
    const lifecycle = createPluginLifecycle(
      {
        manifest: manifest(),
        async setup(env) {
          await resume.promise;
          try {
            env.provide(service, { factory: () => 99 });
          } catch (error: unknown) {
            lateFailure = error;
            throw error;
          } finally {
            finished.resolve();
          }
        },
      },
      50,
    );
    const kernel = createPluginKernel();
    const failed = kernel.register(lifecycle.plugin).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    resume.resolve();
    await finished.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(lateFailure).toBeInstanceOf(Error);
    await kernel.register({
      manifest: manifest(),
      setup(env) {
        env.provide(service, { factory: () => 42 });
      },
    });
    const generation = await kernel.seal();
    expect(await generation.resolve(service)).toBe(42);
    await kernel.dispose();
  });

  it('aborts and guards a successful setup before plugin disposal starts', async () => {
    vi.useFakeTimers();
    let env!: PluginEnv;
    const calls: string[] = [];
    const lifecycle = createPluginLifecycle(
      {
        manifest: manifest(),
        setup(current) {
          env = current;
          contribute(env);
        },
        dispose() {
          expect(env.signal.aborted).toBe(true);
          rejectedEnvCalls(env);
          calls.push('dispose');
        },
      },
      50,
    );
    const kernel = createPluginKernel();
    await kernel.register(lifecycle.plugin);
    await vi.advanceTimersByTimeAsync(50);
    expect(env.signal.aborted).toBe(false);
    const generation = await kernel.seal();
    expect(await generation.resolve(service)).toBe(42);
    await kernel.dispose();
    expect(calls).toEqual(['dispose']);
    expect(kernel.extensions.count(point)).toBe(0);
    expect(kernel.hooks.count(hook)).toBe(0);
    expect(lifecycle.cleanupErrors).toEqual([]);
  });

  it('forwards kernel cancellation when post-setup declaration validation fails', async () => {
    let env!: PluginEnv;
    const lifecycle = createPluginLifecycle(
      {
        manifest: { ...manifest(), permissions: [] },
        setup(current) {
          env = current;
          env.use(service);
        },
      },
      1_000,
    );
    const kernel = createPluginKernel();
    await expect(kernel.register(lifecycle.plugin)).rejects.toMatchObject({
      code: 'plugin-permission-denied',
    });
    expect(env.signal.aborted).toBe(true);
    rejectedEnvCalls(env);
    await lifecycle.dispose();
    await kernel.dispose();
  });

  it('preserves env receivers and event overloads for detached method calls', async () => {
    const receivers: string[] = [];
    let saved!: PluginEnv;
    const lifecycle = createPluginLifecycle(
      {
        manifest: manifest(),
        setup(env) {
          saved = env;
          const { provide, use, contribute, defineEvent, onHook } = env;
          provide(service, { factory: () => 42 });
          use(service);
          contribute(point, (api) => api.add(1));
          onHook(hook, () => undefined);
          expect(defineEvent('plain', { schema: z.object({}) }).create({})).toEqual({
            type: 'local/plain',
            payload: {},
          });
          const projected = defineEvent('projected', {
            schema: z.object({ value: z.number() }),
            project: {
              initial: () => 5,
              apply: (state, event) => state + event.payload.value,
            },
          });
          expect(projected.project([])).toBe(5);
        },
      },
      1_000,
    );
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: lifecycle.plugin.manifest,
      setup(env) {
        const originalEnv = new Proxy(env, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            if (typeof value !== 'function') return value;
            return new Proxy(value, {
              apply(method, actualReceiver, args: unknown[]) {
                expect(actualReceiver).toBe(originalEnv);
                receivers.push(String(key));
                return Reflect.apply(method, target, args);
              },
            });
          },
        });
        return lifecycle.plugin.setup(originalEnv);
      },
      dispose: lifecycle.dispose,
    });
    expect(receivers).toEqual([
      'provide',
      'use',
      'contribute',
      'onHook',
      'defineEvent',
      'defineEvent',
    ]);
    await kernel.seal();
    await kernel.dispose();
    rejectedEnvCalls(saved);
  });

  it('cleans a module whose setup was never registered exactly once', async () => {
    const cleanup = gate();
    const calls: string[] = [];
    const lifecycle = createPluginLifecycle(
      {
        manifest: manifest(),
        setup() {
          calls.push('setup');
        },
        async dispose() {
          calls.push('dispose');
          await cleanup.promise;
          throw undefined;
        },
      },
      1_000,
    );
    const pending = lifecycle.dispose();
    expect(lifecycle.dispose()).toBe(pending);
    cleanup.resolve();
    await pending;
    await lifecycle.dispose();
    expect(calls).toEqual(['dispose']);
    expect(lifecycle.cleanupErrors).toEqual([undefined]);
    expect(Object.isFrozen(lifecycle.cleanupErrors)).toBe(true);
  });

  it('does not normalize a plugin error that only claims to be a setup timeout', () => {
    const lifecycle = createPluginLifecycle({ manifest: manifest(), setup() {} }, 50);
    const fake = Object.assign(new Error('fake timeout'), {
      code: 'plugin-setup-timeout',
      pluginId: 'local',
    });
    const wrapper = new Error('wrapper', { cause: fake });
    expect(lifecycle.normalize(wrapper)).toBe(wrapper);
    const circular = new Error('cycle');
    circular.cause = circular;
    expect(lifecycle.normalize(circular)).toBe(circular);
    expect(lifecycle.normalize(undefined)).toBeUndefined();
  });

  it('normalizes only the timeout marker owned by this lifecycle', async () => {
    vi.useFakeTimers();
    const first = createPluginLifecycle(
      { manifest: manifest('first'), setup: () => new Promise(() => {}) },
      50,
    );
    const second = createPluginLifecycle({ manifest: manifest('second'), setup() {} }, 50);
    const kernel = createPluginKernel();
    const rejected = kernel.register(first.plugin).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const failure = await rejected;
    expect(second.normalize(failure)).toBe(failure);
    expect(first.normalize(failure)).toMatchObject({
      code: 'plugin-setup-timeout',
      pluginId: 'first',
      cause: failure,
    });
    await kernel.dispose();
  });
});
