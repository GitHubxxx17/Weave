import { describe, expect, it } from 'vitest';
import type { SessionEventStore } from '@weave/session';
import {
  createRuntime,
  createSessionEventStoreService,
  type RuntimeService,
} from '../src/index.js';

describe('Runtime lifecycle', () => {
  it('starts services in declaration order and disposes them in reverse order', async () => {
    const calls: string[] = [];
    const first: RuntimeService<string> = {
      key: Symbol('first'),
      create: () => {
        calls.push('create:first');
        return 'first';
      },
      dispose: () => {
        calls.push('dispose:first');
      },
    };
    const second: RuntimeService<string> = {
      key: Symbol('second'),
      create: () => {
        calls.push('create:second');
        return 'second';
      },
      dispose: () => {
        calls.push('dispose:second');
      },
    };

    const runtime = createRuntime({ services: [first, second] });
    await runtime.start();
    expect(runtime.status).toBe('running');
    expect(runtime.get(first)).toBe('first');

    await runtime.stop();
    expect(runtime.status).toBe('stopped');
    expect(calls).toEqual(['create:first', 'create:second', 'dispose:second', 'dispose:first']);
  });

  it('does not expose services before start or after stop', async () => {
    const service: RuntimeService<string> = {
      key: Symbol('service'),
      create: () => 'value',
    };
    const runtime = createRuntime({ services: [service] });

    expect(() => runtime.get(service)).toThrow('Runtime service is not available');
    await runtime.start();
    expect(runtime.get(service)).toBe('value');
    await runtime.stop();
    expect(() => runtime.get(service)).toThrow('Runtime service is not available');
  });

  it('passes the runtime signal and readonly config to services', async () => {
    let signal: AbortSignal | undefined;
    let config: Readonly<Record<string, unknown>> | undefined;
    const service: RuntimeService<string> = {
      key: Symbol('context'),
      create: (context) => {
        signal = context.signal;
        config = context.config;
        return 'value';
      },
      dispose: () => {
        expect(signal?.aborted).toBe(true);
      },
    };
    const runtime = createRuntime({
      config: { environment: 'test' },
      services: [service],
    });

    await runtime.start();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(config).toEqual({ environment: 'test' });
    await runtime.stop();
    expect(signal?.aborted).toBe(true);
  });

  it('makes duplicate start and stop calls idempotent', async () => {
    const service: RuntimeService<string> = {
      key: Symbol('service'),
      create: () => 'value',
    };
    const runtime = createRuntime({ services: [service] });

    await Promise.all([runtime.start(), runtime.start()]);
    expect(runtime.status).toBe('running');
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(runtime.status).toBe('stopped');
  });

  it('cleans up created services in reverse order when startup fails', async () => {
    const calls: string[] = [];
    const first: RuntimeService<string> = {
      key: Symbol('first'),
      create: () => {
        calls.push('create:first');
        return 'first';
      },
      dispose: () => {
        calls.push('dispose:first');
      },
    };
    const failing: RuntimeService<string> = {
      key: Symbol('failing'),
      create: () => {
        calls.push('create:failing');
        throw new Error('startup failed');
      },
      dispose: () => {
        calls.push('dispose:failing');
      },
    };
    const second: RuntimeService<string> = {
      key: Symbol('second'),
      create: () => {
        calls.push('create:second');
        return 'second';
      },
      dispose: () => {
        calls.push('dispose:second');
      },
    };
    const neverCreated: RuntimeService<string> = {
      key: Symbol('never-created'),
      create: () => {
        calls.push('create:never-created');
        return 'never-created';
      },
    };
    const runtime = createRuntime({ services: [first, second, failing, neverCreated] });

    await expect(runtime.start()).rejects.toThrow('startup failed');
    expect(runtime.status).toBe('stopped');
    expect(calls).toEqual([
      'create:first',
      'create:second',
      'create:failing',
      'dispose:second',
      'dispose:first',
    ]);
    expect(() => runtime.get(first)).toThrow('Runtime service is not available');
  });

  it('preserves startup and cleanup failures while attempting every created service', async () => {
    const calls: string[] = [];
    const startupError = new Error('startup failed');
    const cleanupError = new Error('cleanup failed');
    const first: RuntimeService<string> = {
      key: Symbol('first'),
      create: () => {
        calls.push('create:first');
        return 'first';
      },
      dispose: () => {
        calls.push('dispose:first');
        throw cleanupError;
      },
    };
    const second: RuntimeService<string> = {
      key: Symbol('second'),
      create: () => {
        calls.push('create:second');
        return 'second';
      },
      dispose: () => {
        calls.push('dispose:second');
      },
    };
    const failing: RuntimeService<string> = {
      key: Symbol('failing'),
      create: () => {
        calls.push('create:failing');
        throw startupError;
      },
    };
    const runtime = createRuntime({ services: [first, second, failing] });

    const error = await runtime.start().catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([startupError, cleanupError]);
    expect(runtime.status).toBe('stopped');
    expect(calls).toEqual([
      'create:first',
      'create:second',
      'create:failing',
      'dispose:second',
      'dispose:first',
    ]);
  });

  it('preserves a cleanup failure that throws undefined', async () => {
    const calls: string[] = [];
    const startupError = new Error('startup failed');
    const first: RuntimeService<string> = {
      key: Symbol('first'),
      create: () => {
        calls.push('create:first');
        return 'first';
      },
      dispose: () => {
        calls.push('dispose:first');
        throw undefined;
      },
    };
    const second: RuntimeService<string> = {
      key: Symbol('second'),
      create: () => {
        calls.push('create:second');
        return 'second';
      },
      dispose: () => {
        calls.push('dispose:second');
      },
    };
    const failing: RuntimeService<string> = {
      key: Symbol('failing'),
      create: () => {
        calls.push('create:failing');
        throw startupError;
      },
    };
    const runtime = createRuntime({ services: [first, second, failing] });

    const error = await runtime.start().catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toBe(startupError);
    expect((error as AggregateError).errors[1]).toBeUndefined();
    expect(runtime.status).toBe('stopped');
    expect(calls).toEqual([
      'create:first',
      'create:second',
      'create:failing',
      'dispose:second',
      'dispose:first',
    ]);
  });

  it('allows retrying after a failed startup', async () => {
    let attempts = 0;
    const signals: AbortSignal[] = [];
    const service: RuntimeService<string> = {
      key: Symbol('retryable'),
      create: (context) => {
        attempts += 1;
        signals.push(context.signal);
        if (attempts === 1) {
          throw new Error('try again');
        }
        return 'value';
      },
    };
    const runtime = createRuntime({ services: [service] });

    await expect(runtime.start()).rejects.toThrow('try again');
    expect(signals[0]?.aborted).toBe(true);
    await runtime.start();

    expect(runtime.status).toBe('running');
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    expect(runtime.get(service)).toBe('value');
    await runtime.stop();
  });

  it('rejects duplicate service keys before creating any service', () => {
    const key = Symbol('duplicate');
    const first: RuntimeService<string> = {
      key,
      create: () => 'first',
    };
    const second: RuntimeService<string> = {
      key,
      create: () => 'second',
    };

    expect(() => createRuntime({ services: [first, second] })).toThrow(
      'Runtime service keys must be unique',
    );
  });

  it('rejects starting a runtime after it has stopped', async () => {
    const runtime = createRuntime();

    await runtime.stop();

    await expect(runtime.start()).rejects.toThrow('Runtime cannot be started after it has stopped');
    expect(runtime.status).toBe('stopped');
  });

  it('throws a stable error for an unregistered service', async () => {
    const registered: RuntimeService<string> = {
      key: Symbol('registered'),
      create: () => 'value',
    };
    const unregistered: RuntimeService<string> = {
      key: Symbol('unregistered'),
      create: () => 'other',
    };
    const runtime = createRuntime({ services: [registered] });

    await runtime.start();

    expect(() => runtime.get(unregistered)).toThrow('Runtime service is not available');
    await runtime.stop();
  });

  it('creates and closes an injected Session Event Store with the Runtime lifecycle', async () => {
    let receivedSignal: AbortSignal | undefined;
    let receivedConfig: Readonly<Record<string, unknown>> | undefined;
    let closed = false;
    const store: SessionEventStore = {
      append: async () => [],
      read: async () => [],
      close: async () => {
        closed = true;
      },
    };
    const sessionStoreService = createSessionEventStoreService({
      create: (context) => {
        receivedSignal = context.signal;
        receivedConfig = context.config;
        return store;
      },
    });
    const runtime = createRuntime({
      config: { storage: 'memory' },
      services: [sessionStoreService],
    });

    await runtime.start();

    expect(runtime.get(sessionStoreService)).toBe(store);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedConfig).toEqual({ storage: 'memory' });

    await runtime.stop();

    expect(closed).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
  });
});
