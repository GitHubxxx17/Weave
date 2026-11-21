import { realpathSync } from 'node:fs';
import { assertHostVersion } from '@weave/plugin';
import {
  createPluginArtifactStore,
  PluginArtifactError,
  type PluginArtifact,
  type PluginArtifactStore,
} from '@weave/plugin-host';
import { z } from 'zod';
import { canonicalJson } from './plugin-authority-data.js';
import {
  PluginAuthorityError,
  type ManagedStoreBinding,
  type PluginAuthorityDatabase,
} from './plugin-authority-types.js';
import { acquireManagedStoreLease, type ManagedStoreLease } from './plugin-store-lease.js';
import {
  absoluteStorePathSchema,
  initialBindingSchema,
  PluginStoreOwnershipError,
  type PluginStoreOwnershipErrorCode,
} from './plugin-store-ownership-types.js';
import { validateStorePaths } from './plugin-store-paths.js';

export interface OwnedPluginArtifactStore extends PluginArtifactStore {
  readonly binding: ManagedStoreBinding;
  assertHeldSync(): void;
  quiesce(): Promise<void>;
  close(): Promise<void>;
}

interface OpenOwnedStoreOptions {
  readonly authority: PluginAuthorityDatabase;
  readonly directory: string;
  readonly initialBinding: 'allow-unbound' | 'require-bound';
  readonly hostVersion?: string;
  readonly reservedIds?: readonly string[];
  readonly onOwnershipLost: (error: PluginStoreOwnershipError) => undefined;
}

const openOptionsSchema = z.strictObject({
  authority: z.custom<PluginAuthorityDatabase>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'readManagedRootStateSync' in value &&
      typeof value.readManagedRootStateSync === 'function' &&
      'registerManagedRootSync' in value &&
      typeof value.registerManagedRootSync === 'function',
  ),
  directory: absoluteStorePathSchema,
  initialBinding: initialBindingSchema,
  hostVersion: z.string().optional(),
  reservedIds: z.array(z.string().min(1)).optional(),
  onOwnershipLost: z.custom<OpenOwnedStoreOptions['onOwnershipLost']>(
    (value) => typeof value === 'function',
  ),
});
const callerSignalSchema = z.instanceof(AbortSignal).optional();
const stageOptionsSchema = z.strictObject({
  sourceDirectory: absoluteStorePathSchema,
  signal: callerSignalSchema,
});
const readOptionsSchema = z.strictObject({ signal: callerSignalSchema });
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

function parseArtifactInput<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  try {
    return schema.parse(input);
  } catch (cause: unknown) {
    throw new PluginArtifactError('plugin-artifact-invalid', message, { cause });
  }
}

function startupError(message: string, cause: unknown): PluginStoreOwnershipError {
  let code: PluginStoreOwnershipErrorCode = 'plugin-store-storage';
  if (cause instanceof PluginStoreOwnershipError) {
    code =
      cause.code === 'plugin-store-ownership-lost' ? 'plugin-store-recovery-required' : cause.code;
  } else if (cause instanceof PluginAuthorityError) {
    switch (cause.code) {
      case 'plugin-authority-invalid':
        code = 'plugin-store-invalid';
        break;
      case 'plugin-authority-busy':
        code = 'plugin-store-busy';
        break;
      case 'plugin-authority-conflict':
        code = 'plugin-store-owner-mismatch';
        break;
      case 'plugin-authority-protocol':
        code = 'plugin-store-protocol';
        break;
      case 'plugin-authority-closed':
        code = 'plugin-store-closed';
        break;
    }
  }
  return new PluginStoreOwnershipError(code, message, { cause });
}

function assertRegisteredLease(authority: PluginAuthorityDatabase, lease: ManagedStoreLease): void {
  lease.assertHeldSync();
  const { binding } = lease;
  const state = authority.readManagedRootStateSync();
  if (
    state.databaseId !== binding.databaseId ||
    state.databaseFile === null ||
    realpathSync.native(state.databaseFile) !== binding.databaseFile ||
    canonicalJson(state.registration?.binding ?? null) !== canonicalJson(binding)
  ) {
    throw new PluginStoreOwnershipError(
      'plugin-store-owner-mismatch',
      'Managed store binding differs from the authority registration',
    );
  }
}

