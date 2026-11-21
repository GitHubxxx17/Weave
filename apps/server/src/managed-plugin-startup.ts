import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginTrustStore, RecordedPluginTrustEvent } from '@weave/plugin-host';
import { z } from 'zod';
import { serverHostVersion } from './host-version.js';
import type { ClosablePluginTrustStore } from './local-plugin-host.js';
import {
  openOwnedPluginArtifactStore,
  type OwnedPluginArtifactStore,
} from './owned-plugin-artifact-store.js';
import { resolveDatabaseFile, type ResolveDatabaseFileOptions } from './persistence-path.js';
import { createSqlitePluginAuthorityDatabase } from './plugin-authority-store.js';
import type { PluginAuthorityDatabase } from './plugin-authority-types.js';
import { resolvePluginsDirectory, type ResolvePluginsDirectoryOptions } from './plugin-path.js';
import {
  initialBindingSchema,
  type PluginStoreOwnershipError,
} from './plugin-store-ownership-types.js';

export const managedPluginStoreOptionsSchema = z
  .strictObject({ initialBinding: initialBindingSchema })
  .optional();

export type ManagedPluginStoreOptions = Readonly<
  NonNullable<z.output<typeof managedPluginStoreOptionsSchema>>
>;

interface PluginStartupOptions extends ResolveDatabaseFileOptions, ResolvePluginsDirectoryOptions {
  readonly managedPluginStore?: unknown;
  readonly pluginTrustStore?: ClosablePluginTrustStore;
}

interface ResolvedPluginStartup {
  readonly databaseFile: string;
  readonly pluginsDirectory: string | false;
  readonly managedPluginStore: ManagedPluginStoreOptions | undefined;
  readonly pluginTrustStore: ClosablePluginTrustStore | undefined;
}

export function resolvePluginStartupOptions(options: PluginStartupOptions): ResolvedPluginStartup {
  const managedPluginStore = managedPluginStoreOptionsSchema.parse(options.managedPluginStore);
  const pluginsDirectory = resolvePluginsDirectory(options);
  const { pluginTrustStore } = options;
  if (
    managedPluginStore !== undefined &&
    (pluginsDirectory === false || pluginTrustStore !== undefined)
  ) {
    throw new TypeError(
      'managedPluginStore requires local ESM discovery and the default pluginTrustStore',
    );
  }
  return {
    databaseFile: resolveDatabaseFile(options),
    pluginsDirectory,
    managedPluginStore,
    pluginTrustStore,
  };
}

interface AcquisitionHooks {
  readonly baselinePluginIds: readonly string[];
  readonly registerAuthority: (authority: PluginAuthorityDatabase) => undefined;
  readonly registerManualTrustStore: (store: ClosablePluginTrustStore) => undefined;
  readonly registerOwnedStore: (store: OwnedPluginArtifactStore) => undefined;
  readonly onOwnershipLost: (error: PluginStoreOwnershipError) => undefined;
}

interface OverrideTrust {
  readonly kind: 'override';
  readonly store: PluginTrustStore;
  readonly readTrustEventsSync: () => readonly RecordedPluginTrustEvent[] | undefined;
}

type StartupAuthority = ReturnType<PluginAuthorityDatabase['readStartupAuthoritySync']>;

interface ManagedPluginStartup extends StartupAuthority {
  readonly authority: PluginAuthorityDatabase;
  readonly owned: OwnedPluginArtifactStore | undefined;
  readonly localTrust:
    { readonly kind: 'authority'; readonly store: PluginTrustStore } | OverrideTrust | undefined;
}

function createOverrideTrust(store: ClosablePluginTrustStore): OverrideTrust {
  let prefix: readonly RecordedPluginTrustEvent[] | undefined;
  let observedSequence = 0;
  return {
    kind: 'override',
    store: {
      async events() {
        const found = await store.events();
        if (
          found.length >= observedSequence &&
          found.every((event, index) => event.sequence === index + 1)
        ) {
          prefix = structuredClone(found);
          observedSequence = found.length;
        }
        return found;
      },
      async append(event) {
        const recorded = await store.append(event);
        if (prefix?.length === observedSequence && recorded.sequence === observedSequence + 1) {
          prefix = [...prefix, structuredClone(recorded)];
        }
        // A sequence gap keeps the last full prefix unavailable until the source rereads.
        // Returning the recorded event now lets the source publish the admission change first.
        observedSequence = Math.max(observedSequence, recorded.sequence);
        return recorded;
      },
    },
    readTrustEventsSync() {
      if (prefix?.length === observedSequence) return structuredClone(prefix);
      return undefined;
    },
  };
}

function assertOverrideAllowed({ registration, snapshot }: StartupAuthority): void {
  if (registration !== null || snapshot.installations.length > 0) {
    throw new TypeError(
      'pluginTrustStore cannot override a registered store or managed plugin history',
    );
  }
}

export async function acquireManagedPluginStartup(
  config: ResolvedPluginStartup,
  hooks: AcquisitionHooks,
): Promise<ManagedPluginStartup> {
  const { databaseFile, pluginsDirectory, pluginTrustStore, managedPluginStore } = config;
  const authority = createSqlitePluginAuthorityDatabase({ filename: databaseFile });
  hooks.registerAuthority(authority);

  const initial = authority.readStartupAuthoritySync();
  const unowned = { authority, ...initial, owned: undefined };
  if (pluginsDirectory === false) return { ...unowned, localTrust: undefined };

  if (pluginTrustStore !== undefined) {
    assertOverrideAllowed(initial);
    hooks.registerManualTrustStore(pluginTrustStore);
    const localTrust = createOverrideTrust(pluginTrustStore);
    await localTrust.store.events();
    const fresh = authority.readStartupAuthoritySync();
    assertOverrideAllowed(fresh);
    return { ...unowned, ...fresh, localTrust };
  }

  const localTrust = { kind: 'authority', store: authority.trust } as const;
  if (initial.registration === null && managedPluginStore === undefined) {
    return { ...unowned, localTrust };
  }

  const pluginParent = resolve(pluginsDirectory);
  const allowUnbound = managedPluginStore?.initialBinding === 'allow-unbound';
  let rootState = authority.readManagedRootStateSync();
  if (allowUnbound && rootState.registration === null && rootState.databaseFile !== null) {
    await mkdir(pluginParent, { recursive: true });
    rootState = authority.readManagedRootStateSync();
  }

  const owned = await openOwnedPluginArtifactStore({
    authority,
    directory: join(pluginParent, '.weave-store'),
    initialBinding:
      allowUnbound && rootState.registration === null ? 'allow-unbound' : 'require-bound',
    hostVersion: serverHostVersion,
    reservedIds: hooks.baselinePluginIds,
    onOwnershipLost: hooks.onOwnershipLost,
  });
  hooks.registerOwnedStore(owned);
  return { authority, ...authority.readStartupAuthoritySync(), owned, localTrust };
}
