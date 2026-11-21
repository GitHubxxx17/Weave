import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createServerShutdown,
  retryFailedServerStartupCleanup,
  type ServerShutdownResources,
} from '../src/server-shutdown.js';

function cleanupOptions(resources: () => ServerShutdownResources) {
  return {
    resources: vi.fn(resources),
    disposeHost: vi.fn(async () => {}),
    stopRuntime: vi.fn(async () => {}),
    closeProjectStore: vi.fn(),
    closeProviderSettingsStore: vi.fn(),
    closeManualTrustStore: vi.fn(),
    closeMcpAuthorityStore: vi.fn(),
  };
}

describe('Server shutdown', () => {
  it('shares synchronous reentry and retries release and authority independently', async () => {
    const calls: string[] = [];
    const releaseFailure = new Error('lease still held');
    const authorityFailure = new Error('authority still open');
    let held = true;
    let reentered: Promise<void> | undefined;
    const original = {
      owned: {
        async quiesce() {
          calls.push('quiesce');
          reentered = shutdown.stop();
        },
        close: vi
          .fn(async () => {
            calls.push('release');
            held = false;
          })
          .mockImplementationOnce(async () => {
            calls.push('release failed');
            throw releaseFailure;
          }),
      },
      authority: {
        close: vi
          .fn(async () => {
            expect(held).toBe(false);
            calls.push('authority');
          })
          .mockImplementationOnce(async () => {
            expect(held).toBe(false);
            calls.push('authority failed');
            throw authorityFailure;
          }),
      },
    };
    let resources: ServerShutdownResources = original;
    const options = cleanupOptions(() => resources);
    options.disposeHost.mockImplementation(async () => {
      calls.push('host failed');
      throw undefined;
    });
    options.stopRuntime.mockImplementation(async () => {
      calls.push('runtime');
    });
    const shutdown = createServerShutdown(options);

    const first = shutdown.stop();
    expect(reentered).toBe(first);
    expect(shutdown.stop()).toBe(first);
    await expect(first).rejects.toMatchObject({ errors: [undefined, releaseFailure] });
    expect(held).toBe(true);
    expect(calls).toEqual(['quiesce', 'host failed', 'runtime', 'release failed']);
    expect(original.authority.close).not.toHaveBeenCalled();
    resources = {};

    const second = shutdown.stop();
    expect(shutdown.stop()).toBe(second);
    await expect(second).rejects.toMatchObject({ errors: [undefined, authorityFailure] });
    expect(calls).toEqual([
      'quiesce',
      'host failed',
      'runtime',
      'release failed',
      'release',
      'authority failed',
    ]);
    expect(held).toBe(false);

    const third = shutdown.stop();
    await expect(third).rejects.toBeUndefined();
    expect(shutdown.stop()).toBe(third);
    expect(calls.at(-1)).toBe('authority');
    expect(options.resources).toHaveBeenCalledOnce();
    expect(original.owned.close).toHaveBeenCalledTimes(2);
    expect(original.authority.close).toHaveBeenCalledTimes(2);
    expect(options.closeManualTrustStore).not.toHaveBeenCalled();
  });

  it.each([new Error('boot failed'), 'boot failed', undefined])(
    'retains the shutdown closure for the exact aggregate thrown after startup failure %s',
    async (startupFailure) => {
      const firstReleaseFailure = new Error('first release failed');
      const secondReleaseFailure = new Error('second release failed');
      const owner = {
        quiesce: vi.fn(async () => {}),
        close: vi
          .fn(async () => {})
          .mockRejectedValueOnce(firstReleaseFailure)
          .mockRejectedValueOnce(secondReleaseFailure),
      };
      const authority = { close: vi.fn(async () => {}) };
      const options = cleanupOptions(() => ({ owned: owner, authority }));
      const shutdown = createServerShutdown(options);
      const failure = await shutdown.failStartup(startupFailure).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).cause).toBe(startupFailure);
      expect((failure as AggregateError).errors).toEqual([
        startupFailure,
        firstReleaseFailure,
        secondReleaseFailure,
      ]);
      expect(owner.close).toHaveBeenCalledTimes(2);
      expect(authority.close).not.toHaveBeenCalled();

      await expect(retryFailedServerStartupCleanup(startupFailure)).rejects.toThrow(TypeError);
      await expect(retryFailedServerStartupCleanup(new AggregateError([]))).rejects.toThrow(
        'No failed Server startup cleanup is available',
      );
      await Promise.all([
        retryFailedServerStartupCleanup(failure),
        retryFailedServerStartupCleanup(failure),
      ]);
      expect(options.resources).toHaveBeenCalledOnce();
      expect(owner.quiesce).toHaveBeenCalledOnce();
      expect(options.disposeHost).toHaveBeenCalledOnce();
      expect(owner.close).toHaveBeenCalledTimes(3);
      expect(authority.close).toHaveBeenCalledOnce();
      await expect(retryFailedServerStartupCleanup(failure)).rejects.toThrow(TypeError);
    },
  );

  it('retains an incomplete startup barrier and removes its retry after a settled cleanup error', async () => {
    const startupFailure = new Error('listen failed');
    const settledFailure = new Error('host disposal failed');
    const owner = {
      quiesce: vi.fn(async () => {}).mockRejectedValueOnce(undefined),
      close: vi.fn(async () => {}),
    };
    const authority = { close: vi.fn(async () => {}) };
    const options = cleanupOptions(() => ({ owned: owner, authority }));
    options.disposeHost.mockRejectedValueOnce(settledFailure);
    const failure = await createServerShutdown(options)
      .failStartup(startupFailure)
      .catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ errors: [startupFailure, undefined], cause: startupFailure });
    expect(owner.close).not.toHaveBeenCalled();
    expect(options.stopRuntime).not.toHaveBeenCalled();
    expect(authority.close).not.toHaveBeenCalled();
    await expect(retryFailedServerStartupCleanup(failure)).rejects.toBe(settledFailure);
    expect(owner.quiesce).toHaveBeenCalledTimes(2);
    expect(owner.close).toHaveBeenCalledOnce();
    expect(authority.close).toHaveBeenCalledOnce();
    await expect(retryFailedServerStartupCleanup(failure)).rejects.toThrow(TypeError);
  });

  it('preserves the original boot failure after successful cleanup', async () => {
    const owner = {
      quiesce: vi.fn(async () => {}),
      close: vi.fn(async () => {}).mockRejectedValueOnce(new Error('transient release failure')),
    };
    const authority = { close: vi.fn(async () => {}) };
    const options = cleanupOptions(() => ({ owned: owner, authority }));
    await expect(createServerShutdown(options).failStartup('boot')).rejects.toBe('boot');
    expect(owner.close).toHaveBeenCalledTimes(2);
    expect(authority.close).toHaveBeenCalledOnce();
  });

  it('preserves undefined from HTTP close as the first unowned error and shares HTTP reentry', async () => {
    const server = createServer();
    const options = cleanupOptions(() => ({ server }));
    const shutdown = createServerShutdown(options);
    let reentered: Promise<void> | undefined;
    vi.spyOn(server, 'close').mockImplementation(() => {
      reentered = shutdown.stop();
      throw undefined;
    });
    options.stopRuntime.mockRejectedValueOnce(new Error('runtime close failed'));
    const stopped = shutdown.stop();
    expect(reentered).toBe(stopped);
    await expect(stopped).rejects.toBeUndefined();
    expect(options.closeMcpAuthorityStore).toHaveBeenCalledOnce();
    expect(shutdown.stop()).toBe(stopped);
  });
});