function checkObserverResult(result: unknown): void {
  if (result === undefined) return;
  if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
    // Inspect once so a throwing getter is reported with the synchronous ownership failure.
    const then: unknown = Reflect.get(result, 'then');
    if (typeof then === 'function') {
      void Promise.resolve({
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          Reflect.apply(then, result, [resolve, reject]);
        },
      }).catch(() => undefined);
    }
  }
  throw new TypeError('Managed store ownership observer must return undefined');
}

function withAdditionalFailure(
  primary: PluginStoreOwnershipError,
  additional: unknown,
  message: string,
): PluginStoreOwnershipError {
  return new PluginStoreOwnershipError(primary.code, primary.message, {
    cause: new AggregateError([primary, additional], message),
  });
}

function guardArtifactStore(
  authority: PluginAuthorityDatabase,
  lease: ManagedStoreLease,
  store: PluginArtifactStore,
  onOwnershipLost: OpenOwnedStoreOptions['onOwnershipLost'],
): OwnedPluginArtifactStore {
  let state: 'active' | 'quiescing' | 'failed' | 'closed' = 'active';
  const ownershipLossAbort = new AbortController();
  let ownershipLoss: PluginStoreOwnershipError | undefined;
  let releaseStarted = false;
  let releaseFailure: PluginStoreOwnershipError | undefined;
  const pending = new Set<Promise<void>>();
  let drain: Promise<void> | undefined;
  let closeAttempt: Promise<void> | undefined;

  function closedError(): PluginStoreOwnershipError {
    return new PluginStoreOwnershipError(
      'plugin-store-closed',
      'Managed store is not accepting work',
      {
        cause: releaseFailure,
      },
    );
  }

  function assertHeldSync(): void {
    if (state === 'closed') throw closedError();
    if (ownershipLoss !== undefined) throw ownershipLoss;
    if (releaseStarted) throw closedError();
    try {
      assertRegisteredLease(authority, lease);
    } catch (cause: unknown) {
      const loss =
        cause instanceof PluginStoreOwnershipError && cause.code === 'plugin-store-ownership-lost'
          ? cause
          : new PluginStoreOwnershipError(
              'plugin-store-ownership-lost',
              'Managed store ownership was lost',
              { cause },
            );
      state = 'failed';
      ownershipLoss = loss;
      ownershipLossAbort.abort(loss);
      try {
        checkObserverResult(onOwnershipLost(loss));
      } catch (observer: unknown) {
        ownershipLoss = withAdditionalFailure(
          loss,
          observer,
          'Managed store ownership observer failed',
        );
      }
      throw ownershipLoss;
    }
  }

  function assertAccepting(): void {
    if (state === 'failed') throw ownershipLoss;
    if (state !== 'active') throw closedError();
  }

  async function dispatch(
    callerSignal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<PluginArtifact>,
  ): Promise<PluginArtifact> {
    assertHeldSync();
    const lossSignal = ownershipLossAbort.signal;
    const signal =
      callerSignal === undefined ? lossSignal : AbortSignal.any([callerSignal, lossSignal]);
    // Input parsing can invoke getters that synchronously start quiescing.
    assertAccepting();
    let complete!: () => void;
    const ticket = new Promise<void>((resolve) => {
      complete = resolve;
    });
    pending.add(ticket);
    try {
      let artifact: PluginArtifact;
      try {
        artifact = await run(signal);
      } catch (operation: unknown) {
        try {
          assertHeldSync();
        } catch (loss: unknown) {
          if (
            loss instanceof PluginStoreOwnershipError &&
            !Object.is(operation, loss) &&
            !Object.is(operation, lossSignal.reason)
          ) {
            throw withAdditionalFailure(
              loss,
              operation,
              'Managed store operation failed during ownership loss',
            );
          }
          throw loss;
        }
        throw operation;
      }
      assertHeldSync();
      return artifact;
    } finally {
      pending.delete(ticket);
      complete();
    }
  }

  function quiesce(): Promise<void> {
    if (state === 'active') state = 'quiescing';
    drain ??= Promise.all([...pending]).then(() => undefined);
    return drain;
  }

  function close(): Promise<void> {
    if (state === 'closed') return Promise.resolve();
    closeAttempt ??= quiesce()
      .then(async () => {
        releaseStarted = true;
        try {
          await lease.close();
          state = 'closed';
          releaseFailure = undefined;
        } catch (cleanup: unknown) {
          releaseFailure =
            ownershipLoss === undefined
              ? new PluginStoreOwnershipError(
                  'plugin-store-storage',
                  'Could not release the managed store lease',
                  { cause: cleanup },
                )
              : withAdditionalFailure(
                  ownershipLoss,
                  cleanup,
                  'Managed store ownership cleanup failed',
                );
          throw releaseFailure;
        }
      })
      .finally(() => {
        closeAttempt = undefined;
      });
    return closeAttempt;
  }

  return {
    binding: lease.binding,
    assertHeldSync,
    async stage(input) {
      assertAccepting();
      const { sourceDirectory, signal } = parseArtifactInput(
        stageOptionsSchema,
        input,
        'Invalid plugin artifact stage options',
      );
      return dispatch(signal, (effective) => store.stage({ sourceDirectory, signal: effective }));
    },
    async read(input, options = {}) {
      assertAccepting();
      const digest = parseArtifactInput(digestSchema, input, 'Invalid plugin artifact digest');
      const { signal } = parseArtifactInput(
        readOptionsSchema,
        options,
        'Invalid plugin artifact read options',
      );
      return dispatch(signal, (effective) => store.read(digest, { signal: effective }));
    },
    quiesce,
    close,
  };
}

