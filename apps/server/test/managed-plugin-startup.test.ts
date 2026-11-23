import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import type { ClosablePluginTrustStore } from '../src/local-plugin-host.js';
import {
  acquireManagedPluginStartup,
  resolvePluginStartupOptions,
} from '../src/managed-plugin-startup.js';
import {
  openOwnedPluginArtifactStore,
  type OwnedPluginArtifactStore,
} from '../src/owned-plugin-artifact-store.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type { PluginAuthorityDatabase } from '../src/plugin-authority-types.js';
import { PluginStoreOwnershipError } from '../src/plugin-store-ownership-types.js';
import { createSqlitePluginTrustStore } from '../src/plugin-trust-store.js';
import { createServerShutdown } from '../src/server-shutdown.js';
import { startServer } from '../src/main.js';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import {
  activateInput,
  artifact,
  decisionInput,
  digestA,
  importInput,
} from './support/plugin-authority-fixtures.js';

const allowUnbound = { initialBinding: 'allow-unbound' } as const;
const requireBound = { initialBinding: 'require-bound' } as const;
const cleanup: Array<() => Promise<void>> = [];

vi.mock(import('@hono/node-server'), async (original) => {
  const actual = await original();
  return { ...actual, serve: vi.fn(actual.serve) };
});
vi.mock(import('../src/owned-plugin-artifact-store.js'), async (original) => {
  const actual = await original();
  return { ...actual, openOwnedPluginArtifactStore: vi.fn(actual.openOwnedPluginArtifactStore) };
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.mocked(serve).mockClear();
  vi.mocked(openOwnedPluginArtifactStore).mockReset();
});

function fixture() {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weave-managed-startup-'));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const pluginsDirectory = join(dataDirectory, 'plugins');
  return {
    dataDirectory,
    environment: {},
    databaseFile: join(dataDirectory, 'weave.sqlite'),
    pluginsDirectory,
    root: join(pluginsDirectory, '.weave-store'),
    ownerFile: join(pluginsDirectory, '.weave-store', 'ownership.sqlite'),
  };
}

function acquire(
  options: Parameters<typeof resolvePluginStartupOptions>[0],
  inject: {
    readonly baselinePluginIds?: readonly string[];
    readonly afterOwnedRegistration?: (authority: PluginAuthorityDatabase) => void;
    readonly onOwnershipLost?: (error: PluginStoreOwnershipError) => undefined;
  } = {},
) {
  const config = resolvePluginStartupOptions(options);
  let authority: PluginAuthorityDatabase | undefined;
  let owned: OwnedPluginArtifactStore | undefined;
  let manualTrust: ClosablePluginTrustStore | undefined;
  const shutdown = createServerShutdown({
    resources: () => ({ authority, owned }),
    async disposeHost() {},
    async stopRuntime() {},
    closeProjectStore() {},
    closeProviderSettingsStore() {},
    closeManualTrustStore: () => manualTrust?.close(),
    closeMcpAuthorityStore() {},
  });
  cleanup.push(shutdown.stop);
  const startup = acquireManagedPluginStartup(config, {
    baselinePluginIds: inject.baselinePluginIds ?? [],
    registerAuthority(value) {
      authority = value;
      return undefined;
    },
    registerManualTrustStore(value) {
      manualTrust = value;
      return undefined;
    },
    registerOwnedStore(value) {
      owned = value;
      if (authority !== undefined) inject.afterOwnedRegistration?.(authority);
      return undefined;
    },
    onOwnershipLost: inject.onOwnershipLost ?? (() => undefined),
  }).catch((cause: unknown) => shutdown.failStartup(cause));
  return { startup, shutdown };
}

function overrideStore(dataDirectory: string) {
  const store = createSqlitePluginTrustStore({ filename: join(dataDirectory, 'override.sqlite') });
  cleanup.push(() => store.close());
  return store;
}

async function seedSticky(databaseFile: string, mode: 'imported' | 'selected' | 'uninstalled') {
  const authority = createSqlitePluginAuthorityDatabase({ filename: databaseFile });
  try {
    authority.commitSync(importInput('import-notes', 0));
    if (mode !== 'imported') {
      authority.commitSync(activateInput('select-notes', authority.snapshotSync()));
    }
    if (mode === 'uninstalled') {
      authority.commitSync(decisionInput('uninstall', 'uninstall-notes', authority.snapshotSync()));
    }
  } finally {
    await authority.close();
  }
}

