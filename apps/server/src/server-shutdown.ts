import type { ServerType } from '@hono/node-server';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import type { ManagedPluginInstaller } from './managed-plugin-installer.js';
import type { OwnedPluginArtifactStore } from './owned-plugin-artifact-store.js';
import type { PluginAuthorityDatabase } from './plugin-authority-types.js';

export interface ServerShutdownResources {
  readonly server?: ServerType | undefined;
  readonly coordinator?: ExtensionCoordinator | undefined;
  readonly installer?: Pick<ManagedPluginInstaller, 'closeSync'> | undefined;
  readonly owned?: Pick<OwnedPluginArtifactStore, 'quiesce' | 'close'> | undefined;
  readonly authority?: Pick<PluginAuthorityDatabase, 'close'> | undefined;
}

export interface ServerShutdown {
  stop(): Promise<void>;
  failStartup(cause: unknown): Promise<never>;
}

interface ServerShutdownOptions {
  readonly resources: () => ServerShutdownResources;
  readonly disposeHost: () => Promise<void>;
  readonly stopRuntime: () => Promise<void>;
  readonly closeProjectStore: () => void | Promise<void>;
  readonly closeProviderSettingsStore: () => void | Promise<void>;
  /** Closes only a separately owned trust store. */
  readonly closeManualTrustStore: () => void | Promise<void>;
  readonly closeMcpAuthorityStore: () => void | Promise<void>;
}

type CleanupOutcome = { readonly ok: true } | { readonly ok: false; readonly cause: unknown };

interface ShutdownAttempt {
  readonly outcome: Promise<readonly unknown[]>;
  readonly stop: Promise<void>;
}

const failedStartupCleanups = new WeakMap<object, () => Promise<void>>();

export function retryFailedServerStartupCleanup(cause: unknown): Promise<void> {
  const stop =
    typeof cause === 'object' && cause !== null ? failedStartupCleanups.get(cause) : undefined;
  return stop?.() ?? Promise.reject(new TypeError('No failed Server startup cleanup is available'));
}

async function settle(operation: () => void | Promise<void>): Promise<CleanupOutcome> {
  try {
    await operation();
    return { ok: true };
  } catch (cause: unknown) {
    return { ok: false, cause };
  }
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (
          error === undefined ||
          (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
        ) {
          resolve();
          return;
        }
        reject(error);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

export function createServerShutdown(options: ServerShutdownOptions): ServerShutdown {
  let resources: ServerShutdownResources | undefined;
  let httpClose: Promise<CleanupOutcome> | undefined;
  let quiesced = false;
  let consumersDrained = false;
  let settledCleanup = false;
  let wrapperReleased = false;
  let authorityClosed = false;
  let attempt: ShutdownAttempt | undefined;
  let failedStartupError: AggregateError | undefined;
  const cleanupCauses: unknown[] = [];

  async function record(operation: () => void | Promise<void>): Promise<void> {
    const outcome = await settle(operation);
    if (!outcome.ok) cleanupCauses.push(outcome.cause);
  }

  function hasUnfinishedManagedResources(): boolean {
    return (
      (resources?.owned !== undefined && !wrapperReleased) ||
      (resources?.authority !== undefined && !authorityClosed)
    );
  }

  async function run(retryRelease: boolean): Promise<readonly unknown[]> {
    resources ??= options.resources();
    const { server, coordinator, installer, owned, authority } = resources;
    installer?.closeSync();
    // Start HTTP close before cancellation. Its completion can depend on Agent SSE.
    if (server !== undefined) httpClose ??= settle(() => closeServer(server));
    if (owned !== undefined && !consumersDrained) {
      const quiesce = async () => {
        if (quiesced) return;
        await owned.quiesce();
        quiesced = true;
      };
      if (coordinator === undefined) {
        const outcome = await settle(quiesce);
        if (!outcome.ok) return [outcome.cause];
      } else {
        coordinator.beginOwnedDrainSync();
        const outcome = await coordinator.drainOwnedConsumers(quiesce);
        if (outcome.kind === 'incomplete') return [outcome.cause];
        cleanupCauses.push(...outcome.cleanupCauses);
      }
      consumersDrained = true;
    }

    if (!settledCleanup) {
      if (owned === undefined && coordinator !== undefined) {
        await record(() => coordinator.dispose());
      }
      await record(options.disposeHost);
      // Idle SSE sockets can close once Agent terminal writes have settled.
      if (server !== undefined && 'closeAllConnections' in server) {
        await record(() => server.closeAllConnections());
      }
      const httpOutcome = await httpClose;
      if (httpOutcome !== undefined && !httpOutcome.ok) cleanupCauses.push(httpOutcome.cause);
      await record(options.stopRuntime);
      await record(options.closeProjectStore);
      await record(options.closeProviderSettingsStore);
      await record(options.closeManualTrustStore);
      await record(options.closeMcpAuthorityStore);
      settledCleanup = true;
    }

    if (owned !== undefined && !wrapperReleased) {
      const release = await settle(() => owned.close());
      if (!release.ok) {
        if (!retryRelease) return [release.cause];
        const retry = await settle(() => owned.close());
        if (!retry.ok) return [release.cause, retry.cause];
      }
      wrapperReleased = true;
    }
    if (authority !== undefined && !authorityClosed) {
      const close = await settle(() => authority.close());
      if (!close.ok) return [close.cause];
      authorityClosed = true;
    }
    return [];
  }

  function startAttempt(retryRelease: boolean): ShutdownAttempt {
    if (attempt !== undefined) return attempt;
    let resolveOutcome!: (causes: readonly unknown[]) => void;
    const outcome = new Promise<readonly unknown[]>((resolve) => {
      resolveOutcome = resolve;
    });
    const current = {
      outcome,
      stop: outcome.then((causes) => {
        if (hasUnfinishedManagedResources()) {
          attempt = undefined;
        } else if (failedStartupError !== undefined) {
          failedStartupCleanups.delete(failedStartupError);
          failedStartupError = undefined;
        }
        if (causes.length > 1 && resources?.owned !== undefined) {
          throw new AggregateError(causes, 'Server shutdown failed', { cause: causes[0] });
        }
        if (causes.length > 0) throw causes[0];
      }),
    };
    // Publish the attempt before close or abort callbacks can reenter stop().
    attempt = current;
    const finish = (transientCauses: readonly unknown[]) => {
      resolveOutcome([...cleanupCauses, ...transientCauses]);
    };
    void run(retryRelease).then(finish, (cause: unknown) => finish([cause]));
    return current;
  }

  function stop(): Promise<void> {
    return startAttempt(false).stop;
  }

  return {
    stop,
    async failStartup(cause): Promise<never> {
      const current = startAttempt(true);
      void current.stop.catch(() => undefined);
      const failures = await current.outcome;
      if (failures.length === 0) throw cause;
      const error = new AggregateError([cause, ...failures], 'Server startup cleanup failed', {
        cause,
      });
      if (hasUnfinishedManagedResources()) {
        failedStartupError = error;
        failedStartupCleanups.set(error, stop);
      }
      throw error;
    },
  };
}