export async function openOwnedPluginArtifactStore(
  options: OpenOwnedStoreOptions,
): Promise<OwnedPluginArtifactStore> {
  let config: z.output<typeof openOptionsSchema>;
  try {
    config = openOptionsSchema.parse(options);
    assertHostVersion(config.hostVersion);
  } catch (cause: unknown) {
    throw new PluginStoreOwnershipError(
      'plugin-store-invalid',
      'Managed store options are invalid',
      {
        cause,
      },
    );
  }
  const { authority, directory, initialBinding, hostVersion, reservedIds } = config;
  let state;
  try {
    state = authority.readManagedRootStateSync();
  } catch (cause: unknown) {
    throw startupError('Could not read the managed store authority state', cause);
  }
  if (state.databaseFile === null) {
    throw new PluginStoreOwnershipError(
      'plugin-store-invalid',
      'Managed store requires a persistent authority database',
    );
  }

  const paths = await validateStorePaths({
    databaseFile: state.databaseFile,
    directory,
    initialBinding,
  });
  const lease = await acquireManagedStoreLease({
    paths,
    databaseId: state.databaseId,
    existingRegistration: state.registration,
    initialBinding,
  });
  let failureMessage = 'Could not register the managed store after committing the owner binding';
  try {
    authority.registerManagedRootSync(lease.binding);
    failureMessage = 'Could not open the managed store after committing both bindings';
    assertRegisteredLease(authority, lease);
    const artifactStore = createPluginArtifactStore({
      directory: paths.storeDirectory,
      hostVersion,
      reservedIds,
    });
    return guardArtifactStore(authority, lease, artifactStore, config.onOwnershipLost);
  } catch (cause: unknown) {
    const primary = startupError(failureMessage, cause);
    try {
      await lease.close();
    } catch (cleanup: unknown) {
      throw new PluginStoreOwnershipError(primary.code, primary.message, {
        cause: new AggregateError([primary, cleanup], 'Managed store startup cleanup failed'),
      });
    }
    throw primary;
  }
}