async function startLive(options: NonNullable<Parameters<typeof startServer>[1]>) {
  const started = await startServer(0, options);
  cleanup.push(started.stop);
  return started;
}

describe('managed plugin startup', () => {
  it('rejects live malformed managed options before creating the data directory', async () => {
    const { dataDirectory } = fixture();
    const nested = join(dataDirectory, 'missing');
    await expect(
      startLive({
        dataDirectory: nested,
        environment: {},
        managedPluginStore: { ...allowUnbound, directory: 'elsewhere' } as typeof allowUnbound,
      }),
    ).rejects.toThrow();
    expect(existsSync(nested)).toBe(false);
    expect(serve).not.toHaveBeenCalled();
  });

  it('holds the real lease while listening and resumes after stop', async () => {
    const { dataDirectory, root, environment } = fixture();
    const options = { dataDirectory, environment };
    const first = await startLive({ ...options, managedPluginStore: allowUnbound });
    expect(first.port).toBeGreaterThan(0);
    expect(existsSync(root)).toBe(true);
    // Memory is acquired before managed plugins during full Server startup.
    await expect(startLive(options)).rejects.toMatchObject({ code: 'memory-busy' });
    expect(serve).toHaveBeenCalledTimes(1);
    await expect(acquire(options).startup).rejects.toMatchObject({ code: 'plugin-store-busy' });
    const liveHealth = await fetch(`http://127.0.0.1:${first.port}/health`);
    expect(liveHealth.status).toBe(200);
    await expect(liveHealth.json()).resolves.toEqual({ status: 'ok', runtime: 'running' });
    await first.stop();
    const restarted = await startLive(options);
    expect(restarted.pluginHost?.dispose).toBe(restarted.stop);
    const restartedHealth = await fetch(`http://127.0.0.1:${restarted.port}/health`);
    expect(restartedHealth.status).toBe(200);
    await expect(restartedHealth.json()).resolves.toEqual({ status: 'ok', runtime: 'running' });
  });

  it('rejects a preexisting sticky override before listen and leaves it caller-owned', async () => {
    const { dataDirectory, databaseFile, environment, root } = fixture();
    await seedSticky(databaseFile, 'imported');
    const override = overrideStore(dataDirectory);
    const events = vi.spyOn(override, 'events');
    const close = vi.spyOn(override, 'close');
    await expect(
      startLive({ dataDirectory, environment, pluginTrustStore: override }),
    ).rejects.toThrow(/pluginTrustStore/);
    expect(serve).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  it('checks the selected digest but leaves a missing managed artifact unpublished', async () => {
    const { dataDirectory, databaseFile, environment } = fixture();
    const options = { dataDirectory, environment };
    const first = acquire({ ...options, managedPluginStore: allowUnbound });
    await first.startup;
    await first.shutdown.stop();
    await seedSticky(databaseFile, 'selected');
    const open = vi.mocked(openOwnedPluginArtifactStore);
    const actual = await vi.importActual<typeof import('../src/owned-plugin-artifact-store.js')>(
      '../src/owned-plugin-artifact-store.js',
    );
    const reads = vi.fn();
    open.mockImplementationOnce(async (input) => {
      const owned = await actual.openOwnedPluginArtifactStore(input);
      return { ...owned, read: reads.mockImplementation(owned.read) };
    });
    const server = await startLive(options);
    expect(server.pluginHost?.dispose).toBe(server.stop);
    expect(reads).toHaveBeenCalled();
    expect(new Set(reads.mock.calls.map(([digest]) => digest))).toEqual(new Set([digestA]));
    expect(server.runtime.serverHost.controller()?.current().resources.plugins).not.toContainEqual(
      expect.objectContaining({ id: 'notes' }),
    );
  });

  it('reports the first ownership error observed before composition attaches', async () => {
    const { dataDirectory, environment } = fixture();
    const options = { dataDirectory, environment };
    const loss = new PluginStoreOwnershipError(
      'plugin-store-ownership-lost',
      'lease lost during boot',
    );
    const actual = await vi.importActual<typeof import('../src/owned-plugin-artifact-store.js')>(
      '../src/owned-plugin-artifact-store.js',
    );
    vi.mocked(openOwnedPluginArtifactStore).mockImplementationOnce(async (input) => {
      const owned = await actual.openOwnedPluginArtifactStore(input);
      expect(input.onOwnershipLost(loss)).toBeUndefined();
      input.onOwnershipLost(
        new PluginStoreOwnershipError('plugin-store-ownership-lost', 'second observation'),
      );
      return owned;
    });
    await expect(startLive({ ...options, managedPluginStore: allowUnbound })).rejects.toBe(loss);
    expect(serve).not.toHaveBeenCalled();
    const restarted = await startLive(options);
    expect(restarted.pluginHost?.dispose).toBe(restarted.stop);
  });

  it('reports ownership loss even if the initial MCP read subsequently rejects', async () => {
    const { dataDirectory, databaseFile, environment } = fixture();
    const options = { dataDirectory, environment };
    const loss = new PluginStoreOwnershipError(
      'plugin-store-ownership-lost',
      'lease lost during initial MCP refresh',
    );
    const store = createSqliteMcpAuthorityStore({ filename: databaseFile });
    cleanup.push(store.close);
    const actual = await vi.importActual<typeof import('../src/owned-plugin-artifact-store.js')>(
      '../src/owned-plugin-artifact-store.js',
    );
    vi.mocked(openOwnedPluginArtifactStore).mockImplementationOnce(async (input) => {
      const owned = await actual.openOwnedPluginArtifactStore(input);
      vi.spyOn(store, 'read').mockImplementationOnce(async () => {
        input.onOwnershipLost(loss);
        throw new Error('MCP read failed after lease loss');
      });
      return owned;
    });
    await expect(
      startLive({ ...options, managedPluginStore: allowUnbound, mcpAuthorityStore: store }),
    ).rejects.toBe(loss);
    expect(serve).not.toHaveBeenCalled();
    const restarted = await startLive(options);
    expect(restarted.pluginHost?.dispose).toBe(restarted.stop);
  });

  it.each([null, {}, { initialBinding: 'auto' }, { ...allowUnbound, directory: 'elsewhere' }])(
    'rejects malformed managed options before opening persistence (%j)',
    (managedPluginStore) => {
      const { dataDirectory, databaseFile, environment, pluginsDirectory } = fixture();
      expect(() =>
        resolvePluginStartupOptions({ dataDirectory, environment, managedPluginStore }),
      ).toThrow();
      expect(existsSync(databaseFile)).toBe(false);
      expect(existsSync(pluginsDirectory)).toBe(false);
    },
  );

  it('rejects explicit managed mode with disabled ESM or a custom trust store', () => {
    const { dataDirectory, databaseFile, environment } = fixture();
    const options = { dataDirectory, environment, managedPluginStore: allowUnbound };
    expect(() => resolvePluginStartupOptions({ ...options, pluginsDirectory: false })).toThrow();
    expect(() =>
      resolvePluginStartupOptions({ ...options, pluginTrustStore: overrideStore(dataDirectory) }),
    ).toThrow();
    expect(existsSync(databaseFile)).toBe(false);
  });

  it('creates the missing default plugin parent on first bind and resumes the exact binding', async () => {
    const { dataDirectory, environment, pluginsDirectory, root } = fixture();
    expect(existsSync(pluginsDirectory)).toBe(false);
    const options = { dataDirectory, environment };
    const first = acquire({ ...options, managedPluginStore: allowUnbound });
    const { authority, owned, registration, localTrust } = await first.startup;
    expect(owned?.binding.storeDirectory).toBe(await realpath(root));
    expect(registration?.binding).toEqual(owned?.binding);
    expect(localTrust).toEqual({ kind: 'authority', store: authority.trust });
    await first.shutdown.stop();

    const resumed = await acquire(options).startup;
    expect(resumed.owned?.binding).toEqual(owned?.binding);
    resumed.owned?.assertHeldSync();
  });

  it('resolves a configured relative plugin path against the working directory', async () => {
    const { dataDirectory, environment } = fixture();
    const configuredDirectory = join(dataDirectory, 'relative', 'plugins');
    const { owned } = await acquire({
      dataDirectory,
      environment,
      pluginsDirectory: relative(process.cwd(), configuredDirectory),
      managedPluginStore: allowUnbound,
    }).startup;
    expect(owned?.binding.storeDirectory).toBe(
      await realpath(join(configuredDirectory, '.weave-store')),
    );
  });

  it('rejects unsatisfied require-bound without creating the parent or root', async () => {
    const { dataDirectory, environment, pluginsDirectory, root } = fixture();
    const options = { dataDirectory, environment, managedPluginStore: requireBound };
    await expect(acquire(options).startup).rejects.toMatchObject({ code: 'plugin-store-invalid' });
    expect(existsSync(pluginsDirectory)).toBe(false);

    await mkdir(pluginsDirectory);
    await expect(acquire(options).startup).rejects.toMatchObject({
      code: 'plugin-store-recovery-required',
    });
    expect(existsSync(root)).toBe(false);
  });

  it('rejects an existing owner and can resume once that owner stops', async () => {
    const { dataDirectory, environment } = fixture();
    const options = { dataDirectory, environment };
    const first = acquire({ ...options, managedPluginStore: allowUnbound });
    const { owned } = await first.startup;
    await expect(acquire(options).startup).rejects.toMatchObject({ code: 'plugin-store-busy' });
    owned?.assertHeldSync();
    await first.shutdown.stop();
    expect((await acquire(options).startup).owned?.binding).toEqual(owned?.binding);
  });

  it('does not create a wrong plugin parent for a registered allow-unbound request', async () => {
    const { dataDirectory, environment } = fixture();
    const options = { dataDirectory, environment, managedPluginStore: allowUnbound };
    const first = acquire(options);
    const { registration } = await first.startup;
    await first.shutdown.stop();
    const wrongDirectory = join(dataDirectory, 'wrong');
    const wrongOptions = { ...options, pluginsDirectory: wrongDirectory };
    await expect(acquire(wrongOptions).startup).rejects.toMatchObject({
      code: 'plugin-store-invalid',
    });
    expect(existsSync(wrongDirectory)).toBe(false);

    await mkdir(wrongDirectory);
    await expect(acquire(wrongOptions).startup).rejects.toMatchObject({
      code: 'plugin-store-owner-mismatch',
    });
    expect(existsSync(join(wrongDirectory, '.weave-store'))).toBe(false);
    expect((await acquire(options).startup).registration).toEqual(registration);
  });

  it.each(['missing', 'corrupt'] as const)('fails resume with %s owner metadata', async (state) => {
    const { dataDirectory, environment, ownerFile } = fixture();
    const options = { dataDirectory, environment };
    const first = acquire({ ...options, managedPluginStore: allowUnbound });
    const { registration } = await first.startup;
    await first.shutdown.stop();
    if (state === 'missing') await rm(ownerFile);
    else await writeFile(ownerFile, 'corrupt owner database');

    await expect(acquire(options).startup).rejects.toMatchObject({
      code: 'plugin-store-recovery-required',
    });
    if (state === 'missing') expect(existsSync(ownerFile)).toBe(false);
    else expect(await readFile(ownerFile, 'utf8')).toBe('corrupt owner database');
    const disabled = await acquire({ ...options, pluginsDirectory: false }).startup;
    expect(disabled.registration).toEqual(registration);
  });

  it('honors isolated database defaults and leaves an ordinary unbound root unopened', async () => {
    const { dataDirectory, databaseFile, environment, pluginsDirectory } = fixture();
    const isolatedFile = join(dataDirectory, 'isolated.sqlite');
    const bound = acquire({
      databaseFile: isolatedFile,
      pluginsDirectory: join(dataDirectory, 'isolated-plugins'),
      environment,
      managedPluginStore: allowUnbound,
    });
    const boundState = await bound.startup;
    await bound.shutdown.stop();
    await seedSticky(databaseFile, 'selected');

    const isolated = await acquire({ databaseFile: isolatedFile, environment }).startup;
    const usual = await acquire({ dataDirectory, environment }).startup;
    expect(isolated.localTrust).toBeUndefined();
    expect(isolated.owned).toBeUndefined();
    expect(isolated.snapshot.installations).toEqual([]);
    expect(isolated.registration).toEqual(boundState.registration);
    expect(usual.localTrust).toEqual({ kind: 'authority', store: usual.authority.trust });
    expect(usual.snapshot.installations).toMatchObject([{ pluginId: 'notes' }]);
    expect(usual.registration).toBeNull();
    expect(usual.owned).toBeUndefined();
    expect(existsSync(pluginsDirectory)).toBe(false);
  });

  it.each(['default-unbound', 'disabled', 'clean-override'] as const)(
    'accepts a database leaf symlink for %s startup',
    async (mode) => {
      const { dataDirectory, databaseFile, environment, pluginsDirectory } = fixture();
      if (mode === 'clean-override') {
        await createSqlitePluginAuthorityDatabase({ filename: databaseFile }).close();
      } else {
        await seedSticky(databaseFile, 'imported');
      }
      const alias = join(dataDirectory, 'alias.sqlite');
      await symlink(databaseFile, alias, 'file');

      const startup = await acquire({
        dataDirectory,
        databaseFile: alias,
        environment,
        ...(mode === 'disabled' ? { pluginsDirectory: false } : {}),
        ...(mode === 'clean-override' ? { pluginTrustStore: overrideStore(dataDirectory) } : {}),
      }).startup;
      expect(startup.localTrust?.kind).toBe(
        { 'default-unbound': 'authority', disabled: undefined, 'clean-override': 'override' }[mode],
      );
      expect(startup.snapshot.installations.map(({ pluginId }) => pluginId)).toEqual(
        mode === 'clean-override' ? [] : ['notes'],
      );
      expect(startup.registration).toBeNull();
      expect(startup.owned).toBeUndefined();
      expect(existsSync(pluginsDirectory)).toBe(false);
    },
  );

  it.each(['explicit', 'registered'] as const)(
    'rejects a database leaf symlink before %s managed acquisition',
    async (mode) => {
      const { dataDirectory, databaseFile, environment, pluginsDirectory } = fixture();
      if (mode === 'registered') {
        const first = acquire({ dataDirectory, environment, managedPluginStore: allowUnbound });
        await first.startup;
        await first.shutdown.stop();
        await rm(pluginsDirectory, { recursive: true });
      } else {
        await createSqlitePluginAuthorityDatabase({ filename: databaseFile }).close();
      }
      const alias = join(dataDirectory, 'alias.sqlite');
      await symlink(databaseFile, alias, 'file');

      await expect(
        acquire({
          dataDirectory,
          databaseFile: alias,
          environment,
          ...(mode === 'explicit' ? { managedPluginStore: allowUnbound } : {}),
        }).startup,
      ).rejects.toMatchObject({ code: 'plugin-authority-invalid' });
      expect(existsSync(pluginsDirectory)).toBe(false);
    },
  );

  it.each([false, undefined])(
    'preserves unregistered selection with ESM override %s',
    async (esm) => {
      const { dataDirectory, databaseFile, environment, pluginsDirectory } = fixture();
      await seedSticky(databaseFile, 'selected');
      const options = {
        dataDirectory,
        environment,
        ...(esm === false ? { pluginsDirectory: esm } : {}),
      };
      const startup = await acquire(options).startup;
      expect(startup.snapshot.installations).toMatchObject([
        { pluginId: 'notes', selection: { digest: artifact().digest } },
      ]);
      expect(startup.localTrust?.kind).toBe(esm === false ? undefined : 'authority');
      expect(startup.owned).toBeUndefined();
      expect(startup.registration).toBeNull();
      expect(existsSync(pluginsDirectory)).toBe(false);
    },
  );

  it.each(['registered', 'imported', 'uninstalled'] as const)(
    'rejects a custom trust store for %s history',
    async (state) => {
      const { dataDirectory, databaseFile, environment } = fixture();
      const options = { dataDirectory, environment };
      if (state === 'registered') {
        const first = acquire({ ...options, managedPluginStore: allowUnbound });
        await first.startup;
        await first.shutdown.stop();
      } else {
        await seedSticky(databaseFile, state);
      }
      const custom = overrideStore(dataDirectory);
      const read = vi.spyOn(custom, 'events');
      const close = vi.spyOn(custom, 'close');
      await expect(acquire({ ...options, pluginTrustStore: custom }).startup).rejects.toThrow(
        /pluginTrustStore/,
      );
      expect(read).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    },
  );

  it('keeps the override as the sole trust writer and closes it once on stop', async () => {
    const { dataDirectory, environment, pluginsDirectory } = fixture();
    const options = { dataDirectory, environment };
    const first = acquire(options);
    const { authority } = await first.startup;
    const unrelated = await authority.trust.append({ kind: 'revoked', pluginId: 'main' });
    await first.shutdown.stop();

    const custom = overrideStore(dataDirectory);
    const { manifest, digest, pluginId } = artifact();
    const initial = await custom.append({ kind: 'trusted', pluginId, digest, manifest });
    const close = vi.spyOn(custom, 'close');
    const second = acquire({ ...options, pluginTrustStore: custom });
    const startup = await second.startup;
    expect(startup.localTrust?.kind).toBe('override');
    if (startup.localTrust?.kind !== 'override') throw new Error('Expected override trust');
    const { store, readTrustEventsSync } = startup.localTrust;
    expect(await startup.authority.trust.events()).toEqual([unrelated]);
    expect(readTrustEventsSync()).toEqual([initial]);
    const copy = readTrustEventsSync()?.[0];
    if (copy?.kind !== 'trusted') throw new Error('Expected cached trust');
    Reflect.set(copy.manifest, 'name', 'changed outside the cache');
    expect(readTrustEventsSync()).toEqual([initial]);
    const recorded = await store.append({ kind: 'disabled', pluginId });
    expect(readTrustEventsSync()).toEqual([initial, recorded]);
    expect(await store.events()).toEqual([initial, recorded]);
    expect(await startup.authority.trust.events()).toEqual([unrelated]);
    expect(existsSync(pluginsDirectory)).toBe(false);
    await second.shutdown.stop();
    await second.shutdown.stop();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(custom.events()).rejects.toMatchObject({ code: 'plugin-trust-closed' });
  });

  it('rejects an override if sticky history appears during its initial read', async () => {
    const { dataDirectory, databaseFile, environment } = fixture();
    const custom = overrideStore(dataDirectory);
    const close = vi.spyOn(custom, 'close');
    const readEvents = custom.events;
    vi.spyOn(custom, 'events').mockImplementationOnce(async () => {
      await seedSticky(databaseFile, 'imported');
      return readEvents.call(custom);
    });
    await expect(
      acquire({ dataDirectory, environment, pluginTrustStore: custom }).startup,
    ).rejects.toThrow(/pluginTrustStore/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns a gapped append before a reread and withholds the incomplete override prefix', async () => {
    const { dataDirectory, environment } = fixture();
    const custom = overrideStore(dataDirectory);
    const initial = await custom.append({ kind: 'revoked', pluginId: 'initial' });
    const events = vi.spyOn(custom, 'events');
    const { localTrust } = await acquire({ dataDirectory, environment, pluginTrustStore: custom })
      .startup;
    if (localTrust?.kind !== 'override') throw new Error('Expected override trust');
    const skipped = await custom.append({ kind: 'revoked', pluginId: 'concurrent' });
    const recorded = await localTrust.store.append({ kind: 'revoked', pluginId: 'local' });
    expect(recorded.sequence).toBe(3);
    expect(events).toHaveBeenCalledTimes(1);
    expect(localTrust.readTrustEventsSync()).toBeUndefined();

    events.mockResolvedValueOnce([initial, skipped]);
    await localTrust.store.events();
    expect(localTrust.readTrustEventsSync()).toBeUndefined();
    expect(await localTrust.store.events()).toEqual([initial, skipped, recorded]);
    expect(localTrust.readTrustEventsSync()).toEqual([initial, skipped, recorded]);
  });

  it('releases an acquired wrapper when the fresh authority read fails after acquisition', async () => {
    const { dataDirectory, environment } = fixture();
    const options = { dataDirectory, environment };
    const cause = new Error('fresh authority read failed');
    const first = acquire(
      { ...options, managedPluginStore: allowUnbound },
      {
        afterOwnedRegistration(authority) {
          vi.spyOn(authority, 'readStartupAuthoritySync').mockImplementationOnce(() => {
            throw cause;
          });
        },
      },
    );
    await expect(first.startup).rejects.toBe(cause);
    const resumed = await acquire(options).startup;
    expect(resumed.owned?.binding).toEqual(resumed.registration?.binding);
    resumed.owned?.assertHeldSync();
  });

  it('passes baseline reservations and the Server host version to the artifact store', async () => {
    const { dataDirectory, environment } = fixture();
    const { owned } = await acquire(
      { dataDirectory, environment, managedPluginStore: allowUnbound },
      { baselinePluginIds: ['baseline'] },
    ).startup;
    if (owned === undefined) throw new Error('Expected an owned store');
    const sourceDirectory = join(dataDirectory, 'candidate');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'index.mjs'), 'export default {}');
    const { manifest } = artifact();
    for (const [id, engines, message] of [
      ['baseline', undefined, /reserved ID/],
      ['future', { weave: '>=20.0.0' }, /incompatible/],
    ] as const) {
      await writeFile(
        join(sourceDirectory, 'weave-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          entry: 'index.mjs',
          manifest: { ...manifest, id, engines },
        }),
      );
      await expect(owned.stage({ sourceDirectory })).rejects.toThrow(message);
    }
  });
});
